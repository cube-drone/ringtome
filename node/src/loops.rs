//! Background loops: one spawner for every recurring process in the node.
//!
//! Modules export plain "one pass" functions - directly callable, directly testable, no time
//! machinery - and `main.rs` registers each with a name and a cadence. That registration block
//! is the complete inventory of the node's background work: to find out what runs on a timer,
//! read main. This module owns the ticking discipline once: the interval, failure logging under
//! the loop's name, and panic containment (a panicking pass is logged and the loop keeps
//! ticking, because a loop that silently dies is how republishing quietly stops forever).

use std::future::Future;
use std::time::Duration;

/// Run `job(state)` every `every`, forever, on its own task. The first pass runs immediately
/// (so boot re-establishes published state without waiting a full interval). Failures and
/// panics are logged under `name` and never stop the loop.
pub fn periodic<S, F, Fut>(name: &'static str, every: Duration, state: S, job: F)
where
    S: Clone + Send + 'static,
    F: Fn(S) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    periodic_inner(name, every, None, state, job)
}

/// [`periodic`], plus a doorbell: the loop also runs a pass immediately whenever a write nudge
/// fires, without waiting for the tick. The bus buffers a ping that arrives mid-pass, and
/// [`crate::db::await_write_nudge`] folds a lag into one wake, so a write racing the pass is
/// never lost. The tick keeps its own schedule regardless; a nudged pass never delays it.
pub fn periodic_nudged<S, F, Fut>(
    name: &'static str,
    every: Duration,
    nudge: crate::db::WriteNudge,
    state: S,
    job: F,
) where
    S: Clone + Send + 'static,
    F: Fn(S) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    periodic_inner(name, every, Some(nudge.subscribe()), state, job)
}

fn periodic_inner<S, F, Fut>(
    name: &'static str,
    every: Duration,
    mut nudge: Option<tokio::sync::broadcast::Receiver<()>>,
    state: S,
    job: F,
) where
    S: Clone + Send + 'static,
    F: Fn(S) -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<()>> + Send + 'static,
{
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            // Either the tick fires or a write nudge arrives (a no-nudge loop's receiver is
            // None, so `await_write_nudge` parks forever and only the tick drives it).
            tokio::select! {
                _ = tick.tick() => {}
                _ = crate::db::await_write_nudge(&mut nudge) => {}
            }
            // Each pass runs in its own task so a panic is contained (and logged as a join
            // error) instead of killing the loop.
            match tokio::spawn(job(state.clone())).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tracing::warn!(loop_name = name, "background pass failed: {e:#}"),
                Err(join_error) => {
                    tracing::error!(loop_name = name, "background pass panicked: {join_error}")
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test(start_paused = true)]
    async fn a_loop_outlives_failures_and_panics() {
        let passes = Arc::new(AtomicU32::new(0));
        periodic(
            "test-loop",
            Duration::from_secs(60),
            passes.clone(),
            |counter| async move {
                match counter.fetch_add(1, Ordering::SeqCst) {
                    0 => anyhow::bail!("first pass fails"),
                    1 => panic!("second pass panics (expected noise in test output)"),
                    _ => Ok(()),
                }
            },
        );

        // Paused clock: this sleep fast-forwards virtual time through five tick deadlines.
        tokio::time::sleep(Duration::from_secs(60 * 5 + 1)).await;
        assert!(
            passes.load(Ordering::SeqCst) >= 3,
            "the loop kept ticking through an error and a panic"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_nudge_runs_a_pass_without_waiting_for_the_tick() {
        let passes = Arc::new(AtomicU32::new(0));
        let bus = tokio::sync::broadcast::channel::<()>(16).0;
        periodic_nudged(
            "test-nudged-loop",
            Duration::from_secs(3600),
            bus.clone(),
            passes.clone(),
            |counter| async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        );

        // The interval's first tick is immediate: one boot pass.
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(passes.load(Ordering::SeqCst), 1, "the boot pass ran");

        // A ping mid-interval wakes the loop right away - virtual time is nowhere near the
        // hour tick.
        let _ = bus.send(());
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert_eq!(passes.load(Ordering::SeqCst), 2, "the nudge ran a pass");

        // Quiet bus, quiet loop: no extra passes sneak in between ticks.
        tokio::time::sleep(Duration::from_secs(60)).await;
        assert_eq!(passes.load(Ordering::SeqCst), 2, "no phantom passes");
    }
}
