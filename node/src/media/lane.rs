//! Where crushing runs: a pool one core short of the machine, and one queue for the background
//! workers (Curtis, 2026-10-02: "make sure we don't have fat encryption and media encoding calls
//! eating all CPUs at once").
//!
//! An encode wants every core it can get - rav1e splits a frame into tiles, video.rs splits a clip
//! into keyframe chunks - and on a box with a dozen cores it may have nearly all of them. Never the
//! last one: requests, sync and the database run on the async runtime, and a crush that takes every
//! core starves them for as long as a video takes. So every crush runs on [`pool`], sized one short
//! of the machine (`RINGTOME_MEDIA_THREADS` overrides), and the encoders find it as their current
//! rayon pool - rav1e and ravif both split their work on whatever pool calls them.
//!
//! The background workers - the upload queue (ingest.rs) and the bake (record/bake.rs) - also take
//! turns through [`background`]: one crush at a time between them, so a bake never doubles up on a
//! video. A crush a request waits on (a drawing, an avatar, a banner) skips that queue: it shares
//! the pool's threads, but never waits behind somebody's video.
//!
//! On a one-core machine the pool has one thread and there is no spare core to keep; the runtime
//! and the crush share it. That is what one core costs.

use std::sync::OnceLock;

use tokio::sync::Semaphore;
use tokio::task::JoinError;

static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

/// The background workers' turn: one crush at a time.
static BACKGROUND: Semaphore = Semaphore::const_new(1);

/// How many threads crush: what the operator asked for, else one short of the machine, never none.
fn size(cores: usize, wanted: Option<usize>) -> usize {
    wanted.filter(|&n| n > 0).unwrap_or(cores.saturating_sub(1)).max(1)
}

fn pool() -> &'static rayon::ThreadPool {
    POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
        let wanted = std::env::var("RINGTOME_MEDIA_THREADS").ok().and_then(|v| v.parse().ok());
        let threads = size(cores, wanted);
        tracing::info!(threads, cores, "media pool");
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("media-{i}"))
            .build()
            .expect("the media pool starts")
    })
}

/// Crush on the media pool, off the async runtime - for a crush somebody's request is waiting on.
pub async fn crush<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, JoinError> {
    tokio::task::spawn_blocking(move || pool().install(work)).await
}

/// A background worker's crush: its turn in the queue, then [`crush`]. The turn rides into the
/// work, so a caller that stops waiting doesn't let the next crush start beside this one.
pub async fn background<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, JoinError> {
    let turn = BACKGROUND.acquire().await.expect("the background queue never closes");
    crush(move || {
        let _turn = turn;
        work()
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn the_pool_leaves_a_core_unless_there_is_only_one() {
        assert_eq!(size(12, None), 11);
        assert_eq!(size(2, None), 1);
        assert_eq!(size(1, None), 1);
        assert_eq!(size(12, Some(4)), 4, "the operator's number wins");
        assert_eq!(size(2, Some(0)), 1, "zero means the default, not no crushing");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_encoders_split_their_work_on_the_media_pool() {
        let seen = crush(rayon::current_num_threads).await.unwrap();
        assert_eq!(seen, pool().current_num_threads());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn background_crushes_take_turns() {
        let running = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let crushes = (0..4).map(|_| {
            let (running, most) = (running.clone(), most.clone());
            tokio::spawn(background(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                most.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(30));
                running.fetch_sub(1, Ordering::SeqCst);
            }))
        });
        for c in crushes.collect::<Vec<_>>() {
            c.await.unwrap().unwrap();
        }
        assert_eq!(most.load(Ordering::SeqCst), 1, "never two background crushes at once");
    }
}
