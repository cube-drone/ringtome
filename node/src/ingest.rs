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
use sqlx::SqlitePool;
use std::path::PathBuf;

use crate::clock::now_ms;
use crate::media::CrushError;
use crate::record::documents::{save_version, MediaMeta, Save};
use crate::AppError;

/// The enqueue handle, stored in `AppState`. Cheap to clone (just the quarantine path).
#[derive(Clone)]
pub struct Ingest {
    quarantine_dir: PathBuf,
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
}

impl Ingest {
    pub fn new(quarantine_dir: PathBuf) -> Self {
        Self { quarantine_dir }
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
    pub async fn enqueue(&self, node_db: &SqlitePool, up: Upload<'_>) -> Result<String, AppError> {
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

        let parents_csv = up
            .parents
            .iter()
            .map(hex::encode)
            .collect::<Vec<_>>()
            .join(",");
        sqlx::query(
            "INSERT INTO ingest_job \
             (job_id, account, root, doc_id, parents, title, quarantine_path, status, bytes_in, created_ms) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?9)",
        )
        .bind(&job_id)
        .bind(up.account)
        .bind(up.root)
        .bind(hex::encode(up.doc_id))
        .bind(&parents_csv)
        .bind(up.title)
        .bind(path.to_string_lossy().as_ref())
        .bind(up.bytes.len() as i64)
        .bind(now_ms())
        .execute(node_db)
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
        }
    }
    Ok(())
}

/// Atomically claim the oldest pending job (`pending` -> `processing`) and return it decoded.
async fn claim_next(node_db: &SqlitePool) -> anyhow::Result<Option<Job>> {
    let row: Option<(String, String, String, String, String, String)> = sqlx::query_as(
        "UPDATE ingest_job SET status = 'processing' \
         WHERE seq = (SELECT seq FROM ingest_job WHERE status = 'pending' ORDER BY seq LIMIT 1) \
         RETURNING job_id, root, doc_id, parents, title, quarantine_path",
    )
    .fetch_optional(node_db)
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

    // The crush (AV1/AVIF/Opus encode) is CPU-bound: keep it off the async runtime. `media::crush`
    // sniffs the upload and routes it to the image, video, or audio lane.
    let outcome = tokio::task::spawn_blocking(move || crate::media::crush(&bytes)).await?;
    let ingested = match outcome {
        Ok(i) => i,
        Err(te) => {
            // A deterministic transcode failure (the animation tombstone, corrupt bytes, a format
            // we can't read): terminal, with a message the user sees in the progress view. Retrying
            // can't change the bytes.
            fail_job(&state.node_db, &job.job_id, &tombstone(&te)).await?;
            let _ = tokio::fs::remove_file(&job.quarantine_path).await;
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
    Ok(())
}

/// The human message a failed job carries. Animation is the intended-soon tombstone; the rest are
/// genuine "this upload can't be stored" failures.
fn tombstone(te: &CrushError) -> String {
    match te {
        CrushError::Unsupported(f) => format!("unsupported media ({f})"),
        CrushError::Decode(e) => format!("couldn't process the media ({e})"),
        CrushError::TooLong(e) => format!("too long to store ({e})"),
    }
}

async fn finish_job(node_db: &SqlitePool, job_id: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE ingest_job SET status = 'done', error = NULL WHERE job_id = ?1")
        .bind(job_id)
        .execute(node_db)
        .await
        .context("marking ingest job done")?;
    Ok(())
}

async fn fail_job(node_db: &SqlitePool, job_id: &str, error: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE ingest_job SET status = 'failed', error = ?2 WHERE job_id = ?1")
        .bind(job_id)
        .bind(error)
        .execute(node_db)
        .await
        .context("marking ingest job failed")?;
    Ok(())
}

/// Reconcile the queue on boot: a job left non-terminal by a crash (or a `/tmp` wipe) is either
/// resumable - its quarantine file survives, so back to `pending` - or dead: the file is gone, so
/// fail it. Without this, a job claimed-but-not-finished before a restart is stranded at
/// `processing` forever.
pub async fn reconcile_on_boot(node_db: &SqlitePool) -> anyhow::Result<()> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT job_id, quarantine_path FROM ingest_job WHERE status IN ('pending', 'processing')",
    )
    .fetch_all(node_db)
    .await
    .context("reading in-flight ingest jobs")?;

    let (mut requeued, mut lost) = (0u32, 0u32);
    for (job_id, path) in rows {
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            sqlx::query("UPDATE ingest_job SET status = 'pending' WHERE job_id = ?1")
                .bind(&job_id)
                .execute(node_db)
                .await?;
            requeued += 1;
        } else {
            fail_job(node_db, &job_id, "upload lost on restart").await?;
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
}

/// The columns behind one `JobStatus`, in `SELECT` order.
type JobRow = (String, String, String, String, Option<String>, i64, i64);

/// Every ingest job this account has queued, newest first - the "how long until my uploads are
/// usable" view. Failures show here (with their message); they never appear as ghost documents.
pub async fn jobs_for_account(
    node_db: &SqlitePool,
    account: &str,
) -> Result<Vec<JobStatus>, AppError> {
    let rows: Vec<JobRow> = sqlx::query_as(
        "SELECT job_id, doc_id, title, status, error, bytes_in, created_ms \
         FROM ingest_job WHERE account = ?1 ORDER BY seq DESC",
    )
    .bind(account)
    .fetch_all(node_db)
    .await
    .map_err(|e| AppError::Internal(anyhow!("listing ingest jobs: {e}")))?;

    Ok(rows
        .into_iter()
        .map(
            |(job_id, doc_id, title, status, error, bytes_in, created_ms)| JobStatus {
                job_id,
                doc_id,
                title,
                status,
                error,
                bytes_in,
                created_ms,
            },
        )
        .collect())
}

/// The most recent job's `(status, error)` for a document, or `None` if this account never queued
/// anything under it. Lets the body endpoint explain a version-less doc_id (still processing, or
/// failed with a tombstone) instead of a bare 404.
pub async fn latest_job_for_doc(
    node_db: &SqlitePool,
    account: &str,
    doc_id: &str,
) -> Result<Option<(String, Option<String>)>, AppError> {
    sqlx::query_as(
        "SELECT status, error FROM ingest_job \
         WHERE account = ?1 AND doc_id = ?2 ORDER BY seq DESC LIMIT 1",
    )
    .bind(account)
    .bind(doc_id)
    .fetch_optional(node_db)
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

    // The queue and its bookkeeping are testable with just a node DB + a scratch quarantine dir;
    // the transcode-and-land path (worker_pass -> process_job) needs a fully-agented identity with
    // sealed epoch keys and is exercised end-to-end by the integration tests instead.
    async fn node_db() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::node_migrator_for_test(&pool).await;
        pool
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
        }
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
        let jobs = jobs_for_account(&db, "acct-1").await.unwrap();
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
        sqlx::query("UPDATE ingest_job SET status = 'processing'")
            .execute(&db)
            .await
            .unwrap();
        tokio::fs::remove_file(dir.join(&lost)).await.unwrap();

        reconcile_on_boot(&db).await.unwrap();

        let jobs = jobs_for_account(&db, "acct-1").await.unwrap();
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
