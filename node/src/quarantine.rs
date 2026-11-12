//! Quarantine (plans/SCANNING.md, step 1): what an operator does the moment they find out a
//! picture on their node is one no one should hold - from a report, a match they hear about, or
//! their own eyes.
//!
//! One action, on any blob the node holds: **seal** it. The bytes are kept, never deleted -
//! preserving them can be a legal duty - and from that moment nothing on the node reads, fetches,
//! stores again or serves them: not the web, not the app, not a peer (`files::FileStore::seal`, which
//! every read and the blob protocol's door consult). The reaper keeps them while they're sealed,
//! whatever still points at them. **Release** unseals; the row stays, with who and when, as the
//! record of what the node held and did.
//!
//! **The refusal list** (plans/SCANNING.md, step 3): each sealed picture's PDQ fingerprint
//! (media/pdq.rs), kept beside its row and never published. An upload whose crushed body comes
//! near one is refused before it's kept (ingest.rs); a public picture that lands here near one -
//! from a peer, or a publish - is sealed on arrival ([`arrived`]), so it is refused at sync and at
//! serve from then on.
//!
//! The node never fetches a picture by itself to look at it: quarantine names what is already
//! here, or what a report names, and seals the hash whether or not the bytes are here yet - so
//! they never arrive.
//!
//! Owns the `quarantine` SQL (tests/conventions.rs).

use anyhow::Context as _;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::AppState;

/// The refusal list in memory: every sealed picture's fingerprint, for the doors that check an
/// upload or an arrival against it.
static REFUSAL: std::sync::LazyLock<std::sync::RwLock<Vec<[u8; 32]>>> =
    std::sync::LazyLock::new(Default::default);

async fn reload_refusal(state: &AppState) -> anyhow::Result<()> {
    let rows: Vec<(String,)> = state
        .node_db
        .fetch_all("SELECT pdq FROM quarantine WHERE released_ms IS NULL AND pdq IS NOT NULL", ())
        .await
        .context("reading the refusal list")?;
    let prints: Vec<[u8; 32]> = rows.iter().filter_map(|(h,)| parse_hash(h)).collect();
    if let Ok(mut r) = REFUSAL.write() {
        *r = prints;
    }
    Ok(())
}

/// Is this print near a quarantined picture's? (plans/SCANNING.md, ruling 4: our own decisions are
/// ours to use - a removed picture is refused when it comes back re-encoded or cropped.)
pub fn refuses_print(print: &crate::media::pdq::Pdq) -> bool {
    print.usable()
        && REFUSAL
            .read()
            .is_ok_and(|r| r.iter().any(|p| print.distance(p) <= crate::media::pdq::MATCH_DISTANCE))
}

fn refusing_anything() -> bool {
    REFUSAL.read().is_ok_and(|r| !r.is_empty())
}

/// An upload's crushed body, before it is kept (ingest.rs): `true` when it is a quarantined
/// picture come back.
pub async fn refuses_upload(body: &[u8]) -> bool {
    if !refusing_anything() {
        return false;
    }
    let bytes = body.to_vec();
    let print = crate::media::lane::background(move || crate::media::image::fingerprint(&bytes))
        .await
        .ok()
        .flatten();
    print.as_ref().is_some_and(refuses_print)
}

/// A public picture that just landed here - fetched from a peer, or minted by a publish
/// (files.rs's arrival hook): fingerprinted against the refusal list, and sealed when it matches,
/// so it is refused at sync and at serve from then on. Only while there is anything to refuse:
/// a node that never quarantined anything decodes nothing extra.
pub async fn arrived(state: AppState, hash: iroh_blobs::Hash) {
    if !refusing_anything() || state.files.is_sealed(&hash) {
        return;
    }
    let print = crate::prints::of(&state, hash.as_bytes()).await;
    if print.as_ref().is_some_and(refuses_print) {
        if let Err(e) = seal(
            &state,
            &[*hash.as_bytes()],
            None,
            "looks like a picture quarantined here",
            "refusal-list",
        )
        .await
        {
            tracing::warn!(error = ?e, "could not seal a refused picture");
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/quarantine", get(list_handler).post(seal_handler))
        .route("/api/admin/quarantine/{hash}/release", post(release_handler))
        .route("/api/admin/quarantine/reported-by/{root}/release", post(release_reporter_handler))
}

/// A seal a child-abuse report made (reports.rs) names its reporter in `by_account`, where an
/// operator's own seal names their account: `report:<root>`.
const REPORTED_BY: &str = "report:";

pub fn reported_by(reporter_root: &str) -> String {
    format!("{REPORTED_BY}{reporter_root}")
}

/// Seal every blob this node quarantined and hasn't released. At boot, before the accept loop.
pub async fn load(state: &AppState) -> anyhow::Result<()> {
    let rows: Vec<(String,)> = state
        .node_db
        .fetch_all("SELECT hash FROM quarantine WHERE released_ms IS NULL", ())
        .await
        .context("reading the quarantine")?;
    state
        .files
        .seal(rows.iter().filter_map(|(h,)| parse_hash(h)).map(iroh_blobs::Hash::from_bytes));
    reload_refusal(state).await
}

/// The blobs sealed here: the reaper keeps every one of them (reaper.rs).
pub async fn preserved(node_db: &crate::db::Db) -> anyhow::Result<Vec<[u8; 32]>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT hash FROM quarantine WHERE released_ms IS NULL", ())
        .await
        .context("reading the quarantine for the reaper")?;
    Ok(rows.iter().filter_map(|(h,)| parse_hash(h)).collect())
}

fn parse_hash(hex_hash: &str) -> Option<[u8; 32]> {
    hex::decode(hex_hash).ok().and_then(|b| b.try_into().ok())
}

/// A picture's address as anyone copies it - the body, the thumbnail, the post itself - read to
/// its author and document. `None` for anything else.
pub fn picture_address(address: &str) -> Option<([u8; 32], [u8; 16])> {
    let address = address.trim();
    let bare = address.split(['?', '#']).next().unwrap_or(address).trim_end_matches('/');
    let bare = bare.strip_suffix("/thumb").unwrap_or(bare);
    let with_body = if bare.contains("/body") { bare.to_string() } else { format!("{bare}/body") };
    crate::record::bake::twin_address(&with_body)
}

/// The blobs a public document names and the blobs of everything it embeds: a post with a picture
/// is its words, and the picture is a document of its own.
pub async fn blobs_of(
    state: &AppState,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> anyhow::Result<Vec<[u8; 32]>> {
    let mut out = own_blobs(state, author, doc_id).await?;
    for embedded in embeds(state, author, doc_id).await? {
        out.extend(own_blobs(state, author, &embedded).await?);
    }
    Ok(out)
}

/// The documents a public document embeds, as this node holds it.
pub async fn embeds(
    state: &AppState,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> anyhow::Result<Vec<[u8; 16]>> {
    let author_hex = hex::encode(author);
    if let Some(db) = state.user_dbs.get(&author_hex).await? {
        if let Some(media) = crate::record::documents::public_media(&db, doc_id)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
        {
            return Ok(media.refs);
        }
    }
    Ok(crate::fragments::serving_header(&state.node_db, &author_hex, doc_id)
        .await?
        .map(|h| h.refs)
        .unwrap_or_default())
}

/// The blobs a public document itself names as this node holds it - its body and its thumbnail -
/// from the author's chain if it's here, else the fragment shelf. Never fetched for the asking.
pub async fn own_blobs(
    state: &AppState,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> anyhow::Result<Vec<[u8; 32]>> {
    let author_hex = hex::encode(author);
    let mut out = Vec::new();
    if let Some(db) = state.user_dbs.get(&author_hex).await? {
        if let Some(head) = crate::record::documents::public_head(&db, doc_id)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
        {
            out.push(head.file_hash);
            out.extend(head.thumb_hash);
        }
    }
    if out.is_empty() {
        if let Some(h) =
            crate::fragments::serving_header(&state.node_db, &author_hex, doc_id).await?
        {
            out.push(h.file_hash);
            out.extend(h.thumb_hash);
        }
    }
    Ok(out)
}

/// Seal these blobs, now, and record why. A blob already sealed keeps its first row; one sealed
/// again after a release takes the new why and who.
pub async fn seal(
    state: &AppState,
    hashes: &[[u8; 32]],
    picture: Option<([u8; 32], [u8; 16])>,
    why: &str,
    by_account: &str,
) -> anyhow::Result<()> {
    let now = crate::clock::now_ms();
    let (author, doc) = match picture {
        Some((a, d)) => (Some(hex::encode(a)), Some(hex::encode(d))),
        None => (None, None),
    };
    for hash in hashes {
        state
            .node_db
            .execute(
                "INSERT INTO quarantine (hash, author, doc_id, why, by_account, quarantined_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (hash) DO UPDATE SET released_ms = NULL, released_by = NULL,
                     quarantined_ms = CASE WHEN quarantine.released_ms IS NULL
                         THEN quarantine.quarantined_ms ELSE excluded.quarantined_ms END,
                     why = CASE WHEN quarantine.released_ms IS NULL
                         THEN quarantine.why ELSE excluded.why END,
                     by_account = CASE WHEN quarantine.released_ms IS NULL
                         THEN quarantine.by_account ELSE excluded.by_account END",
                (hex::encode(hash), author.clone(), doc.clone(), why, by_account, now),
            )
            .await
            .context("recording a quarantine")?;
    }
    // Nobody keeps a sketch of a quarantined picture (sketches.rs) - not its lister, not anyone.
    for hash in hashes {
        crate::sketches::forget_picture(state, hash).await?;
    }
    // The fingerprints, read before the seal closes the store to every reader.
    let mut prints = Vec::new();
    for hash in hashes {
        if let Ok(Some(bytes)) = state.files.get_public(iroh_blobs::Hash::from_bytes(*hash)).await {
            let print =
                crate::media::lane::background(move || crate::media::image::fingerprint(&bytes))
                    .await
                    .ok()
                    .flatten();
            if let Some(p) = print.filter(|p| p.usable()) {
                prints.push((hex::encode(hash), hex::encode(p.hash)));
            }
        }
    }
    state.files.seal(hashes.iter().copied().map(iroh_blobs::Hash::from_bytes));
    for (hash, print) in prints {
        state
            .node_db
            .execute("UPDATE quarantine SET pdq = ?2 WHERE hash = ?1", (hash, print))
            .await
            .context("noting a quarantined picture's print")?;
    }
    reload_refusal(state).await?;
    tracing::warn!(count = hashes.len(), "quarantined blobs on this node");
    Ok(())
}

#[derive(Serialize)]
struct Row {
    hash: String,
    author: Option<String>,
    doc_id: Option<String>,
    why: String,
    by_account: String,
    /// The reporter whose child-abuse report sealed it, when one did: their persona's root.
    reporter: Option<String>,
    quarantined_ms: i64,
    released_ms: Option<i64>,
    released_by: Option<String>,
    /// Whether the bytes are on this node's disk, kept.
    held: bool,
    /// On the refusal list: its fingerprint is refused when it comes back, re-encoded or not.
    printed: bool,
}

type RowTuple = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    i64,
    Option<i64>,
    Option<String>,
    Option<String>,
);

async fn rows(state: &AppState) -> Result<Vec<Row>, AppError> {
    let rows: Vec<RowTuple> = state
        .node_db
        .fetch_all(
            "SELECT hash, author, doc_id, why, by_account, quarantined_ms, released_ms, released_by,
                 pdq
             FROM quarantine ORDER BY quarantined_ms DESC",
            (),
        )
        .await
        .context("reading the quarantine")
        .map_err(AppError::Internal)?;
    let mut out = Vec::with_capacity(rows.len());
    for (hash, author, doc_id, why, by_account, quarantined_ms, released_ms, released_by, pdq) in
        rows
    {
        let held = match parse_hash(&hash) {
            Some(h) => state.files.size_of(iroh_blobs::Hash::from_bytes(h)).await.is_some(),
            None => false,
        };
        let reporter = by_account.strip_prefix(REPORTED_BY).map(str::to_string);
        out.push(Row {
            hash,
            author,
            doc_id,
            why,
            by_account,
            reporter,
            quarantined_ms,
            released_ms,
            released_by,
            held,
            printed: pdq.is_some(),
        });
    }
    Ok(out)
}

/// GET `/api/admin/quarantine` - everything quarantined here, sealed and released, newest first.
async fn list_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::json!({ "rows": rows(&state).await? })))
}

#[derive(Deserialize)]
struct SealRequest {
    /// A picture's address: its body, its thumbnail or its post.
    #[serde(default)]
    address: Option<String>,
    /// Or a blob's hash, hex - what a report names, or what a log said.
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    why: String,
}

/// POST `/api/admin/quarantine` - seal a picture by its address, or a blob by its hash.
async fn seal_handler(
    State(state): State<AppState>,
    admin: crate::auth::NodeAdminSession,
    Json(req): Json<SealRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (hashes, picture) = if let Some(hash) = req.hash.as_deref().filter(|h| !h.is_empty()) {
        let hash = parse_hash(hash.trim()).ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "quarantine.not-a-hash",
                "that isn't a file's hash - 64 hex characters"
            ))
        })?;
        (vec![hash], None)
    } else {
        let address = req.address.as_deref().unwrap_or("");
        let (author, doc) = picture_address(address).ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "quarantine.not-an-address",
                "that isn't a picture's address on Horse Drawing Tycoon 2"
            ))
        })?;
        let hashes = blobs_of(&state, &author, &doc).await.map_err(AppError::Internal)?;
        if hashes.is_empty() {
            return Err(AppError::NotFound(crate::msg!(
                "quarantine.not-held",
                "this server doesn't hold that picture"
            )));
        }
        (hashes, Some((author, doc)))
    };
    let why: String = req.why.trim().chars().take(1000).collect();
    seal(&state, &hashes, picture, &why, &admin.account.id.to_string())
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "rows": rows(&state).await? })))
}

/// POST `/api/admin/quarantine/{hash}/release` - unseal: the operator was wrong, or the
/// preservation period is over.
async fn release_handler(
    State(state): State<AppState>,
    admin: crate::auth::NodeAdminSession,
    Path(hash): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let Some(bytes) = parse_hash(&hash) else {
        return Err(AppError::BadRequest(crate::msg!(
            "quarantine.not-a-hash",
            "that isn't a file's hash - 64 hex characters"
        )));
    };
    release(&state, &[bytes], &admin.account.id.to_string()).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "rows": rows(&state).await? })))
}

/// POST `/api/admin/quarantine/reported-by/{root}/release` - unseal everything one reporter's
/// child-abuse reports sealed: their word was no good (Curtis, 2026-11-03).
async fn release_reporter_handler(
    State(state): State<AppState>,
    admin: crate::auth::NodeAdminSession,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = root.to_ascii_lowercase();
    if parse_hash(&root).is_none() {
        return Err(AppError::BadRequest(crate::msg!(
            "quarantine.not-a-persona",
            "that isn't a persona - 64 hex characters"
        )));
    }
    let sealed: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT hash FROM quarantine WHERE by_account = ?1 AND released_ms IS NULL",
            (reported_by(&root),),
        )
        .await
        .context("reading a reporter's seals")
        .map_err(AppError::Internal)?;
    let hashes: Vec<[u8; 32]> = sealed.iter().filter_map(|(h,)| parse_hash(h)).collect();
    release(&state, &hashes, &admin.account.id.to_string()).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "rows": rows(&state).await? })))
}

/// Unseal these blobs, recording who did and when; the rows stay as the record.
async fn release(state: &AppState, hashes: &[[u8; 32]], by_account: &str) -> anyhow::Result<()> {
    let now = crate::clock::now_ms();
    for hash in hashes {
        state
            .node_db
            .execute(
                "UPDATE quarantine SET released_ms = ?2, released_by = ?3
                 WHERE hash = ?1 AND released_ms IS NULL",
                (hex::encode(hash), now, by_account),
            )
            .await
            .context("releasing a quarantine")?;
        state.files.unseal(&iroh_blobs::Hash::from_bytes(*hash));
        crate::notifications::forget_quarantine(&state.node_db, &hex::encode(hash)).await?;
    }
    reload_refusal(state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_picture_from_any_of_its_addresses() {
        let root = "a".repeat(64);
        let doc = "0123456789abcdef0123456789abcdef";
        let want = Some((
            <[u8; 32]>::try_from(hex::decode(&root).unwrap()).unwrap(),
            <[u8; 16]>::try_from(hex::decode(doc).unwrap()).unwrap(),
        ));
        for a in [
            format!("https://horsedrawingtycoon.com/ringtome/user/{root}/doc/{doc}/body"),
            format!("https://example.org/ringtome/user/{root}/doc/{doc}/thumb"),
            format!("/ringtome/user/{root}/doc/{doc}"),
            format!(" /id/{root}/docs/{doc}/body/media.avif?via=x "),
        ] {
            assert_eq!(picture_address(&a), want, "{a}");
        }
        assert_eq!(picture_address("https://example.org/cats.png"), None);
    }
}
