//! Publication as a job: a publish that outlives the request that asked for it.
//!
//! A post's pictures mint one public twin each, and a post with dozens of them could take longer
//! than anything in front of the node will hold a request open: a CDN's 60-second timeout cut an
//! importer's publishes of old blog posts at about fifteen pictures (2026-10-02), far short of
//! the fifty a post may carry. The answer keeps the publish door's existing contract - a 202
//! with the modal's item list means "not yet, ask again", the external-media bake's idiom - and
//! moves the work off the request:
//!
//!   * the first POST starts the job and waits a few seconds for it, so an ordinary publish still
//!     answers 200 on the spot, exactly as before;
//!   * past that, it answers 202 with each media item's standing (`bake::Progress`);
//!   * every later POST for the same note asks after the SAME job - it never starts a second -
//!     and the one after the job ends receives its answer, success or refusal alike.
//!
//! The job runs on a task of its own, so a dropped connection cannot stop it half-minted; an
//! answer nobody comes back for is swept after a while (the post stands either way).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::response::{IntoResponse, Response};

use crate::error::AppError;
use crate::record::bake::Progress;

/// How long the asking request waits before answering 202: past this the job keeps going on
/// its own and the client polls. Generous, so a normal publish never sees the poll at all.
const INLINE: Duration = Duration::from_secs(8);

/// How long a finished job's answer waits for someone to ask for it.
const KEEP_ANSWER: Duration = Duration::from_secs(600);

struct Job {
    progress: Arc<Progress>,
    /// The job's answer, once it has one: handed to the next ask, which removes the job.
    answer: Option<Result<Response, AppError>>,
    finished_at: Option<Instant>,
    /// Flips to true when `answer` is set, so a waiting ask wakes without polling.
    finished: tokio::sync::watch::Sender<bool>,
}

static JOBS: LazyLock<Mutex<HashMap<String, Job>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn key(root: &str, doc_id: &[u8; 16]) -> String {
    format!("{root}:{}", hex::encode(doc_id))
}

/// A test node's override of [`INLINE`], in ms (`/test/publish-inline`); negative means none.
/// Runtime, per test, never boot-wide: a tiny boot value would turn every OTHER test's publish
/// into a poll (the `/test/fresh-window` idiom).
pub static INLINE_OVERRIDE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

fn inline_wait() -> Duration {
    match INLINE_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        ms if ms >= 0 => Duration::from_millis(ms as u64),
        _ => INLINE,
    }
}

/// Ask after `doc_id`'s job, if it has one: its answer when finished (taking it), else how it
/// is going. None when no job stands - the route then validates and [`run`]s a new one. Asked
/// FIRST, before the route's checks, because those write (an audience asked for, a parent's
/// key): a poll must not repeat them while the job they started is minting.
pub fn ask(root: &str, doc_id: &[u8; 16]) -> Option<Result<Response, AppError>> {
    let key = key(root, doc_id);
    let mut jobs = JOBS.lock().expect("publish jobs poisoned");
    jobs.retain(|_, job| job.finished_at.is_none_or(|at| at.elapsed() < KEEP_ANSWER));
    let job = jobs.get_mut(&key)?;
    if job.answer.is_some() {
        let answer = job.answer.take().expect("checked above");
        jobs.remove(&key);
        return Some(answer);
    }
    Some(Ok(still_going(&job.progress)))
}

/// Publish `doc_id` as a job, or ask after the one already running for it. `work` is the
/// publication itself, run at most once per job; it reports its media to the `Progress` it is
/// handed and answers as the route would.
pub async fn run<F, Fut>(root: &str, doc_id: &[u8; 16], work: F) -> Result<Response, AppError>
where
    F: FnOnce(Arc<Progress>) -> Fut,
    Fut: std::future::Future<Output = Result<Response, AppError>> + Send + 'static,
{
    let key = key(root, doc_id);
    let mut finished = {
        let mut jobs = JOBS.lock().expect("publish jobs poisoned");
        jobs.retain(|_, job| job.finished_at.is_none_or(|at| at.elapsed() < KEEP_ANSWER));
        match jobs.get_mut(&key) {
            Some(job) if job.answer.is_some() => {
                let answer = job.answer.take().expect("checked above");
                jobs.remove(&key);
                return answer;
            }
            // Running: say how it is going. Never a second start.
            Some(job) => return Ok(still_going(&job.progress)),
            None => {
                let progress = Arc::new(Progress::default());
                let (finished, watching) = tokio::sync::watch::channel(false);
                let job = work(progress.clone());
                jobs.insert(
                    key.clone(),
                    Job { progress, answer: None, finished_at: None, finished },
                );
                let done_key = key.clone();
                tokio::spawn(async move {
                    // Its own task inside, so a panic becomes a refusal here rather than a job
                    // that reads "running" forever.
                    let answer = tokio::spawn(job).await.unwrap_or_else(|e| {
                        Err(AppError::Internal(anyhow::anyhow!("the publish stopped: {e}")))
                    });
                    let mut jobs = JOBS.lock().expect("publish jobs poisoned");
                    if let Some(job) = jobs.get_mut(&done_key) {
                        job.answer = Some(answer);
                        job.finished_at = Some(Instant::now());
                        job.finished.send_replace(true);
                    }
                });
                watching
            }
        }
    };
    let _ = tokio::time::timeout(inline_wait(), finished.wait_for(|done| *done)).await;
    let mut jobs = JOBS.lock().expect("publish jobs poisoned");
    match jobs.get_mut(&key) {
        Some(job) if job.answer.is_some() => {
            let answer = job.answer.take().expect("checked above");
            jobs.remove(&key);
            answer
        }
        Some(job) => Ok(still_going(&job.progress)),
        // Taken by a concurrent ask in the instant between: the job is over, and that ask
        // carried its answer. Report the last standing as still going; the next ask finds
        // no job and starts fresh - an idempotent publish of what is already public.
        None => Ok(still_going(&Progress::default())),
    }
}

/// The 202: the publish door's "not yet" with the modal's item list, plus `publishing` so a
/// client can tell a running job from media still preparing.
fn still_going(progress: &Progress) -> Response {
    (
        axum::http::StatusCode::ACCEPTED,
        axum::Json(serde_json::json!({ "baking": progress.items(), "publishing": true })),
    )
        .into_response()
}
