//! Media ingest: the async pipeline between "raw bytes arrived over HTTP" and "an encrypted,
//! canonical-format version landed on the documents chain".
//!
//! Text commits synchronously (it's inert); media does not. An uploaded image/audio/video is
//! written to the quarantine directory, a `pending` row goes into `ingest_job`, and the caller
//! gets a `doc_id` back immediately - a version-less doc_id IS the pending state. A shared worker
//! (see [`worker_pass`], registered as a background loop) drains the queue FIFO: it transcodes
//! the upload to a canonical AV1-family codec (on `spawn_blocking`, since AV1 encode is
//! CPU-bound), stores the encrypted body + a sibling thumbnail blob, and appends the first
//! version. Only then does the document exist to the rest of the system.
//!
//! **Trust boundary.** The plaintext upload lives, briefly, in the clear on disk here - but only
//! on this node, which must see the plaintext to transcode it anyway and which holds the epoch
//! key to re-encrypt. Every relaying node ever only sees the encrypted AVIF. The quarantine file
//! is unlinked the moment its version lands (or the job terminally fails).
//!
//! **Deferred, on purpose:** per-account fairness (v1 is global FIFO - one uploader's dump makes
//! everyone wait) and retry-on-transient (an internal failure terminally fails the job; the user
//! still holds the original file and re-uploads). Both are marked so future-us knows they were
//! choices, not oversights.

use anyhow::{anyhow, Context};
use std::path::PathBuf;

use crate::clock::now_ms;
use crate::db::Db;
use crate::media::CrushError;
use crate::record::documents::{save_version, MediaMeta, Save};
use crate::AppError;

/// The enqueue handle, stored in `AppState`. Cheap to clone (just the quarantine path).
#[derive(Clone)]
pub struct Ingest {
    quarantine_dir: PathBuf,
    /// Live transcode progress for the currently-processing job (job_id -> 0-100), fed by the
    /// crush lanes' progress callbacks. In-memory on purpose: progress is ephemeral UI truth,
    /// and a reboot honestly resets the bar to "processing…".
    progress: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, u8>>>,
}

/// One upload to quarantine and queue. `doc_id` is freshly minted by the caller for a create, or
/// an existing document's id for a new version.
pub struct Upload<'a> {
    pub account: &'a str,
    pub root: &'a str,
    pub doc_id: [u8; 16],
    pub parents: &'a [[u8; 32]],
    pub title: &'a str,
    pub bytes: &'a [u8],
    /// The browser pre-encoder's fallback-lane sidecar: a separate Ogg Opus blob accompanying
    /// APNG frames (the lane for browsers that can't encode AV1 - inline WebM audio needs no
    /// sidecar). Quarantined as a sibling file (`<path>.audio`), no schema column needed.
    pub audio: Option<&'a [u8]>,
}

/// The sidecar's on-disk home, derived from the main quarantine path - existence IS the flag.
fn sidecar_path(quarantine_path: &str) -> String {
    format!("{quarantine_path}.audio")
}

impl Ingest {
    pub fn new(quarantine_dir: PathBuf) -> Self {
        Self {
            quarantine_dir,
            progress: Default::default(),
        }
    }

    /// Record the processing job's progress (called from the crush's blocking thread).
    pub fn set_progress(&self, job_id: &str, pct: u8) {
        self.progress
            .lock()
            .expect("ingest progress poisoned")
            .insert(job_id.to_string(), pct);
    }

    /// The processing job's last-reported progress, if any.
    pub fn progress_of(&self, job_id: &str) -> Option<u8> {
        self.progress
            .lock()
            .expect("ingest progress poisoned")
            .get(job_id)
            .copied()
    }

    /// Drop a finished job's meter (done or failed alike - the row's status takes over).
    pub fn clear_progress(&self, job_id: &str) {
        self.progress
            .lock()
            .expect("ingest progress poisoned")
            .remove(job_id);
    }

    /// Create the quarantine directory if absent, `0700` on unix (the plaintext staged here is
    /// private user content; keep it off other local users). Called once at boot and defensively
    /// before each write.
    pub fn ensure_dir(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.quarantine_dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.quarantine_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    /// Quarantine the upload and record a pending job against `doc_id` (freshly minted by the
    /// caller for a create, or an existing document's id for a new version). Writes the raw bytes
    /// to disk and inserts the row; does NOT transcode or touch the record - that's the worker's
    /// job. Returns the `job_id` to poll by.
    pub async fn enqueue(&self, node_db: &Db, up: Upload<'_>) -> Result<String, AppError> {
        let job_id = {
            use rand::RngCore;
            let mut b = [0u8; 16];
            rand::rngs::OsRng.fill_bytes(&mut b);
            hex::encode(b)
        };
        self.ensure_dir()
            .map_err(|e| AppError::Internal(anyhow!("preparing quarantine dir: {e}")))?;
        let path = self.quarantine_dir.join(&job_id);
        tokio::fs::write(&path, up.bytes)
            .await
            .map_err(|e| AppError::Internal(anyhow!("writing quarantine file: {e}")))?;
        if let Some(audio) = up.audio {
            tokio::fs::write(sidecar_path(&path.to_string_lossy()), audio)
                .await
                .map_err(|e| AppError::Internal(anyhow!("writing quarantine sidecar: {e}")))?;
        }

        let parents_csv = up
            .parents
            .iter()
            .map(hex::encode)
            .collect::<Vec<_>>()
            .join(",");
        node_db
            .execute(
                "INSERT INTO ingest_job \
             (job_id, account, root, doc_id, parents, title, quarantine_path, status, bytes_in, created_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)",
                (
                    job_id.as_str(),
                    up.account,
                    up.root,
                    hex::encode(up.doc_id),
                    parents_csv.as_str(),
                    up.title,
                    path.to_string_lossy().as_ref(),
                    (up.bytes.len() + up.audio.map_or(0, <[u8]>::len)) as i64,
                    now_ms(),
                ),
            )
            .await
            .map_err(|e| AppError::Internal(anyhow!("recording ingest job: {e}")))?;

        Ok(job_id)
    }
}

/// A claimed unit of work, decoded from its row.
struct Job {
    job_id: String,
    root: String,
    doc_id: [u8; 16],
    parents: Vec<[u8; 32]>,
    title: String,
    quarantine_path: String,
}

/// One worker pass: drain every currently-pending job, oldest first, one at a time. Registered as
/// a background loop in `main`. A single loop means passes never overlap, so claims never race;
/// the atomic claim below is belt-and-suspenders for the day there's a worker pool.
pub async fn worker_pass(state: crate::AppState) -> anyhow::Result<()> {
    while let Some(job) = claim_next(&state.node_db).await? {
        if let Err(e) = process_job(&state, &job).await {
            // Internal (non-transcode) failure: mark terminal and move on - never leave a claimed
            // job stuck at 'processing' (that strands it until the next boot). Retry-on-transient
            // is deferred; the user still has the original file.
            tracing::error!(job = %job.job_id, "ingest job failed internally: {e:#}");
            fail_job(&state.node_db, &job.job_id, &format!("internal error: {e}")).await?;
            let _ = tokio::fs::remove_file(&job.quarantine_path).await;
            let _ = tokio::fs::remove_file(sidecar_path(&job.quarantine_path)).await;
        }
    }
    Ok(())
}

/// Atomically claim the oldest pending job (`pending` -> `processing`) and return it decoded.
async fn claim_next(node_db: &Db) -> anyhow::Result<Option<Job>> {
    // fetch_optional drains the RETURNING statement to completion, which is what actually
    // commits the claim before anything else touches the connection.
    let row: Option<(String, String, String, String, String, String)> = node_db
        .fetch_optional(
            "UPDATE ingest_job SET status = 'processing' \
         WHERE seq = (SELECT seq FROM ingest_job WHERE status = 'pending' ORDER BY seq LIMIT 1) \
         RETURNING job_id, root, doc_id, parents, title, quarantine_path",
            (),
        )
        .await
        .context("claiming next ingest job")?;

    let Some((job_id, root, doc_id, parents, title, quarantine_path)) = row else {
        return Ok(None);
    };
    Ok(Some(Job {
        doc_id: parse_doc_id(&doc_id)?,
        parents: parse_parents(&parents)?,
        job_id,
        root,
        title,
        quarantine_path,
    }))
}

/// Transcode one upload and land it as a version, or terminally fail it with a human tombstone.
async fn process_job(state: &crate::AppState, job: &Job) -> anyhow::Result<()> {
    let bytes = tokio::fs::read(&job.quarantine_path)
        .await
        .with_context(|| format!("reading quarantine file {}", job.quarantine_path))?;
    // The fallback lane's Ogg Opus sidecar, when the browser pre-encoder shipped one.
    let audio = tokio::fs::read(sidecar_path(&job.quarantine_path)).await.ok();

    // The crush (AV1/AVIF/Opus encode) is CPU-bound: keep it off the async runtime. The
    // sidecar-aware door sniffs the upload and routes it to the image, video, or audio lane.
    // The progress callback feeds the shared meter the jobs endpoint reads (the UI's bar).
    let ingest_meter = state.ingest.clone();
    let meter_job_id = job.job_id.clone();
    ingest_meter.set_progress(&meter_job_id, 0);
    let outcome = tokio::task::spawn_blocking(move || {
        let report = |pct: u8| ingest_meter.set_progress(&meter_job_id, pct);
        crate::media::crush_with_sidecar(&bytes, audio.as_deref(), &report)
    })
    .await?;
    state.ingest.clear_progress(&job.job_id);
    let ingested = match outcome {
        Ok(i) => i,
        Err(te) => {
            // A deterministic transcode failure (the animation tombstone, corrupt bytes, a format
            // we can't read): terminal, with a message the user sees in the progress view. Retrying
            // can't change the bytes.
            fail_job(&state.node_db, &job.job_id, &tombstone(&te)).await?;
            let _ = tokio::fs::remove_file(&job.quarantine_path).await;
            let _ = tokio::fs::remove_file(sidecar_path(&job.quarantine_path)).await;
            return Ok(());
        }
    };

    // This identity's write keys, via the session-free node path (same as the post-sync body
    // fetch): the node's own leaf for the root, its enc keypair, its unsealed epoch keys.
    let leaf = crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, &job.root)
        .await?
        .ok_or_else(|| anyhow!("node does not agent identity {}", job.root))?;
    let leaf_pub = leaf.verifying_key().to_bytes();
    let enc = crate::record::private::load_enc_keypair(&state.keystore, &hex::encode(leaf_pub))?;
    let db = state.user_dbs.get(&job.root).await?;
    let keys = crate::record::private::unseal_epoch_keys(&db, &leaf_pub, &enc).await?;
    let (epoch, epoch_key) = keys
        .current()
        .ok_or_else(|| anyhow!("no epoch key to write media under"))?;

    // The thumbnail (when the lane produced one - image thumb, audio waveform; video has none yet)
    // is its own sibling blob, never inline in the header. The body - the crushed AVIF/WebM/APNG/
    // Opus - rides save_version's normal store-and-append path (with blob reuse).
    let thumb_hash = match &ingested.thumb_avif {
        Some(thumb) => Some(
            *state
                .files
                .put_encrypted(epoch, &epoch_key, thumb)
                .await?
                .as_bytes(),
        ),
        None => None,
    };

    // The hover-preview clip (video WebM output only) is likewise its own sibling blob.
    let preview_hash = match &ingested.preview_webm {
        Some(preview) => Some(
            *state
                .files
                .put_encrypted(epoch, &epoch_key, preview)
                .await?
                .as_bytes(),
        ),
        None => None,
    };

    save_version(
        &db,
        &leaf,
        &keys,
        &state.files,
        Save {
            doc_id: job.doc_id,
            parents: job.parents.clone(),
            title: job.title.clone(),
            body: ingested.body,
            format: ingested.format,
            media: Some(MediaMeta {
                width: ingested.width,
                height: ingested.height,
                duration_ms: ingested.duration_ms,
                thumb_hash,
                preview_hash,
            }),
        },
    )
    .await?;

    finish_job(&state.node_db, &job.job_id).await?;
    let _ = tokio::fs::remove_file(&job.quarantine_path).await;
    let _ = tokio::fs::remove_file(sidecar_path(&job.quarantine_path)).await;
    Ok(())
}

/// The human message a failed job carries. Animation is the intended-soon tombstone; the rest are
/// genuine "this upload can't be stored" failures.
fn tombstone(te: &CrushError) -> String {
    match te {
        // Lead with what a person needs; keep the codec detail parenthesized for debugging.
        CrushError::Unsupported(f) => format!(
            "this isn't a kind of media Ringtome can store yet - images, audio, and a few video codecs ({f})"
        ),
        CrushError::Decode(e) => format!("couldn't process the media ({e})"),
        CrushError::TooLong(e) => format!("too long to store ({e})"),
    }
}

async fn finish_job(node_db: &Db, job_id: &str) -> anyhow::Result<()> {
    node_db
        .execute(
            "UPDATE ingest_job SET status = 'done', error = NULL WHERE job_id = ?1",
            (job_id,),
        )
        .await
        .context("marking ingest job done")?;
    Ok(())
}

async fn fail_job(node_db: &Db, job_id: &str, error: &str) -> anyhow::Result<()> {
    node_db
        .execute(
            "UPDATE ingest_job SET status = 'failed', error = ?2 WHERE job_id = ?1",
            (job_id, error),
        )
        .await
        .context("marking ingest job failed")?;
    Ok(())
}

/// Reconcile the queue on boot: a job left non-terminal by a crash (or a `/tmp` wipe) is either
/// resumable - its quarantine file survives, so back to `pending` - or dead: the file is gone, so
/// fail it. Without this, a job claimed-but-not-finished before a restart is stranded at
/// `processing` forever.
pub async fn reconcile_on_boot(node_db: &Db) -> anyhow::Result<()> {
    let rows: Vec<(String, String)> = node_db
        .fetch_all(
            "SELECT job_id, quarantine_path FROM ingest_job WHERE status IN ('pending', 'processing')",
            (),
        )
        .await
        .context("reading in-flight ingest jobs")?;

    let (mut requeued, mut lost) = (0u32, 0u32);
    for (job_id, path) in rows {
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            node_db
                .execute(
                    "UPDATE ingest_job SET status = 'pending' WHERE job_id = ?1",
                    (job_id.as_str(),),
                )
                .await?;
            requeued += 1;
        } else {
            fail_job(node_db, &job_id, "upload lost on restart").await?;
            let _ = tokio::fs::remove_file(sidecar_path(&path)).await; // no orphaned sidecars
            lost += 1;
        }
    }
    if requeued + lost > 0 {
        tracing::info!(requeued, lost, "reconciled ingest queue on boot");
    }
    Ok(())
}

/// One job's status, for the per-account progress view.
#[derive(serde::Serialize)]
pub struct JobStatus {
    pub job_id: String,
    pub doc_id: String,
    pub title: String,
    /// `pending` | `processing` | `done` | `failed`.
    pub status: String,
    /// The tombstone message when `status = failed`.
    pub error: Option<String>,
    pub bytes_in: i64,
    pub created_ms: i64,
    /// Jobs ahead of this one in the node's whole queue (`pending` only): 0 = next up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<i64>,
    /// The transcode meter, 0-100, while `processing` (loosely accurate by design).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
}

/// The columns behind one `JobStatus`, in `SELECT` order.
type JobRow = (String, String, String, String, Option<String>, i64, i64, Option<i64>);

/// Rename a QUEUED upload. The title is baked into the version at transcode time, and the
/// worker reads it when it CLAIMS the job (the `RETURNING` in `claim`) - so only a still-
/// `pending` job can honestly take a new name; once claimed, the old title is already in
/// flight. Returns whether the rename landed, so the caller can report "too late" truthfully
/// instead of pretending.
pub async fn retitle_job(
    node_db: &Db,
    account: &str,
    job_id: &str,
    title: &str,
) -> Result<bool, AppError> {
    let n = node_db
        .execute(
            "UPDATE ingest_job SET title = ?3 \
             WHERE job_id = ?1 AND account = ?2 AND status = 'pending'",
            (job_id, account, title),
        )
        .await
        .map_err(|e| AppError::Internal(anyhow!("renaming ingest job: {e}")))?;
    Ok(n > 0)
}

/// Every ingest job this account has queued, newest first - the "how long until my uploads are
/// usable" view. Failures show here (with their message); they never appear as ghost documents.
pub async fn jobs_for_account(
    node_db: &Db,
    ingest: &Ingest,
    account: &str,
) -> Result<Vec<JobStatus>, AppError> {
    // `position` counts the whole node's queue, not just this account's slice: "3 ahead of
    // you" is only honest if it includes other people's jobs on a shared node.
    let rows: Vec<JobRow> = node_db
        .fetch_all(
            "SELECT job_id, doc_id, title, status, error, bytes_in, created_ms, \
         CASE WHEN status = 'pending' THEN \
             (SELECT COUNT(*) FROM ingest_job q WHERE q.status = 'pending' AND q.seq < ingest_job.seq) \
         END \
         FROM ingest_job WHERE account = ?1 ORDER BY seq DESC",
            (account,),
        )
        .await
        .map_err(|e| AppError::Internal(anyhow!("listing ingest jobs: {e}")))?;

    Ok(rows
        .into_iter()
        .map(
            |(job_id, doc_id, title, status, error, bytes_in, created_ms, position)| {
                let progress = (status == "processing")
                    .then(|| ingest.progress_of(&job_id))
                    .flatten();
                JobStatus {
                    job_id,
                    doc_id,
                    title,
                    status,
                    error,
                    bytes_in,
                    created_ms,
                    position,
                    progress,
                }
            },
        )
        .collect())
}

/// The most recent job's `(status, error)` for a document, or `None` if this account never queued
/// anything under it. Lets the body endpoint explain a version-less doc_id (still processing, or
/// failed with a tombstone) instead of a bare 404.
pub async fn latest_job_for_doc(
    node_db: &Db,
    account: &str,
    doc_id: &str,
) -> Result<Option<(String, Option<String>)>, AppError> {
    node_db
        .fetch_optional(
            "SELECT status, error FROM ingest_job \
         WHERE account = ?1 AND doc_id = ?2 ORDER BY seq DESC LIMIT 1",
            (account, doc_id),
        )
        .await
        .map_err(|e| AppError::Internal(anyhow!("looking up ingest job for doc: {e}")))
}

fn parse_doc_id(s: &str) -> anyhow::Result<[u8; 16]> {
    let bytes = hex::decode(s).context("decoding job doc_id")?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("job doc_id is not 16 bytes"))
}

fn parse_parents(csv: &str) -> anyhow::Result<Vec<[u8; 32]>> {
    csv.split(',')
        .filter(|s| !s.is_empty())
        .map(|s| {
            let bytes = hex::decode(s.trim()).context("decoding job parent hash")?;
            bytes
                .as_slice()
                .try_into()
                .map_err(|_| anyhow!("job parent hash is not 32 bytes"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_ingest() -> Ingest {
        Ingest::new(std::env::temp_dir())
    }

    // The queue and its bookkeeping are testable with just a node DB + a scratch quarantine dir;
    // the transcode-and-land path (worker_pass -> process_job) needs a fully-agented identity with
    // sealed epoch keys and is exercised end-to-end by the integration tests instead.
    async fn node_db() -> Db {
        crate::db::test_node_db().await
    }

    fn scratch_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ringtome-ingest-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn upload<'a>(doc_id: [u8; 16], title: &'a str, bytes: &'a [u8]) -> Upload<'a> {
        Upload {
            account: "acct-1",
            root: "rootpub",
            doc_id,
            parents: &[],
            title,
            bytes,
            audio: None,
        }
    }

    #[tokio::test]
    async fn enqueue_with_sidecar_writes_the_sibling_file() {
        let db = node_db().await;
        let dir = scratch_dir("sidecar");
        let ingest = Ingest::new(dir.clone());
        let job_id = ingest
            .enqueue(
                &db,
                Upload {
                    audio: Some(b"ogg opus bytes"),
                    ..upload([9u8; 16], "clip", b"apng frames")
                },
            )
            .await
            .unwrap();

        // Both blobs staged: the frames under the job id, the audio as its `.audio` sibling.
        assert_eq!(
            tokio::fs::read(dir.join(&job_id)).await.unwrap(),
            b"apng frames"
        );
        assert_eq!(
            tokio::fs::read(dir.join(format!("{job_id}.audio"))).await.unwrap(),
            b"ogg opus bytes"
        );
        // bytes_in counts the whole upload, sidecar included.
        let jobs = jobs_for_account(&db, &test_ingest(), "acct-1").await.unwrap();
        assert_eq!(jobs[0].bytes_in, ("apng frames".len() + "ogg opus bytes".len()) as i64);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn enqueue_quarantines_bytes_and_shows_pending() {
        let db = node_db().await;
        let dir = scratch_dir("enqueue");
        let ingest = Ingest::new(dir.clone());

        let job_id = ingest
            .enqueue(&db, upload([3u8; 16], "sunset", b"raw upload bytes"))
            .await
            .unwrap();

        // The raw bytes are on disk, in the clear, under the job id.
        assert_eq!(
            tokio::fs::read(dir.join(&job_id)).await.unwrap(),
            b"raw upload bytes"
        );
        // And the job is visible to the owner as pending, carrying its doc_id - the pending state.
        let jobs = jobs_for_account(&db, &test_ingest(), "acct-1").await.unwrap();
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, "pending");
        assert_eq!(jobs[0].error, None);
        assert_eq!(jobs[0].title, "sunset");
        assert_eq!(jobs[0].doc_id, hex::encode([3u8; 16]));
        assert_eq!(jobs[0].bytes_in, "raw upload bytes".len() as i64);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn claim_is_fifo_and_marks_processing() {
        let db = node_db().await;
        let dir = scratch_dir("claim");
        let ingest = Ingest::new(dir.clone());
        ingest
            .enqueue(&db, upload([1u8; 16], "first", b"1"))
            .await
            .unwrap();
        ingest
            .enqueue(&db, upload([2u8; 16], "second", b"2"))
            .await
            .unwrap();

        // Oldest first, and claiming one flips it to processing so the next claim skips it.
        let a = claim_next(&db).await.unwrap().unwrap();
        assert_eq!(a.title, "first");
        assert_eq!(a.doc_id, [1u8; 16]);
        let b = claim_next(&db).await.unwrap().unwrap();
        assert_eq!(b.title, "second");
        assert!(
            claim_next(&db).await.unwrap().is_none(),
            "nothing left to claim"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn retitle_lands_on_pending_and_refuses_after_claim() {
        let db = node_db().await;
        let dir = scratch_dir("retitle");
        let ingest = Ingest::new(dir.clone());
        let job_id = ingest
            .enqueue(&db, upload([7u8; 16], "IMG_4021.jpeg", b"pix"))
            .await
            .unwrap();

        // Pending: the rename lands, and the owner's queue view shows the new name.
        assert!(retitle_job(&db, "acct-1", &job_id, "the lighthouse").await.unwrap());
        let jobs = jobs_for_account(&db, &test_ingest(), "acct-1").await.unwrap();
        assert_eq!(jobs[0].title, "the lighthouse");

        // Another account can't rename it, even pending.
        assert!(!retitle_job(&db, "acct-2", &job_id, "hijack").await.unwrap());

        // Claimed (the worker holds the title in memory now): too late, reported honestly.
        claim_next(&db).await.unwrap().unwrap();
        assert!(!retitle_job(&db, "acct-1", &job_id, "too late").await.unwrap());
        let jobs = jobs_for_account(&db, &test_ingest(), "acct-1").await.unwrap();
        assert_eq!(jobs[0].title, "the lighthouse");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn boot_reconcile_requeues_survivors_and_fails_the_lost() {
        let db = node_db().await;
        let dir = scratch_dir("reconcile");
        let ingest = Ingest::new(dir.clone());
        let survivor = ingest
            .enqueue(&db, upload([1u8; 16], "survivor", b"aa"))
            .await
            .unwrap();
        let lost = ingest
            .enqueue(&db, upload([2u8; 16], "lost", b"bb"))
            .await
            .unwrap();

        // Simulate a crash mid-run: both were claimed (processing), and one quarantine file was
        // wiped (a /tmp reboot, say) while the other survived.
        db.execute("UPDATE ingest_job SET status = 'processing'", ())
            .await
            .unwrap();
        tokio::fs::remove_file(dir.join(&lost)).await.unwrap();

        reconcile_on_boot(&db).await.unwrap();

        let jobs = jobs_for_account(&db, &test_ingest(), "acct-1").await.unwrap();
        let by = |id: &str| jobs.iter().find(|j| j.job_id == id).unwrap();
        assert_eq!(by(&survivor).status, "pending", "file present -> requeued");
        assert_eq!(by(&lost).status, "failed", "file gone -> failed");
        assert!(by(&lost)
            .error
            .as_deref()
            .unwrap()
            .contains("lost on restart"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
