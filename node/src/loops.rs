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
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
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
}
