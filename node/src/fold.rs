//! The fold lane: per-root serialized, generation-based, drainable derived-state work.
//!
//! The ownership model this replaces (2026-08-25): every arrival path - both ends of a sync
//! exchange, the frontier backstop sweep, the body heal, a local publish - ran the derived-
//! state chain (frontier memo, feed journal, edge graph, notifications, share fold,
//! subscriptions memo) ITSELF, gated on `frontier::refresh`'s moved verdict. Under concurrent
//! exchanges one caller got `true` and fired the hooks over whatever snapshot it happened to
//! hold, every racer got a silent `false` and fired nothing, and detached hooks interleaved
//! with each other freely. The whole 2026-08 flake family was that model showing its face:
//! "the data arrived, but the derived state did not update until something unrelated moved."
//!
//! The model now:
//!   * **serialized** - one worker per root runs the chain; no two chain runs for the same
//!     root ever overlap;
//!   * **generation-based** - every arrival bumps the root's generation; the worker snapshots
//!     the generation BEFORE it runs and loops until it has covered the latest, so a nudge
//!     landing mid-run is never lost and the last run always starts after the last write it
//!     covers (read-your-writes, structurally);
//!   * **drainable** - `drain` awaits "a run that began at or after my nudge has completed",
//!     which is what the test beat's `fold` pass and any read-after-write caller actually
//!     mean by "folded".
//!
//! The moved verdict still exists inside the chain - as an INFO log and the hooks' own cheap
//! gates (edgegraph's service mark, the stat guards) - but it no longer decides WHO folds.
//! Arrival sites call [`nudge`] (or [`nudge_ledger`] when a general-private entry landed -
//! the memo-rewrite cost gate the old `ledger_moved` branch paid for) and move on; the lane
//! owns the rest.
//!
//! Rules for the chain's hooks: they may `nudge` any root (a bump on a running root is one
//! more loop, never a deadlock), and they must NEVER `drain`/`fold_now` their own root - a
//! worker awaiting its own completion never completes.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::AppState;

struct RootFold {
    /// Latest demanded generation - bumped by every nudge.
    generation: u64,
    /// A nudge since the last snapshot named the private ledger (general-private entries
    /// landed), so the next run must include the subscriptions-memo leg.
    ledger_pending: bool,
    /// Generation covered by the last COMPLETED run; watch so drains wake without polling.
    folded: tokio::sync::watch::Sender<u64>,
    /// A worker task is alive for this root.
    running: bool,
}

impl Default for RootFold {
    fn default() -> Self {
        let (folded, _) = tokio::sync::watch::channel(0);
        RootFold {
            generation: 0,
            ledger_pending: false,
            folded,
            running: false,
        }
    }
}

/// The registry. Module-static like `subscriptions::refresh_gate`, for the same reason: the
/// unit-test binary is many tests in one process, and roots are unique per test. Entries are
/// never removed - a root that folded once costs one small struct for the process's life,
/// bounded by how many personas this node has ever held.
static FOLDS: Mutex<Option<HashMap<String, RootFold>>> = Mutex::new(None);

fn with_root<T>(root: &str, f: impl FnOnce(&mut RootFold) -> T) -> T {
    let mut map = FOLDS.lock().expect("fold registry poisoned");
    let map = map.get_or_insert_with(Default::default);
    f(map.entry(root.to_string()).or_default())
}

/// Bump the root's generation; report whether the caller must spawn the worker. Pure
/// bookkeeping, split out so the state machine is testable without an `AppState`.
fn bump(root: &str, ledger: bool) -> (u64, bool) {
    with_root(root, |s| {
        s.generation += 1;
        if ledger {
            s.ledger_pending = true;
        }
        let spawn = !s.running;
        if spawn {
            s.running = true;
        }
        (s.generation, spawn)
    })
}

/// The worker's pre-run snapshot: the generation this run will cover, and whether it owes
/// the ledger leg. Taking `ledger_pending` here (not at completion) is what makes a ledger
/// nudge landing MID-run safe: it re-sets the flag, the completion check sees it, and the
/// worker loops.
fn snapshot(root: &str) -> (u64, bool) {
    with_root(root, |s| {
        let ledger = s.ledger_pending;
        s.ledger_pending = false;
        (s.generation, ledger)
    })
}

/// Record a completed run and decide, atomically with that record, whether the worker may
/// exit. The decision and `running = false` happen under one lock so a nudge can never slip
/// between "nothing left" and "worker gone" - the lost-wakeup this whole shape exists to
/// forbid.
fn complete(root: &str, covered: u64) -> bool {
    with_root(root, |s| {
        s.folded.send_if_modified(|f| {
            if covered > *f {
                *f = covered;
                true
            } else {
                false
            }
        });
        if s.generation == covered && !s.ledger_pending {
            s.running = false;
            true
        } else {
            false
        }
    })
}

/// If the worker dies without completing (a panicking hook), `running` must not stay latched
/// or the root never folds again - the guard clears it on the unwind path, and the next
/// nudge respawns. Disarmed on the loop's clean exit, which already cleared it under lock.
struct WorkerGuard {
    root: String,
    armed: bool,
}

impl Drop for WorkerGuard {
    fn drop(&mut self) {
        if self.armed {
            with_root(&self.root, |s| s.running = false);
        }
    }
}

/// The generic single-flight loop, chain injected so the state machine is testable with a
/// fake chain (the unit tests below) and production supplies [`run_chain`].
async fn worker_loop<F, Fut>(root: String, mut chain: F)
where
    F: FnMut(bool) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let mut guard = WorkerGuard {
        root: root.clone(),
        armed: true,
    };
    loop {
        let (target, ledger) = snapshot(&root);
        chain(ledger).await;
        if complete(&root, target) {
            guard.armed = false;
            break;
        }
    }
}

/// Something changed for this root - queue a fold and return the generation to [`drain`] on.
/// Never blocks, never runs the chain inline: safe from any context, including inside the
/// chain itself.
pub fn nudge(state: &AppState, root: &str) -> u64 {
    nudge_inner(state, root, false)
}

/// A nudge that also owes the subscriptions-memo leg: general-private entries landed (a
/// contact dial can be among them). The split keeps the old `ledger_moved` cost gate - a
/// batch of posts must not pay a hosted persona's full memo rewrite.
pub fn nudge_ledger(state: &AppState, root: &str) -> u64 {
    nudge_inner(state, root, true)
}

fn nudge_inner(state: &AppState, root: &str, ledger: bool) -> u64 {
    let (generation, spawn) = bump(root, ledger);
    if spawn {
        let state = state.clone();
        let root = root.to_string();
        tokio::spawn(async move {
            worker_loop(root.clone(), move |ledger| {
                let state = state.clone();
                let root = root.clone();
                async move { run_chain(&state, &root, ledger, false).await }
            })
            .await;
        });
    }
    generation
}

/// Await a completed run that began at or after `generation` (a [`nudge`]'s return). NEVER
/// call from inside the chain for the worker's own root.
pub async fn drain(root: &str, generation: u64) {
    let mut rx = with_root(root, |s| s.folded.subscribe());
    // The sender lives in the process-static registry, so wait_for can only err if the
    // registry itself is gone - shutdown, where an unfinished drain is moot.
    let _ = rx.wait_for(|folded| *folded >= generation).await;
}

/// Nudge (ledger leg included) and await the fold - the read-after-write form: the test
/// beat's `fold` pass, and any caller that must observe derived state current as of now.
pub async fn fold_now(state: &AppState, root: &str) {
    let generation = nudge_ledger(state, root);
    drain(root, generation).await;
}

/// The test beat's fold: every leg, movement or not - the vocabulary promises
/// "unconditionally", and a test that planted state by hand has no frontier move to show
/// for it. Production paths never force: the moved gate below is the whole cure for the
/// quadratic fold (2026-08-28).
pub async fn fold_now_forced(state: &AppState, root: &str) {
    run_chain(state, root, true, true).await;
}

/// The derived-state chain, in dependency order - the one place it runs. Every hook keeps
/// its own cheap change gates (correct now that no two runs race), and every hook absorbs
/// its own errors: a fold must always complete, or the generation ratchet stalls.
async fn run_chain(state: &AppState, root: &str, ledger: bool, force: bool) {
    // Per-leg timing, kept at debug: the fold is the app's hottest write path, and when
    // per-action cost creeps (the 2026-08-28 test-data quadratic hunt), THIS line is the
    // attribution - which leg grew, on whose fold, without reaching for a profiler.
    let t0 = std::time::Instant::now();
    // The moved gate (2026-08-28, the test-data quadratic): the four public legs below
    // derive ONLY from this root's public chains, and `refresh` answers exactly "did any
    // of those move since the last fold" (memo anchors vs stored fingerprints - local
    // appends included, since every entry writer notes the tip at write time). Unmoved
    // means their inputs are byte-identical to the last pass, so re-running them was pure
    // waste - and the waste grew with history (each leg re-derives from the full shelf),
    // which is how per-action cost went quadratic under test-data. Work that depends on
    // OTHER inputs has its own road: a new follower's history is `fanout`'s backfill, the
    // ledger legs ride the `ledger` flag below, fragment arrivals note their own memos at
    // intake.
    use ringtome_proto::registry::service;
    const EVERYTHING: [u32; 6] = [
        service::IDENTITY_PUBLIC,
        service::PROFILE_PUBLIC,
        service::POSTS,
        service::FOLLOWS_PUBLIC,
        service::REBROADCASTS,
        service::ANNOTATIONS_PUBLIC,
    ];
    let moved: Vec<u32> = match crate::net::frontier::refresh_moved(state, root).await {
        Ok(m) => {
            if !m.is_empty() {
                tracing::info!(root = %root, services = ?m, "public frontier moved");
            }
            m
        }
        Err(e) => {
            tracing::debug!(root = %root, error = ?e, "frontier refresh failed");
            // A refresh that cannot answer must not silence the legs: stale is worse
            // than slow, and the error path is rare.
            EVERYTHING.to_vec()
        }
    };
    let moved: Vec<u32> = if force { EVERYTHING.to_vec() } else { moved };
    let has = |s: u32| moved.contains(&s);
    let t_frontier = t0.elapsed();
    let t = std::time::Instant::now();
    if !moved.is_empty() {
        crate::fanout::after_public_move(state, root, &moved, force).await;
    }
    let t_journal = t.elapsed();
    let t = std::time::Instant::now();
    if has(service::POSTS) || has(service::FOLLOWS_PUBLIC) || has(service::REBROADCASTS) {
        crate::notifications::refresh_parts(state, root, &moved, force).await;
    }
    let t_notif = t.elapsed();
    let t = std::time::Instant::now();
    if has(service::REBROADCASTS) {
        crate::rebroadcast::refresh_from(state, root, force).await;
    }
    let t_shares = t.elapsed();
    let t = std::time::Instant::now();
    if has(service::POSTS) {
        crate::replies::refresh_from(state, root, force).await;
    }
    if has(service::ANNOTATIONS_PUBLIC) {
        crate::annotations::refresh_from(state, root, force).await;
    }
    let t_replies = t.elapsed();
    let t = std::time::Instant::now();
    if ledger {
        crate::net::subscriptions::refresh_root(state, root).await;
        crate::replies::curation_refresh_root(state, root).await;
    }
    let t_ledger = t.elapsed();
    tracing::debug!(
        root = %root,
        total_ms = t0.elapsed().as_millis() as u64,
        frontier_ms = t_frontier.as_millis() as u64,
        journal_ms = t_journal.as_millis() as u64,
        notifications_ms = t_notif.as_millis() as u64,
        shares_ms = t_shares.as_millis() as u64,
        replies_ms = t_replies.as_millis() as u64,
        ledger_ms = t_ledger.as_millis() as u64,
        "fold legs"
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;

    /// Drive the bookkeeping the way `nudge_inner` does, with a fake chain.
    fn test_nudge<F, Fut>(root: &str, ledger: bool, chain: F) -> u64
    where
        F: FnMut(bool) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (generation, spawn) = bump(root, ledger);
        if spawn {
            tokio::spawn(worker_loop(root.to_string(), chain));
        }
        generation
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn overlapping_nudges_serialize_and_none_is_lost() {
        let root = "fold-test-serial";
        let in_chain = Arc::new(AtomicU64::new(0));
        let runs = Arc::new(AtomicU64::new(0));
        let overlaps = Arc::new(AtomicU64::new(0));
        let make = {
            let (in_chain, runs, overlaps) = (in_chain.clone(), runs.clone(), overlaps.clone());
            move |_ledger: bool| {
                let (in_chain, runs, overlaps) =
                    (in_chain.clone(), runs.clone(), overlaps.clone());
                async move {
                    if in_chain.fetch_add(1, Ordering::SeqCst) != 0 {
                        overlaps.fetch_add(1, Ordering::SeqCst);
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    runs.fetch_add(1, Ordering::SeqCst);
                    in_chain.fetch_sub(1, Ordering::SeqCst);
                }
            }
        };
        // A burst of nudges from many tasks, all mid-flight of each other.
        let mut last = 0;
        for _ in 0..10 {
            last = test_nudge(root, false, make.clone());
        }
        drain(root, last).await;
        assert_eq!(overlaps.load(Ordering::SeqCst), 0, "no two chain runs overlap");
        let n = runs.load(Ordering::SeqCst);
        assert!(n >= 1, "the chain ran");
        assert!(n <= 10, "coalescing means at most one run per nudge, usually far fewer");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn drain_returns_only_after_a_run_that_saw_the_nudge() {
        // The read-your-writes property, pinned: a run that STARTED before the nudge cannot
        // satisfy its drain. The chain records the snapshot generation it ran under (via a
        // side channel); by drain-return, a run whose snapshot >= our nudge must have
        // completed.
        let root = "fold-test-ryw";
        let seen = Arc::new(AtomicU64::new(0));
        let make = {
            let seen = seen.clone();
            move |_ledger: bool| {
                let seen = seen.clone();
                let g = with_root("fold-test-ryw", |s| s.generation);
                async move {
                    tokio::time::sleep(std::time::Duration::from_millis(3)).await;
                    seen.fetch_max(g, Ordering::SeqCst);
                }
            }
        };
        for _ in 0..5 {
            let g = test_nudge(root, false, make.clone());
            drain(root, g).await;
            assert!(
                seen.load(Ordering::SeqCst) >= g,
                "drain returned before any run had covered generation {g}"
            );
        }
    }

    #[tokio::test]
    async fn the_ledger_leg_rides_only_a_ledger_nudge_and_is_never_dropped() {
        let root = "fold-test-ledger";
        let ledger_runs = Arc::new(AtomicU64::new(0));
        let plain_runs = Arc::new(AtomicU64::new(0));
        let make = {
            let (ledger_runs, plain_runs) = (ledger_runs.clone(), plain_runs.clone());
            move |ledger: bool| {
                let (ledger_runs, plain_runs) = (ledger_runs.clone(), plain_runs.clone());
                async move {
                    if ledger {
                        ledger_runs.fetch_add(1, Ordering::SeqCst);
                    } else {
                        plain_runs.fetch_add(1, Ordering::SeqCst);
                    }
                }
            }
        };
        let g = test_nudge(root, false, make.clone());
        drain(root, g).await;
        assert_eq!(ledger_runs.load(Ordering::SeqCst), 0, "a posts nudge owes no memo leg");

        let g = test_nudge(root, true, make.clone());
        drain(root, g).await;
        assert!(
            ledger_runs.load(Ordering::SeqCst) >= 1,
            "a ledger nudge's leg survives to some run, coalesced or not"
        );
    }
}
