//! Moderation lists (plans/MODERATION.md, 2026-11-02): what a persona says about sources -
//! block or warn, with a reason - and what a reader takes from the people they trust to
//! moderate for them.
//!
//! - **A list** is the persona's `MODERATION_PUBLIC` chain, folded per persona into their user
//!   database's `moderation_entries` (record/imaol.rs) - newest statement per target wins.
//! - **The memo** (`moderation_said`, node.db) copies every held persona's present entries,
//!   reconciled whole whenever their chain moves (the fold lane's leg, fold.rs). A list is
//!   small, so a whole pass beats keeping marks.
//! - **What a reader takes** is their own entries plus those of the contacts they ticked
//!   `moderates` - one hop, never what those people take in turn (ruling 5) - minus their own
//!   overrules (`moderation_overrules`, a private set: ruling 6). Where sources disagree, block
//!   beats warn; every source and reason is kept for the settings view.
//!
//! - **Pictures** (plans/SCANNING.md, _Community picture entries_): an entry names a public
//!   picture by its blob's hash and carries its PDQ fingerprint (prints.rs). The same file - the
//!   hash, or the document whose body or thumbnail it is - acts at the entry's level; a picture
//!   that only fingerprints near it is warned about and never more, because a perceptual hash can
//!   be collided on purpose (someone makes pornography that prints like a popular drawing,
//!   reports it, and the drawing is blocked everywhere in good faith). Worked out for the cards on
//!   a reader's screen ([`verdicts_handler`]), never stamped onto posts.
//!
//! - **What the node refuses** (plans/MODERATION.md, _What the levels do_): the block-level
//!   entries its administrators' personas take, as administrators. A refused node is never
//!   dialled or answered (net/p2p.rs); a refused persona is never synced, fetched, shelved or
//!   answered for, and what this node already held of them goes (`eviction::evict_one`, the
//!   feed journal) - a block is retroactive (Curtis, 2026-11-01: "clear this person off my
//!   network"). The node's own users are never refused: their accounts are the operator's to
//!   remove, not to starve. A blocked picture - by exact hash only - is refused at every door a
//!   quarantined one is, and not kept (`files::FileStore::withhold`, the reaper). On a device
//!   node the person and the operator are the same, so their lists decide both.
//!
//! Owns the `moderation_said` SQL (tests/conventions.rs).

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result};
use axum::extract::{Path, State};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use ringtome_proto::{ModerationLevel, ModerationTarget};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::identity::routes::hex_fixed;
use crate::record::store;
use crate::AppState;

/// The private set of entries this reader overrules ("I'll judge this myself"), as
/// `<kind>:<target hex>`.
pub const OVERRULES: &str = "moderation_overrules";
/// The contact fact: "I trust this person to moderate for me".
pub const MODERATES: &str = "moderates";
/// The private set of posts this reader hid - what a report does first, on the reporter's own
/// devices, before anything is sent (plans/MODERATION.md, _Reports_ 1) - as `<author>:<doc>`.
pub const HIDDEN: &str = "hidden_posts";

/// What this node refuses, held in memory for the doors that ask on every connection and every
/// exchange: personas by root and nodes by endpoint id, hex.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Refused {
    personas: BTreeSet<String>,
    nodes: BTreeSet<String>,
    pictures: BTreeSet<String>,
}

static REFUSED: std::sync::LazyLock<std::sync::RwLock<Refused>> =
    std::sync::LazyLock::new(Default::default);
/// One recomputation at a time: two racing would each evict from their own view.
static RECOMPUTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Does this node refuse the persona? (Root, hex.)
pub fn refuses_persona(root_hex: &str) -> bool {
    REFUSED.read().map(|r| r.personas.contains(root_hex)).unwrap_or(false)
}

/// Does this node refuse the node? (Endpoint id, as raw bytes.)
pub fn refuses_node(endpoint: &[u8; 32]) -> bool {
    REFUSED.read().map(|r| r.nodes.contains(&hex::encode(endpoint))).unwrap_or(false)
}

/// Work out again what the node refuses - at boot, when a list moves, when an administrator
/// changes whose lists they take - and clear out what a newly refused persona left here.
pub async fn recompute(state: &AppState) {
    if let Err(e) = recompute_inner(state).await {
        tracing::warn!(error = ?e, "could not work out what this node's moderation refuses");
    }
}

/// The personas of this node's administrators' accounts: what they take, as administrators, the
/// node refuses (and reports.rs lets a child-abuse report to them seal its pictures here).
pub async fn administrator_roots(state: &AppState) -> Result<BTreeSet<String>> {
    let mut accounts: BTreeSet<uuid::Uuid> = BTreeSet::new();
    for tag in [crate::auth::TAG_NODE_ADMIN, crate::auth::TAG_ADMIN] {
        let tagged = crate::auth::accounts_tagged(&state.node_db, tag)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        accounts.extend(tagged);
    }
    let mut admins: BTreeSet<String> = BTreeSet::new();
    for account in &accounts {
        let personas = crate::identity::list_for_account(&state.node_db, account)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        admins.extend(personas.into_iter().map(|i| i.root_pubkey));
    }
    Ok(admins)
}

async fn recompute_inner(state: &AppState) -> Result<()> {
    let _one = RECOMPUTING.lock().await;
    let admins = administrator_roots(state).await?;
    let mut next = Refused::default();
    for root in admins {
        let data = match store::open_agented(state, &root).await {
            Ok(data) => data,
            Err(e) => {
                tracing::debug!(root = %root, error = ?e, "an administrator's persona did not open");
                continue;
            }
        };
        let (_, _, taken) =
            view_of(state, &data, &root).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        for t in taken.into_iter().filter(|t| t.level == "block" && !t.overruled) {
            match t.kind {
                "persona" => next.personas.insert(t.target),
                "picture" => next.pictures.insert(t.target),
                _ => next.nodes.insert(t.target),
            };
        }
    }
    // The node's own users are the operator's to remove, never to starve.
    let mut own = BTreeSet::new();
    for root in &next.personas {
        if crate::identity::is_agented(&state.node_db, root).await.unwrap_or(true) {
            own.insert(root.clone());
        }
    }
    next.personas.retain(|r| !own.contains(r));
    let before = REFUSED.read().map(|r| r.clone()).unwrap_or_default();
    if before == next {
        return Ok(());
    }
    let newly: Vec<String> = next.personas.difference(&before.personas).cloned().collect();
    tracing::info!(
        personas = next.personas.len(),
        nodes = next.nodes.len(),
        pictures = next.pictures.len(),
        newly = newly.len(),
        "this node's moderation refusals moved"
    );
    state.files.withhold(
        next.pictures
            .iter()
            .filter_map(|h| hex::decode(h).ok()?.try_into().ok())
            .map(iroh_blobs::Hash::from_bytes)
            .collect(),
    );
    if let Ok(mut r) = REFUSED.write() {
        *r = next;
    }
    for root in newly {
        clear_out(state, &root).await;
    }
    Ok(())
}

/// A newly refused persona: everything this node held of them goes, through each table's owner.
async fn clear_out(state: &AppState, root: &str) {
    if let Err(e) = crate::eviction::evict_one(state, root).await {
        tracing::warn!(root = %root, error = ?e, "could not evict a refused persona");
    }
    if let Err(e) = crate::fanout::excise_author(&state.node_db, root).await {
        tracing::warn!(root = %root, error = ?e, "could not excise a refused persona's posts");
    }
    if let Err(e) = crate::fragments::forget_author(&state.node_db, root).await {
        tracing::warn!(root = %root, error = ?e, "could not drop a refused persona's fragments");
    }
    tracing::info!(root = %root, "cleared a refused persona off this node");
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/identity/{root}/moderation", get(moderation_handler))
        .route(
            "/api/identity/{root}/moderation/{kind}/{target}",
            put(entry_put_handler).delete(entry_delete_handler),
        )
        .route("/api/identity/{root}/moderation/by-address", post(by_address_handler))
        .route("/api/identity/{root}/moderation/verdicts", post(verdicts_handler))
}

/// The fold-lane hook: copy one persona's present entries into the memo.
pub async fn refresh_from(state: &AppState, author: &str, _force: bool) {
    if let Err(e) = refresh_inner(state, author).await {
        tracing::debug!(author = %author, error = ?e, "moderation memo refresh failed");
    }
    recompute(state).await;
}

async fn refresh_inner(state: &AppState, author: &str) -> Result<()> {
    let Ok(Some(db)) = state.user_dbs.get(author).await else {
        return Ok(());
    };
    let rows =
        crate::record::imaol::moderation_entries(&db).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(db);
    // Upsert what's present, then drop what no longer is. No transaction - the node connection
    // is shared - so a reader in between may briefly see an entry that is on its way out.
    let present: BTreeSet<(i64, String)> = rows
        .iter()
        .filter(|r| r.present)
        .map(|r| (r.kind.code() as i64, r.target.clone()))
        .collect();
    for r in rows.iter().filter(|r| r.present) {
        state
            .node_db
            .execute(
                "INSERT INTO moderation_said (author, target_kind, target, level, reason, said_ms, pdq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (author, target_kind, target) DO UPDATE SET
                   level = excluded.level, reason = excluded.reason, said_ms = excluded.said_ms,
                   pdq = excluded.pdq",
                (
                    author,
                    r.kind.code() as i64,
                    r.target.as_str(),
                    r.level.code() as i64,
                    r.reason.as_str(),
                    r.timestamp_ms,
                    r.pdq.as_deref(),
                ),
            )
            .await
            .context("noting a moderation entry")?;
    }
    let held: Vec<(i64, String)> = state
        .node_db
        .fetch_all("SELECT target_kind, target FROM moderation_said WHERE author = ?1", (author,))
        .await
        .context("reading a moderation list")?;
    for (kind, target) in held {
        if !present.contains(&(kind, target.clone())) {
            state
                .node_db
                .execute(
                    "DELETE FROM moderation_said WHERE author = ?1 AND target_kind = ?2 AND target = ?3",
                    (author, kind, target.as_str()),
                )
                .await
                .context("forgetting a moderation entry")?;
        }
    }
    Ok(())
}

/// One source's word about a target.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Said {
    pub author: String,
    pub level: &'static str,
    pub reason: String,
    pub said_ms: i64,
}

/// One target, as the reader takes it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Taken {
    pub kind: &'static str,
    pub target: String,
    /// The strongest level among the sources: block beats warn.
    pub level: &'static str,
    /// The reader overruled it: shown in settings, ignored everywhere else.
    pub overruled: bool,
    pub sources: Vec<Said>,
    /// A picture's fingerprint, hex: the same picture prints the same for every source.
    pub pdq: Option<String>,
}

/// One row of what someone said: author, kind, target, level, reason, when, fingerprint.
pub type SaidRow = (String, i64, String, i64, String, i64, Option<String>);

/// Fold what the reader takes (pure: the test lives below). `said` is every row from the
/// reader and their moderators; `overrules` the `<kind>:<target>` set.
pub fn fold_taken(said: Vec<SaidRow>, overrules: &BTreeSet<String>) -> Vec<Taken> {
    type Sources = (Vec<(ModerationLevel, Said)>, Option<String>);
    let mut by_target: BTreeMap<(i64, String), Sources> = BTreeMap::new();
    for (author, kind, target, level, reason, said_ms, pdq) in said {
        let Some(level) = ModerationLevel::from_code(level as u64) else {
            continue;
        };
        let (sources, print) = by_target.entry((kind, target)).or_default();
        sources.push((level, Said { author, level: level.word(), reason, said_ms }));
        if print.is_none() {
            *print = pdq;
        }
    }
    by_target
        .into_iter()
        .filter_map(|((kind, target), (mut sources, pdq))| {
            let kind = ModerationTarget::from_code(kind as u64)?;
            let level = sources.iter().map(|(l, _)| *l).max()?;
            sources.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.said_ms.cmp(&a.1.said_ms)));
            Some(Taken {
                kind: kind.word(),
                overruled: overrules.contains(&format!("{}:{target}", kind.word())),
                target,
                level: level.word(),
                sources: sources.into_iter().map(|(_, s)| s).collect(),
                pdq,
            })
        })
        .collect()
}

#[derive(Serialize)]
pub(crate) struct MineRow {
    kind: &'static str,
    target: String,
    level: &'static str,
    reason: String,
    said_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pdq: Option<String>,
    /// A picture entry's sketch, as a `data:` URL - only in the keeper's own view (sketches.rs).
    #[serde(skip_serializing_if = "Option::is_none")]
    sketch: Option<String>,
    /// A persona entry this server hosts - said only to its administrator, whose block doesn't
    /// touch the server's own users (Curtis, 2026-11-06: the way to their account instead).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    hosted_here: bool,
}

#[derive(Serialize)]
struct ModerationView {
    /// This persona's own public list.
    mine: Vec<MineRow>,
    /// The contacts this persona trusts to moderate for it.
    moderators: Vec<String>,
    /// Everything taken: own entries and the moderators', folded per target.
    taken: Vec<Taken>,
    /// This persona's account administers the node, so what it blocks the node refuses.
    administers: bool,
    /// The posts this persona hid, `<author>:<doc>`.
    hidden: Vec<String>,
}

/// GET - the persona's own list, whose lists it takes, and what it takes from them.
async fn moderation_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<ModerationView>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (mut mine, moderators, taken) = view_of(&state, &data, &root).await?;
    let mut sketches = crate::sketches::of(&state, &root).await.map_err(AppError::Internal)?;
    for row in mine.iter_mut().filter(|r| r.kind == ModerationTarget::Picture.word()) {
        row.sketch = sketches.remove(&row.target).map(|png| {
            use base64::Engine as _;
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            )
        });
    }
    let mut administers = false;
    for tag in [crate::auth::TAG_NODE_ADMIN, crate::auth::TAG_ADMIN] {
        administers |= crate::auth::has_tag(&state.node_db, &session.account.id, tag).await?;
    }
    if administers {
        let hosted: BTreeSet<String> = crate::identity::hosted_roots_with_accounts(&state.node_db)
            .await?
            .into_iter()
            .map(|(root, _)| root)
            .collect();
        for row in mine.iter_mut().filter(|r| r.kind == ModerationTarget::Persona.word()) {
            row.hosted_here = hosted.contains(&row.target);
        }
    }
    let (hidden, _) = data.private_set(HIDDEN).elements().await?;
    let hidden = hidden.into_iter().map(|e| e.element).collect();
    Ok(Json(ModerationView { mine, moderators, taken, administers, hidden }))
}

/// One persona's own list, whose lists it takes, and what it takes from them.
pub(crate) async fn view_of(
    state: &AppState,
    data: &store::Store,
    root: &str,
) -> Result<(Vec<MineRow>, Vec<String>, Vec<Taken>), AppError> {
    let mine: Vec<MineRow> = data
        .moderation()
        .all()
        .await?
        .into_iter()
        .filter(|r| r.present)
        .map(|r| MineRow {
            kind: r.kind.word(),
            target: r.target,
            level: r.level.word(),
            reason: r.reason,
            said_ms: r.timestamp_ms,
            pdq: r.pdq,
            sketch: None,
            hosted_here: false,
        })
        .collect();
    let moderators: Vec<String> = data
        .contacts()
        .await?
        .into_iter()
        .filter(|(_, facts)| {
            facts.get(MODERATES).map(String::as_str) == Some("yes")
                && facts.get("blocked").map(String::as_str) != Some("yes")
        })
        .map(|(root, _)| root)
        .collect();
    let (elements, _) = data.private_set(OVERRULES).elements().await?;
    let overrules: BTreeSet<String> = elements.into_iter().map(|e| e.element).collect();

    let mut said: Vec<SaidRow> = mine
        .iter()
        .map(|m| {
            let kind = ModerationTarget::from_word(m.kind).map(|k| k.code() as i64).unwrap_or(0);
            let level = ModerationLevel::from_word(m.level).map(|l| l.code() as i64).unwrap_or(0);
            let (target, reason) = (m.target.clone(), m.reason.clone());
            (root.to_string(), kind, target, level, reason, m.said_ms, m.pdq.clone())
        })
        .collect();
    for moderator in &moderators {
        let rows: Vec<SaidRow> = state
            .node_db
            .fetch_all(
                "SELECT author, target_kind, target, level, reason, said_ms, pdq
                 FROM moderation_said WHERE author = ?1",
                (moderator.as_str(),),
            )
            .await
            .map_err(AppError::Internal)?;
        said.extend(rows);
    }
    Ok((mine, moderators, fold_taken(said, &overrules)))
}

#[derive(Deserialize)]
struct EntryPut {
    level: String,
    #[serde(default)]
    reason: String,
}

fn parse_target(kind: &str, target: &str) -> Result<(ModerationTarget, [u8; 32]), AppError> {
    let kind = ModerationTarget::from_word(kind).ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "moderation.unknown-kind",
            "a list names a persona or a node"
        ))
    })?;
    Ok((kind, hex_fixed::<32>(target, "target")?))
}

/// PUT - put a target on this persona's public list, or change its level or reason.
async fn entry_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, kind, target)): Path<(String, String, String)>,
    Json(req): Json<EntryPut>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (kind, key) = parse_target(&kind, &target)?;
    let level = ModerationLevel::from_word(&req.level).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("moderation.unknown-level", "block or warn"))
    })?;
    if kind == ModerationTarget::Persona && hex::encode(key) == root {
        return Err(AppError::BadRequest(crate::msg!(
            "moderation.not-yourself",
            "you can't put yourself on your own list"
        )));
    }
    let pdq =
        if kind == ModerationTarget::Picture { picture_print(&state, &key).await? } else { None };
    if kind == ModerationTarget::Picture {
        crate::sketches::keep(&state, &root, &key).await;
    }
    data.moderation().say(kind, &key, level, req.reason.trim(), true, pdq).await?;
    crate::fold::fold_now(&state, &root).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

/// What a picture entry carries beside the hash: its fingerprint, when it has a usable one. The
/// picture has to be here: an entry is written about something its author has seen.
pub(crate) async fn picture_print(
    state: &AppState,
    hash: &[u8; 32],
) -> Result<Option<[u8; 32]>, AppError> {
    if let Some(print) = crate::prints::of(state, hash).await {
        return Ok(print.usable().then_some(print.hash));
    }
    if state.files.has(iroh_blobs::Hash::from_bytes(*hash)).await {
        return Ok(None); // here, but not a picture we can print: listed by its hash alone
    }
    Err(AppError::NotFound(crate::msg!(
        "moderation.picture-not-here",
        "this server doesn't hold that picture"
    )))
}

#[derive(Deserialize)]
struct ByAddress {
    address: String,
    level: String,
    #[serde(default)]
    reason: String,
}

/// POST `/api/identity/{root}/moderation/by-address` - put a picture on this persona's public
/// list by its address as anyone copies it (the body, the thumbnail, the post): the entry names
/// the document's body, or for a post with pictures in it, each picture's. A post's words are no
/// picture.
async fn by_address_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<ByAddress>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let level = ModerationLevel::from_word(&req.level).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("moderation.unknown-level", "block or warn"))
    })?;
    let not_a_picture = || {
        AppError::BadRequest(crate::msg!(
            "moderation.not-a-picture-address",
            "that isn't the address of a picture this server holds"
        ))
    };
    let (author, doc) =
        crate::quarantine::picture_address(&req.address).ok_or_else(not_a_picture)?;
    let embedded =
        crate::quarantine::embeds(&state, &author, &doc).await.map_err(AppError::Internal)?;
    let documents = if embedded.is_empty() { vec![doc] } else { embedded };
    let mut bodies = Vec::new();
    for document in &documents {
        let blobs = crate::quarantine::own_blobs(&state, &author, document)
            .await
            .map_err(AppError::Internal)?;
        bodies.extend(blobs.first().copied());
    }
    let first = *bodies.first().ok_or_else(not_a_picture)?;
    for body in &bodies {
        let pdq = picture_print(&state, body).await?;
        crate::sketches::keep(&state, &root, body).await;
        data.moderation()
            .say(ModerationTarget::Picture, body, level, req.reason.trim(), true, pdq)
            .await?;
    }
    crate::fold::fold_now(&state, &root).await;
    Ok(Json(serde_json::json!({ "ok": true, "hash": hex::encode(first) })))
}

/// The most addresses one verdicts call answers: a page of cards.
const MAX_VERDICTS: usize = 64;

#[derive(Deserialize)]
struct VerdictsReq {
    pictures: Vec<String>,
}

/// One picture's verdict, as its card meets it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Verdict {
    pub level: &'static str,
    pub reason: String,
    /// Only like a listed picture, by fingerprint: always `warn`, whatever the entry says.
    pub near: bool,
    pub sources: Vec<Said>,
}

/// The verdict for one picture (pure: the test lives below) - its blobs' hashes, the body's
/// fingerprint, and the picture entries the reader takes. An exact match acts at its level and
/// beats any near one; a near match only warns.
pub fn verdict_for(
    blobs: &[String],
    print: Option<&[u8; 32]>,
    entries: &[&Taken],
) -> Option<Verdict> {
    let reason_of = |t: &Taken| {
        t.sources
            .iter()
            .find(|s| s.level == t.level && !s.reason.is_empty())
            .map(|s| s.reason.clone())
    };
    let exact = entries
        .iter()
        .filter(|t| blobs.contains(&t.target))
        .max_by_key(|t| ModerationLevel::from_word(t.level));
    if let Some(t) = exact {
        return Some(Verdict {
            level: t.level,
            reason: reason_of(t).unwrap_or_default(),
            near: false,
            sources: t.sources.clone(),
        });
    }
    let print = print?;
    let near = entries.iter().find(|t| {
        t.pdq.as_deref().and_then(|h| hex::decode(h).ok()?.try_into().ok()).is_some_and(
            |p: [u8; 32]| {
                crate::media::pdq::distance(print, &p) <= crate::media::pdq::MATCH_DISTANCE
            },
        )
    })?;
    Some(Verdict {
        level: ModerationLevel::Warn.word(),
        reason: reason_of(near).unwrap_or_default(),
        near: true,
        sources: near.sources.clone(),
    })
}

/// POST `/api/identity/{root}/moderation/verdicts` - for the pictures on a reader's screen, by
/// address: which the picture entries they take reach, and how. Nothing at all while they take
/// none, so a reader without picture entries costs no decoding.
async fn verdicts_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<VerdictsReq>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (_, _, taken) = view_of(&state, &data, &root).await?;
    drop(data);
    let entries: Vec<&Taken> =
        taken.iter().filter(|t| t.kind == "picture" && !t.overruled).collect();
    let mut verdicts = serde_json::Map::new();
    if entries.is_empty() {
        return Ok(Json(serde_json::json!({ "verdicts": verdicts })));
    }
    let wants_print = entries.iter().any(|t| t.pdq.is_some());
    let addresses: BTreeSet<String> = req.pictures.into_iter().take(MAX_VERDICTS).collect();
    for address in addresses {
        let Some((author, doc)) = crate::quarantine::picture_address(&address) else {
            continue;
        };
        let blobs =
            crate::quarantine::blobs_of(&state, &author, &doc).await.map_err(AppError::Internal)?;
        let Some(body) = blobs.first().copied() else { continue };
        let hexes: Vec<String> = blobs.iter().map(hex::encode).collect();
        let print = if wants_print && !entries.iter().any(|t| hexes.contains(&t.target)) {
            crate::prints::of(&state, &body).await.filter(|p| p.usable()).map(|p| p.hash)
        } else {
            None
        };
        if let Some(v) = verdict_for(&hexes, print.as_ref(), &entries) {
            verdicts.insert(
                address,
                serde_json::to_value(v).map_err(|e| AppError::Internal(e.into()))?,
            );
        }
    }
    Ok(Json(serde_json::json!({ "verdicts": verdicts })))
}

/// DELETE - take a target off this persona's public list.
async fn entry_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, kind, target)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (kind, key) = parse_target(&kind, &target)?;
    data.moderation().say(kind, &key, ModerationLevel::Warn, "", false, None).await?;
    if kind == ModerationTarget::Picture {
        crate::sketches::forget(&state, &root, &key).await.map_err(AppError::Internal)?;
    }
    crate::fold::fold_now(&state, &root).await;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(author: &str, target: &str, level: i64, reason: &str, at: i64) -> SaidRow {
        (author.into(), 0, target.into(), level, reason.into(), at, None)
    }

    #[test]
    fn block_beats_warn_and_every_source_is_kept() {
        let taken = fold_taken(
            vec![row("rache", "aa", 0, "rude", 1), row("official", "aa", 1, "court order", 2)],
            &BTreeSet::new(),
        );
        assert_eq!(taken.len(), 1);
        assert_eq!(taken[0].level, "block");
        assert_eq!(taken[0].sources.len(), 2, "both reasons stay readable");
        assert_eq!(taken[0].sources[0].author, "official", "the strongest first");
        assert!(!taken[0].overruled);
    }

    #[test]
    fn an_overrule_marks_the_target_and_keeps_it_listed() {
        let overrules: BTreeSet<String> = ["persona:aa".to_string()].into();
        let taken = fold_taken(
            vec![row("rache", "aa", 1, "", 1), row("rache", "bb", 0, "", 1)],
            &overrules,
        );
        let aa = taken.iter().find(|t| t.target == "aa").unwrap();
        let bb = taken.iter().find(|t| t.target == "bb").unwrap();
        assert!(aa.overruled, "the reader's word is the last word");
        assert!(!bb.overruled);
    }

    fn picture(target: &str, level: &'static str, pdq: Option<[u8; 32]>) -> Taken {
        Taken {
            kind: "picture",
            target: target.into(),
            level,
            overruled: false,
            sources: vec![Said {
                author: "rache".into(),
                level,
                reason: "not on my network".into(),
                said_ms: 1,
            }],
            pdq: pdq.map(hex::encode),
        }
    }

    #[test]
    fn the_same_file_acts_at_its_level_and_a_lookalike_only_warns() {
        let print = [0b1010_1010u8; 32];
        let blocked = picture("aa", "block", Some(print));
        let entries = vec![&blocked];
        let same = verdict_for(&["aa".into(), "th".into()], None, &entries).unwrap();
        assert_eq!((same.level, same.near), ("block", false), "the hash itself: the entry's level");
        let thumb = verdict_for(&["zz".into(), "aa".into()], None, &entries).unwrap();
        assert_eq!(thumb.level, "block", "a document whose thumbnail is listed");

        let mut close = print;
        close[0] ^= 0xFF; // 8 bits off: a re-encode
        let alike = verdict_for(&["bb".into()], Some(&close), &entries).unwrap();
        assert_eq!((alike.level, alike.near), ("warn", true), "a block, near: only ever warned");
        assert_eq!(alike.reason, "not on my network");

        let mut far = print;
        for b in far.iter_mut().take(5) {
            *b ^= 0xFF; // 40 bits off: another picture
        }
        assert!(verdict_for(&["bb".into()], Some(&far), &entries).is_none());
        assert!(verdict_for(&["bb".into()], None, &entries).is_none(), "no print, no near match");
    }
}
