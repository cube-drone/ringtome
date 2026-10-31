//! Asking several computers the same thing, staggered (Curtis, 2026-10-30: "our current procedure
//! is to call Node Q, wait for it to time-out, then call Node R ... should we consider dialing them
//! all in parallel?").
//!
//! Not all at once: every ask reaches a computer that only had to hear from one, and spends one of
//! its connection seats (plans/CROWD.md) and tells it this computer is interested. So the first
//! candidate gets a head start, as a browser gives the first of a site's addresses: when it hasn't
//! answered within `STAGGER`, the next starts beside it, never in place of it - a slow computer that
//! is up still wins if it answers first - and an ask that fails starts the next at once. The first
//! answer ends the race, and the asks still running are dropped. Where the candidates are in good
//! order, which is the caller's business, the first is usually the only one asked.
//!
//! An ask answers `None` for "nothing here": it failed, or was refused, or had nothing. What counts
//! as an answer is the caller's: a connection for a sync, which then runs its exchange on the
//! winner alone (racing whole exchanges would download the same entries from everyone); a key for
//! the key lane, whose ask is a single round trip.

use std::future::Future;
use std::time::Duration;

use n0_future::{FuturesUnordered, StreamExt};

/// The head start: half a second, long enough for a nearby computer, or a far one through a relay,
/// to connect before anyone else is asked; short beside the six seconds a silent one costs
/// (`p2p::CONNECT_DEADLINE`).
pub const STAGGER: Duration = Duration::from_millis(500);

/// The most asks running at once, however long the list and however silent its head.
pub const IN_FLIGHT: usize = 4;

/// Ask `candidates` in order, staggered: the first answer, and whose it was. `None` when every
/// candidate was asked and none answered.
pub async fn first<C, T, F, Fut>(
    candidates: impl IntoIterator<Item = C>,
    stagger: Duration,
    ask: F,
) -> Option<(C, T)>
where
    C: Clone,
    F: Fn(C) -> Fut,
    Fut: Future<Output = Option<T>>,
{
    let mut waiting = candidates.into_iter().peekable();
    let mut running = FuturesUnordered::new();
    let launch = |c: C| {
        let asked = ask(c.clone());
        async move { (c, asked.await) }
    };
    loop {
        if running.len() < IN_FLIGHT {
            if let Some(c) = waiting.next() {
                running.push(launch(c));
            }
        }
        if running.is_empty() {
            return None;
        }
        let another = waiting.peek().is_some() && running.len() < IN_FLIGHT;
        tokio::select! {
            Some((c, answer)) = running.next() => {
                if let Some(t) = answer {
                    return Some((c, t));
                }
                // Nothing there: the next starts at once, at the top of the loop.
            }
            _ = tokio::time::sleep(stagger), if another => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tokio::time::{sleep, Instant};

    /// A candidate: how long it takes, and whether it answers then.
    #[derive(Clone)]
    struct Computer {
        name: &'static str,
        after: Duration,
        answers: bool,
    }

    const fn up(name: &'static str, ms: u64) -> Computer {
        Computer { name, after: Duration::from_millis(ms), answers: true }
    }
    const fn down(name: &'static str, ms: u64) -> Computer {
        Computer { name, after: Duration::from_millis(ms), answers: false }
    }

    /// The race over `computers`: who won, when, and everyone asked in the order they were.
    async fn race(computers: Vec<Computer>) -> (Option<&'static str>, Duration, Vec<&'static str>) {
        let asked = Mutex::new(Vec::new());
        let start = Instant::now();
        let won = first(computers, STAGGER, |c| {
            asked.lock().unwrap().push(c.name);
            async move {
                sleep(c.after).await;
                c.answers.then_some(())
            }
        })
        .await;
        (won.map(|(c, _)| c.name), start.elapsed(), asked.into_inner().unwrap())
    }

    #[tokio::test(start_paused = true)]
    async fn a_first_that_answers_quickly_is_the_only_one_asked() {
        let (won, took, asked) = race(vec![up("q", 100), up("r", 10), up("s", 10)]).await;
        assert_eq!(won, Some("q"));
        assert_eq!(took, Duration::from_millis(100));
        assert_eq!(asked, ["q"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_first_gets_company_after_the_head_start_not_a_timeout() {
        let (won, took, asked) = race(vec![down("q", 6000), up("r", 100), up("s", 100)]).await;
        assert_eq!(won, Some("r"));
        assert_eq!(took, STAGGER + Duration::from_millis(100));
        assert_eq!(asked, ["q", "r"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_slow_first_that_is_up_still_wins_if_it_answers_first() {
        let (won, took, asked) = race(vec![up("q", 700), up("r", 400)]).await;
        assert_eq!(won, Some("q"));
        assert_eq!(took, Duration::from_millis(700));
        assert_eq!(asked, ["q", "r"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_failure_starts_the_next_at_once() {
        let (won, took, asked) = race(vec![down("q", 0), down("r", 50), up("s", 100)]).await;
        assert_eq!(won, Some("s"));
        assert_eq!(took, Duration::from_millis(150));
        assert_eq!(asked, ["q", "r", "s"]);
    }

    #[tokio::test(start_paused = true)]
    async fn nobody_answering_is_none_once_everyone_was_asked() {
        let (won, _, asked) = race(vec![down("q", 6000), down("r", 6000), down("s", 0)]).await;
        assert_eq!(won, None);
        assert_eq!(asked, ["q", "r", "s"]);
    }

    #[tokio::test(start_paused = true)]
    async fn never_more_than_a_handful_at_once() {
        let silent: Vec<Computer> = ["a", "b", "c", "d", "e", "f"]
            .into_iter()
            .map(|n| down(n, 6000))
            .chain([up("g", 0)])
            .collect();
        let (won, took, asked) = race(silent).await;
        assert_eq!(won, Some("g"));
        // a to d start a head start apart and give up six seconds after starting; each that
        // gives up lets one more in - e at 6s, f at 6.5s, g at 7s, which answers at once.
        assert_eq!(asked.len(), 7);
        assert_eq!(took, Duration::from_millis(6000) + STAGGER * 2);
    }
}
