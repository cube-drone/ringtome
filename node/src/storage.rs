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
//!
//! **The Storage page** (2026-11-20; Curtis: people ask "how much space am I giving up to hosting a
//! p2p node?", and nothing answered them) adds one figure and one answer. The figure is the
//! place's **footprint**: everything under the data directory, by kind, by walking it - at most
//! once a minute, off the async threads. The answer (`overview_handler`) puts three things side by
//! side for whoever asks: the footprint, their own persona's tally, and the standing of each
//! person they follow that this node holds - read off the memos above, so no followed persona is
//! opened for it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
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
    /// `files_bytes` by what the files are.
    pub kinds: Kinds,
    /// How much of `files_bytes` its public documents name; the rest is private.
    pub public_bytes: i64,
    /// The public files by kind (they sum to `public_bytes`); the private ones are `kinds` less
    /// these. In memory only: the Storage page shows the split for the asker's own persona.
    pub public_kinds: Kinds,
    /// Per document: the blobs its versions name, each once - doc id hex to bytes.
    pub docs: Arc<BTreeMap<String, i64>>,
    /// Taken before the persona's files last moved: answered from memory inside `RETALLY_MS`, so
    /// whoever asked may ask again once it has passed.
    pub stale: bool,
}

/// A persona's files by what they are (2026-11-20, the Storage page). The node transcodes
/// everything at ingest, so the formats are a closed set and each is one of these; `other` is a
/// format this build does not know. The five sum to the files' total: a blob is counted once,
/// under one kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Kinds {
    pub pictures: i64,
    pub video: i64,
    pub audio: i64,
    pub writing: i64,
    pub other: i64,
}

/// What a version's format makes its blobs. In this order a blob two versions disagree about
/// takes the first - which no honest chain does, but the sums must not depend on row order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Kind {
    Pictures,
    Video,
    Audio,
    Writing,
    Other,
}

impl Kind {
    /// A `doc_format` id as a kind: text of every sort is writing (plain, Marquee, a book's
    /// table, a room's description), and a drawing's strokes are a picture to the person who
    /// drew it.
    pub(crate) fn of(format: Option<u64>) -> Kind {
        use ringtome_proto::registry::doc_format as f;
        match format {
            None | Some(f::MARQUEE | f::BOOK | f::ROOM) => Kind::Writing,
            Some(f::AVIF | f::APNG | f::DRAWING) => Kind::Pictures,
            Some(f::WEBM_AV1) => Kind::Video,
            Some(f::OGG_OPUS) => Kind::Audio,
            Some(_) => Kind::Other,
        }
    }
}

impl Kind {
    /// This kind's bit among the kinds a follower may decline to sync
    /// (`subscriptions.skip_kinds`): pictures, video and audio. Writing is the post itself and is
    /// never declined.
    pub(crate) fn skip_bit(self) -> i64 {
        match self {
            Kind::Pictures => 1,
            Kind::Video => 2,
            Kind::Audio => 4,
            Kind::Writing | Kind::Other => 0,
        }
    }
}

impl Kinds {
    /// The five, summed.
    pub fn total(&self) -> i64 {
        self.pictures + self.video + self.audio + self.writing + self.other
    }

    /// These less `other`, kind by kind: every file less the public ones is the private ones.
    fn less(&self, other: &Kinds) -> Kinds {
        Kinds {
            pictures: self.pictures - other.pictures,
            video: self.video - other.video,
            audio: self.audio - other.audio,
            writing: self.writing - other.writing,
            other: self.other - other.other,
        }
    }

    fn add(&mut self, kind: Kind, bytes: i64) {
        match kind {
            Kind::Pictures => self.pictures += bytes,
            Kind::Video => self.video += bytes,
            Kind::Audio => self.audio += bytes,
            Kind::Writing => self.writing += bytes,
            Kind::Other => self.other += bytes,
        }
    }
}

/// The files' total by kind and by lane: each blob once, under the first kind any version naming
/// it has, and public if any public version names it. `(every file by kind, the public ones by
/// kind)`.
fn split(
    refs: &[crate::record::documents::VersionBlob],
    size: impl Fn(&[u8; 32]) -> i64,
) -> (Kinds, Kinds) {
    let mut said: HashMap<[u8; 32], (Kind, bool)> = HashMap::new();
    for r in refs {
        let kind = Kind::of(r.format);
        said.entry(r.hash)
            .and_modify(|(k, public)| {
                *k = (*k).min(kind);
                *public |= r.public;
            })
            .or_insert((kind, r.public));
    }
    let mut kinds = Kinds::default();
    let mut public_kinds = Kinds::default();
    for (hash, (kind, public)) in &said {
        let bytes = size(hash);
        kinds.add(*kind, bytes);
        if *public {
            public_kinds.add(*kind, bytes);
        }
    }
    (kinds, public_kinds)
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
static TALLIES: LazyLock<Mutex<HashMap<String, Held>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

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
        if let Some(oldest) =
            tallies.iter().min_by_key(|(_, (_, taken, _))| *taken).map(|(r, _)| r.clone())
        {
            tallies.remove(&oldest);
        }
    }
    tallies.insert(root.to_string(), (mtime, now, tally.clone()));
    Ok(Some(tally))
}

async fn retake(state: &AppState, db: &Db, root: &str, mtime: i64) -> Result<Tally> {
    let refs =
        crate::record::documents::version_blobs(db).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let named: HashSet<[u8; 32]> = refs.iter().map(|r| r.hash).collect();
    let sizes = sizes_of(state, &named).await?;
    let mut per_doc: HashMap<[u8; 16], HashSet<[u8; 32]>> = HashMap::new();
    for r in &refs {
        per_doc.entry(r.doc).or_default().insert(r.hash);
    }
    // Files deleted at the follower's asking (net::subscriptions, "delete existing images") take
    // nothing, though their sizes are still remembered for when they come back.
    let purged = crate::net::subscriptions::purged_hashes(state, root, Some(db)).await?;
    let size =
        |h: &[u8; 32]| if purged.contains(h) { 0 } else { sizes.get(h).copied().unwrap_or(0) };
    let docs: BTreeMap<String, i64> = per_doc
        .iter()
        .map(|(doc, hashes)| (hex::encode(doc), hashes.iter().map(size).sum()))
        .collect();
    let files_bytes: i64 = named.iter().map(size).sum();
    let (kinds, public_kinds) = split(&refs, size);
    let public_bytes = public_kinds.total();
    let db_bytes = state.user_dbs.disk_bytes(root);
    remember_names(&state.node_db, root, &named).await?;
    state
        .node_db
        .execute(
            "INSERT INTO persona_storage (root_pubkey, files_bytes, db_bytes, files_mtime_ms, tallied_ms,
                 pictures_bytes, video_bytes, audio_bytes, writing_bytes, public_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT (root_pubkey) DO UPDATE SET files_bytes = excluded.files_bytes, db_bytes = excluded.db_bytes,
                 files_mtime_ms = excluded.files_mtime_ms, tallied_ms = excluded.tallied_ms,
                 pictures_bytes = excluded.pictures_bytes, video_bytes = excluded.video_bytes,
                 audio_bytes = excluded.audio_bytes, writing_bytes = excluded.writing_bytes,
                 public_bytes = excluded.public_bytes",
            (
                root,
                files_bytes,
                db_bytes,
                mtime,
                crate::clock::now_ms(),
                kinds.pictures,
                kinds.video,
                kinds.audio,
                kinds.writing,
                public_bytes,
            ),
        )
        .await
        .context("recording a persona's tally")?;
    Ok(Tally {
        files_bytes,
        db_bytes,
        kinds,
        public_bytes,
        public_kinds,
        docs: Arc::new(docs),
        stale: false,
    })
}

/// The sizes of `hashes`: the remembered ones in a read, the rest asked of the blob store - up
/// to `MEASURE_PER_TALLY` - and remembered. A blob not (yet) held whole has no size to give and
/// is asked again next time.
async fn sizes_of(state: &AppState, hashes: &HashSet<[u8; 32]>) -> Result<HashMap<[u8; 32], i64>> {
    let all: Vec<[u8; 32]> = hashes.iter().copied().collect();
    let mut sizes: HashMap<[u8; 32], i64> = HashMap::new();
    for chunk in all.chunks(CHUNK) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let params: Vec<turso::Value> =
            chunk.iter().map(|h| turso::Value::Blob(h.to_vec())).collect();
        let rows: Vec<(Vec<u8>, i64)> = state
            .node_db
            .fetch_all(
                &format!("SELECT hash, bytes FROM blob_sizes WHERE hash IN ({marks})"),
                params,
            )
            .await
            .context("reading remembered blob sizes")?;
        for (hash, bytes) in rows {
            if let Ok(hash) = <[u8; 32]>::try_from(hash.as_slice()) {
                sizes.insert(hash, bytes);
            }
        }
    }
    let unmeasured: Vec<[u8; 32]> =
        all.into_iter().filter(|h| !sizes.contains_key(h)).take(MEASURE_PER_TALLY).collect();
    let mut measured: Vec<([u8; 32], i64)> = Vec::new();
    for hash in unmeasured {
        if let Some(bytes) = state.files.size_of(iroh_blobs::Hash::from_bytes(hash)).await {
            measured.push((hash, bytes as i64));
        }
    }
    for chunk in measured.chunks(CHUNK) {
        let marks = vec!["(?, ?)"; chunk.len()].join(", ");
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|(h, b)| [turso::Value::Blob(h.to_vec()), turso::Value::Integer(*b)])
            .collect();
        state
            .node_db
            .execute(
                &format!("INSERT OR IGNORE INTO blob_sizes (hash, bytes) VALUES {marks}"),
                params,
            )
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
    let had: HashSet<[u8; 32]> =
        rows.into_iter().filter_map(|(h,)| <[u8; 32]>::try_from(h.as_slice()).ok()).collect();
    let gone: Vec<&[u8; 32]> = had.difference(named).collect();
    let new: Vec<&[u8; 32]> = named.difference(&had).collect();
    for chunk in gone.chunks(CHUNK) {
        let marks = vec!["?"; chunk.len()].join(", ");
        let mut params: Vec<turso::Value> = vec![turso::Value::Text(root.to_string())];
        params.extend(chunk.iter().map(|h| turso::Value::Blob(h.to_vec())));
        node_db
            .execute(
                &format!("DELETE FROM persona_blobs WHERE root_pubkey = ?1 AND hash IN ({marks})"),
                params,
            )
            .await
            .context("forgetting blobs a persona no longer names")?;
    }
    for chunk in new.chunks(CHUNK) {
        let marks = vec!["(?, ?)"; chunk.len()].join(", ");
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|h| [turso::Value::Text(root.to_string()), turso::Value::Blob(h.to_vec())])
            .collect();
        node_db
            .execute(
                &format!("INSERT OR IGNORE INTO persona_blobs (root_pubkey, hash) VALUES {marks}"),
                params,
            )
            .await
            .context("remembering blobs a persona names")?;
    }
    Ok(())
}

/// What evicting `root` would free: the blobs no other persona here names, and its own database -
/// `db_bytes` as the tally measured it, the figure moving is reckoned from. Measured afresh, a
/// database written to since the tally made evicting free more than moving carries (a CI flake,
/// 2026-10-21); the admin's list (`all`) already used the one stored figure for both.
pub async fn evict_bytes(state: &AppState, root: &str, db_bytes: i64) -> Result<i64> {
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
    Ok(files + db_bytes)
}

/// One persona's standing as the node admin's People list shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Standing {
    pub move_bytes: i64,
    pub evict_bytes: i64,
    pub tallied_ms: i64,
    /// The two halves of `move_bytes`, and the files by kind once a tally has split them (one
    /// taken before 2026-11-20 has not). The Storage page's; the admin's list does not show them.
    #[serde(skip_serializing)]
    pub files_bytes: i64,
    #[serde(skip_serializing)]
    pub db_bytes: i64,
    #[serde(skip_serializing)]
    pub kinds: Option<Kinds>,
}

/// A `persona_storage` row, as `all` reads it: root, files, database, when, and the four named
/// kinds - NULL together until a tally splits them.
type StorageRow = (String, i64, i64, i64, Option<i64>, Option<i64>, Option<i64>, Option<i64>);

/// Every tallied persona's cost to move and value to evict, off the memos: two reads, no
/// persona opened.
pub async fn all(node_db: &Db) -> Result<BTreeMap<String, Standing>> {
    let rows: Vec<StorageRow> = node_db
        .fetch_all(
            "SELECT root_pubkey, files_bytes, db_bytes, tallied_ms,
                    pictures_bytes, video_bytes, audio_bytes, writing_bytes
             FROM persona_storage",
            (),
        )
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
        .map(|(root, files, db, at, pictures, video, audio, writing)| {
            let alone = only.get(&root).copied().unwrap_or(0);
            let kinds = match (pictures, video, audio, writing) {
                (Some(pictures), Some(video), Some(audio), Some(writing)) => Some(Kinds {
                    pictures,
                    video,
                    audio,
                    writing,
                    other: (files - pictures - video - audio - writing).max(0),
                }),
                _ => None,
            };
            let standing = Standing {
                move_bytes: files + db,
                evict_bytes: alone + db,
                tallied_ms: at,
                files_bytes: files,
                db_bytes: db,
                kinds,
            };
            (root, standing)
        })
        .collect())
}

/// This persona's files are not what its tally says any more, though its database did not move
/// (a follower asked for a kind of its files to be deleted, or took that back): the next ask or
/// beat retakes it.
pub async fn mark_moved(node_db: &Db, root: &str) -> Result<()> {
    TALLIES.lock().expect("tallies poisoned").remove(root);
    node_db
        .execute("UPDATE persona_storage SET files_mtime_ms = 0 WHERE root_pubkey = ?1", (root,))
        .await
        .context("marking a persona's tally as moved")?;
    Ok(())
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
            (marks.get(root) != Some(&mtime))
                .then(|| (marks.get(root).copied().unwrap_or(0), root.clone()))
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
    let tally =
        tally(&state, &root).await.map_err(crate::error::AppError::Internal)?.unwrap_or_default();
    let evict = evict_bytes(&state, &root, tally.db_bytes)
        .await
        .map_err(crate::error::AppError::Internal)?;
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

// ---------------------------------------------------------------------------------------------
// The Storage page: the place's footprint, and one person's view of it

/// The least time between two walks of the data directory.
const REMEASURE_MS: i64 = 60_000;

/// What this place keeps on disk, by kind. Sizes are the files' lengths, as every other figure
/// here is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Footprint {
    /// Everything: the four below, summed.
    pub total_bytes: i64,
    /// The blob store: every picture, recording and attachment held, each once.
    pub files_bytes: i64,
    /// Every persona's database, log and journal - this node's own people and the ones it mirrors.
    pub chains_bytes: i64,
    /// The backups directory, wherever it is.
    pub backups_bytes: i64,
    /// The rest of the data directory: the node's own database, its keys.
    pub other_bytes: i64,
    /// The disk the data directory is on: what is free for this to grow into, and its size.
    /// `None` where the system will not say.
    pub disk_free_bytes: Option<i64>,
    pub disk_total_bytes: Option<i64>,
    pub measured_ms: i64,
}

static FOOTPRINT: LazyLock<Mutex<Option<Footprint>>> = LazyLock::new(|| Mutex::new(None));

/// Every file under `path`, summed. A link is counted as a link and never followed, and what
/// cannot be read (a file deleted mid-walk) counts for nothing.
fn tree_bytes(path: &Path) -> i64 {
    let mut total = 0i64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(at) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&at) else { continue };
        if meta.is_dir() {
            let Ok(entries) = std::fs::read_dir(&at) else { continue };
            stack.extend(entries.flatten().map(|e| e.path()));
        } else {
            total += meta.len() as i64;
        }
    }
    total
}

/// Walk the data directory and say what is in it, by kind: `blobs` is the files, `users` and
/// `journals` the chains, the backups directory the backups - inside the data directory (where it
/// is unless the operator moved it) or out - and whatever else is there the rest.
fn measure(data: &Path, backups: &Path) -> Footprint {
    let mut found = Footprint::default();
    let mut backups_seen = false;
    for entry in std::fs::read_dir(data).into_iter().flatten().flatten() {
        let path = entry.path();
        let bytes = tree_bytes(&path);
        if path == backups {
            backups_seen = true;
            found.backups_bytes += bytes;
            continue;
        }
        match entry.file_name().to_str() {
            Some("blobs") => found.files_bytes += bytes,
            Some("users" | "journals") => found.chains_bytes += bytes,
            _ => found.other_bytes += bytes,
        }
    }
    // Anywhere else under the data directory it was counted with the rest; outside, it is the
    // app's all the same.
    if !backups_seen && !backups.starts_with(data) {
        found.backups_bytes = tree_bytes(backups);
    }
    found.total_bytes =
        found.files_bytes + found.chains_bytes + found.backups_bytes + found.other_bytes;
    if let Ok(disk) = fs4::statvfs(data) {
        if disk.total_space() > 0 {
            found.disk_free_bytes = i64::try_from(disk.available_space()).ok();
            found.disk_total_bytes = i64::try_from(disk.total_space()).ok();
        }
    }
    found
}

/// The place's footprint, walked again only when the last walk is older than `REMEASURE_MS`.
pub async fn footprint(state: &AppState) -> Result<Footprint> {
    let now = crate::clock::now_ms();
    if let Some(held) = *FOOTPRINT.lock().expect("footprint poisoned") {
        if now - held.measured_ms < REMEASURE_MS {
            return Ok(held);
        }
    }
    let data = state.config.data_directory.clone();
    let backups = state.config.backup_directory.clone();
    let mut found = tokio::task::spawn_blocking(move || measure(&data, &backups))
        .await
        .context("walking the data directory")?;
    found.measured_ms = now;
    *FOOTPRINT.lock().expect("footprint poisoned") = Some(found);
    Ok(found)
}

/// Has a tally that splits by kind reached this persona?
fn reached(standings: &BTreeMap<String, Standing>, who: &str) -> bool {
    standings.get(who).is_some_and(|s| s.kinds.is_some())
}

/// One person the asker follows, as this node holds them.
#[derive(Debug, serde::Serialize)]
struct Followed {
    root: String,
    name: Option<String>,
    /// What they take here: their files, each once, and their own database.
    bytes: i64,
    files_bytes: i64,
    chains_bytes: i64,
    /// Their files by kind; `None` until a tally has split them.
    kinds: Option<Kinds>,
    /// False until a tally that splits by kind reaches them: until the first, `bytes` is their
    /// database alone.
    counted: bool,
}

/// GET `/api/identity/{root}/storage/overview` - the Storage page: what this place keeps in all,
/// what the asker's persona takes, and what each person they follow takes here. Whom a persona
/// follows is its own business, so this is the persona's owner's alone; the place's total is no
/// secret from anyone it hosts.
///
/// The people's figures are the memos the background beat keeps (`persona_storage`): a followed
/// persona is opened only when it has no memo yet or its files moved since, a few per ask, and
/// until its first gives its database's size by stat. A file
/// two people both name is kept once and counted for each, so the people's figures may sum past
/// the place's - the page says so.
pub async fn overview_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    use crate::error::AppError;
    let _owned = crate::record::store::open(&state, &session.account.id, &root).await?;
    let place = footprint(&state).await.map_err(AppError::Internal)?;
    let mine = tally(&state, &root).await.map_err(AppError::Internal)?.unwrap_or_default();
    let held: HashSet<String> =
        state.user_dbs.held_roots().map_err(AppError::Internal)?.into_iter().collect();
    let followed: Vec<String> = crate::net::subscriptions::followed_by(&state.node_db, &root)
        .await
        .map_err(AppError::Internal)?
        .into_iter()
        .filter(|who| *who != root && held.contains(who))
        .collect();
    // The beat tallies a few personas every five minutes, which is a long wait for someone
    // looking at the page: a few of the followed are tallied now - the ones no tally that splits
    // by kind has reached first, then the ones whose files moved since theirs - and the page asks
    // again while any are unreached (`counted`).
    let mut standings = all(&state.node_db).await.map_err(AppError::Internal)?;
    let marks: HashMap<String, i64> = state
        .node_db
        .fetch_all("SELECT root_pubkey, files_mtime_ms FROM persona_storage", ())
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("reading the tallies' marks: {e}")))?
        .into_iter()
        .collect();
    let moved = |who: &String| state.user_dbs.db_mtime_ms(who) != marks.get(who).copied();
    let (unreached, behind): (Vec<&String>, Vec<&String>) = followed
        .iter()
        .filter(|who| !reached(&standings, who) || moved(who))
        .partition(|who| !reached(&standings, who));
    let due: Vec<&String> = unreached.into_iter().chain(behind).take(TALLY_PER_PASS).collect();
    if !due.is_empty() {
        for who in due {
            if let Err(e) = tally(&state, who).await {
                tracing::debug!(root = %who, error = ?e, "storage tally failed; the next ask retries");
            }
        }
        standings = all(&state.node_db).await.map_err(AppError::Internal)?;
    }
    // What one held persona takes: its tally, or only its database so far.
    let size = |who: &str| match standings.get(who) {
        Some(standing) => standing.move_bytes,
        None => state.user_dbs.disk_bytes(who),
    };
    let names =
        crate::profiles::bylines(&state.node_db, &followed).await.map_err(AppError::Internal)?;
    let mut following: Vec<Followed> = followed
        .iter()
        .map(|who| {
            let name = names.get(who).and_then(|b| b.name.clone());
            let standing = standings.get(who);
            let chains_bytes = standing.map_or_else(|| size(who), |s| s.db_bytes);
            Followed {
                root: who.clone(),
                name,
                bytes: size(who),
                files_bytes: standing.map_or(0, |s| s.files_bytes),
                chains_bytes,
                kinds: standing.and_then(|s| s.kinds),
                counted: reached(&standings, who),
            }
        })
        .collect();
    following.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.root.cmp(&b.root)));
    // Everyone else held here - other accounts' personas and the people they follow, the asker's
    // other personas, people kept on a friend's word - as a count and a sum, and no more: who
    // they are is not this persona's to be told.
    let listed: HashSet<&String> = followed.iter().collect();
    let (others, others_bytes) = held
        .iter()
        .filter(|who| **who != root && !listed.contains(who))
        .fold((0i64, 0i64), |(n, sum), who| (n + 1, sum + size(who)));
    Ok(axum::Json(serde_json::json!({
        "place": place,
        "persona": {
            "bytes": mine.move_bytes(),
            "files_bytes": mine.files_bytes,
            "chains_bytes": mine.db_bytes,
            "kinds": mine.kinds,
            "public_bytes": mine.public_bytes,
            "private_bytes": mine.files_bytes - mine.public_bytes,
            "public_kinds": mine.public_kinds,
            "private_kinds": mine.kinds.less(&mine.public_kinds),
            "stale": mine.stale,
        },
        "following": following,
        "others": { "people": others, "bytes": others_bytes },
        "retally_ms": RETALLY_MS,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each blob is counted once, under one kind and one lane, whatever order the versions come
    /// in; the kinds sum to the whole.
    #[test]
    fn files_split_by_kind_and_lane_each_blob_once() {
        use crate::record::documents::VersionBlob;
        use ringtome_proto::registry::doc_format as f;
        let blob = |n: u8, format: Option<u64>, public: bool| VersionBlob {
            doc: [n; 16],
            hash: [n; 32],
            format,
            public,
        };
        let mut refs = vec![
            blob(1, Some(f::AVIF), true),
            blob(1, Some(f::AVIF), true), // a second version naming the same picture
            blob(2, Some(f::WEBM_AV1), false),
            blob(3, Some(f::OGG_OPUS), false),
            blob(4, None, false),
            blob(5, Some(f::MARQUEE), true),
            blob(6, Some(f::DRAWING), false),
            blob(7, Some(999), false),
            // One blob, named by a private note and a public picture: a picture, and public.
            blob(8, None, false),
            blob(8, Some(f::APNG), true),
        ];
        let size = |h: &[u8; 32]| i64::from(h[0]) * 10;
        let (kinds, public) = split(&refs, size);
        let want =
            Kinds { pictures: 10 + 60 + 80, video: 20, audio: 30, writing: 40 + 50, other: 70 };
        assert_eq!(kinds, want);
        assert_eq!(public, Kinds { pictures: 10 + 80, writing: 50, ..Kinds::default() });
        assert_eq!(
            kinds.less(&public),
            Kinds { pictures: 60, video: 20, audio: 30, writing: 40, other: 70 }
        );
        let whole: i64 = (1..=8).map(|n| n * 10).sum();
        assert_eq!(kinds.total(), whole);
        refs.reverse();
        assert_eq!(split(&refs, size), (want, public));
    }

    /// The footprint sorts the data directory's contents into its kinds, sums them, and finds
    /// the backups inside the data directory or out of it.
    #[test]
    fn the_footprint_is_the_data_directory_by_kind() {
        let base = std::env::temp_dir().join(format!("ringtome-footprint-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let data = base.join("data");
        let put = |path: &str, bytes: usize| {
            let at = data.join(path);
            std::fs::create_dir_all(at.parent().unwrap()).unwrap();
            std::fs::write(at, vec![0u8; bytes]).unwrap();
        };
        put("blobs/data/ab/cd.data", 1000);
        put("blobs/blobs.db", 24);
        put("users/aa.db", 300);
        put("users/aa.db-wal", 30);
        put("journals/aa.jnl", 70);
        put("backups/backup_20261120T000000Z.tar.gz", 5000);
        put("node.db", 400);
        put("keys/aa.key", 8);

        let inside = measure(&data, &data.join("backups"));
        assert_eq!(inside.files_bytes, 1024);
        assert_eq!(inside.chains_bytes, 400);
        assert_eq!(inside.backups_bytes, 5000);
        assert_eq!(inside.other_bytes, 408);
        assert_eq!(inside.total_bytes, 1024 + 400 + 5000 + 408);
        let (free, disk) = (inside.disk_free_bytes.unwrap(), inside.disk_total_bytes.unwrap());
        assert!(free <= disk && disk > inside.total_bytes, "the disk it sits on: {free} of {disk}");

        // Moved out by the operator: still the app's, and the directory left behind is the rest.
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("backup.tar.gz"), vec![0u8; 77]).unwrap();
        let outside = measure(&data, &elsewhere);
        assert_eq!(outside.backups_bytes, 77);
        assert_eq!(outside.other_bytes, 408 + 5000);
        assert_eq!(outside.total_bytes, 1024 + 400 + 77 + 408 + 5000);

        // A place with nothing yet takes nothing, and says so without failing.
        assert_eq!(measure(&base.join("nowhere"), &base.join("nowhere/backups")).total_bytes, 0);
        let _ = std::fs::remove_dir_all(&base);
    }
}
