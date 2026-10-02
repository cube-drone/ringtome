//! Storage accounting (2026-10-02): what a persona held here takes - per file, in all, what it
//! would cost to move and what evicting it would free.
//!
//! Curtis's brief came with a warning, the HorseBucks corner's lesson: a figure that rolls across a
//! persona's whole history too often, without snapshotting, becomes the persona's slowest work.
//! So nothing here is computed on a read that has no reason to:
//!
//!   * **A blob's size is measured once, ever** (`blob_sizes`): a hash names its bytes, so the
//!     blob store's metadata answers each hash a single time and the node remembers.
//!   * **A tally is retaken only when the persona's files moved** since the last one, and never
//!     within `RETALLY_MS` of it - the stat-only test the frontier sweep and the bank corner use.
//!     Retaking it is one plain read of the persisted fold (`documents::version_blobs`: no decrypt,
//!     no view) and node-side sums; the per-file sizes stay in memory against the mtime they
//!     were taken at.
//!   * **What a persona names is kept as rows** (`persona_blobs`), rewritten by difference -
//!     usually a handful - so "what would evicting them free" (the blobs nobody else names) is
//!     one indexed query, for one persona or all.
//!   * **The background pass** retakes only personas whose files moved, a few per beat; a
//!     persona at rest is never opened for it.
//!
//! Two figures, both per persona (PROJECT_PLAN's personas are what move and what evict): the
//! **cost to move** - every blob its versions name, each once, plus its own files (database, log,
//! journal) - and the **value to evict** - the blobs no other persona here names, plus its own
//! files. Blobs are stored once per node however many name them, which is why the two differ.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex};

use anyhow::{Context, Result};

use crate::db::Db;
use crate::AppState;

/// The least time between two tallies of one persona, however much it moves: a burst of saves
/// retallies once, after it.
const RETALLY_MS: i64 = 15_000;

/// How many blobs one tally asks the blob store about; the rest are counted on a later tally.
/// Only a first tally over a long history ever meets it.
const MEASURE_PER_TALLY: usize = 2_000;

/// How many personas one background beat retallies.
const TALLY_PER_PASS: usize = 8;

/// Rows per multi-row write: well under the engine's bind limit.
const CHUNK: usize = 400;

/// One persona's tally.
#[derive(Clone, Debug, Default)]
pub struct Tally {
    /// Every blob its documents name, each once.
    pub files_bytes: i64,
    /// Its own files: database, log, journal, heads.
    pub db_bytes: i64,
    /// Per document: the blobs its versions name, each once - doc id hex to bytes.
    pub docs: Arc<BTreeMap<String, i64>>,
    /// Taken before the persona's files last moved: answered from memory inside `RETALLY_MS`, so
    /// whoever asked may ask again once it has passed.
    pub stale: bool,
}

impl Tally {
    /// What moving the persona to another node carries.
    pub fn move_bytes(&self) -> i64 {
        self.files_bytes + self.db_bytes
    }
}

/// Per persona: the files' mtime the tally was taken at, when, and the tally. In memory only -
/// a restart retakes it on first ask, from the measured sizes.
/// (the files' mtime it was taken at, when it was taken, the tally)
type Held = (i64, i64, Tally);
static TALLIES: LazyLock<Mutex<HashMap<String, Held>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// How many personas' tallies stay in memory; past it the oldest go (they are retaken on ask).
const KEEP_TALLIES: usize = 256;

/// The persona's tally, retaken only when its files moved since the last one and not within
/// `RETALLY_MS` of it. `None` when this node holds nothing of theirs.
pub async fn tally(state: &AppState, root: &str) -> Result<Option<Tally>> {
    let Some(mtime) = state.user_dbs.db_mtime_ms(root) else {
        return Ok(None);
    };
    let now = crate::clock::now_ms();
    let held = TALLIES.lock().expect("tallies poisoned").get(root).cloned();
    if let Some((at_mtime, taken, tally)) = &held {
        if *at_mtime == mtime || now - taken < RETALLY_MS {
            return Ok(Some(Tally { stale: *at_mtime != mtime, ..tally.clone() }));
        }
    }
    let Some(db) = state.user_dbs.get(root).await? else {
        return Ok(None);
    };
    let tally = retake(state, &db, root, mtime).await?;
    let mut tallies = TALLIES.lock().expect("tallies poisoned");
    if tallies.len() >= KEEP_TALLIES && !tallies.contains_key(root) {
        if let Some(oldest) = tallies.iter().min_by_key(|(_, (_, taken, _))| *taken).map(|(r, _)| r.clone()) {
            tallies.remove(&oldest);
        }
    }
    tallies.insert(root.to_string(), (mtime, now, tally.clone()));
    Ok(Some(tally))
}

async fn retake(state: &AppState, db: &Db, root: &str, mtime: i64) -> Result<Tally> {
    let refs = crate::record::documents::version_blobs(db).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let named: HashSet<[u8; 32]> = refs.iter().map(|(_, h)| *h).collect();
    let sizes = sizes_of(state, &named).await?;
    let mut per_doc: HashMap<[u8; 16], HashSet<[u8; 32]>> = HashMap::new();
    for (doc, hash) in &refs {
        per_doc.entry(*doc).or_default().insert(*hash);
    }
    let size = |h: &[u8; 32]| sizes.get(h).copied().unwrap_or(0);
    let docs: BTreeMap<String, i64> = per_doc.iter().map(|(doc, hashes)| (hex::encode(doc), hashes.iter().map(size).sum())).collect();
    let files_bytes: i64 = named.iter().map(size).sum();
    let db_bytes = state.user_dbs.disk_bytes(root);
    remember_names(&state.node_db, root, &named).await?;
    state
        .node_db
        .execute(
            "INSERT INTO persona_storage (root_pubkey, files_bytes, db_bytes, files_mtime_ms, tallied_ms) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (root_pubkey) DO UPDATE SET files_bytes = excluded.files_bytes, db_bytes = excluded.db_bytes,
                 files_mtime_ms = excluded.files_mtime_ms, tallied_ms = excluded.tallied_ms",
            (root, files_bytes, db_bytes, mtime, crate::clock::now_ms()),
        )
        .await
        .context("recording a persona's tally")?;
    Ok(Tally { files_bytes, db_bytes, docs: Arc::new(docs), stale: false })
}

/// The sizes of `hashes`: the remembered ones in a read, the rest asked of the blob store - up
/// to `MEASURE_PER_TALLY` - and remembered. A blob not (yet) held whole has no size to give and
/// is asked again next time.
async fn sizes_of(state: &AppState, hashes: &HashSet<[u8; 32]>) -> Result<HashMap<[u8; 32], i64>> {
    let all: Vec<[u8; 32]> = hashes.iter().copied().collect();
    let mut sizes: HashMap<[u8; 32], i64> = HashMap::new();
    for chunk in all.chunks(CHUNK) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let params: Vec<turso::Value> = chunk.iter().map(|h| turso::Value::Blob(h.to_vec())).collect();
        let rows: Vec<(Vec<u8>, i64)> = state
            .node_db
            .fetch_all(&format!("SELECT hash, bytes FROM blob_sizes WHERE hash IN ({marks})"), params)
            .await
            .context("reading remembered blob sizes")?;
        for (hash, bytes) in rows {
            if let Ok(hash) = <[u8; 32]>::try_from(hash.as_slice()) {
                sizes.insert(hash, bytes);
            }
        }
    }
    let unmeasured: Vec<[u8; 32]> = all.into_iter().filter(|h| !sizes.contains_key(h)).take(MEASURE_PER_TALLY).collect();
    let mut measured: Vec<([u8; 32], i64)> = Vec::new();
    for hash in unmeasured {
        if let Some(bytes) = state.files.size_of(iroh_blobs::Hash::from_bytes(hash)).await {
            measured.push((hash, bytes as i64));
        }
    }
    for chunk in measured.chunks(CHUNK) {
        let marks = vec!["(?, ?)"; chunk.len()].join(", ");
        let params: Vec<turso::Value> = chunk.iter().flat_map(|(h, b)| [turso::Value::Blob(h.to_vec()), turso::Value::Integer(*b)]).collect();
        state
            .node_db
            .execute(&format!("INSERT OR IGNORE INTO blob_sizes (hash, bytes) VALUES {marks}"), params)
            .await
            .context("remembering blob sizes")?;
    }
    sizes.extend(measured);
    Ok(sizes)
}

/// Bring `persona_blobs` for `root` to `named`, by difference.
async fn remember_names(node_db: &Db, root: &str, named: &HashSet<[u8; 32]>) -> Result<()> {
    let rows: Vec<(Vec<u8>,)> = node_db
        .fetch_all("SELECT hash FROM persona_blobs WHERE root_pubkey = ?1", (root,))
        .await
        .context("reading what a persona names")?;
    let had: HashSet<[u8; 32]> = rows.into_iter().filter_map(|(h,)| <[u8; 32]>::try_from(h.as_slice()).ok()).collect();
    let gone: Vec<&[u8; 32]> = had.difference(named).collect();
    let new: Vec<&[u8; 32]> = named.difference(&had).collect();
    for chunk in gone.chunks(CHUNK) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let mut params: Vec<turso::Value> = vec![turso::Value::Text(root.to_string())];
        params.extend(chunk.iter().map(|h| turso::Value::Blob(h.to_vec())));
        node_db
            .execute(&format!("DELETE FROM persona_blobs WHERE root_pubkey = ?1 AND hash IN ({marks})"), params)
            .await
            .context("forgetting blobs a persona no longer names")?;
    }
    for chunk in new.chunks(CHUNK) {
        let marks = vec!["(?, ?)"; chunk.len()].join(", ");
        let params: Vec<turso::Value> = chunk.iter().flat_map(|h| [turso::Value::Text(root.to_string()), turso::Value::Blob(h.to_vec())]).collect();
        node_db
            .execute(&format!("INSERT OR IGNORE INTO persona_blobs (root_pubkey, hash) VALUES {marks}"), params)
            .await
            .context("remembering blobs a persona names")?;
    }
    Ok(())
}

/// What evicting `root` would free: the blobs no other persona here names, and its own files.
pub async fn evict_bytes(state: &AppState, root: &str) -> Result<i64> {
    let row: Option<(Option<i64>,)> = state
        .node_db
        .fetch_optional(
            "SELECT SUM(s.bytes) FROM persona_blobs p JOIN blob_sizes s ON s.hash = p.hash
             WHERE p.root_pubkey = ?1
               AND NOT EXISTS (SELECT 1 FROM persona_blobs q WHERE q.hash = p.hash AND q.root_pubkey <> ?1)",
            (root,),
        )
        .await
        .context("summing what only this persona names")?;
    let files = row.and_then(|(n,)| n).unwrap_or(0);
    Ok(files + state.user_dbs.disk_bytes(root))
}

/// One persona's standing as the node admin's People list shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Standing {
    pub move_bytes: i64,
    pub evict_bytes: i64,
    pub tallied_ms: i64,
}

/// Every tallied persona's cost to move and value to evict, off the memos: two reads, no
/// persona opened.
pub async fn all(node_db: &Db) -> Result<BTreeMap<String, Standing>> {
    let rows: Vec<(String, i64, i64, i64)> = node_db
        .fetch_all("SELECT root_pubkey, files_bytes, db_bytes, tallied_ms FROM persona_storage", ())
        .await
        .context("reading the tallies")?;
    let only: Vec<(String, Option<i64>)> = node_db
        .fetch_all(
            "SELECT p.root_pubkey, SUM(s.bytes) FROM persona_blobs p JOIN blob_sizes s ON s.hash = p.hash
             WHERE p.hash IN (SELECT hash FROM persona_blobs GROUP BY hash HAVING COUNT(*) = 1)
             GROUP BY p.root_pubkey",
            (),
        )
        .await
        .context("summing what each persona alone names")?;
    let only: HashMap<String, i64> = only.into_iter().map(|(r, n)| (r, n.unwrap_or(0))).collect();
    Ok(rows
        .into_iter()
        .map(|(root, files, db, at)| {
            let alone = only.get(&root).copied().unwrap_or(0);
            (root, Standing { move_bytes: files + db, evict_bytes: alone + db, tallied_ms: at })
        })
        .collect())
}

/// The background beat: retally the personas whose files moved since their last tally - a few per
/// beat, the stalest first - and forget the ones this node no longer holds.
pub async fn pass(state: AppState) -> Result<()> {
    let held: HashSet<String> = state.user_dbs.held_roots()?.into_iter().collect();
    let rows: Vec<(String, i64)> = state
        .node_db
        .fetch_all("SELECT root_pubkey, files_mtime_ms FROM persona_storage", ())
        .await
        .context("reading the tallies' marks")?;
    let marks: HashMap<String, i64> = rows.into_iter().collect();
    for root in marks.keys().filter(|r| !held.contains(*r)) {
        forget(&state.node_db, root).await?;
    }
    let mut moved: Vec<(i64, String)> = held
        .iter()
        .filter_map(|root| {
            let mtime = state.user_dbs.db_mtime_ms(root)?;
            (marks.get(root) != Some(&mtime)).then(|| (marks.get(root).copied().unwrap_or(0), root.clone()))
        })
        .collect();
    moved.sort();
    for (_, root) in moved.into_iter().take(TALLY_PER_PASS) {
        if let Err(e) = tally(&state, &root).await {
            tracing::debug!(root = %root, error = ?e, "storage tally failed; the next beat retries");
        }
    }
    Ok(())
}

/// Forget a persona this node no longer holds (eviction's sweep, and the beat's).
pub async fn forget(node_db: &Db, root: &str) -> Result<()> {
    node_db
        .execute("DELETE FROM persona_blobs WHERE root_pubkey = ?1", (root,))
        .await
        .context("forgetting what a persona named")?;
    node_db
        .execute("DELETE FROM persona_storage WHERE root_pubkey = ?1", (root,))
        .await
        .context("forgetting a persona's tally")?;
    TALLIES.lock().expect("tallies poisoned").remove(root);
    Ok(())
}

/// GET `/api/identity/{root}/storage` - the persona's own tally, for its files browser: what each
/// file takes, what the persona costs to move, and what evicting it would free. Retaken only when
/// its files moved (`tally`).
pub async fn persona_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    let _owned = crate::record::store::open(&state, &session.account.id, &root).await?;
    let tally = tally(&state, &root).await.map_err(crate::error::AppError::Internal)?.unwrap_or_default();
    let evict = evict_bytes(&state, &root).await.map_err(crate::error::AppError::Internal)?;
    Ok(axum::Json(serde_json::json!({
        "files_bytes": tally.files_bytes,
        "db_bytes": tally.db_bytes,
        "move_bytes": tally.move_bytes(),
        "evict_bytes": evict,
        "docs": &*tally.docs,
        "stale": tally.stale,
        "retally_ms": RETALLY_MS,
    })))
}

/// GET `/api/node/storage` - every tallied persona's cost to move and value to evict, for the node
/// admin's People list; nobody else's business.
pub async fn node_handler(
    _admin: crate::auth::NodeAdminSession,
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    let personas = all(&state.node_db).await.map_err(crate::error::AppError::Internal)?;
    Ok(axum::Json(serde_json::json!({ "personas": personas })))
}
