//! The `/id/<root>` surface (PROJECT_PLAN, Addressing: "The prefix gets its name") - one URL,
//! two audiences, and the split that keeps both simple: **a session gets the SPA, anonymity
//! gets a server-rendered face.** The browser app stays session-only (its whole substrate -
//! mirror, stream, lens - assumes one); the anonymous face is deliberately tiny, static HTML
//! with hardened headers, because the stranger-facing surface should have as little machinery
//! behind it as possible.
//!
//! The anonymous rungs shipped here (Moderation, The Web Gateway):
//!   - **shelf**: a root this node hosts -> its public profile (name, bio - the public lane).
//!   - **tombstone, warmly**: a root not carried -> an honest dead end with directions.
//!   - **checksum refusal**: worded address whose words lie -> refused loudly, with the true
//!     words in hand ("did you mean").
//!
//! The **signpost** rung waits on serving records carrying public web URLs; the fetch-and-serve
//! behavior for members waits on the resolution ladder. Both are NEXT_STEPS' next bricks, not
//! forgotten scope.

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::imaol;
use crate::speakable::{self, Parsed};
use crate::AppState;

/// Escape untrusted text into HTML body/attribute position. The profile is user-authored;
/// the face renders nothing unescaped.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The anonymous face's response envelope: plain HTML under the hardened serving headers
/// (the gateway posture, applied from the first byte this surface ever serves - validated
/// type, nosniff, a CSP that permits our own inline style and nothing else).
fn face(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
            ),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
        .into_response()
}

/// The shared page skeleton: system fonts, one card, no scripts, no fetches.
fn page(title: &str, card: String) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #f6f2ea; color: #2d2a26;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; }}
  .card {{ max-width: 34rem; margin: 2rem; padding: 2rem 2.2rem; background: #fffdf8;
          border: 1px solid #e0d8c8; border-radius: 14px; }}
  .chip {{ display: inline-block; width: 0.9em; height: 0.9em; border-radius: 50%;
          margin-right: 0.45rem; vertical-align: baseline; }}
  .avatar {{ width: 4.5rem; height: 4.5rem; border-radius: 12px; object-fit: cover;
            display: block; margin-bottom: 0.8rem; border: 1px solid #e0d8c8;
            overflow: hidden; }}
  .avatar svg {{ width: 100%; height: 100%; display: block; }}
  h1 {{ font-size: 1.35rem; margin: 0 0 0.2rem; }}
  .words {{ color: #8a7f6e; font-size: 0.9rem; margin: 0 0 1rem; }}
  .bio {{ white-space: pre-wrap; }}
  .addr {{ font-family: ui-monospace, monospace; font-size: 0.78rem; word-break: break-all;
          background: #f2ecdf; border-radius: 8px; padding: 0.6rem 0.8rem; }}
  .foot {{ color: #8a7f6e; font-size: 0.8rem; margin-top: 1.4rem; }}
  a {{ color: #2a7f78; }}
</style>
</head>
<body><div class="card">{card}</div></body>
</html>
"#,
        title = esc(title),
    )
}

/// The persona's colour dot beside their name - the same hue their identicon and the
/// console's heptagon ring wear (crate::identicon::hue is the one source).
fn chip(root: &[u8; 32]) -> String {
    format!(
        r#"<span class="chip" style="background: hsl({}, 60%, 55%)"></span>"#,
        crate::identicon::hue(root)
    )
}

/// Is this root hosted by any account on this node? (The shelf, v1: hosting is the only
/// demand edge that exists - member follows join it when follows do.) The identities table
/// belongs to identity.rs; this is its question, asked through its door.
async fn hosted_here(state: &AppState, root_hex: &str) -> Result<bool, AppError> {
    crate::identity::is_hosted(&state.node_db, root_hex).await
}

/// The public profile straight off the identity's own db - the public lane, no account in
/// the question. Absent fields render as absent; a profile-less persona is still a page.
async fn public_profile(state: &AppState, root_hex: &str) -> Result<Vec<imaol::ProfileField>, AppError> {
    let Some(db) = state.user_dbs.get(root_hex).await.map_err(AppError::Internal)? else {
        return Err(AppError::NotFound(crate::msg!("idface.nothing-of-theirs-is-held", "nothing of theirs is held here")));
    };
    imaol::get_profile(&db).await
}

fn profile_value<'a>(fields: &'a [imaol::ProfileField], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|f| f.field == name)
        .map(|f| f.value.as_str())
}

/// GET `/id/{seg}/{*rest}` - any deeper path under a persona. Its own handler because axum
/// extracts path params POSITIONALLY: a two-parameter route destructured as one `Path<String>`
/// is a 500, not a fallback (found 2026-08-03 by the first deep /id link the app ever
/// followed - the widget gallery). The deeper path is the SPA's business: routes under a
/// persona (their pages, the gallery) resolve in the client, so this hands back the same
/// answer the bare address does.
pub async fn idface_deep(
    session: Option<Session>,
    state: State<AppState>,
    Path((seg, _rest)): Path<(String, String)>,
) -> Result<Response, AppError> {
    idface(session, state, Path(seg)).await
}

/// GET `/id/{seg}`: the one URL, both audiences.
pub async fn idface(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
) -> Result<Response, AppError> {

    let Some(parsed) = speakable::parse(&seg) else {
        return Ok(face(
            StatusCode::NOT_FOUND,
            page(
                "not a ringtome address",
                "<h1>that's not an address</h1>\
                 <p>The path after <code>/id/</code> should be a persona's address - two words \
                 and a key, like <code>sway-broke-AwTy…</code></p>"
                    .into(),
            ),
        ));
    };

    let root = match parsed {
        Parsed::Ok(root) => root,
        Parsed::Mismatch { root, expected } => {
            // Refused loudly, with the truth in hand - lenient acceptance would train
            // everyone to ignore the words, which deletes the feature.
            let key = seg.rsplit('-').next().unwrap_or("");
            let _ = root; // the claimed root is never rendered as if it were good
            return Ok(face(
                StatusCode::BAD_REQUEST,
                page(
                    "this address arrived mangled",
                    format!(
                        "<h1>this address arrived mangled</h1>\
                         <p>The words on this address don't match its key, so something got \
                         mixed up in transit.</p>\
                         <p>Did you mean <a href=\"/id/{expected}-{key}\"><code>{expected}-{key_short}…</code></a>?</p>",
                        expected = esc(&expected),
                        key = esc(key),
                        key_short = esc(&key.chars().take(8).collect::<String>()),
                    ),
                ),
            ));
        }
    };
    let root_hex = hex::encode(root);
    let speak = speakable::speakable(&root);
    let words = speak.rsplit_once('-').map(|x| x.0).unwrap_or("").to_string();

    // A session gets the SPA - the lens is the console's job, and the app router owns /id.
    if session.is_some() {
        return Ok(crate::ui::homepage(State(state)).await.into_response());
    }

    if hosted_here(&state, &root_hex).await? {
        // The shelf: this node chose to host the persona, so its public face serves. The
        // address is the FULL shareable form - origin (when declared), `?via=` hints (this
        // node first, then the persona's liveliest peers, up to ten, base58-dressed - the
        // SPA row's rule; the wide list keeps fast-moving identities alive) - shown above
        // the bio and linked to itself, exactly as the lens shows it. No separate words
        // line: the words are the address's own prefix.
        let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
        let name = profile_value(&fields, "name").unwrap_or(&words).to_string();
        let bio = profile_value(&fields, "bio").unwrap_or("").to_string();
        // Leaves first ("hints become leaves"): our own leaf for this persona, then the
        // liveliest sibling leaves by serving-record freshness. Endpoint-id peers remain as
        // filler for rows whose leaf was never learned - the resolver tries each hint as a
        // leaf and falls back to dialing it as an endpoint, so a mixed list is fine.
        let mut via = Vec::new();
        if let Ok(Some(own_leaf)) = crate::identity::leaf_hex_of(&state.node_db, &root_hex).await {
            via.push(own_leaf);
        }
        for leaf in crate::net::sync::liveliest_leaves(&state.node_db, &root_hex, 16)
            .await
            .unwrap_or_default()
        {
            if via.len() >= 10 {
                break;
            }
            if !via.contains(&leaf) {
                via.push(leaf);
            }
        }
        if via.is_empty() {
            via.push(state.endpoint.id().to_string());
        }
        for peer in crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 16)
            .await
            .unwrap_or_default()
        {
            if via.len() >= 10 {
                break;
            }
            if !via.contains(&peer) {
                via.push(peer);
            }
        }
        let via: Vec<String> = via
            .iter()
            .map(|k| speakable::node_key_b58(k).unwrap_or_else(|| k.clone()))
            .collect();
        let base = state.config.public_url.clone().unwrap_or_default();
        let addr = format!("{base}/id/{speak}?via={}", via.join(","));
        // Their picture if they chose one, else their identicon - the same glyph the
        // console draws (crate::identicon and its JS twin). Inlined, not linked: the face's
        // CSP allows no data: images, and an inline <svg> needs no permission at all.
        let avatar = match profile_value(&fields, "avatar") {
            Some(doc) => format!(
                "<img class=\"avatar\" src=\"/id/{speak}/docs/{}/thumb\" alt=\"\">",
                esc(doc)
            ),
            None => format!(
                "<span class=\"avatar\">{}</span>",
                crate::identicon::identicon_svg(&root)
            ),
        };
        return Ok(face(
            StatusCode::OK,
            page(
                &name,
                format!(
                    "{avatar}<h1>{chip}{name}</h1>\
                     <p class=\"addr\"><a href=\"{addr}\">{addr}</a></p>\
                     {bio}\
                     <p class=\"foot\">a persona on ringtome, served from this node</p>",
                    chip = chip(&root),
                    name = esc(&name),
                    bio = if bio.is_empty() {
                        String::new()
                    } else {
                        format!("<p class=\"bio\">{}</p>", esc(&bio))
                    },
                    addr = esc(&addr),
                ),
            ),
        ));
    }

    // The warm tombstone: not carried here, and (until serving records carry public web
    // URLs - the signpost rung) nowhere to point. An honest dead end with directions.
    Ok(face(
        StatusCode::NOT_FOUND,
        page(
            &words,
            format!(
                "<h1>{chip}{words}</h1>\
                 <p>This persona lives on the quiet side of ringtome - it isn't served from \
                 this node, and it hasn't told the web where else to find it.</p>\
                 <p>If you're on ringtome, open it from your own node:</p>\
                 <p class=\"addr\">/id/{speak}</p>\
                 <p class=\"foot\">nothing about this persona is hosted here</p>",
                chip = chip(&root),
                words = esc(&words),
                speak = esc(&speak),
            ),
        ),
    ))
}

/// How long a fetched foreign profile is served without even trying to revalidate.
///
/// This was ten minutes, back when a visit's fetch sat in the request path and a long window
/// was the only thing keeping a dead peer from making a slow page. It is thirty seconds now,
/// because the fetch no longer blocks anything: a visit serves what we hold and revalidates
/// BEHIND the response. What remains is an anti-hammer floor - a reload loop must not become a
/// dial loop - and the exchange it guards is cheap in the common case (an up-to-date frontier
/// swap transfers nothing; only a persona that actually moved costs more than a kilobyte).
const FOREIGN_REVALIDATE_MS: i64 = 30 * 1000;

/// Record a successful foreign fetch - ON DISK (amended 2026-08-02 from an in-memory map):
/// once an identity's own nodes go permanently dark, it survives exactly in the nodes that
/// fetched it and their memory of having done so; a fleet of friendly nodes rebooting must
/// not orphan chains they still hold. Durable KNOWLEDGE, still member-scoped SERVING - this
/// table never touches the identities table (the anonymous shelf) or identity_peers (the
/// background sync worklist): a fetch is remembered, never promoted to fronting.
/// A via hint interpreted as an identity leaf: if a fresh serving record exists under this
/// key AND names the root we are fetching, the record's endpoint is the dial target -
/// authenticated by the leaf's own signature, with the root binding checked so a leaf via
/// for the WRONG identity can't redirect a fetch. Anything else returns the key unchanged,
/// to be dialed as the endpoint id it presumably is.
pub(crate) async fn leaf_via_to_endpoint(
    state: &AppState,
    root_hex: &str,
    key_hex: &str,
) -> String {
    let Some(leaf) = crate::pubkey::decode(key_hex) else {
        return key_hex.to_string();
    };
    match state.directory.resolve_serving(&leaf).await {
        Ok(Some(signed)) if hex::encode(signed.record().root) == root_hex => {
            match iroh::PublicKey::from_bytes(&signed.record().endpoint_id) {
                Ok(ep) => ep.to_string(),
                Err(_) => key_hex.to_string(),
            }
        }
        _ => key_hex.to_string(),
    }
}

async fn record_foreign_fetch(state: &AppState, root_hex: &str, via: &str) -> Result<(), AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO foreign_fetches (root_pubkey, fetched_at_ms, last_via, looked_ms)
             VALUES (?1, ?2, ?3, ?2)
             ON CONFLICT(root_pubkey) DO UPDATE SET fetched_at_ms = ?2, last_via = ?3, looked_ms = ?2",
            (root_hex, crate::clock::now_ms(), via),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

/// Drop a root's fetch memory - called when this node starts HOSTING it (identity.rs, the
/// transition that makes the record wrong rather than merely old) and by the eviction
/// sweep's owner-forgets walk (eviction.rs, 2026-08-25 - an evicted mirror must not leave
/// a registry row claiming a persona whose database is gone).
pub async fn forget_foreign_fetch(node_db: &crate::db::Db, root_hex: &str) -> Result<(), AppError> {
    node_db
        .execute("DELETE FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

/// The fetch memory for a root: (fetched_at_ms, the endpoint key that last answered).
/// Every foreign root this node has fetched and still carries. The other half of "personas we
/// hold" - deliberately NOT in the identities table (that is what keeps the anonymous face
/// tombstoning them), so the frontier sweep has to ask both.
pub async fn fetched_roots(node_db: &crate::db::Db) -> anyhow::Result<Vec<String>> {
    use anyhow::Context;
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT root_pubkey FROM foreign_fetches", ())
        .await
        .context("listing fetched identities")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Has this node ever fetched-and-carried this foreign root? The sync responder's question
/// when a push arrives for a persona we don't host: a carried persona's updates are welcome.
pub async fn has_fetched(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<bool> {
    use anyhow::Context;
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM foreign_fetches WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("checking the fetch registry")?;
    Ok(row.is_some())
}

/// The endpoint that last answered a fetch of this persona, if any - the recovery sweep's
/// best first guess for who holds its bodies (net::bodies).
pub async fn fetched_via(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<Option<String>> {
    let row: Option<(Option<String>,)> = node_db
        .fetch_optional(
            "SELECT last_via FROM foreign_fetches WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await?;
    Ok(row.and_then(|(via,)| via))
}

pub(crate) async fn foreign_fetch_row(
    state: &AppState,
    root_hex: &str,
) -> Result<Option<(i64, Option<String>)>, AppError> {
    state
        .node_db
        .fetch_optional(
            "SELECT fetched_at_ms, last_via FROM foreign_fetches WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .map_err(AppError::Internal)
}

/// Per-candidate ceiling on the whole dial-and-sync; the ladder tries at most three, so a
/// page's worst case stays bounded even when every hinted node is dark.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(serde::Deserialize)]
pub struct IdQuery {
    /// Comma-separated node endpoint keys - the address's own `?via=` hints, passed through
    /// by the lens page. Hints are keys, never addresses; anything unparseable is skipped.
    pub via: Option<String>,
    /// The VIEWING persona's root, hex - the reader the sealed-post rule is asked for: a
    /// trusted-only post the viewer cannot open is not listed at all, as the feed does.
    #[serde(rename = "as")]
    pub as_root: Option<String>,
}

/// Fetch a foreign identity's PUBLIC chains at request time: dial the candidate node keys IN
/// PARALLEL and take the first success - with the `?via=` list widened to ten keys
/// (2026-08-02, keeping fast-moving identities alive), a sequential ladder's worst case
/// would be ten timeouts end to end, and a page can't wait for that. Each task runs the
/// ordinary sync exchange (an unproven requester with empty frontiers receives exactly the
/// public lane - the same from-empty path adoption exercises), the gate validates everything
/// against `root`, and concurrent winners are safe (single-writer chains, duplicate-skip
/// ingest; the also-rans are DETACHED to finish, never aborted - see below). Candidates
/// arrive base58 or hex, and each may be
/// either kind of key (2026-08-07, "hints become leaves"): an identity LEAF - resolved
/// through its signed serving record, which must name OUR target root or the hint is
/// discarded - or a bare endpoint id, the original transport-layer form. Leaves are tried as
/// leaves first; a key that resolves no serving record falls back to being dialed as an
/// endpoint. The resolve-a-bare-root announce backstop remains NEXT_STEPS.
pub(crate) async fn fetch_foreign(state: &AppState, root_hex: &str, via: &[String]) -> bool {
    fetch_foreign_passes(state, root_hex, via, crate::net::sync::CONTINUATIONS_PER_WAKE).await
}

/// `fetch_foreign` with the continuation count named: each winning candidate chains up to
/// `max_passes` budgeted exchanges while the peer still holds more (PROJECT_PLAN's Peeks, ruling 2). One
/// pass is the test beat's "pull-once", which is how the cut itself is observed.
/// Held at PEEK depth (PROJECT_PLAN's Peeks, ruling 1): not this node's own, and nobody's dial here names
/// them - follow, rebroadcast interest, or trust alike (the eviction sweep's "nobody wants"
/// question; a rebroadcast-only follow is a relationship whose shares chain must arrive
/// whole, which the first full rig run proved by refusing every share in the tree). Depth
/// is a fact about OUR relationships, so this is the one question every door asks.
pub(crate) async fn peek_held(state: &AppState, root_hex: &str) -> bool {
    if crate::identity::is_agented(&state.node_db, root_hex).await.unwrap_or(false) {
        return false;
    }
    // A speculative mirror (Discovery slice 1) is held on a reader's trust rollup, not on a
    // dial - quiet by design, and at whatever depth its own pass chose. Not a peek.
    if crate::speculative::fetched_at(&state.node_db, root_hex).await.ok().flatten().is_some() {
        return false;
    }
    crate::net::subscriptions::dialed_by(&state.node_db, root_hex)
        .await
        .map(|d| d.is_empty())
        .unwrap_or(false)
}

/// Promotion (PROJECT_PLAN's Peeks, ruling 7): a dial just landed on a persona held as a peek, so fetch
/// them whole NOW, through the ladder the peek already knows - the demand signal is the
/// dial, and "follow, then open their page" must find the mirror, not the next beat.
pub(crate) async fn promote_peek(state: &AppState, root_hex: &str) -> bool {
    let via = stored_tree_leaves(state, root_hex).await;
    fetch_foreign_at(state, root_hex, &via, crate::net::sync::CONTINUATIONS_PER_WAKE, Some(false)).await
}

/// How many posts a peek carries (PROJECT_PLAN's Peeks, ruling 4), and how long the page waits for them.
const PEEK_POSTS: u64 = 20;
const PEEK_SHELF_WAIT: std::time::Duration = std::time::Duration::from_secs(6);
/// How often a look is written down - a reload loop is one look.
const PEEK_LOOK_THROTTLE_MS: i64 = 60 * 1000;

/// A member looked at this peek (PROJECT_PLAN's Peeks, ruling 6): the expiry and the node-wide budget's
/// least-recently-looked order read the stamp. Throttled in memory so a page's dozen reads
/// are one write.
pub(crate) async fn touch_look(state: &AppState, root_hex: &str) {
    let now = crate::clock::now_ms();
    if state
        .sweep_marks
        .last("peek-look", root_hex)
        .is_some_and(|t| now - t < PEEK_LOOK_THROTTLE_MS)
    {
        return;
    }
    state.sweep_marks.record("peek-look", root_hex, now);
    if let Err(e) = state
        .node_db
        .execute(
            "UPDATE foreign_fetches SET looked_ms = ?2 WHERE root_pubkey = ?1",
            (root_hex, now),
        )
        .await
    {
        tracing::debug!(root = %root_hex, error = ?e, "could not stamp a look");
    }
}

/// The peek registry, for the eviction sweep: every fetched root with its last look and
/// its measured footprint (PROJECT_PLAN's Peeks, ruling 6). Owner's read - `foreign_fetches` is this
/// module's table.
pub(crate) async fn peek_registry(node_db: &crate::db::Db) -> anyhow::Result<Vec<(String, i64, i64)>> {
    node_db
        .fetch_all("SELECT root_pubkey, looked_ms, bytes FROM foreign_fetches", ())
        .await
        .map_err(|e| anyhow::anyhow!("reading the peek registry: {e}"))
}

/// Whether somebody here looked at this persona within the expiry - the keeper a peek
/// holds its mirror by (PROJECT_PLAN's Peeks, ruling 6): a look is the rest clock a peek is judged on.
pub(crate) async fn looked_within(node_db: &crate::db::Db, root_hex: &str, now: i64, expiry_ms: i64) -> bool {
    let row: Option<(i64,)> = node_db
        .fetch_optional("SELECT looked_ms FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await
        .ok()
        .flatten();
    row.is_some_and(|(looked,)| now - looked < expiry_ms)
}

/// The author's pinned posts as this node holds them (PROJECT_PLAN's Peeks, ruling 12): the pins off the
/// author's own annotations chain (mirror or peek alike carry it), each resolved to the
/// post - the mirror's shelf, or for a peek whatever the ledger fetched. A pin whose post
/// is not here yet is simply not in the strip until it lands.
async fn pinned_here(state: &AppState, root_hex: &str, peek: bool) -> Vec<crate::record::documents::PublicDoc> {
    let Ok(Some(db)) = state.user_dbs.get(root_hex).await else {
        return Vec::new();
    };
    let ids = crate::record::imaol::pinned_docs(&db, root_hex).await.unwrap_or_default();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let doc = if peek {
            crate::fragments::public_doc_of(&state.node_db, root_hex, &hex::encode(id))
                .await
                .ok()
                .flatten()
                .map(|(p, _)| p)
        } else {
            match crate::record::documents::public_doc(&db, &id).await.ok().flatten() {
                Some(p) => Some(p),
                None => {
                    // Beneath the follow ceiling's floor (PROJECT_PLAN's Peeks, ruling 13): acquired by id
                    // over the fragment road, never by deepening the chain.
                    if let Some(author) = crate::pubkey::decode(root_hex) {
                        crate::fragments::fetch_post(state, root_hex, &author, &id).await;
                    }
                    crate::fragments::public_doc_of(&state.node_db, root_hex, &hex::encode(id))
                        .await
                        .ok()
                        .flatten()
                        .map(|(p, _)| p)
                }
            }
        };
        if let Some(p) = doc {
            out.push(p);
        }
    }
    out
}

/// The peek's footprint, measured now and written to the registry (PROJECT_PLAN's Peeks, ruling 6).
pub(crate) async fn peek_bytes(state: &AppState, root_hex: &str) -> u64 {
    let bytes = crate::fragments::bytes_of_author(state, root_hex).await.unwrap_or(0);
    let _ = state
        .node_db
        .execute(
            "UPDATE foreign_fetches SET bytes = ?2 WHERE root_pubkey = ?1",
            (root_hex, bytes as i64),
        )
        .await;
    bytes
}

/// Whether this peek may still fetch (PROJECT_PLAN's Peeks, ruling 6): under its byte ceiling. Every
/// road that fetches for a peek - the shelf, the on-demand reads, the reply door - asks
/// this first; over the ceiling, the peek keeps what it has and the page says so.
pub(crate) async fn peek_room(state: &AppState, root_hex: &str) -> bool {
    peek_bytes(state, root_hex).await < state.config.peek_max_bytes
}

/// The peek's shelf (PROJECT_PLAN's Peeks, ruling 4): ask the node that just answered for the persona
/// which posts are newest (and pinned), then fetch each as a fragment - its own signed
/// header, verified here, its labels riding along - and want its body. Bounded by the
/// page's patience: what lands in time renders now, the rest lands behind the page
/// (ruling 9, render at first entry). Returns how many posts the ledger holds afterwards.
async fn peek_shelf(state: &AppState, root_hex: &str, endpoint_id: &str) -> usize {
    let Some(author) = crate::pubkey::decode(root_hex) else {
        return 0;
    };
    let shelf = tokio::time::timeout(
        PEEK_SHELF_WAIT,
        crate::net::fragment::fetch_shelf_from(state, endpoint_id, &author, PEEK_POSTS),
    )
    .await;
    let (posts, pinned) = match shelf {
        Ok(Ok(lists)) => lists,
        Ok(Err(e)) => {
            tracing::debug!(root = %root_hex, via = %endpoint_id, "peek: shelf refused: {e:#}");
            return 0;
        }
        Err(_) => {
            tracing::debug!(root = %root_hex, via = %endpoint_id, "peek: shelf did not answer in time");
            return 0;
        }
    };
    let mut wanted: Vec<[u8; 16]> = Vec::new();
    // The face first: the profile names its avatar by document id, and a peek that shows
    // the name without the face is half a look.
    if let Ok(fields) = public_profile(state, root_hex).await {
        if let Some(avatar) = profile_value(&fields, "avatar")
            .and_then(|h| hex::decode(h).ok())
            .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
        {
            wanted.push(avatar);
        }
    }
    for id in pinned.into_iter().chain(posts) {
        if !wanted.contains(&id) {
            wanted.push(id);
        }
    }
    wanted.truncate((PEEK_POSTS * 2 + 1) as usize);
    if !peek_room(state, root_hex).await {
        tracing::info!(root = %root_hex, "peek: at its ceiling - nothing more fetched");
        return crate::fragments::shelf_of(&state.node_db, root_hex, PEEK_POSTS as i64)
            .await
            .map(|s| s.len())
            .unwrap_or(0);
    }
    let started = std::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for (index, doc_id) in wanted.into_iter().enumerate() {
        let doc_hex = hex::encode(doc_id);
        if let Ok(Some(_)) = crate::fragments::held(&state.node_db, root_hex, &doc_hex).await {
            continue;
        }
        let task_state = state.clone();
        let task_root = root_hex.to_string();
        let task_via = endpoint_id.to_string();
        tasks.spawn(async move {
            let fetched = crate::net::fragment::fetch_from(&task_state, &task_via, &author, &doc_id).await;
            if let Ok(crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by)) = fetched {
                if crate::fragments::remember(&task_state.node_db, &task_root, &task_root, &verified, &entry, &auth_path)
                    .await
                    .is_ok()
                {
                    if let Some(ep) = served_by {
                        let _ = crate::fragments::note_deliverer(&task_state.node_db, &task_root, &ep).await;
                    }
                    // The words, the thumbnail and the preview alike: a face is its thumbnail.
                    let mut hashes = vec![verified.header.file_hash];
                    hashes.extend(verified.header.thumb_hash);
                    hashes.extend(verified.header.preview_hash);
                    return Some((index, hashes));
                }
            }
            None
        });
    }
    // Wait the page's patience, then let the rest finish detached (never aborted: a late
    // fragment is a warmer shelf, and an abort mid-dial is the zombie the ladder learned
    // to avoid).
    let mut landed: Vec<(usize, Vec<[u8; 32]>)> = Vec::new();
    let deadline = tokio::time::sleep(PEEK_SHELF_WAIT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            joined = tasks.join_next() => match joined {
                None => break,
                Some(Ok(Some(hit))) => landed.push(hit),
                Some(_) => {}
            },
            _ = &mut deadline => {
                tasks.detach_all();
                break;
            }
        }
    }
    landed.sort_by_key(|(i, _)| *i);
    // The bytes cross with the look, not behind it (the face test's "no second trip") -
    // one document at a time, in shelf order, each wanted and fetched only while the peek
    // has room (ruling 6) and the page has patience. Past either, nothing more is even
    // wanted: what the ceiling refuses, the sweep must not fetch later.
    if let Ok(addr) = crate::net::sync::dial_addr(state, endpoint_id).await {
        for (_, hashes) in landed {
            if started.elapsed() > PEEK_SHELF_WAIT * 2 || !peek_room(state, root_hex).await {
                break;
            }
            for h in &hashes {
                let _ = crate::net::bodies::want(&state.node_db, root_hex, h).await;
            }
            crate::net::bodies::fetch_wanted(state, root_hex, addr.clone()).await;
        }
    }
    peek_bytes(state, root_hex).await;
    crate::fragments::shelf_of(&state.node_db, root_hex, PEEK_POSTS as i64)
        .await
        .map(|s| s.len())
        .unwrap_or(0)
}

pub(crate) async fn fetch_foreign_passes(
    state: &AppState,
    root_hex: &str,
    via: &[String],
    max_passes: usize,
) -> bool {
    fetch_foreign_at(state, root_hex, via, max_passes, None).await
}

/// How far one scrollback backfill reaches beneath the floor (PROJECT_PLAN's Peeks, slice 5).
const BACKFILL_ENTRIES: u64 = 200;

/// Scrollback's backfill (PROJECT_PLAN's Peeks, ruling 8): the pager ran out of what a follow holds and
/// the posts chain has a floor above zero - ask the author's nodes for the entries beneath
/// it, one bounded exchange, and let the caller read again.
pub(crate) async fn backfill(state: &AppState, root_hex: &str) -> bool {
    let via = stored_tree_leaves(state, root_hex).await;
    fetch_foreign_with(
        state,
        root_hex,
        &via,
        1,
        Some(false),
        crate::net::sync::Ask { ceiling: state.config.follow_posts_ceiling, below: BACKFILL_ENTRIES },
    )
    .await
}

/// The posts chain's floor as this node holds it - zero when whole or absent.
pub(crate) async fn posts_floor(state: &AppState, root_hex: &str) -> u64 {
    crate::net::frontier::memo_chains(&state.node_db, root_hex)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, svc, _, _, _)| *svc == ringtome_proto::registry::service::POSTS)
        .map(|(_, _, floor, _, _)| floor)
        .max()
        .unwrap_or(0)
}

/// `fetch_foreign_passes` with the depth named: `Some(true)` peeks, `Some(false)` pulls
/// whole, `None` asks the relationships (`peek_held`).
async fn fetch_foreign_at(
    state: &AppState,
    root_hex: &str,
    via: &[String],
    max_passes: usize,
    depth: Option<bool>,
) -> bool {
    let ask = crate::net::sync::Ask { ceiling: state.config.follow_posts_ceiling, below: 0 };
    fetch_foreign_with(state, root_hex, via, max_passes, depth, ask).await
}

async fn fetch_foreign_with(
    state: &AppState,
    root_hex: &str,
    via: &[String],
    max_passes: usize,
    depth: Option<bool>,
    ask: crate::net::sync::Ask,
) -> bool {
    // Depth (PROJECT_PLAN's Peeks, ruling 1): nobody here follows them, so this is a PEEK - the scoped
    // exchange for identity, profile and annotations, then the shelf as fragments. A
    // followed persona takes the ordinary full pull.
    let peek = match depth {
        Some(p) => p,
        None => peek_held(state, root_hex).await,
    };
    let scope: &'static [u32] = if peek { crate::net::sync::PEEK_SCOPE } else { &[] };
    // Detach, never cancel (2026-08-24, closing REFACTOR's visit-ladder entry): the old
    // shape aborted the also-rans on first success (JoinSet::abort_all) and cancelled each
    // exchange at its 8s deadline (timeout around the future), and every one of those
    // aborts could mint zombie QUIC state against the very node the winner just used. The
    // sharedby CI artifact caught the cluster the REFACTOR entry predicted: three share
    // pointers took 128 seconds - the QUIC idle reaper's clearing time - to cross to a
    // node whose wake pass was dialing their host every 4 seconds, every dial wedged
    // behind a poisoned connection. Now each exchange runs on its own task; deadlines and
    // winners bound the WAIT and detach the work (the `speculative::acquire_one` idiom),
    // and a late also-ran just leaves a warmer mirror (duplicate-skip ingest).
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Option<(String, u64)>>(16);
    // The zeroth hint is the root itself: a founding node signs with the root AS its leaf,
    // so its serving record lives under the root key - which makes a bare root resolve with
    // no hint at all, for every persona whose founding node still publishes. (The announce
    // rendezvous, when built, covers the personas whose founder is gone.)
    let implicit = std::iter::once(root_hex.to_string());
    for candidate in implicit.chain(via.iter().take(10).cloned()) {
        let candidate = &candidate;
        // A hint in neither spelling costs a shrug, never the ladder.
        let Some(key_hex) = speakable::node_key_from_via(candidate) else {
            continue;
        };
        let task_state = state.clone();
        let task_root = root_hex.to_string();
        let tx = tx.clone();
        tokio::spawn(async move {
            let key_hex = leaf_via_to_endpoint(&task_state, &task_root, &key_hex).await;
            let Ok(addr) = crate::net::sync::dial_addr(&task_state, &key_hex).await else {
                let _ = tx.send(None).await;
                return;
            };
            let exchange_state = task_state.clone();
            let exchange_root = task_root.clone();
            let mut pull = tokio::spawn(async move {
                let mut passes = 0;
                loop {
                    let stats = crate::net::sync::sync_with_peer_asking(
                        &exchange_state,
                        &exchange_root,
                        addr.clone(),
                        scope,
                        ask,
                    )
                    .await?;
                    passes += 1;
                    if !stats.behind || passes >= max_passes.max(1) {
                        break Ok::<_, anyhow::Error>(stats);
                    }
                }
            });
            let outcome = match tokio::time::timeout(FETCH_TIMEOUT, &mut pull).await {
                Ok(Ok(Ok(stats))) => Some((key_hex, stats.received)),
                Ok(Ok(Err(e))) => {
                    tracing::debug!(root = %task_root, via = %key_hex, "foreign fetch failed: {e:#}");
                    None
                }
                Ok(Err(join_error)) => {
                    tracing::debug!(root = %task_root, via = %key_hex, "foreign fetch died: {join_error}");
                    None
                }
                Err(_) => {
                    tracing::debug!(root = %task_root, via = %key_hex,
                        "foreign fetch still in flight at the deadline - detached, moving on");
                    None
                }
            };
            let _ = tx.send(outcome).await;
        });
    }
    drop(tx); // the channel closes when the last candidate reports (or none were spawnable)
    while let Some(outcome) = rx.recv().await {
        if let Some((key_hex, received)) = outcome {
            tracing::info!(root = %root_hex, via = %key_hex, received, peek,
                "fetched foreign identity on member request");
            if let Err(e) = record_foreign_fetch(state, root_hex, &key_hex).await {
                tracing::warn!(root = %root_hex, "could not record foreign fetch: {e:#}");
            }
            if peek {
                state.peeked.mark(root_hex);
                // The shelf lands BEHIND the answer (ruling 9, render at first entry - Curtis,
                // 2026-09-05: "my first look at the page is completely blank"): the page gets
                // the persona the moment their chains are here and says the posts are still
                // arriving; the in-flight set is what it reads, and it polls until clear.
                let shelf_state = state.clone();
                let shelf_root = root_hex.to_string();
                let shelf_via = key_hex.clone();
                if state.refreshing.lock().unwrap().insert(root_hex.to_string()) {
                    tokio::spawn(async move {
                        let held = peek_shelf(&shelf_state, &shelf_root, &shelf_via).await;
                        shelf_state.refreshing.lock().unwrap().remove(&shelf_root);
                        tracing::info!(root = %shelf_root, via = %shelf_via, held, "peek: shelf fetched as fragments");
                    });
                }
            } else {
                state.peeked.clear(root_hex);
            }
            return true;
        }
    }
    false
}

/// Start a background revalidation of a foreign persona, unless one is already running for it.
///
/// Returns whether a refresh is now in flight - true if this call started one OR found one
/// already going, because either way the answer being served may be superseded shortly, and
/// that is what the caller is asking.
///
/// The in-flight set is what keeps a reload loop from becoming a dial loop: ten page loads in a
/// second dial the stranger's node once. It is released in every exit path (the guard is
/// dropped by the task's own end, success or failure), because a root that leaked into the set
/// would never be refreshed again for the life of the process.
fn spawn_revalidate(state: &AppState, root_hex: String, via: Vec<String>) -> bool {
    {
        let mut running = state.refreshing.lock().unwrap();
        if !running.insert(root_hex.clone()) {
            return true; // already being fetched; the caller's answer is superseded either way
        }
    }
    let task_state = state.clone();
    tokio::spawn(async move {
        // Widen the hints with the tree we already hold (2026-08-07): a revalidation only
        // runs for a persona we've fetched before, so its identity chain is here - and its
        // Active leaves are exactly the members the mesh now uses to find its own siblings.
        // This is what un-pins a mirror from the one node that answered its first fetch:
        // last_via dead, every explicit hint rotten, and the refresh still finds any device
        // whose serving record is alive.
        let mut via = via;
        for leaf in stored_tree_leaves(&task_state, &root_hex).await {
            if !via.contains(&leaf) {
                via.push(leaf);
            }
        }
        // The cohort, last (2026-08-15): our own personas' sibling nodes hold the followed
        // world we slept through, and the sync door already answers for any persona their
        // users follow. This is FRONTIER GOSSIP's fetch half - the AM-node scenario: every
        // hint above names the followed persona's own machinery, and when all of it is dark
        // (the author left; we hold nothing of their tree), the sibling that stayed up is
        // the one candidate that still exists.
        for endpoint in crate::net::sync::cohort_endpoints(&task_state)
            .await
            .unwrap_or_default()
        {
            if !via.contains(&endpoint) {
                via.push(endpoint);
            }
        }
        let ok = fetch_foreign(&task_state, &root_hex, &via).await;
        if !ok {
            tracing::debug!(root = %root_hex, "background revalidation reached nobody");
        }
        task_state.refreshing.lock().unwrap().remove(&root_hex);
    });
    true
}

/// Stamp a mirrored persona as fresh without a fetch - called by the sync responder when a
/// push DELIVERS for a followed persona, so the follow-refresh sweep stays quiet exactly
/// while the push machinery is doing its job. Update-only: a persona with no fetch record
/// yet keeps "never fetched", which correctly reads as stale.
pub async fn touch_foreign_fetch(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<()> {
    node_db
        .execute(
            "UPDATE foreign_fetches SET fetched_at_ms = ?2 WHERE root_pubkey = ?1",
            (root_hex, crate::clock::now_ms()),
        )
        .await?;
    Ok(())
}

/// One followed persona, as the refresh sweep weighs it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RefreshCandidate {
    foreign: String,
    /// Any follower's account touched the node within the activity window.
    active: bool,
    /// The highest eagerness any follower set.
    eagerness: i64,
    /// COALESCE(fetched_at_ms, 0) - never-fetched sorts stalest.
    fetched_at: i64,
}

/// Priority for a wake-up's limited sync budget: personas followed by HUMANS PRESENT AT THE
/// NODE first (a computer waking with a hundred users must serve the ones actually here),
/// then by the interest dial (already a cadence dial by design), stalest first within a tie.
fn order_refresh(mut candidates: Vec<RefreshCandidate>) -> Vec<String> {
    candidates.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then(b.eagerness.cmp(&a.eagerness))
            .then(a.fetched_at.cmp(&b.fetched_at))
    });
    candidates.into_iter().map(|c| c.foreign).collect()
}

/// How long a follower's account counts as "active on the node" after its last request.
const ACTIVITY_WINDOW_MS: i64 = 30 * 60 * 1000;
/// A mirror this stale gets a wake-up sync. LOCAL_TEST may shorten it.
const FOLLOW_REFRESH_STALE_MS: i64 = 30 * 60 * 1000;
/// Refreshes started per pass - the stampede cap. A laptop waking with hundreds of stale
/// follows catches up over a few beats, priority-ordered, instead of dialing them all at once.
const FOLLOW_REFRESH_CAP: usize = 8;
/// How long an ATTEMPTED mirror rests before the sweep tries it again, success or failure.
/// Without this, a partition starves the tail: failures don't advance any ordering key, so
/// the same top-of-list mirrors would be re-dialed every beat forever while everything
/// behind them is never attempted. The cooldown rotates the cap through the whole list and
/// rate-limits partition-time dialing; partition-heal latency is bounded by one cooldown.
const FOLLOW_ATTEMPT_COOLDOWN_MS: i64 = 5 * 60 * 1000;

/// In-memory attempt stamps for the rotation above. Boot-reset by design: the first pass
/// after boot may retry everything once, which is exactly what a booting node wants.
static FOLLOW_ATTEMPTS: std::sync::Mutex<Option<std::collections::HashMap<String, i64>>> =
    std::sync::Mutex::new(None);

/// Follower-side anti-entropy (2026-08-07): the wake pass. For each followed persona whose
/// mirror has gone stale, re-fetch through the ordinary ladder (zeroth root rung, stored-tree
/// leaves, last_via) - which does BOTH halves of the reunion in one exchange: pulls whatever
/// we missed while closed, and re-records this node as an asker on whoever answers ("asking
/// is telling"), re-arming their push list until we go quiet again. Steady state is near
/// silent: delivered pushes touch the freshness stamp, so an online node's sweep finds
/// nothing stale. This is what makes a follow bind to the PERSON: their founder can die and
/// their fleet can migrate, and the next wake finds whoever currently answers for the tree.
pub async fn refresh_followed_pass(state: crate::AppState) -> anyhow::Result<()> {
    let stale_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_FOLLOW_STALE_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(FOLLOW_REFRESH_STALE_MS)
    } else {
        FOLLOW_REFRESH_STALE_MS
    };
    let cooldown_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_FOLLOW_COOLDOWN_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(FOLLOW_ATTEMPT_COOLDOWN_MS)
    } else {
        FOLLOW_ATTEMPT_COOLDOWN_MS
    };
    let now = crate::clock::now_ms();

    let follows = crate::net::subscriptions::followed_foreign(&state.node_db).await?;
    if follows.is_empty() {
        return Ok(());
    }
    // Local personas are the eager loop's job, whoever follows them; and the follower ->
    // account join is how presence reaches priority.
    let hosted: std::collections::HashMap<String, String> =
        crate::identity::hosted_roots_with_accounts(&state.node_db)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .into_iter()
            .map(|(root, account)| (root, account.to_string()))
            .collect();
    let active_accounts = state.activity.active_within(ACTIVITY_WINDOW_MS);
    let fetched: std::collections::HashMap<String, i64> = state
        .node_db
        .fetch_all("SELECT root_pubkey, fetched_at_ms FROM foreign_fetches", ())
        .await?
        .into_iter()
        .map(|(r, at): (String, i64)| (r, at))
        .collect();

    let mut by_foreign: std::collections::HashMap<String, RefreshCandidate> =
        std::collections::HashMap::new();
    for (foreign, local, eagerness) in follows {
        if hosted.contains_key(&foreign) {
            continue;
        }
        let fetched_at = fetched.get(&foreign).copied().unwrap_or(0);
        // A persona the last exchange left behind is stale whatever its stamp says
        // (PROJECT_PLAN's Peeks, ruling 2): the wake pass is how a budgeted history keeps arriving. So is
        // one held at PEEK depth that somebody here now dials (ruling 7): the dial is the
        // demand, and the whole mirror is owed on the next beat.
        if now - fetched_at < stale_ms && !state.behind.is_behind(&foreign) && !state.peeked.is_behind(&foreign) {
            continue;
        }
        {
            let marks = FOLLOW_ATTEMPTS.lock().expect("attempt marks poisoned");
            if let Some(at) = marks.as_ref().and_then(|m| m.get(&foreign)) {
                if now - at < cooldown_ms {
                    continue; // recently attempted - let the rest of the list have the cap
                }
            }
        }
        let active = hosted
            .get(&local)
            .is_some_and(|account| active_accounts.contains(account));
        let entry = by_foreign
            .entry(foreign.clone())
            .or_insert(RefreshCandidate { foreign, active: false, eagerness: 0, fetched_at });
        entry.active |= active;
        entry.eagerness = entry.eagerness.max(eagerness);
    }
    if by_foreign.is_empty() {
        return Ok(());
    }

    let started: Vec<String> = order_refresh(by_foreign.into_values().collect())
        .into_iter()
        .take(FOLLOW_REFRESH_CAP)
        .collect();
    let n = started.len();
    {
        let mut marks = FOLLOW_ATTEMPTS.lock().expect("attempt marks poisoned");
        let map = marks.get_or_insert_with(Default::default);
        for foreign in &started {
            map.insert(foreign.clone(), now);
        }
    }
    for foreign in started {
        // The revalidate machinery is the whole ladder: dedup against in-flight fetches,
        // stored-tree leaves, the zeroth root rung, last_via.
        spawn_revalidate(&state, foreign, Vec::new());
    }
    tracing::info!(refreshed = n, "follow-refresh pass reached for stale mirrors");
    Ok(())
}

/// The Active leaves of a persona's stored identity chain, hex - candidates for re-fetching
/// it. Empty on any failure: a mirror we can't read just falls back to the explicit hints.
///
/// A mirror we hold NOTHING of has no stored leaves, and says so by existing-check rather
/// than by trusting its callers to have checked: `user_dbs.get` creates on open, so the
/// version that asked the question directly minted an empty database (and WAL, and journal)
/// for every persona it was asked about cold. The doc used to say "callers must hold a
/// reason to believe the mirror exists" - and the wake pass, whose whole job is chasing
/// followed personas we may never have synced, is a caller that structurally cannot. Found
/// 2026-08-08 in the node log: `generated new database encryption key` for a stranger root,
/// thirteen milliseconds before `background revalidation reached nobody`. A precondition a
/// caller cannot satisfy belongs in the callee (STYLE: structural, not disciplinary).
pub(crate) async fn stored_tree_leaves(state: &AppState, root_hex: &str) -> Vec<String> {
    let result: anyhow::Result<Vec<String>> = async {
        let Some(db) = state.user_dbs.get(root_hex).await? else {
            return Ok(Vec::new()); // hold nothing of them, so we know none of their leaves
        };
        let tree = crate::record::imaol::load_key_tree(&db, root_hex).await?;
        Ok(tree
            .members()
            .filter(|(_, status)| *status == ringtome_proto::crown::KeyStatus::Active)
            .map(|(leaf, _)| hex::encode(leaf))
            .collect())
    }
    .await;
    result.unwrap_or_default()
}

#[derive(serde::Serialize)]
pub struct DirectoryRow {
    pub root: String,
    pub speakable: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Hosted here (a neighbor), or merely known here (someone a member once reached).
    pub hosted: bool,
}

/// GET `/api/directory` - the personas this node KNOWS, for its members: a proto-discovery
/// surface, and the first place anywhere that ENUMERATES identities, which is why its rules
/// are consent lines rather than reach:
///
///   - Hosted personas appear only once SERVED. `served_at_ms` is the publication act
///     ("identities are born dark"), and it gates local listing for the same reason it gates
///     the DHT record - a housemate's dark pseudonym must not be volunteered to housemates.
///   - Fetched personas appear because acquaintance is the surface's whole value - but the
///     trail is node-level and anonymous WITHIN the node by construction: `foreign_fetches`
///     has no account column, so a row says "someone here has met them", never who.
///   - Members only. The anonymous face keeps tombstoning everything it already tombstones;
///     a stranger enumerating who this node knows would be reading its members' interests.
///   - Follows are never consulted. A quiet follow is quiet (Edge-Endpoint Visibility), and
///     this list must not be a way to notice one.
///
/// Bylines come from the cache - one query, no database per face (the conventions test pins
/// this surface to zero `user_dbs.get` calls simply by counting).
/// Directory rows served per request - see the cap comment in `directory` for the reasoning.
const DIRECTORY_CAP: usize = 200;

pub async fn directory(
    _session: Session,
    State(state): State<AppState>,
) -> Result<axum::Json<Vec<DirectoryRow>>, AppError> {
    let served: std::collections::BTreeSet<String> =
        crate::identity::served_roots(&state.node_db)
            .await?
            .into_iter()
            .collect();
    let fetched = fetched_roots(&state.node_db)
        .await
        .map_err(AppError::Internal)?;
    let mut roots: Vec<String> = served.iter().cloned().collect();
    roots.extend(fetched.into_iter().filter(|r| !served.contains(r)));
    // The directory is a shelf to scan, never an export: capped, hosted-first, BEFORE the
    // byline join so a node fronting tens of thousands of mirrors neither builds a
    // roots-long IN clause nor ships them all. Which fetched personas make the cut is
    // arbitrary past "hosted first", and that is fine for a discovery surface - finding a
    // KNOWN persona is the lookup box's job (and a search endpoint's, the day it exists:
    // NEXT_STEPS, "Search my people / all visible people").
    roots.truncate(DIRECTORY_CAP);

    let bylines = crate::profiles::bylines(&state.node_db, &roots)
        .await
        .map_err(AppError::Internal)?;
    let mut rows: Vec<DirectoryRow> = roots
        .into_iter()
        .filter_map(|root| {
            let raw = crate::pubkey::decode(&root)?;
            let byline = bylines.get(&root).cloned().unwrap_or_default();
            Some(DirectoryRow {
                speakable: speakable::speakable(&raw),
                hosted: served.contains(&root),
                name: byline.name,
                avatar: byline.avatar,
                root,
            })
        })
        .collect();
    // The named before the nameless, each alphabetically - a directory people can scan.
    rows.sort_by(|a, b| match (&a.name, &b.name) {
        (Some(x), Some(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.speakable.cmp(&b.speakable),
    });
    Ok(axum::Json(rows))
}

/// GET `/id/{seg}/docs/{doc}/body` and `/thumb` - a public document's bytes, anonymously.
/// The lane check is the whole gate: `public_head` answers only for POSTS-lane documents, so
/// a private doc_id asked through this door is a 404, never a leak. Bytes are served with
/// the stored format's own Content-Type, nosniff, and ETag revalidation (the blob hash:
/// a different avatar is a different document).
async fn public_doc_bytes(
    state: &AppState,
    session: &Option<Session>,
    seg: &str,
    doc_hex: &str,
    thumb: bool,
    if_none_match: Option<&str>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(seg) else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here", "no such persona here")));
    };
    let root_hex = hex::encode(root);
    let doc_id: [u8; 16] = hex::decode(doc_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::NotFound(crate::msg!("idface.no-such-document", "no such document")))?;
    // Two shelves, the author's chain first. Held chain: authoritative, retraction-filtered
    // at `public_head`. No chain: the FRAGMENT ledger (2026-08-14) - a reader whose node
    // learned of this document through a share holds the author's own signed entry and (once
    // healed) its bytes, and this route was the missing door between that store and the
    // reader's own browser. Every reader past the chain rendered "these words haven't reached
    // this computer" forever, under months of green cascade tests that stopped at the
    // database. An anonymous probe for a document held NEITHER way finds nothing rather than
    // minting a place to look: absence is the answer here, and `get` is the verb that can say
    // it.
    //
    // One carve-out to "the chain first" (2026-08-21, found by cascade.cjs the day the
    // speculative pass landed): a chain held ONLY SPECULATIVELY (speculative.rs - no hosting,
    // no member fetch, no follow) has no freshness contract - it is allowed to be hours
    // stale by design - so its silence is ignorance, not retraction, and it must not shadow
    // a fragment a chosen share delivered five seconds ago. For a hunch-held persona the
    // FRAGMENT shelf answers first (explicit beats implicit: the share was asked for), and
    // the mirror serves only what no fragment can. Relationship-held chains keep the
    // authoritative rule unchanged, silence included.
    struct ServeFacts {
        file_hash: [u8; 32],
        thumb_hash: Option<[u8; 32]>,
        format: Option<u64>,
        trusted_only: bool,
    }
    let from_fragments = || async {
        Result::<Option<ServeFacts>, AppError>::Ok(
            crate::fragments::serving_header(&state.node_db, &root_hex, &doc_id)
                .await
                .map_err(AppError::Internal)?
                .map(|h| ServeFacts {
                    file_hash: h.file_hash,
                    thumb_hash: h.thumb_hash,
                    format: h.format,
                    trusted_only: h.trusted_only,
                }),
        )
    };
    let facts: Option<ServeFacts> =
        match state.user_dbs.get(&root_hex).await.map_err(AppError::Internal)? {
            Some(db) => {
                let speculative_only = crate::speculative::speculative_only(state, &root_hex)
                    .await
                    .map_err(AppError::Internal)?;
                // A peek's mirror (PROJECT_PLAN's Peeks, ruling 4) has no posts lane either: its words
                // live on the fragment ledger, so it reads fragment-first like a hunch does.
                // And a peek FOLLOWS THE EYE (ruling 5): a document it never fetched - a
                // page of a shared book, a post past the newest twenty - is asked for by id
                // over the fragment road from the author's own nodes, right now, so the
                // reader who clicked it gets it rather than a shrug.
                let peek = peek_held(state, &root_hex).await;
                let mut fragment_first = if speculative_only || peek { from_fragments().await? } else { None };
                if peek {
                    touch_look(state, &root_hex).await;
                }
                if peek && fragment_first.is_none() {
                    if !peek_room(state, &root_hex).await {
                        return Err(AppError::NotFound(crate::msg!("idface.this-look-is-full", "this look is full - follow them to keep everything")));
                    }
                    crate::fragments::fetch_post(state, &root_hex, &root, &doc_id).await;
                    fragment_first = from_fragments().await?;
                }
                // A FOLLOW held from a floor (PROJECT_PLAN's Peeks, ruling 8) may lack an old document
                // too - a pin beneath the floor, a link into deep history: the ledger, then
                // by id over the fragment road. Only while the posts chain HAS a floor: a
                // whole mirror lacking a document lacks it for a reason (retracted,
                // disproven), and must not fetch it back. Never for a persona hosted here.
                if !peek
                    && !speculative_only
                    && fragment_first.is_none()
                    && !hosted_here(state, &root_hex).await.unwrap_or(false)
                    && posts_floor(state, &root_hex).await > 0
                    && crate::record::documents::public_head(&db, &doc_id).await?.is_none()
                {
                    fragment_first = from_fragments().await?;
                    if fragment_first.is_none() {
                        crate::fragments::fetch_post(state, &root_hex, &root, &doc_id).await;
                        fragment_first = from_fragments().await?;
                    }
                }
                match fragment_first {
                    Some(facts) => Some(facts),
                    None => {
                        // Off the HEADER, not the text-only shelf view: a media twin is
                        // filtered out of `public_doc` by format, which left sealed
                        // pictures serving their ciphertext ungated (caught by the twins
                        // acceptance - 200 of sealed bytes for the untrusted).
                        let gated = match crate::record::documents::public_header_entry(&db, &doc_id)
                            .await?
                        {
                            Some(entry) => match &entry.entry().payload {
                                ringtome_proto::Payload::Inline(payload) => {
                                    ringtome_proto::registry::DocHeaderPlain::decode(payload)
                                        .map(|h| h.trusted_only)
                                        .unwrap_or(false)
                                }
                                _ => false,
                            },
                            None => false,
                        };
                        crate::record::documents::public_head(&db, &doc_id).await?.map(|h| {
                            ServeFacts {
                                file_hash: h.file_hash,
                                thumb_hash: h.thumb_hash,
                                format: h.format,
                                trusted_only: gated,
                            }
                        })
                    }
                }
            }
            None => from_fragments().await?,
        };
    let Some(ServeFacts { file_hash, thumb_hash, format, trusted_only }) = facts else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-public-document-here", "no such public document here")));
    };
    // The trusted-readers gate (PROJECT_PLAN's Post visibility slice 2). The BODY is the gated thing; the
    // thumbnail is the post's public face by ruling, with the title and the date. A reader
    // qualifies when any persona on their session is the author, or holds any published
    // trust band on the author's own chain - checked at serve time, so trust published
    // later opens older posts.
    // The thumb exemption died with the twins slice (PROJECT_PLAN's Post visibility): a sealed document's
    // thumbnail is a small copy of the sealed content. A text post's public face - title,
    // date - never had a thumb to lose, and untrusted feeds hide the card anyway.
    if trusted_only {
        let mut allowed = false;
        if let Some(sess) = session {
            let mine: Vec<String> =
                crate::identity::list_for_account(&state.node_db, &sess.account.id)
                    .await?
                    .into_iter()
                    .map(|i| i.root_pubkey)
                    .collect();
            if mine.contains(&root_hex) {
                allowed = true;
            } else if let Ok(Some(db)) = state.user_dbs.get(&root_hex).await {
                if let Ok(edges) = crate::record::imaol::published_edges(&db).await {
                    allowed = mine
                        .iter()
                        .any(|r| edges.get(r).is_some_and(|e| e.edge.trust.is_some()));
                }
            }
        }
        if !allowed {
            return Err(AppError::Forbidden(crate::msg!(
                "idface.for-trusted-readers-only",
                "the author shares these words only with people they trust"
            )));
        }
    }
    let (hash, mime) = if thumb {
        let Some(t) = thumb_hash else {
            return Err(AppError::NotFound(crate::msg!("idface.this-document-has-no-thumbnail", "this document has no thumbnail")));
        };
        (t, "image/avif")
    } else {
        (
            file_hash,
            crate::record::documents::Format::from_wire(format).mime(),
        )
    };
    // The URL names the DOCUMENT (mutable - editing re-publishes new words under the same
    // doc_id); only the blob underneath is content-addressed. This once said `immutable,
    // max-age=1y`, which promised browsers a year of staleness on every edited post - the
    // "my edit isn't visible until refresh" bug (2026-08-06). The honest shape: the blob
    // hash IS content-addressed, so it makes a perfect ETag - an unchanged body costs a
    // 304 and no bytes, an edited one arrives the moment the card asks.
    let etag = format!("\"{}\"", hex::encode(hash));
    if if_none_match.is_some_and(|inm| inm == etag) {
        return Ok((
            StatusCode::NOT_MODIFIED,
            [
                (header::ETAG, etag.as_str()),
                (header::CACHE_CONTROL, "no-cache"),
            ],
        )
            .into_response());
    }
    let Some(bytes) = state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(hash))
        .await
        .map_err(AppError::Internal)?
    else {
        // A peek at its ceiling never wanted these bytes (PROJECT_PLAN's Peeks, ruling 6): say so, rather
        // than promising bodies that are not on their way.
        if peek_held(state, &root_hex).await && !peek_room(state, &root_hex).await {
            return Err(AppError::NotFound(crate::msg!("idface.this-look-is-full", "this look is full - follow them to keep everything")));
        }
        return Err(AppError::NotFound(crate::msg!("idface.the-bytes-havent-arrived-here", "the bytes haven't arrived here yet - headers travel ahead of bodies")));
    };
    // A sealed body opens at the door (PROJECT_PLAN's Post visibility slice 2b): what the store holds and
    // the network spreads is ciphertext; the trusted reader above has earned the words,
    // and the key comes from the memo - or, first time, from whoever serves the author,
    // over the key lane with its own trust check at the far end.
    let bytes = if trusted_only {
        let doc_bytes: [u8; 16] = hex::decode(doc_hex)
            .ok()
            .and_then(|b| b.try_into().ok())
            .expect("checked above");
        let key = match crate::postkeys::lookup(&state.node_db, &root_hex, doc_hex)
            .await
            .map_err(AppError::Internal)?
        {
            Some(k) => Some(k),
            None => crate::net::fragment::fetch_key(state, &root, &doc_bytes).await,
        };
        let Some(key) = key else {
            return Err(AppError::NotFound(crate::msg!(
                "idface.the-key-hasnt-arrived",
                "the key hasn't arrived here yet - it travels only between trusted computers"
            )));
        };
        let Some(plain) = crate::record::private::open_post_body(&bytes, &key) else {
            return Err(AppError::Internal(anyhow::anyhow!(
                "a sealed body would not open with its own key"
            )));
        };
        plain
    } else {
        bytes
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            // no-cache = "keep a copy, ask before using it": every use revalidates against
            // the ETag, so staleness is bounded by one conditional request, not a year.
            (header::CACHE_CONTROL, "no-cache"),
            (header::ETAG, etag.as_str()),
        ],
        bytes,
    )
        .into_response())
}

pub async fn public_body_route(
    State(state): State<AppState>,
    session: Option<Session>,
    headers: axum::http::HeaderMap,
    Path((seg, doc_hex)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let inm = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    public_doc_bytes(&state, &session, &seg, &doc_hex, false, inm).await
}

/// The decorative-filename twin of the body route: baked embeds mint as
/// `/id/<root>/docs/<doc>/body/media.<ext>` so the renderer's media-kind sniff has an
/// extension to read; the name itself is ignored, exactly like the private twin.
pub async fn public_body_named_route(
    State(state): State<AppState>,
    session: Option<Session>,
    headers: axum::http::HeaderMap,
    Path((seg, doc_hex, _filename)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    let inm = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    public_doc_bytes(&state, &session, &seg, &doc_hex, false, inm).await
}

pub async fn public_thumb_route(
    State(state): State<AppState>,
    session: Option<Session>,
    headers: axum::http::HeaderMap,
    Path((seg, doc_hex)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let inm = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok());
    public_doc_bytes(&state, &session, &seg, &doc_hex, true, inm).await
}

/// GET `/api/id/{root}/profile` - the JSON face. Anonymous callers get the shelf rule (hosted
/// -> the public profile; not carried -> 404: only what the HTML face already shows the whole
/// web). A MEMBER asking about an off-shelf root triggers fetch-and-serve: a demand edge in
/// miniature - funnel 2 with a named human - synced at request time, cached with a TTL,
/// ephemeral by design (the anonymous shelf grows only through durable demand; a fetch here
/// never touches the identities table, so the HTML face still tombstones this root).
/// How many posts a page of the public shelf carries. The profile's first page and the
/// "further back" pages are the same size, so the reader's scroll is even.
pub const POSTS_PAGE: i64 = 20;

#[derive(serde::Deserialize)]
pub struct PostsQuery {
    /// The cursor: the `published_ms` and `doc_id` of the last post already shown.
    pub after_ms: Option<i64>,
    pub after_doc: Option<String>,
    /// The viewing persona's root, hex (see `IdQuery::as_root`).
    #[serde(rename = "as")]
    pub as_root: Option<String>,
}

/// The feed's sealed-post rule, on the shelf (Curtis, 2026-09-05: a trusted-only post from
/// someone who does not trust you "I shouldn't see ... we just hide that"): drop every
/// trusted-only post unless the viewer is the author or the author publishes trust for
/// them. Checked against the author's own published edges as this node holds them; fails
/// closed when it holds none.
async fn hide_sealed(
    state: &AppState,
    session: &Option<Session>,
    author_hex: &str,
    viewer: Option<&str>,
    posts: &mut Vec<crate::record::documents::PublicDoc>,
) {
    if !posts.iter().any(|p| p.trusted_only) || viewer == Some(author_hex) {
        return;
    }
    // No viewer named, a member session, and the author lives here: the author's own
    // reads (their page, their shelf) name no viewer and must see their own sealed posts.
    if viewer.is_none() && session.is_some() && hosted_here(state, author_hex).await.unwrap_or(false) {
        return;
    }
    let trusted = match (viewer, state.user_dbs.get(author_hex).await) {
        (Some(v), Ok(Some(db))) => crate::record::imaol::published_edges(&db)
            .await
            .map(|e| e.get(v).is_some_and(|row| row.edge.trust.is_some()))
            .unwrap_or(false),
        _ => false,
    };
    if !trusted {
        posts.retain(|p| !p.trusted_only);
    }
}

/// GET `/api/id/{root}/posts` - further back down someone's public shelf.
///
/// The shelf rule, same as the profile's: anonymous callers get personas this node HOSTS, and
/// nothing else. A member may page a foreign persona too, but only one this node has already
/// reached - paging is a continuation of a visit, so it reads what an earlier fetch brought
/// home rather than reaching across the network again per page turn.
/// The shelf rule, shared by the paged and single-post reads: anonymous callers get personas
/// this node HOSTS, and nothing else. A member may also read a foreign persona this node has
/// already reached - a visit's continuation, never a fresh reach - and a SPECULATIVELY held
/// one (speculative.rs): the quiet mirror serves nobody over the network, but its own node's
/// members reading it was never serving - that is the whole reason it was pulled.
async fn shelf_readable(
    state: &AppState,
    session: &Option<Session>,
    root_hex: &str,
) -> Result<bool, AppError> {
    if hosted_here(state, root_hex).await? {
        return Ok(true);
    }
    if session.is_none() {
        return Ok(false);
    }
    Ok(foreign_fetch_row(state, root_hex).await?.is_some()
        || crate::speculative::fetched_at(&state.node_db, root_hex)
            .await
            .map_err(AppError::Internal)?
            .is_some())
}

pub async fn id_posts(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<PostsQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-2", "no such persona here")));
    };
    let root_hex = hex::encode(root);
    let missing = || AppError::NotFound(crate::msg!("idface.no-such-persona-here-3", "no such persona here"));
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(missing());
    }
    // A cursor that doesn't parse is a bad REQUEST, and says so: answering "no such persona"
    // to a malformed doc_id sends the reader looking for the wrong problem entirely (it did:
    // this was written against a 32-byte id, and document ids are 16).
    let after = match (query.after_ms, query.after_doc.as_deref()) {
        (Some(ms), Some(doc)) => {
            let bad = || AppError::BadRequest(crate::msg!("idface.that-cursor-isnt-a-document", "that cursor isn't a document id"));
            let raw = hex::decode(doc).map_err(|_| bad())?;
            let id: [u8; 16] = raw.try_into().map_err(|_| bad())?;
            Some((ms, id))
        }
        _ => None,
    };
    // One more than the page, to learn whether there IS a further page without counting the
    // whole shelf - the extra row is the answer and never reaches the reader.
    let dbh = state.user_dbs.get(&root_hex).await.ok().flatten();
    let hosted_here = crate::identity::is_agented(&state.node_db, &root_hex).await.unwrap_or(false);
    let posts = if !hosted_here && peek_held(&state, &root_hex).await {
        touch_look(&state, &root_hex).await;
        // A peek's shelf is the fragment ledger's (PROJECT_PLAN's Peeks, ruling 4): one page, no further.
        if after.is_some() {
            Vec::new()
        } else {
            crate::fragments::shelf_of(&state.node_db, &root_hex, POSTS_PAGE)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|p| p.part_of.is_none())
                .collect()
        }
    } else {
        match &dbh {
            Some(db) => crate::record::documents::public_docs(db, after, POSTS_PAGE + 1)
                .await
                .unwrap_or_default()
                .into_iter()
                // Pages stay off the shelf too (PROJECT_PLAN's Books, ruling 4): the book lists them.
                .filter(|p| p.part_of.is_none())
                .collect(),
            None => Vec::new(), // nothing held, or unreadable: an empty shelf either way
        }
    };
    let mut posts = posts;
    // Scrollback backfills on demand (PROJECT_PLAN's Peeks, ruling 8): a page that came up short on a
    // follow held from a floor asks the author's nodes for what lies beneath, then reads
    // again - the reader paging back is the demand.
    if !hosted_here
        && session.is_some()
        && posts.len() as i64 <= POSTS_PAGE
        && posts_floor(&state, &root_hex).await > 0
        && tokio::time::timeout(std::time::Duration::from_secs(8), backfill(&state, &root_hex)).await.unwrap_or(false)
    {
        if let Some(db) = &dbh {
            posts = crate::record::documents::public_docs(db, after, POSTS_PAGE + 1)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|p| p.part_of.is_none())
                .collect();
        }
    }
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut posts).await;
    // The persona's SHARES join the shelf (Curtis, 2026-09-02: the page defaults to
    // everything - posts, rebroadcasts, replies - and the client's toggles subtract).
    // Same stamp-keyset cursor as the posts, stamped by when they passed it along; a
    // withdrawn pointer is a tombstone and stays off. Titles resolve from the fragment
    // shelf this node's own share machinery keeps - node.db only, no per-author opens.
    let mut shares = match &dbh {
        Some(db) => crate::record::imaol::rebroadcasts(db).await.unwrap_or_default(),
        None => Vec::new(),
    };
    shares.retain(|s| s.version_seen.is_some());
    if let Some((ms, doc)) = &after {
        let doc_hex = hex::encode(doc);
        shares.retain(|s| {
            s.received_at_ms < *ms
                || (s.received_at_ms == *ms && hex::encode(s.doc_id) > doc_hex)
        });
    }
    shares.truncate((POSTS_PAGE + 1) as usize); // the view is already newest-first
    enum Shelf {
        Post(usize),
        Share(usize),
    }
    let mut merged: Vec<(i64, String, Shelf)> = Vec::with_capacity(posts.len() + shares.len());
    for (i, p) in posts.iter().enumerate() {
        // The DISPLAY stamp (PUBLISH.md): a dated post files under its claimed day here as
        // everywhere - the query already ordered by it; the merge must not undo that.
        merged.push((p.display_ms(), hex::encode(p.doc_id), Shelf::Post(i)));
    }
    for (i, s) in shares.iter().enumerate() {
        merged.push((s.received_at_ms, hex::encode(s.doc_id), Shelf::Share(i)));
    }
    merged.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let more = merged.len() as i64 > POSTS_PAGE;
    merged.truncate(POSTS_PAGE as usize);
    // The reply counts, one page-scoped memo read for the whole shelf page.
    let pairs: Vec<(String, String)> = posts
        .iter()
        .map(|p| (root_hex.clone(), hex::encode(p.doc_id)))
        .collect();
    let counts = crate::replies::known_counts(&state.node_db, &pairs)
        .await
        .unwrap_or_default();
    let mut items: Vec<serde_json::Value> = Vec::with_capacity(merged.len());
    for (_, _, which) in &merged {
        items.push(match which {
            Shelf::Post(i) => {
                let p = &posts[*i];
                let n = counts
                    .get(&(root_hex.clone(), hex::encode(p.doc_id)))
                    .copied()
                    .unwrap_or(0);
                post_json(p, n)
            }
            Shelf::Share(i) => {
                let s = &shares[*i];
                let doc_hex = hex::encode(s.doc_id);
                let header = crate::fragments::serving_header(&state.node_db, &s.author_root, &s.doc_id)
                    .await
                    .ok()
                    .flatten();
                serde_json::json!({
                    "kind": "share",
                    "author": s.author_root,
                    "doc_id": doc_hex,
                    "title": header.as_ref().map(|h| h.title.clone()),
                    "format": header
                        .as_ref()
                        .map(|h| crate::record::documents::Format::from_wire(h.format).as_str()),
                    "published_ms": s.received_at_ms,
                    "shared_ms": s.received_at_ms,
                    "via": root_hex,
                })
            }
        });
    }
    attach_annotations(&state, &root_hex, &mut items).await;
    // Replies say what they answer (Curtis, 2026-09-02: the list "doesn't make it obvious
    // what the replies are replies to"): dress each reply's parent link with a title and a
    // byline - the author's own shelf for same-shelf parents, the fragment shelf for
    // foreign ones, never a fresh per-author open.
    {
        let mut parents: Vec<(String, String)> = Vec::new();
        for v in items.iter() {
            if let (Some(pa), Some(pd)) = (
                v["reply_to"]["author"].as_str(),
                v["reply_to"]["doc_id"].as_str(),
            ) {
                parents.push((pa.to_string(), pd.to_string()));
            }
        }
        if !parents.is_empty() {
            let bylines = crate::profiles::bylines(
                &state.node_db,
                &parents.iter().map(|(a, _)| a.clone()).collect::<Vec<_>>(),
            )
            .await
            .unwrap_or_default();
            let mut cards: std::collections::HashMap<(String, String), (Option<String>, Option<i64>)> =
                Default::default();
            for (pa, pd) in &parents {
                let Some(id) = hex::decode(pd)
                    .ok()
                    .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
                else {
                    continue;
                };
                // The parent's card: this author's own shelf, any OTHER author's shelf this
                // node holds (the reader's own post, a friend's - Curtis, 2026-09-05: "we
                // know about that post, because it's ours"), then the fragment ledger.
                let resolved: Option<(Option<String>, Option<i64>)> = if *pa == root_hex {
                    match &dbh {
                        Some(db) => crate::record::documents::public_doc(db, &id)
                            .await
                            .ok()
                            .flatten()
                            .map(|d| (Some(d.title), Some(d.genesis_ms))),
                        None => None,
                    }
                } else {
                    let held = match state.user_dbs.get(pa).await {
                        Ok(Some(db)) => crate::record::documents::public_doc(&db, &id)
                            .await
                            .ok()
                            .flatten()
                            .map(|d| (Some(d.title), Some(d.genesis_ms))),
                        _ => None,
                    };
                    match held {
                        Some(card) => Some(card),
                        None => crate::fragments::serving_header(&state.node_db, pa, &id)
                            .await
                            .ok()
                            .flatten()
                            .map(|h| (Some(h.title), None)),
                    }
                };
                if let Some((title, ms)) = resolved {
                    cards.insert((pa.clone(), pd.clone()), (title, ms));
                }
            }
            for v in items.iter_mut() {
                let (Some(pa), Some(pd)) = (
                    v["reply_to"]["author"].as_str().map(String::from),
                    v["reply_to"]["doc_id"].as_str().map(String::from),
                ) else {
                    continue;
                };
                let (title, ms) = cards.get(&(pa.clone(), pd.clone())).cloned().unwrap_or((None, None));
                v["reply_to"] = serde_json::json!({
                    "author": pa,
                    "doc_id": pd,
                    "name": bylines.get(&pa).and_then(|b| b.name.clone()),
                    "title": title,
                    "published_ms": ms,
                });
            }
        }
    }
    Ok(axum::Json(serde_json::json!({
        "posts": items,
        "more": more,
    }))
    .into_response())
}

/// Attach every known label to a page of post JSON (PROJECT_PLAN's Public annotations, slice 2's read, on the
/// two surfaces that missed it): one page-scoped memo read, bylines for the annotators,
/// the author's own labels first. The reader's display register filters at the client.
async fn attach_annotations(
    state: &AppState,
    root_hex: &str,
    posts: &mut [serde_json::Value],
) {
    let pairs: Vec<(String, String)> = posts
        .iter()
        .filter_map(|v| v["doc_id"].as_str().map(|d| (root_hex.to_string(), d.to_string())))
        .collect();
    let Ok(known) = crate::annotations::for_posts(&state.node_db, &pairs).await else {
        return;
    };
    if known.is_empty() {
        return;
    }
    let annotators: Vec<String> = known
        .values()
        .flatten()
        .map(|a| a.annotator.clone())
        .collect();
    let bylines = crate::profiles::bylines(&state.node_db, &annotators)
        .await
        .unwrap_or_default();
    for v in posts.iter_mut() {
        let Some(doc) = v["doc_id"].as_str().map(String::from) else {
            continue;
        };
        let Some(list) = known.get(&(root_hex.to_string(), doc)) else {
            continue;
        };
        v["annotations"] = serde_json::json!(list
            .iter()
            .map(|a| serde_json::json!({
                "annotator_name": bylines.get(&a.annotator).and_then(|b| b.name.clone()),
                "annotator": a.annotator,
                "key": a.key,
                "value": a.value,
            }))
            .collect::<Vec<_>>());
    }
}

/// One post, as every surface reports it. `replies` is the honest-partial count from
/// this node's memo (`replies::known_counts`) - absent when zero, so a surface that knows
/// nothing renders exactly as before.
fn post_json(p: &crate::record::documents::PublicDoc, replies: i64) -> serde_json::Value {
    let link = |l: &Option<(String, String)>| {
        l.as_ref()
            .map(|(author, doc)| serde_json::json!({ "author": author, "doc_id": doc }))
    };
    serde_json::json!({
        "settled": if p.settled { Some(true) } else { None },
        "trusted_only": if p.trusted_only { Some(true) } else { None },
        "replies": if replies > 0 { Some(replies) } else { None },
        "reply_to": link(&p.reply_to),
        "thread_root": link(&p.thread_root),
        "doc_id": hex::encode(p.doc_id),
        "title": p.title,
        "format": crate::record::documents::Format::from_wire(p.format).as_str(),
        // When it was first said - what it is dated by and sorted by. A re-publication
        // improves a post; it does not make a new one, and does not move it.
        "published_ms": p.display_ms(),
        // The preferred date when one was claimed, and the mint moment beside it - the edit
        // window's anchor, and the dossier's honest "when it was actually said".
        "dated_ms": p.dated_ms,
        "minted_ms": p.genesis_ms,
        // The book this is a page of (PROJECT_PLAN's Books), when it is one.
        "part_of": p.part_of.map(hex::encode),
        "updated_ms": p.head_ms,
        // Whether a re-publication would still be honoured (PROJECT_PLAN: the edit window
        // anchors on the mint) - Writer's publish bar offers "update" only while it is.
        "edit_window_open": crate::clock::now_ms()
            < p.genesis_ms + crate::record::documents::edit_window_ms(),
        "thumb": p.thumb_hash.map(hex::encode),
    })
}

/// GET `/api/id/{root}/posts/{doc}` - one post, by id: the permalink's read (2026-08-25).
/// The same shelf rule as the page, and the same honest 404 for never-was, private, and
/// taken-down alike - a post that is not on the public shelf is not a post here.
pub async fn id_post(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-8", "no such persona here")));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-9", "no such persona here")));
    }
    let doc_id: [u8; 16] = hex::decode(&doc)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| {
            AppError::BadRequest(crate::msg!("idface.that-isnt-a-document-id", "that isn't a document id"))
        })?;
    let db_for_labels = match state.user_dbs.get(&root_hex).await {
        Ok(Some(db)) => db,
        _ => {
            return Err(AppError::NotFound(crate::msg!("idface.no-such-post-here-2", "no such post here")));
        }
    };
    let mut post = crate::record::documents::public_doc(&db_for_labels, &doc_id).await?;
    // A peek's permalink (PROJECT_PLAN's Peeks, ruling 4 and 5): the mirror has no posts lane, so the
    // fragment ledger answers - fetched by id right now if the peek never held it.
    let mut fragment_refs: Option<Vec<[u8; 16]>> = None;
    let peek_here = peek_held(&state, &root_hex).await;
    // A peek's permalink, or a follow's beneath its floor - never a whole mirror's missing
    // document, which is missing for a reason (retracted, disproven).
    let beneath_floor = !peek_here
        && !hosted_here(&state, &root_hex).await.unwrap_or(false)
        && posts_floor(&state, &root_hex).await > 0;
    if post.is_none() && (peek_here || beneath_floor) {
        if peek_here {
            touch_look(&state, &root_hex).await;
        }
        // A peek's permalink, or a follow's beneath its floor (PROJECT_PLAN's Peeks, ruling 4, 8, 13):
        // the ledger answers, fetched by id right now if it never held the document.
        if crate::fragments::held(&state.node_db, &root_hex, &doc).await.ok().flatten().is_none()
            && (!peek_here || peek_room(&state, &root_hex).await)
        {
            crate::fragments::fetch_post(&state, &root_hex, &root, &doc_id).await;
        }
        if let Some((p, refs)) = crate::fragments::public_doc_of(&state.node_db, &root_hex, &doc)
            .await
            .map_err(AppError::Internal)?
        {
            fragment_refs = Some(refs);
            post = Some(p);
        }
    }
    match post {
        Some(p) => {
            let n = crate::replies::known_counts(
                &state.node_db,
                &[(root_hex.clone(), hex::encode(p.doc_id))],
            )
            .await
            .unwrap_or_default()
            .values()
            .copied()
            .next()
            .unwrap_or(0);
            // The author's own public annotations ride the permalink read (PROJECT_PLAN's Public annotations
            // slice 1) - from the author's shelf, so a mirror-holding node answers too.
            let mut v = post_json(&p, n);
            // The refs are public facts (they ride the signed header and every fragment);
            // naming them here lets a reader's renderer - and the twins acceptance - ask
            // for exactly the documents the post embeds.
            if let Some(refs) = &fragment_refs {
                v["refs"] = serde_json::json!(refs.iter().map(hex::encode).collect::<Vec<_>>());
            } else if let Ok(Some(entry)) =
                crate::record::documents::public_header_entry(&db_for_labels, &doc_id).await
            {
                if let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload {
                    if let Ok(h) = ringtome_proto::registry::DocHeaderPlain::decode(payload) {
                        v["refs"] = serde_json::json!(h
                            .refs
                            .iter()
                            .map(hex::encode)
                            .collect::<Vec<_>>());
                    }
                }
            }
            // The author's own statements straight off their shelf (read-your-writes for a
            // fresh publish), merged with everything the memo knows - others' labels with
            // their annotator (PROJECT_PLAN's Public annotations, slice 2). Names ride from the byline cache.
            let doc_hex = hex::encode(p.doc_id);
            let mut labels: Vec<(String, String, String)> = Vec::new();
            if let Ok(rows) =
                crate::record::imaol::annotations_of(&db_for_labels, &root_hex, &p.doc_id).await
            {
                labels.extend(rows.into_iter().map(|r| (root_hex.clone(), r.key, r.value)));
            }
            if let Ok(known) = crate::annotations::for_posts(
                &state.node_db,
                &[(root_hex.clone(), doc_hex.clone())],
            )
            .await
            {
                for a in known.into_values().flatten() {
                    let row = (a.annotator, a.key, a.value);
                    if !labels.contains(&row) {
                        labels.push(row);
                    }
                }
            }
            let annotators: Vec<String> = labels.iter().map(|(a, _, _)| a.clone()).collect();
            let bylines = crate::profiles::bylines(&state.node_db, &annotators)
                .await
                .unwrap_or_default();
            v["annotations"] = serde_json::json!(labels
                .into_iter()
                .map(|(annotator, key, value)| serde_json::json!({
                    "annotator_name": bylines.get(&annotator).and_then(|b| b.name.clone()),
                    "annotator": annotator,
                    "key": key,
                    "value": value,
                }))
                .collect::<Vec<_>>());
            Ok(axum::Json(v).into_response())
        }
        None => Err(AppError::NotFound(crate::msg!("idface.no-such-post-here", "no such post here"))),
    }
}

/// GET `/api/id/{root}/posts/{doc}/replies` - one page of the post's DIRECT replies as
/// this node knows them (PROJECT_PLAN's Replies slice 2: assembly is honest-partial, and the copy
/// says "replies known here"). Same shelf rule as the post itself; keyset by
/// (claimed_ms, reply_doc), oldest first.
pub async fn id_post_replies(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<RepliesQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-10", "no such persona here")));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-11", "no such persona here")));
    }
    if hex::decode(&doc).map(|b| b.len()) != Ok(16) {
        return Err(AppError::BadRequest(crate::msg!("idface.that-isnt-a-document-id-2", "that isn't a document id")));
    }
    let after = match (query.after_ms, query.after_doc) {
        (Some(ms), Some(d)) => Some((ms, d)),
        _ => None,
    };
    // A settled parent's thread door is shut (PROJECT_PLAN's Post visibility): a node that can see the
    // header serves no replies and does not go asking for more.
    if let Ok(Some(db)) = state.user_dbs.get(&root_hex).await {
        if let Ok(doc_bytes) = hex::decode(&doc) {
            if let Ok(doc_id) = <[u8; 16]>::try_from(doc_bytes.as_slice()) {
                if let Ok(Some(p)) = crate::record::documents::public_doc(&db, &doc_id).await {
                    if p.settled {
                        return Ok(axum::Json(serde_json::json!({
                            "replies": [], "more": false, "seeking": false, "settled": true,
                        }))
                        .into_response());
                    }
                }
            }
        }
    }
    let (mut replies, more) = crate::replies::replies_of(&state.node_db, &root_hex, &doc, after)
        .await
        .map_err(AppError::Internal)?;

    // Curation is the same bit as display (PROJECT_PLAN's Replies slice 6): when the post's author
    // lives HERE, this public read speaks with the author's own voice, so it holds back
    // exactly what the door would - a stranger's reply waits for the nod, a suppressed one
    // stays quiet. The author's own view (session-owned, routes.rs) sees everything,
    // pending marked; other nodes' memos only ever learned what some door already served.
    let hosted = hosted_here(&state, &root_hex).await?;
    if hosted {
        let mut served = Vec::with_capacity(replies.len());
        for r in replies {
            if crate::replies::servable(&state, &root_hex, &r.author, &r.doc_id).await {
                served.push(r);
            }
        }
        replies = served;
    }

    // The reading side (slice 6): visiting the permalink IS the demand. For a foreign
    // author, ask their door behind this render - budget-capped by the cursor table's
    // cooldown, `refresh=1` the human's deliberate re-ask - and say so, so the UI can show
    // its quiet "looking for more of the conversation" and look again.
    let mut seeking = false;
    if !hosted && session.is_some() {
        let force = query.refresh.unwrap_or(0) != 0;
        if let Some(since) =
            crate::replies::should_ask(&state.node_db, &root_hex, &doc, force).await
        {
            seeking = true;
            let state = state.clone();
            let (author_hex, doc_hex) = (root_hex.clone(), doc.clone());
            tokio::spawn(async move {
                let Ok(doc_bytes) = hex::decode(&doc_hex) else { return };
                let Ok(doc_id) = <[u8; 16]>::try_from(doc_bytes.as_slice()) else { return };
                if let Some((verified, cursor)) =
                    crate::net::fragment::fetch_replies(&state, &root, &doc_id, since).await
                {
                    crate::replies::learn(&state, &author_hex, &doc_hex, verified).await;
                    let _ =
                        crate::replies::record_ask(&state.node_db, &author_hex, &doc_hex, cursor)
                            .await;
                }
            });
        }
    }
    // The repliers' bylines ride the answer (Curtis, 2026-09-05: a trusted-but-unread
    // replier rendered as their speakable words): the page's own mirror knows only the
    // people the reader follows, and this node knows everyone it holds.
    let authors: Vec<String> = replies
        .iter()
        .map(|r| r.author.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let bylines: serde_json::Map<String, serde_json::Value> = crate::profiles::bylines_healed(&state, &authors)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(root, b)| (root, serde_json::json!({ "name": b.name, "avatar": b.avatar })))
        .collect();
    Ok(axum::Json(serde_json::json!({ "replies": replies, "more": more, "seeking": seeking, "bylines": bylines }))
        .into_response())
}

/// GET `/api/id/{root}/posts/{doc}/dossier` - the post's forensic ledger (Curtis,
/// 2026-08-31): everything THIS node knows about the post, its replies and its labels, and
/// crucially, which ROAD taught the node each fact. Every statement in the network is
/// signed, but carriage was anonymous; a reader who feels harassed reads this to
/// reverse-engineer the peer that has been rubber-stamping the traffic in. Deliberately
/// dense and unpolished: it is a log, not a page.
pub async fn id_post_dossier(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-12", "no such persona here")));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-13", "no such persona here")));
    }
    if hex::decode(&doc).map(|b| b.len()) != Ok(16) {
        return Err(AppError::BadRequest(crate::msg!("idface.that-isnt-a-document-id-3", "that isn't a document id")));
    }
    let hosted = hosted_here(&state, &root_hex).await?;

    // The post's own shelf facts, when a shelf here holds it.
    let mut post_v = serde_json::Value::Null;
    let doc_id: [u8; 16] = hex::decode(&doc)
        .ok()
        .and_then(|b| b.try_into().ok())
        .expect("length-checked above");
    if let Ok(Some(db)) = state.user_dbs.get(&root_hex).await {
        if let Ok(Some(p)) = crate::record::documents::public_doc(&db, &doc_id).await {
            post_v = post_json(&p, 0);
        }
    }

    // Every reply row the memo holds for this post - the owning module's ledger read - and
    // (when the author lives here) the door's verdict per row.
    let rows = crate::replies::ledger_for(&state.node_db, &root_hex, &doc)
        .await
        .map_err(AppError::Internal)?;
    let mut replies = Vec::with_capacity(rows.len());
    for (author, rdoc, direct, claimed_ms, noted_ms, learned_via) in rows {
        let served = if hosted {
            Some(crate::replies::servable(&state, &root_hex, &author, &rdoc).await)
        } else {
            None
        };
        replies.push(serde_json::json!({
            "author": author,
            "doc_id": rdoc,
            "direct": direct,
            "claimed_ms": claimed_ms,
            "noted_ms": noted_ms,
            "learned_via": learned_via,
            "served": served,
        }));
    }

    // Every label the memo holds, its road, and whether the proof is kept servable onward
    // (a kept proof means this node RELAYS it - carriage, named).
    let (labels, kept) = crate::annotations::ledger_for(&state.node_db, &root_hex, &doc)
        .await
        .map_err(AppError::Internal)?;

    let mut names: Vec<String> = labels.iter().map(|(a, ..)| a.clone()).collect();
    names.extend(replies.iter().filter_map(|r| r["author"].as_str().map(String::from)));
    let bylines = crate::profiles::bylines_healed(&state, &names)
        .await
        .unwrap_or_default();

    let annotations: Vec<serde_json::Value> = labels
        .into_iter()
        .map(|(annotator, key, value, noted_ms, learned_via)| {
            serde_json::json!({
                "annotator_name": bylines.get(&annotator).and_then(|b| b.name.clone()),
                "proof_kept": kept.contains(&(annotator.clone(), key.clone(), value.clone())),
                "annotator": annotator,
                "key": key,
                "value": value,
                "noted_ms": noted_ms,
                "learned_via": learned_via,
            })
        })
        .collect();
    let reply_names: serde_json::Value = serde_json::json!(replies
        .iter()
        .filter_map(|r| r["author"].as_str())
        .filter_map(|a| bylines.get(a).and_then(|b| b.name.clone()).map(|n| (a.to_string(), n)))
        .collect::<std::collections::BTreeMap<String, String>>());

    Ok(axum::Json(serde_json::json!({
        "hosted": hosted,
        "post": post_v,
        "replies": replies,
        "reply_names": reply_names,
        "annotations": annotations,
    }))
    .into_response())
}

#[derive(serde::Deserialize)]
pub struct RepliesQuery {
    pub after_ms: Option<i64>,
    pub after_doc: Option<String>,
    /// The refresh affordance: a human asking the author's door again on purpose.
    pub refresh: Option<u8>,
}

pub async fn id_profile(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<IdQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-4", "no such persona here")));
    };
    let root_hex = hex::encode(root);
    let hosted = hosted_here(&state, &root_hex).await?;

    // Whether a refresh is running behind this response, so the caller knows to look again, and
    // when this node last successfully reached them. Both are honest only for a FOREIGN
    // persona: one we host has no "last synced" - its words are written here.
    let mut refreshing = false;
    let mut synced_ms: Option<i64> = None;
    if !hosted {
        let Some(_member) = session.as_ref() else {
            return Err(AppError::NotFound(crate::msg!("idface.no-such-persona-here-5", "no such persona here")));
        };
        let now = crate::clock::now_ms();
        let row = foreign_fetch_row(&state, &root_hex).await?;
        // Candidates: the address's own hints first, then the endpoint that answered last time
        // (the durable half of the ladder - it works even when the URL was typed bare, and it
        // is what keeps a quiet identity reachable after every friendly node has rebooted).
        let mut via: Vec<String> = query
            .via
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if let Some((_, Some(last))) = &row {
            if !via.contains(last) {
                via.push(last.clone());
            }
        }
        // A speculative mirror (speculative.rs) may hold them even when no member ever asked.
        let speculative_at = crate::speculative::fetched_at(&state.node_db, &root_hex)
            .await
            .map_err(AppError::Internal)?;
        match &row {
            // Held by the quiet pull: serve what it brought home, exactly like a member
            // fetch. No revalidation spawns here - freshness for speculative content is the
            // acquisition pass's own slow beat, at lower priority than real follows
            // (PROJECT_PLAN's Discovery), and a page view must not promote a hunch into a dial loop.
            None if speculative_at.is_some() => {
                synced_ms = speculative_at;
            }
            // Nothing held: there is nothing to serve stale, so this one waits. A first visit
            // to a stranger is the only case that pays the network's latency.
            None => {
                synced_ms = Some(now); // this request IS the sync; saying so beats saying nothing
                if !fetch_foreign(&state, &root_hex, &via).await {
                    return Err(AppError::NotFound(crate::msg!("idface.not-carried-here-and-none", "not carried here, and none of the address's computers answered")));
                }
                // A peek's shelf is still landing behind this answer: say so, and the page
                // keeps asking until it has arrived.
                refreshing = state.refreshing.lock().unwrap().contains(&root_hex);
            }
            // Something held: answer NOW and revalidate behind it. A visit is the demand
            // signal the pull model is built on, so it always means "go and look" - but the
            // reader should not wait on a stranger's node to find that out.
            Some((at, _)) => {
                synced_ms = Some(*at);
                if now - at >= FOREIGN_REVALIDATE_MS {
                    refreshing = spawn_revalidate(&state, root_hex.clone(), via);
                }
                refreshing = refreshing || state.refreshing.lock().unwrap().contains(&root_hex);
            }
        }
    }

    let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
    // What they have PUBLISHED - the public lane's documents, newest first. Keyless and
    // lane-checked like everything on this surface; a private note cannot appear here
    // because the query cannot name one.
    // A PEEK (PROJECT_PLAN's Peeks, ruling 4) holds no posts chain: its shelf is the fragment ledger's -
    // the newest posts the peek fetched, each the author's own signed header.
    let peek = !hosted && peek_held(&state, &root_hex).await;
    let mut peek_full = false;
    if peek {
        touch_look(&state, &root_hex).await;
        peek_full = !peek_room(&state, &root_hex).await;
    }
    let mut posts: Vec<crate::record::documents::PublicDoc> = if peek {
        crate::fragments::shelf_of(&state.node_db, &root_hex, POSTS_PAGE)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.part_of.is_none())
            .collect()
    } else {
        match state.user_dbs.get(&root_hex).await {
            Ok(Some(db)) => crate::record::documents::public_docs(&db, None, POSTS_PAGE + 1)
                .await
                .unwrap_or_default()
                .into_iter()
                // Pages stay off this shelf as off the other (PROJECT_PLAN's Books, ruling 4).
                .filter(|p| p.part_of.is_none())
                .collect(),
            _ => Vec::new(), // nothing held, or unreadable: an empty shelf either way
        }
    };
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut posts).await;
    let posts_more = posts.len() as i64 > POSTS_PAGE;
    posts.truncate(POSTS_PAGE as usize);
    // The pinned strip (PROJECT_PLAN's Peeks, ruling 12): the author's own pins, most recently pinned
    // first, each the post as this node holds it - the mirror's, or for a peek the ledger's.
    let mut pinned: Vec<crate::record::documents::PublicDoc> = pinned_here(&state, &root_hex, peek).await;
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut pinned).await;
    // How to REACH this persona, as this node honestly knows it - the `?via=` hints any
    // address minted here should carry (Addressing: hints are keys, never addresses).
    //
    // Hosted: this node serves them to anyone, so it hints ITSELF first, then their
    // liveliest known peers. NOT hosted: this node serves them to nobody (fetch-and-serve
    // is member-scoped and the anonymous face still tombstones them), so hinting itself
    // would hand strangers a dead end - the honest hints are the ones that reached them,
    // whatever the caller's URL carried plus the endpoint that last answered for them.
    let mut via: Vec<String> = Vec::new();
    if hosted {
        via.push(state.endpoint.id().to_string());
        via.extend(
            crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 16)
                .await
                .unwrap_or_default(),
        );
    } else {
        via.extend(
            query
                .via
                .as_deref()
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter_map(speakable::node_key_from_via),
        );
        if let Some((_, Some(last))) = foreign_fetch_row(&state, &root_hex).await? {
            via.push(last);
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let via: Vec<String> = via
        .into_iter()
        .filter(|k| seen.insert(k.clone()))
        .take(10)
        .filter_map(|k| speakable::node_key_b58(&k))
        .collect();

    // The profile's first shelf page carries reply counts like every other post surface.
    let count_pairs: Vec<(String, String)> = posts
        .iter()
        .map(|p| (root_hex.clone(), hex::encode(p.doc_id)))
        .collect();
    let reply_counts = crate::replies::known_counts(&state.node_db, &count_pairs)
        .await
        .unwrap_or_default();
    let mut profile_posts: Vec<serde_json::Value> = posts
        .iter()
        .map(|p| {
            let n = reply_counts
                .get(&(root_hex.clone(), hex::encode(p.doc_id)))
                .copied()
                .unwrap_or(0);
            post_json(p, n)
        })
        .collect();
    attach_annotations(&state, &root_hex, &mut profile_posts).await;
    let mut pinned_posts: Vec<serde_json::Value> = pinned.iter().map(|p| post_json(p, 0)).collect();
    attach_annotations(&state, &root_hex, &mut pinned_posts).await;

    Ok(axum::Json(serde_json::json!({
        "root": root_hex,
        "speakable": speakable::speakable(&root),
        "foreign": !hosted,
        // A look, not a mirror (PROJECT_PLAN's Peeks, ruling 9): nobody here follows them, so this node
        // holds their identity, profile, labels and newest posts, and no history.
        "peek": peek,
        // The look is at its ceiling (PROJECT_PLAN's Peeks, ruling 6): what is here stays, nothing more
        // is fetched, and following them is the way to the rest.
        "peek_full": peek_full,
        // Whether an address minted here may wear this node's ORIGIN: only for personas it
        // actually serves. A foreign persona's address mints origin-free, which re-homes at
        // whatever node the reader has.
        "hosted": hosted,
        "via": via,
        // A refresh is running behind this answer: what you are reading may be a moment old,
        // and asking again shortly will say so honestly either way.
        "refreshing": refreshing,
        // When this node last reached them, for a persona it does not host. Absent for one it
        // does: a persona we host has no "last synced" - its words are written here.
        "synced_ms": synced_ms,
        "posts": profile_posts,
        // The pinned strip (PROJECT_PLAN's Peeks, ruling 12): above the shelf, in place in it still.
        "pinned": pinned_posts,
        // Whether the shelf goes further back than this first page.
        "posts_more": posts_more,
        "fields": fields.iter().map(|f| serde_json::json!({
            "field": f.field, "value": f.value,
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}

#[cfg(test)]
mod refresh_order_tests {
    use super::*;

    fn cand(foreign: &str, active: bool, eagerness: i64, fetched_at: i64) -> RefreshCandidate {
        RefreshCandidate { foreign: foreign.into(), active, eagerness, fetched_at }
    }

    #[test]
    fn present_humans_outrank_every_dial_setting() {
        // A node waking with a hundred users serves the ones actually here first: an active
        // follower's mild interest beats an absent follower's obsession.
        let order = order_refresh(vec![
            cand("absent-obsessed", false, 100, 0),
            cand("present-mild", true, 10, 0),
        ]);
        assert_eq!(order, vec!["present-mild".to_string(), "absent-obsessed".to_string()]);
    }

    #[test]
    fn within_presence_the_dial_ranks_and_staleness_breaks_ties() {
        let order = order_refresh(vec![
            cand("low-dial", true, 20, 0),
            cand("high-dial", true, 90, 0),
            cand("high-dial-fresher", true, 90, 500),
        ]);
        assert_eq!(
            order,
            vec![
                "high-dial".to_string(),        // same dial, stalest first
                "high-dial-fresher".to_string(),
                "low-dial".to_string(),
            ]
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The visit registry answers the DOOR's question (has this node fetched-and-carried
    /// them), agelessly; retention is the eviction grace's business, not this table's
    /// (2026-08-25 - the aged-visit detour and its revert are in HISTORY).
    #[tokio::test]
    async fn the_visit_registry_is_ageless_and_the_doors() {
        let db = crate::db::test_node_db().await;
        let now = crate::clock::now_ms();
        for (root, at) in [("aa11", now - 10_000), ("bb22", now - 100)] {
            db.execute(
                "INSERT INTO foreign_fetches (root_pubkey, fetched_at_ms) VALUES (?1, ?2)",
                (root, at),
            )
            .await
            .unwrap();
        }
        let all = fetched_roots(&db).await.unwrap();
        assert_eq!(all.len(), 2, "the ageless list still serves the door's question");
    }
}
