//! Reports (plans/MODERATION.md, _Reports_; Curtis, 2026-11-02): a person asks the moderators they
//! trust to consider an entry for their list, and a moderator who opted in works through them.
//!
//! **Both sides opt in, or the report bounces.** A persona takes reports only with _Accept
//! Reports_ on (`report_takers`), on a node whose operator turned on _Allow Users to Accept
//! Reports_ (`report_policy`); both default off - except that a development build's node allows
//! them until its operator says otherwise, so a local network can fill with reports to look at
//! (`just test-data`; Curtis, 2026-11-04). Anything else is refused aloud
//! ([`refusal::NOT_TAKING`]), and the bounce is the whole answer: nothing advertises who takes
//! reports.
//!
//! **Off the chains.** A report rides the delivery lane as an envelope ([`ringtome_proto::report`])
//! and lands in `reports`, on the node that took it - never transcribed, never synced (Curtis: "we
//! don't need that to sync across multiple devices").
//!
//! **Floods.** By default a moderator takes reports only from the people they trust, and
//! optionally the people those people trust (the trust lane of `implicit_edges`): a fresh persona
//! reaches nobody and bounces at the door, never stored. Taking strangers' reports is a second
//! switch, into a pool bounded per moderator (`stranger_pool`, oldest dropped first) that a flood
//! can fill but never push a trusted reporter's report out of. Every report remembers the node
//! that knocked, so a queue groups by it, and "block that node and drop these" is one action.
//!
//! **Evidence is signed, never made up.** A report about something published carries the
//! author's own signed header for that version, checked at the door
//! (`ringtome_proto::report::verify_report`). Its pictures - the body and thumbnail that header
//! names - come afterwards over HTTPS only, to an address the door hands back
//! ([`DeliverMessage::Taken`]): whatever upload scanning sits in front of this node
//! (plans/SCANNING.md) sees them before they reach the disk, and only bytes that hash to what the
//! author signed are kept. A sealed post's words never travel: reporting private things is left
//! for later.
//!
//! **A post's pictures are documents of their own**, which its signed header names, so a report
//! on a post has to reach them or it acts on the words and leaves the picture up. The envelope
//! carries their signed headers while it has room ([`ReportedPart`]), and the door reads the rest
//! from its own copy ([`files_named`]). A picture past the room that this node doesn't hold is
//! out of reach: it can't be shown to the moderator, or sealed before it arrives.
//!
//! **A child being abused** is a separate choice that carries the reference and nothing else: no
//! upload address is ever handed back for it. When the moderator administers this node and the
//! reporter is someone their trust reaches, the reference seals the item's files here at once
//! (quarantine.rs); otherwise the queue offers an administrator the quarantine.
//!
//! **The queue, and an assistant.** The moderator lists or dismisses; an assistant behind their
//! API key (mcp/) reads the queue and can only *propose* an entry - the person approves. Report
//! text is written by whoever is attacking you.
//!
//! Owns the `report_policy`, `report_takers`, `reports` and `report_pictures` SQL
//! (tests/conventions.rs).

use std::collections::BTreeMap;

use anyhow::{anyhow, Context as _, Result};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ringtome_proto::deliver::{
    notice_kind, refusal, DeliverMessage, SignedEnvelope, MAX_ENVELOPE_BYTES,
};
use ringtome_proto::registry::DocHeaderPlain;
use ringtome_proto::report::{Report, ReportedItem, ReportedPart, VerifiedReport};
use ringtome_proto::{ModerationLevel, ModerationTarget};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::identity::routes::hex_fixed;
use crate::record::store;
use crate::AppState;

/// How long a report's upload address takes its pictures.
const UPLOAD_WINDOW_MS: i64 = 60 * 60 * 1000;
/// The defaults an operator starts from when they first allow reports.
const DEFAULT_STRANGER_POOL: i64 = 500;
const DEFAULT_KEEP_DAYS: i64 = 90;
/// How much of a reported post's words the queue shows.
const WORDS_SHOWN: usize = 4000;
/// What a knock's proof of work may add to an envelope sized without one.
const STAMP_ROOM: usize = 64;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/report-policy", get(policy_handler).put(set_policy_handler))
        .route("/api/identity/{root}/reports", get(queue_handler).post(send_handler))
        .route(
            "/api/identity/{root}/reports/settings",
            get(settings_handler).put(set_settings_handler),
        )
        .route("/api/identity/{root}/reports/{id}/dismiss", post(dismiss_handler))
        .route("/api/identity/{root}/reports/{id}/list", post(list_handler))
        .route("/api/identity/{root}/reports/{id}/propose", post(propose_handler))
        .route("/api/identity/{root}/reports/{id}/quarantine", post(quarantine_handler))
        .route("/api/identity/{root}/reports/{id}/picture/{hash}", get(picture_handler))
        .route("/api/identity/{root}/reports/from/{node}/drop", post(drop_node_handler))
        .route("/api/reports/upload/{token}", post(upload_handler))
}

// ---------------------------------------------------------------------------------------------
// The two switches

/// The operator's word on reports here.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Policy {
    pub users_may: bool,
    pub stranger_pool: i64,
    pub keep_days: i64,
}

pub async fn policy(state: &AppState) -> Policy {
    let row: Option<(i64, i64, i64)> = state
        .node_db
        .fetch_optional(
            "SELECT users_may, stranger_pool, keep_days FROM report_policy WHERE id = 1",
            (),
        )
        .await
        .ok()
        .flatten();
    match row {
        Some((on, pool, days)) => {
            Policy { users_may: on != 0, stranger_pool: pool, keep_days: days }
        }
        // Never set: off, but on a development build, on (the header says why).
        None => Policy {
            users_may: state.config.is_dev(),
            stranger_pool: DEFAULT_STRANGER_POOL,
            keep_days: DEFAULT_KEEP_DAYS,
        },
    }
}

/// A persona's word on reports here.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Taking {
    pub takes: bool,
    /// 1: the people they trust; 2: and the people those people trust.
    pub reach: i64,
    pub strangers: bool,
}

async fn taking(state: &AppState, root: &str) -> Result<Taking> {
    let row: Option<(i64, i64, i64)> = state
        .node_db
        .fetch_optional(
            "SELECT takes, reach, strangers FROM report_takers WHERE root = ?1",
            (root,),
        )
        .await
        .context("reading who takes reports")?;
    Ok(match row {
        Some((takes, reach, strangers)) => {
            Taking { takes: takes != 0, reach: reach.clamp(1, 2), strangers: strangers != 0 }
        }
        None => Taking { takes: false, reach: 1, strangers: false },
    })
}

// ---------------------------------------------------------------------------------------------
// The door

/// Where a reporter stands with the moderator.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Standing {
    Trusted,
    Reach,
    Stranger,
}

impl Standing {
    fn word(self) -> &'static str {
        match self {
            Standing::Trusted => "trusted",
            Standing::Reach => "reach",
            Standing::Stranger => "stranger",
        }
    }
}

/// The delivery lane's answer to a report envelope (net/deliver.rs hands every one here, after
/// the stamp). `from` is the endpoint that knocked.
pub async fn judge(state: &AppState, signed: &SignedEnvelope, from: &str) -> DeliverMessage {
    let verified = match ringtome_proto::report::verify_report(signed) {
        Ok(v) => v,
        Err(e) => {
            tracing::debug!(error = ?e, "a report did not verify");
            return DeliverMessage::Refused(refusal::MALFORMED);
        }
    };
    match take(state, &verified, from).await {
        Ok(answer) => answer,
        Err(e) => {
            tracing::warn!(error = ?e, "a report could not be judged");
            DeliverMessage::Busy
        }
    }
}

async fn take(state: &AppState, v: &VerifiedReport, from: &str) -> Result<DeliverMessage> {
    let moderator = hex::encode(v.moderator_root);
    let reporter = hex::encode(v.reporter_root);
    let policy = policy(state).await;
    let taking = taking(state, &moderator).await?;
    if !policy.users_may || !taking.takes {
        return Ok(DeliverMessage::Refused(refusal::NOT_TAKING));
    }
    let data = store::open_agented(state, &moderator).await.map_err(|e| anyhow!("{e}"))?;
    let facts: BTreeMap<String, String> = data
        .contacts()
        .await
        .map_err(|e| anyhow!("{e}"))?
        .into_iter()
        .find(|(root, _)| *root == reporter)
        .map(|(_, f)| f.into_iter().collect())
        .unwrap_or_default();
    // A blocked reporter is told "taken" and kept nowhere: the answer is never a block oracle
    // (net/deliver.rs, _Words beat resets_).
    if facts.get("blocked").map(String::as_str) == Some("yes") {
        return Ok(DeliverMessage::Taken(None));
    }
    let trusted = facts.get("trust").is_some_and(|t| !t.is_empty() && t != "none");
    let standing = if trusted {
        Standing::Trusted
    } else if taking.reach >= 2
        && crate::edgegraph::implicit_of(data.db())
            .await?
            .iter()
            .any(|r| r.lane == "trust" && r.target_root == reporter)
    {
        Standing::Reach
    } else if taking.strangers {
        Standing::Stranger
    } else {
        return Ok(DeliverMessage::Refused(refusal::NOT_TAKING));
    };
    drop(data);

    let id = hex::encode(v.id);
    let held: Option<(Option<String>,)> = state
        .node_db
        .fetch_optional("SELECT upload_token FROM reports WHERE id = ?1", (id.as_str(),))
        .await
        .context("reading a report")?;
    if let Some((token,)) = held {
        // The same envelope again - a retry, or a sibling's - is the same report.
        return Ok(DeliverMessage::Taken(token.and_then(|t| upload_address(state, &t))));
    }

    let report = &v.report;
    let item = v.item.as_ref();
    let item_hashes = files_named(state, v).await?;
    // Pictures are asked for only over HTTPS, only for an open post, never for a child-abuse
    // report, and only where this node can be reached by address.
    let wants_upload = !report.child_abuse
        && item.is_some_and(|f| !f.header.trusted_only)
        && !item_hashes.is_empty()
        && public_base(state).is_some();
    let token = wants_upload.then(new_token);
    let now = crate::clock::now_ms();
    let params: Vec<turso::Value> = vec![
        id.clone().into(),
        moderator.clone().into(),
        reporter.clone().into(),
        Option::<String>::None.into(),
        standing.word().into(),
        from_hex(from).into(),
        report.kind.word().into(),
        hex::encode(report.target).into(),
        report.reason.clone().into(),
        i64::from(report.child_abuse).into(),
        report.item.as_ref().map(|i| hex::encode(i.author)).into(),
        item.map(|f| hex::encode(f.doc_id)).into(),
        item.map(|f| hex::encode(f.version)).into(),
        item.map(|f| if f.header.trusted_only { String::new() } else { f.header.title.clone() })
            .into(),
        item.and_then(|f| f.header.format.map(|x| x as i64)).into(),
        item.map(|f| i64::from(f.header.trusted_only)).into(),
        item.map(|f| f.timestamp_ms).into(),
        serde_json::to_string(&item_hashes.iter().map(hex::encode).collect::<Vec<_>>())?.into(),
        token.clone().into(),
        token.as_ref().map(|_| now + UPLOAD_WINDOW_MS).into(),
        now.into(),
    ];
    state
        .node_db
        .execute(
            "INSERT INTO reports (id, moderator, reporter, reporter_name, standing, from_node,
                 target_kind, target, reason, child_abuse, item_author, item_doc, item_version,
                 item_title, item_format, item_trusted_only, item_signed_ms, item_hashes,
                 upload_token, upload_until_ms, received_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                 ?18, ?19, ?20, ?21)",
            params,
        )
        .await
        .context("keeping a report")?;
    trim(state, &moderator, &policy).await?;

    // A child-abuse report to an administrator here, from someone their trust reaches, seals what
    // it names at once - the operator's quarantine, started (plans/SCANNING.md). From a stranger it
    // waits for a person: sealing on a stranger's word would let anyone take any picture down. The
    // seal names its reporter, so the operator can see whose word it was, and undo all of it at
    // once (Curtis, 2026-11-03: auditable and reversible).
    if report.child_abuse && standing != Standing::Stranger && !item_hashes.is_empty() {
        let admins = crate::moderation::administrator_roots(state).await?;
        if admins.contains(&moderator) {
            let picture = report.item.as_ref().map(|i| (i.author, i.doc_id));
            let by = crate::quarantine::reported_by(&reporter);
            crate::quarantine::seal(state, &item_hashes, picture, "a child-abuse report", &by)
                .await?;
        }
    }
    tracing::info!(moderator = %moderator, standing = standing.word(), "took a report");
    Ok(DeliverMessage::Taken(token.and_then(|t| upload_address(state, &t))))
}

/// The files a report's item names, the post's own first: the signed headers it carries, then
/// whatever else the post embeds, from this node's copy.
async fn files_named(state: &AppState, v: &VerifiedReport) -> Result<Vec<[u8; 32]>> {
    let (Some(named), Some(item)) = (&v.report.item, &v.item) else {
        return Ok(Vec::new());
    };
    let mut files = own_files(&item.header);
    for part in &v.parts {
        files.extend(own_files(&part.header));
    }
    for embedded in &item.header.refs {
        if !v.parts.iter().any(|p| p.doc_id == *embedded) {
            files.extend(crate::quarantine::own_blobs(state, &named.author, embedded).await?);
        }
    }
    let mut seen = std::collections::HashSet::new();
    files.retain(|f| seen.insert(*f));
    Ok(files)
}

fn own_files(header: &DocHeaderPlain) -> Vec<[u8; 32]> {
    std::iter::once(header.file_hash).chain(header.thumb_hash).collect()
}

/// The knocking node, as a node entry names it: its endpoint id, hex.
fn from_hex(from: &str) -> String {
    from.parse::<iroh::EndpointId>()
        .map(|k| hex::encode(k.as_bytes()))
        .unwrap_or_else(|_| from.to_string())
}

/// Oldest strangers' reports past the pool, and every report past its keeping, go.
async fn trim(state: &AppState, moderator: &str, policy: &Policy) -> Result<()> {
    let cutoff = crate::clock::now_ms() - policy.keep_days.max(1) * 24 * 60 * 60 * 1000;
    let gone: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT id FROM reports WHERE moderator = ?1 AND (received_ms < ?2 OR id IN (
                 SELECT id FROM reports WHERE moderator = ?1 AND standing = 'stranger'
                 ORDER BY received_ms DESC LIMIT -1 OFFSET ?3))",
            (moderator, cutoff, policy.stranger_pool.max(0)),
        )
        .await
        .context("finding reports past keeping")?;
    for (id,) in gone {
        forget(state, &id).await?;
    }
    Ok(())
}

async fn forget(state: &AppState, id: &str) -> Result<()> {
    state
        .node_db
        .execute("DELETE FROM report_pictures WHERE report_id = ?1", (id,))
        .await
        .context("dropping a report's pictures")?;
    state
        .node_db
        .execute("DELETE FROM reports WHERE id = ?1", (id,))
        .await
        .context("dropping a report")?;
    Ok(())
}

fn new_token() -> String {
    use rand::Rng;
    let mut b = [0u8; 24];
    crate::random::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// Where strangers reach this node over HTTPS: its public address. A test rig has none, so it
/// answers on its own loopback port, which only a rig's reporters may dial (`send`).
fn public_base(state: &AppState) -> Option<String> {
    if crate::webpath::has_public_url(state) {
        return Some(crate::webpath::public_url(state));
    }
    state.config.local_test.then(|| format!("http://127.0.0.1:{}", state.config.port))
}

fn upload_address(state: &AppState, token: &str) -> Option<String> {
    public_base(state).map(|base| format!("{base}/api/reports/upload/{token}"))
}

/// The blobs the reports here hold: the reaper keeps them while their report is kept.
pub async fn blob_refs(node_db: &crate::db::Db) -> Result<Vec<[u8; 32]>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT hash FROM report_pictures", ())
        .await
        .context("reading reports' pictures")?;
    Ok(rows.iter().filter_map(|(h,)| hex::decode(h).ok()?.try_into().ok()).collect())
}

// ---------------------------------------------------------------------------------------------
// The upload, over HTTPS

/// POST `/api/reports/upload/{token}` - one of the reported item's files, raw. Kept only if it
/// hashes to a file the author's signed header names, and only while the address is fresh.
async fn upload_handler(
    State(state): State<AppState>,
    Path(token): Path<String>,
    body: Bytes,
) -> Result<Json<serde_json::Value>, AppError> {
    let not_here = || {
        AppError::NotFound(crate::msg!(
            "reports.no-such-upload",
            "this address takes no more pictures"
        ))
    };
    if token.len() != 48 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(not_here());
    }
    let row: Option<(String, String, i64)> = state
        .node_db
        .fetch_optional(
            "SELECT id, item_hashes, upload_until_ms FROM reports WHERE upload_token = ?1",
            (token.as_str(),),
        )
        .await
        .context("reading an upload address")
        .map_err(AppError::Internal)?;
    let Some((id, hashes, until)) = row else { return Err(not_here()) };
    if crate::clock::now_ms() > until {
        return Err(not_here());
    }
    let named: Vec<String> = serde_json::from_str(&hashes).unwrap_or_default();
    let hash = hex::encode(iroh_blobs::Hash::new(&body).as_bytes());
    if !named.contains(&hash) {
        return Err(AppError::BadRequest(crate::msg!(
            "reports.not-what-was-signed",
            "that isn't a file the reported post names"
        )));
    }
    let put = state.files.put_public(&body).await.map_err(AppError::Internal)?;
    state
        .node_db
        .execute(
            "INSERT OR IGNORE INTO report_pictures (report_id, hash, arrived_ms) VALUES (?1, ?2, ?3)",
            (id.as_str(), hash.as_str(), crate::clock::now_ms()),
        )
        .await
        .context("noting a report's picture")
        .map_err(AppError::Internal)?;
    drop(put);
    Ok(Json(serde_json::json!({ "ok": true })))
}

// ---------------------------------------------------------------------------------------------
// The reporter's side

#[derive(Deserialize)]
struct SendItem {
    author: String,
    doc_id: String,
}

#[derive(Deserialize)]
struct SendRequest {
    /// `persona` or `node`.
    kind: String,
    target: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    child_abuse: bool,
    #[serde(default)]
    item: Option<SendItem>,
}

#[derive(Serialize)]
struct Sent {
    moderator: String,
    /// `sent`, `not-taking`, `unreachable` or `refused`.
    outcome: &'static str,
    pictures: usize,
}

/// POST `/api/identity/{root}/reports` - send a report to every moderator this persona trusts. The
/// app has already protected the reporter (hidden the post, blocked if asked) before this is
/// called: that part never waits on anyone.
async fn send_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<SendRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let kind = ModerationTarget::from_word(&req.kind).ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "moderation.unknown-kind",
            "a list names a persona or a node"
        ))
    })?;
    let target = hex_fixed::<32>(&req.target, "target")?;
    if kind == ModerationTarget::Persona && req.target == root {
        return Err(AppError::BadRequest(crate::msg!(
            "reports.not-yourself",
            "you can't report yourself"
        )));
    }
    let reason = req.reason.trim().to_string();
    if reason.len() > ringtome_proto::report::MAX_REPORT_REASON_BYTES {
        return Err(AppError::BadRequest(crate::msg!(
            "record.imaol.moderation-reason-too-long",
            "that reason is too long - 512 bytes at most"
        )));
    }
    let mut embedded = Vec::new();
    let item = match &req.item {
        Some(i) => {
            let author = hex_fixed::<32>(&i.author, "author")?;
            let doc_id = hex_fixed::<16>(&i.doc_id, "doc_id")?;
            let (entry, auth_path) =
                crate::net::fragment::signed_header(&state, &i.author, &doc_id).await.ok_or_else(
                    || {
                        AppError::NotFound(crate::msg!(
                            "reports.cant-vouch-for-it",
                            "this computer can't vouch for that post - it may have been taken down"
                        ))
                    },
                )?;
            let item = ReportedItem { author, doc_id, entry, auth_path };
            embedded = embedded_in(&state, &item).await;
            Some(item)
        }
        None => None,
    };
    let mut report =
        Report { kind, target, reason, child_abuse: req.child_abuse, item, parts: Vec::new() };
    let malformed = |e: ringtome_proto::ProtoError| {
        AppError::BadRequest(crate::msg!(
            "reports.malformed",
            "this report can't be sent: {why}",
            why = e.to_string()
        ))
    };
    let root_bytes = hex_fixed::<32>(&root, "root")?;
    // As many of its pictures as fit: an envelope's whole size is a door's to refuse, so measure
    // this one's own weight - the reporter's path and name - instead of guessing it.
    let empty = crate::outbox::seal_with(
        data.db(),
        data.signer(),
        &root_bytes,
        &root_bytes,
        Vec::new(),
        notice_kind::REPORT,
        0,
    )
    .await
    .map_err(AppError::Internal)?;
    let room = MAX_ENVELOPE_BYTES.saturating_sub(empty.bytes().len() + STAMP_ROOM);
    for (part, _) in &embedded {
        report.parts.push(part.clone());
        if report.encode().map_err(malformed)?.len() > room {
            report.parts.pop();
            break;
        }
    }
    let bytes = report.encode().map_err(malformed)?;
    // What the moderator is sent to look at: the post's files and its pictures, not its sounds or
    // films, however many fit in the envelope - their node may hold the rest, and so know them.
    let mut files = Vec::new();
    if let Some(item) = &report.item {
        if let Ok(signed) = ringtome_proto::fragment::verify_fragment(
            item.author,
            item.doc_id,
            &item.entry,
            &item.auth_path,
        ) {
            files = own_files(&signed.header);
        }
    }
    for (_, header) in embedded.iter().filter(|(_, h)| is_picture(h)) {
        files.extend(own_files(header));
    }
    let (_, moderators, _) = crate::moderation::view_of(&state, &data, &root).await?;
    // Every moderator hears, at once: a person waits on the form.
    let report = &report;
    let (state, data, root_bytes, bytes, files) = (&state, &data, &root_bytes, &bytes, &files);
    let sent: Vec<Sent> = n0_future::join_all(moderators.into_iter().map(|moderator| async move {
        let Ok(recipient) = hex_fixed::<32>(&moderator, "moderator") else {
            return Sent { moderator, outcome: "refused", pictures: 0 };
        };
        let outcome = deliver_one(state, data, root_bytes, &recipient, bytes).await;
        let (word, pictures) = match outcome {
            Ok(Delivered::Taken(upload)) => {
                let pictures = match &upload {
                    Some(url) if !report.child_abuse => send_pictures(state, url, files).await,
                    _ => 0,
                };
                ("sent", pictures)
            }
            Ok(Delivered::NotTaking) => ("not-taking", 0),
            Ok(Delivered::Refused) => ("refused", 0),
            Ok(Delivered::Unreachable) | Err(_) => ("unreachable", 0),
        };
        Sent { moderator, outcome: word, pictures }
    }))
    .await;
    Ok(Json(serde_json::json!({ "sent": sent })))
}

enum Delivered {
    Taken(Option<String>),
    NotTaking,
    Refused,
    Unreachable,
}

async fn deliver_one(
    state: &AppState,
    data: &store::Store,
    root: &[u8; 32],
    recipient: &[u8; 32],
    report: &[u8],
) -> Result<Delivered> {
    let signer = data.signer();
    let mut price = 0u32;
    // one at a time: the second knock pays the price the first was quoted, so it can't start
    // before the first answers.
    for _ in 0..2 {
        let envelope = crate::outbox::seal_with(
            data.db(),
            signer,
            root,
            recipient,
            report.to_vec(),
            notice_kind::REPORT,
            price,
        )
        .await?;
        match crate::net::deliver::deliver(state, &hex::encode(recipient), envelope.bytes()).await {
            crate::net::deliver::Outcome::Taken(upload) => return Ok(Delivered::Taken(upload)),
            crate::net::deliver::Outcome::Accepted => return Ok(Delivered::Taken(None)),
            crate::net::deliver::Outcome::Refused(r) if r == refusal::NOT_TAKING => {
                return Ok(Delivered::NotTaking)
            }
            crate::net::deliver::Outcome::Refused(_) => return Ok(Delivered::Refused),
            crate::net::deliver::Outcome::Unreachable => return Ok(Delivered::Unreachable),
            crate::net::deliver::Outcome::NeedsStamp(bits) => {
                if bits > state.config.pow_willing_bits {
                    return Ok(Delivered::Unreachable);
                }
                price = bits;
            }
        }
    }
    Ok(Delivered::Unreachable)
}

/// What the reported item embeds, by this node's copy, with the signed header that says so. Only
/// for something public: a sealed post's parts stay with it.
async fn embedded_in(state: &AppState, item: &ReportedItem) -> Vec<(ReportedPart, DocHeaderPlain)> {
    let Ok(signed) = ringtome_proto::fragment::verify_fragment(
        item.author,
        item.doc_id,
        &item.entry,
        &item.auth_path,
    ) else {
        return Vec::new();
    };
    if signed.header.trusted_only {
        return Vec::new();
    }
    let author = hex::encode(item.author);
    let mut out = Vec::new();
    for doc_id in signed.header.refs {
        let Some((entry, auth_path)) =
            crate::net::fragment::signed_header(state, &author, &doc_id).await
        else {
            continue;
        };
        let Ok(part) =
            ringtome_proto::fragment::verify_fragment(item.author, doc_id, &entry, &auth_path)
        else {
            continue;
        };
        let auth_path = if auth_path == item.auth_path { Vec::new() } else { auth_path };
        out.push((ReportedPart { doc_id, entry, auth_path }, part.header));
    }
    out
}

fn is_picture(header: &DocHeaderPlain) -> bool {
    crate::record::documents::Format::from_wire(header.format).mime().starts_with("image/")
}

/// These files, from this node's own copy, to the moderator's upload address - over HTTPS, so
/// whatever scans uploads in front of their node sees them first. Never through a private address:
/// the address came from someone else's node. One the moderator's node can't check against a
/// signed header is refused there, and uncounted here.
async fn send_pictures(state: &AppState, url: &str, files: &[[u8; 32]]) -> usize {
    let mut sent = 0;
    for hash in files {
        let Ok(Some(bytes)) = state.files.get_public(iroh_blobs::Hash::from_bytes(*hash)).await
        else {
            continue;
        };
        match crate::net::unfurl::guarded_post(
            url,
            bytes,
            std::time::Duration::from_secs(30),
            state.config.local_test,
        )
        .await
        {
            Ok(status) if status.is_success() => sent += 1,
            Ok(status) => tracing::debug!(%status, "a report's picture was refused"),
            // Anything that isn't this node's own JSON is "refused before it reached that server"
            // - a scanning layer's answer, whatever its status (plans/SCANNING.md, _Open_).
            Err(e) => tracing::debug!(error = %e, "a report's picture did not arrive"),
        }
    }
    sent
}

// ---------------------------------------------------------------------------------------------
// Settings

/// GET `/api/admin/report-policy`.
async fn policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
) -> Result<Json<serde_json::Value>, AppError> {
    let p = policy(&state).await;
    Ok(Json(serde_json::json!({
        "users_may": p.users_may,
        "stranger_pool": p.stranger_pool,
        "keep_days": p.keep_days,
        "public": crate::webpath::has_public_url(&state),
    })))
}

/// PUT `/api/admin/report-policy` - _Allow Users to Accept Reports_, and the bounds.
async fn set_policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
    Json(req): Json<Policy>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO report_policy (id, users_may, stranger_pool, keep_days, updated_ms)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET users_may = excluded.users_may,
                 stranger_pool = excluded.stranger_pool, keep_days = excluded.keep_days,
                 updated_ms = excluded.updated_ms",
            (
                i64::from(req.users_may),
                req.stranger_pool.clamp(0, 100_000),
                req.keep_days.clamp(1, 3650),
                crate::clock::now_ms(),
            ),
        )
        .await
        .context("writing the report policy")
        .map_err(AppError::Internal)?;
    policy_handler(State(state), _admin).await
}

/// GET `/api/identity/{root}/reports/settings` - this persona's Accept Reports here, and whether
/// the operator lets them.
async fn settings_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    let t = taking(&state, &root).await.map_err(AppError::Internal)?;
    let p = policy(&state).await;
    Ok(Json(serde_json::json!({
        "takes": t.takes,
        "reach": t.reach,
        "strangers": t.strangers,
        "allowed": p.users_may,
        "stranger_pool": p.stranger_pool,
        "public": public_base(&state).is_some(),
    })))
}

/// PUT `/api/identity/{root}/reports/settings`.
async fn set_settings_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<Taking>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    if req.takes && !policy(&state).await.users_may {
        return Err(AppError::Forbidden(crate::msg!(
            "reports.not-here",
            "this server's operator doesn't let people take reports here"
        )));
    }
    state
        .node_db
        .execute(
            "INSERT INTO report_takers (root, takes, reach, strangers, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (root) DO UPDATE SET takes = excluded.takes, reach = excluded.reach,
                 strangers = excluded.strangers, updated_ms = excluded.updated_ms",
            (
                root.as_str(),
                i64::from(req.takes),
                req.reach.clamp(1, 2),
                i64::from(req.strangers),
                crate::clock::now_ms(),
            ),
        )
        .await
        .context("writing who takes reports")
        .map_err(AppError::Internal)?;
    settings_handler(session, State(state), Path(root)).await
}

// ---------------------------------------------------------------------------------------------
// The queue

#[derive(Serialize, Clone)]
pub struct Queued {
    pub id: String,
    pub reporter: String,
    pub standing: String,
    pub from_node: String,
    pub target_kind: String,
    pub target: String,
    pub reason: String,
    pub child_abuse: bool,
    pub item_author: Option<String>,
    pub item_doc: Option<String>,
    pub item_title: Option<String>,
    pub item_format: Option<i64>,
    pub item_sealed: bool,
    pub item_signed_ms: Option<i64>,
    /// The reported post's words, as its author signed them, when they arrived and are words.
    pub words: Option<String>,
    /// The pictures that arrived, by hash: each at `.../picture/{hash}`.
    pub pictures: Vec<String>,
    pub received_ms: i64,
    pub status: String,
    pub proposal: Option<serde_json::Value>,
}

#[derive(Deserialize, Default)]
pub struct QueueQuery {
    /// `open` (the default: open and proposed), or `all`.
    #[serde(default)]
    pub status: Option<String>,
}

type QueueRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<i64>,
    String,
    i64,
    String,
    Option<String>,
);

/// A moderator's queue, newest first. Shared with the assistant's tools (mcp/).
pub async fn queue_of(state: &AppState, moderator: &str, all: bool) -> Result<Vec<Queued>> {
    let rows: Vec<QueueRow> = state
        .node_db
        .fetch_all(
            &format!(
                "SELECT id, reporter, standing, from_node, target_kind, target, reason, child_abuse,
                     item_author, item_doc, item_title, item_format, item_trusted_only,
                     item_signed_ms, item_hashes, received_ms, status, proposal
                 FROM reports WHERE moderator = ?1 {}
                 ORDER BY received_ms DESC LIMIT 1000",
                if all { "" } else { "AND status IN ('open', 'proposed')" }
            ),
            (moderator,),
        )
        .await
        .context("reading the report queue")?;
    let mut out = Vec::with_capacity(rows.len());
    for (
        id,
        reporter,
        standing,
        from_node,
        target_kind,
        target,
        reason,
        child_abuse,
        item_author,
        item_doc,
        item_title,
        item_format,
        item_trusted_only,
        item_signed_ms,
        item_hashes,
        received_ms,
        status,
        proposal,
    ) in rows
    {
        let arrived: Vec<(String,)> = state
            .node_db
            .fetch_all("SELECT hash FROM report_pictures WHERE report_id = ?1", (id.as_str(),))
            .await
            .context("reading a report's pictures")?;
        let arrived: Vec<String> = arrived.into_iter().map(|(h,)| h).collect();
        let named: Vec<String> = serde_json::from_str(&item_hashes).unwrap_or_default();
        let is_words = matches!(
            crate::record::documents::Format::from_wire(item_format.map(|f| f as u64)).mime(),
            m if m.starts_with("text/")
        );
        let mut words = None;
        let mut pictures = Vec::new();
        for (i, hash) in named.iter().enumerate() {
            if !arrived.contains(hash) {
                continue;
            }
            // The body of a post of words is its words; everything else is a picture.
            if i == 0 && is_words {
                if let Some(b) = hex::decode(hash).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()) {
                    if let Ok(Some(bytes)) =
                        state.files.get_public(iroh_blobs::Hash::from_bytes(b)).await
                    {
                        words = Some(
                            String::from_utf8_lossy(&bytes).chars().take(WORDS_SHOWN).collect(),
                        );
                    }
                }
            } else {
                pictures.push(hash.clone());
            }
        }
        out.push(Queued {
            id,
            reporter,
            standing,
            from_node,
            target_kind,
            target,
            reason,
            child_abuse: child_abuse != 0,
            item_author,
            item_doc,
            item_title,
            item_format,
            item_sealed: item_trusted_only.unwrap_or(0) != 0,
            item_signed_ms,
            words,
            pictures,
            received_ms,
            status,
            proposal: proposal.and_then(|p| serde_json::from_str(&p).ok()),
        });
    }
    Ok(out)
}

/// GET `/api/identity/{root}/reports` - the queue, and how it groups by the node that knocked.
async fn queue_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(q): Query<QueueQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    let reports = queue_of(&state, &root, q.status.as_deref() == Some("all"))
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "reports": reports, "groups": groups(&reports) })))
}

/// "9,800 reports from 9,800 personas on node X": the queue counted by the node that knocked,
/// biggest first.
pub fn groups(reports: &[Queued]) -> Vec<serde_json::Value> {
    let mut by: BTreeMap<&str, (usize, std::collections::BTreeSet<&str>, i64)> = BTreeMap::new();
    for r in reports.iter().filter(|r| r.status == "open" || r.status == "proposed") {
        let e = by.entry(r.from_node.as_str()).or_insert((0, Default::default(), i64::MAX));
        e.0 += 1;
        e.1.insert(r.reporter.as_str());
        e.2 = e.2.min(r.received_ms);
    }
    let mut out: Vec<_> = by
        .into_iter()
        .map(|(node, (reports, reporters, since))| {
            serde_json::json!({
                "node": node,
                "reports": reports,
                "reporters": reporters.len(),
                "since_ms": since,
            })
        })
        .collect();
    out.sort_by_key(|g| std::cmp::Reverse(g["reports"].as_u64().unwrap_or(0)));
    out
}

async fn report_of(state: &AppState, moderator: &str, id: &str) -> Result<Queued, AppError> {
    queue_of(state, moderator, true)
        .await
        .map_err(AppError::Internal)?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| {
            AppError::NotFound(crate::msg!("reports.no-such-report", "no such report here"))
        })
}

async fn decide(state: &AppState, id: &str, status: &str, proposal: Option<String>) -> Result<()> {
    state
        .node_db
        .execute(
            "UPDATE reports SET status = ?2, decided_ms = ?3, proposal = ?4 WHERE id = ?1",
            (id, status, crate::clock::now_ms(), proposal),
        )
        .await
        .context("deciding a report")?;
    Ok(())
}

/// Dismiss one report. Shared with the assistant's tools: dismissing harms nobody.
pub async fn dismiss(state: &AppState, moderator: &str, id: &str) -> Result<(), AppError> {
    report_of(state, moderator, id).await?;
    decide(state, id, "dismissed", None).await.map_err(AppError::Internal)
}

async fn dismiss_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    dismiss(&state, &root, &id).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(Deserialize)]
pub struct EntryReq {
    pub level: String,
    #[serde(default)]
    pub reason: String,
}

/// List the report's target on the moderator's own public list - a person's tap, never an
/// assistant's.
async fn list_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
    Json(req): Json<EntryReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let report = report_of(&state, &root, &id).await?;
    let kind = ModerationTarget::from_word(&report.target_kind)
        .ok_or_else(|| AppError::Internal(anyhow!("a report kept an unknown kind")))?;
    let level = ModerationLevel::from_word(&req.level).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("moderation.unknown-level", "block or warn"))
    })?;
    let target = hex_fixed::<32>(&report.target, "target")?;
    if kind == ModerationTarget::Persona && report.target == root {
        return Err(AppError::BadRequest(crate::msg!(
            "moderation.not-yourself",
            "you can't put yourself on your own list"
        )));
    }
    data.moderation().say(kind, &target, level, req.reason.trim(), true, None).await?;
    crate::fold::fold_now(&state, &root).await;
    decide(&state, &id, "listed", None).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// Propose an entry for the report - what an assistant may do. It waits in the queue for the
/// moderator's own tap.
pub async fn propose(
    state: &AppState,
    moderator: &str,
    id: &str,
    level: &str,
    reason: &str,
) -> Result<(), AppError> {
    report_of(state, moderator, id).await?;
    if ModerationLevel::from_word(level).is_none() {
        return Err(AppError::BadRequest(crate::msg!("moderation.unknown-level", "block or warn")));
    }
    let reason: String = reason.trim().to_string();
    if reason.len() > ringtome_proto::report::MAX_REPORT_REASON_BYTES {
        return Err(AppError::BadRequest(crate::msg!(
            "record.imaol.moderation-reason-too-long",
            "that reason is too long - 512 bytes at most"
        )));
    }
    let proposal = serde_json::json!({ "level": level, "reason": reason }).to_string();
    decide(state, id, "proposed", Some(proposal)).await.map_err(AppError::Internal)
}

async fn propose_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
    Json(req): Json<EntryReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    propose(&state, &root, &id, &req.level, &req.reason).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// An administrator quarantines what a report names (quarantine.rs) - for a child-abuse report
/// that didn't seal it at the door, or anything else they judge belongs there.
async fn quarantine_handler(
    session: Session,
    admin: crate::auth::NodeAdminSession,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    let report = report_of(&state, &root, &id).await?;
    let (Some(author), Some(doc)) = (&report.item_author, &report.item_doc) else {
        return Err(AppError::BadRequest(crate::msg!(
            "reports.names-no-files",
            "this report names no files"
        )));
    };
    let author = hex_fixed::<32>(author, "author")?;
    let doc = hex_fixed::<16>(doc, "doc")?;
    let row: Option<(String,)> = state
        .node_db
        .fetch_optional("SELECT item_hashes FROM reports WHERE id = ?1", (id.as_str(),))
        .await
        .map_err(AppError::Internal)?;
    let named: Vec<String> = row.and_then(|(h,)| serde_json::from_str(&h).ok()).unwrap_or_default();
    let hashes: Vec<[u8; 32]> =
        named.iter().filter_map(|h| hex::decode(h).ok()?.try_into().ok()).collect();
    crate::quarantine::seal(
        &state,
        &hashes,
        Some((author, doc)),
        &format!("from a report: {}", report.reason),
        &admin.account.id.to_string(),
    )
    .await
    .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "ok": true, "sealed": hashes.len() })))
}

/// GET a picture that arrived for a report - the moderator's own, and nobody else's.
async fn picture_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, id, hash)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    let _ = store::open(&state, &session.account.id, &root).await?;
    let report = report_of(&state, &root, &id).await?;
    if !report.pictures.contains(&hash) {
        return Err(AppError::NotFound(crate::msg!("reports.no-such-picture", "no such picture")));
    }
    let bytes = hex_fixed::<32>(&hash, "hash")?;
    let Some(body) = state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(bytes))
        .await
        .map_err(AppError::Internal)?
    else {
        return Err(AppError::NotFound(crate::msg!(
            "quarantine.removed-here",
            "removed by this server's operator"
        )));
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/avif"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "private, no-store"),
        ],
        body,
    )
        .into_response())
}

#[derive(Deserialize)]
struct DropReq {
    /// Also put the node on the moderator's list, at block.
    #[serde(default)]
    block: bool,
    #[serde(default)]
    reason: String,
}

/// "Block node X and drop these": every open report from one knocking node, dismissed at once.
async fn drop_node_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, node)): Path<(String, String)>,
    Json(req): Json<DropReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let dropped = state
        .node_db
        .execute(
            "UPDATE reports SET status = 'dismissed', decided_ms = ?3
             WHERE moderator = ?1 AND from_node = ?2 AND status IN ('open', 'proposed')",
            (root.as_str(), node.as_str(), crate::clock::now_ms()),
        )
        .await
        .context("dropping a node's reports")
        .map_err(AppError::Internal)?;
    if req.block {
        let endpoint = hex_fixed::<32>(&node, "node")?;
        data.moderation()
            .say(
                ModerationTarget::Node,
                &endpoint,
                ModerationLevel::Block,
                req.reason.trim(),
                true,
                None,
            )
            .await?;
        crate::fold::fold_now(&state, &root).await;
    }
    Ok(Json(serde_json::json!({ "ok": true, "dropped": dropped })))
}
