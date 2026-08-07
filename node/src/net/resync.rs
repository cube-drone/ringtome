//! Background sync: eager push of fresh local writes, plus periodic anti-entropy.
//!
//! Two registered passes (see main.rs's loop inventory), both thin schedulers over the one
//! point-to-point exchange in [`super::sync`]:
//!
//!   - **Eager push** (fast tick + doorbell): notice that an identity's chains moved, wait
//!     for the burst to quiet (the debounce), then run a full exchange with every known
//!     peer - the "seconds-while-connected" freshness mitigation (PROJECT_PLAN, Loss and
//!     the Replication Window). Locally-*signed* writes additionally ring the write nudge
//!     (`Db::nudge_sync`, wired through `loops::periodic_nudged`), so the pass that starts
//!     the debounce clock runs at the write itself instead of up to a tick later - and names
//!     the identity, so that pass does one root's work rather than every root's. Entries
//!     that *arrive* by sync move the frontier too, so a push received from one peer
//!     re-dirties the root here and relays onward next tick - epidemic spread over the peer
//!     graph, converging because an up-to-date exchange transfers nothing. Relayed entries
//!     deliberately do NOT ring the bell: local writes are latency-sensitive and rare, relay
//!     traffic is neither, and keeping relays on the lazy tick is the damping that keeps a
//!     peer triangle from ping-ponging exchanges.
//!   - **Anti-entropy** (slow interval): a full exchange with a few peers chosen at random
//!     over the whole peer set, dirty or not (PROJECT_PLAN, sync discipline - the random
//!     choice is what keeps the sync graph well-connected). This is the reliability layer:
//!     eager push may miss (offline peers, process restarts losing tracker state), anti-
//!     entropy always catches up, starting with its immediate first pass at boot.
//!
//! Who gets what is decided *inside* the exchange, per-connection, by member proofs - private
//! chains never leave the membership boundary no matter who schedules the dial. This module
//! only decides when to dial whom, and dials only peers already known in `identity_peers`
//! (which is a discovery limit, not a permission model: hosts holding tradeable information
//! should sync, unprompted - refusal is a future per-identity operator policy, not the
//! default).
//!
//! Change detection is a per-root frontier snapshot compared against the last push: one GROUP
//! BY over `entries` per root examined. A NAMED pass examines exactly one - the nudge carries
//! the root that wrote (2026-08-04), so one person posting no longer makes a node scan every
//! persona it holds to discover that nobody else did. The tick still sweeps everyone, which is
//! what it is for: entries arriving by sync never ring the bell, so only the sweep finds them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::anyhow;

use crate::clock::now_ms;
use crate::net::sync;
use crate::AppState;

/// Eager-loop cadence (registered in main.rs). The write nudge handles the local-write case
/// in ~0ms; this tick is what paces everything else - relays, retries, the follow-up pass
/// that finds the debounce open. Write-to-peer latency floor: ~debounce rounded up to the
/// next tick (typically just over a second at the defaults).
pub const EAGER_TICK: Duration = Duration::from_secs(1);
/// Under continuous writes the debounce never opens; push anyway once dirty this long.
const MAX_PUSH_DELAY_MS: i64 = 30_000;
/// After a push reached zero peers, wait this long before re-dialing. Offline peers must not
/// be re-dialed every tick; anti-entropy is the reliability layer behind this backoff.
const FAILED_PUSH_RETRY_MS: i64 = 30_000;
/// Anti-entropy fanout: k random peers per interval over the full peer set (doctrine k=3-5).
const ANTI_ENTROPY_PEERS: usize = 3;

/// Frontier snapshot used for change detection: sorted (author, service, floor, head,
/// head_hash) rows. Compared by equality only - a frontier moving *down* (forgery eviction)
/// is a change too. HEAD_HASH INCLUDED (2026-08-06): a same-height replacement - eviction
/// re-admitting an anchored prefix of equal length - changes authoritative content without
/// moving a single seq, and a hashless snapshot called that "nothing happened", so the eager
/// loop never pushed the correction. Includes private chains: the snapshot never leaves this
/// process, so no disclosure arises.
type Fingerprint = Vec<([u8; 32], u32, u64, u64, [u8; 32])>;

fn fingerprint(frontiers: Vec<ringtome_proto::sync::Frontier>) -> Fingerprint {
    let mut fp: Fingerprint = frontiers
        .into_iter()
        .map(|f| (f.author, f.service, f.floor, f.head, f.head_hash))
        .collect();
    fp.sort_unstable();
    fp
}

/// Per-root debounce state. `last_pushed` is the frontier snapshot captured at the last push
/// that reached at least one peer - dirty means "the world moved past what we've shared".
#[derive(Debug, Clone)]
struct RootState {
    /// Frontiers at the most recent tick.
    last_seen: Fingerprint,
    /// When `last_seen` last moved (tick granularity - the debounce clock).
    last_changed_ms: i64,
    /// Frontiers captured just before the last push that reached >= 1 peer.
    last_pushed: Fingerprint,
    /// When the root became dirty (the max-delay clock); None while clean.
    dirty_since_ms: Option<i64>,
    /// Any push attempt, success or failure (the failure-backoff clock).
    last_attempt_ms: i64,
    /// The last attempt reached zero peers (drives backoff + warn-on-transition).
    failing: bool,
}

/// What the eager pass should do about one root, as decided by [`ResyncTracker::observe`].
struct Decision {
    push: bool,
    /// The root was already in the failing state before this tick (suppresses repeat warns).
    was_failing: bool,
}

/// Fold one observed fingerprint into a root's state and decide whether to push now.
///
/// A first observation seeds *dirty* (empty `last_pushed`): a root that appears in the
/// worklist mid-run - a fresh adoption - may carry writes that landed after its last exchange,
/// and seeding clean was empirically shown to swallow them until anti-entropy (a write in the
/// sub-second gap between the adoption's peer-add and this loop's first look). The price is
/// one no-op frontier exchange per root at boot, redundancy the sync discipline explicitly
/// calls cheap. A root with no entries stays clean (empty == empty). Thresholds arrive as
/// parameters so tests need no time machinery.
fn observe_state(
    prior: Option<RootState>,
    fp: Fingerprint,
    now_ms: i64,
    debounce_ms: i64,
    max_delay_ms: i64,
    retry_ms: i64,
) -> (RootState, bool) {
    let mut st = prior.unwrap_or_else(|| RootState {
        last_seen: Fingerprint::new(),
        last_changed_ms: now_ms,
        last_pushed: Fingerprint::new(),
        dirty_since_ms: None,
        last_attempt_ms: 0,
        failing: false,
    });

    if fp != st.last_seen {
        st.last_seen = fp;
        st.last_changed_ms = now_ms;
    }

    let dirty = st.last_seen != st.last_pushed;
    if dirty {
        if st.dirty_since_ms.is_none() {
            st.dirty_since_ms = Some(now_ms);
        }
    } else {
        st.dirty_since_ms = None;
    }

    let quiesced = now_ms - st.last_changed_ms >= debounce_ms;
    let overdue = st
        .dirty_since_ms
        .is_some_and(|since| now_ms - since >= max_delay_ms);
    let backing_off = st.failing && now_ms - st.last_attempt_ms < retry_ms;
    let push = dirty && (quiesced || overdue) && !backing_off;
    (st, push)
}

/// Record the outcome of a push attempt. `fp` is the fingerprint captured *before* the
/// exchange, so writes that land mid-push leave the root dirty for the next tick. A successful
/// push restarts the max-delay clock; a total failure arms the backoff.
fn record_push_state(st: &mut RootState, fp: Fingerprint, any_peer_ok: bool, now_ms: i64) {
    st.last_attempt_ms = now_ms;
    if any_peer_ok {
        st.last_pushed = fp;
        st.dirty_since_ms = None;
        st.failing = false;
    } else {
        st.failing = true;
    }
}

/// In-memory eager-push debounce state, one entry per root, hung on AppState. Rebuilt empty
/// each boot: every root re-seeds dirty and re-pushes once (cheap), and anti-entropy's
/// immediate first pass covers whatever that misses.
#[derive(Clone, Default)]
pub struct ResyncTracker(Arc<Mutex<HashMap<String, RootState>>>);

impl ResyncTracker {
    fn observe(&self, root: &str, fp: Fingerprint, now_ms: i64, debounce_ms: i64) -> Decision {
        let mut map = self.0.lock().expect("resync tracker poisoned");
        let prior = map.get(root).cloned();
        let was_failing = prior.as_ref().is_some_and(|s| s.failing);
        let (st, push) = observe_state(
            prior,
            fp,
            now_ms,
            debounce_ms,
            MAX_PUSH_DELAY_MS,
            FAILED_PUSH_RETRY_MS,
        );
        map.insert(root.to_string(), st);
        Decision { push, was_failing }
    }

    fn record_push(&self, root: &str, fp: Fingerprint, any_peer_ok: bool, now_ms: i64) {
        let mut map = self.0.lock().expect("resync tracker poisoned");
        if let Some(st) = map.get_mut(root) {
            record_push_state(st, fp, any_peer_ok, now_ms);
        }
    }
}

/// One eager-push pass: fingerprint every agented identity that has peers; push a debounced,
/// quiescent change to all of them. Latency mechanism only - a fully-unreachable peer set gets
/// one warn and a lazy retry, never a dial every tick.
/// One pass. `who` is the identity a write nudge named, when it could: a named pass pushes only
/// that persona, because the other nine hundred and ninety-nine on this node did not write and
/// scanning them all to discover that is the cost this parameter exists to delete. `None` - a
/// tick, or a lagged receiver that can no longer say what it missed - sweeps everyone.
pub async fn eager_pass(state: AppState, who: Option<String>) -> anyhow::Result<()> {
    let roots = match who {
        Some(root) => vec![root],
        None => sync::roots_with_peers(&state.node_db).await?,
    };
    for root in roots {
        if let Err(e) = eager_root(&state, &root).await {
            tracing::warn!(root = %root, "eager push pass failed: {e:#}");
        }
    }
    Ok(())
}

async fn eager_root(state: &AppState, root: &str) -> anyhow::Result<()> {
    // Guard before user_dbs.get: get() CREATES the database if absent, and a stale peer row
    // must not mint DBs for identities this node no longer agents.
    let agented = crate::identity::is_agented(&state.node_db, root)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    if !agented {
        return Ok(());
    }

    let db = state.user_dbs.get(root).await?;
    let fp = fingerprint(sync::local_frontiers(&db, true).await?);
    let decision = state
        .resync
        .observe(root, fp.clone(), now_ms(), state.config.sync_debounce_ms);
    if !decision.push {
        return Ok(());
    }

    let peers = sync::peers_for(&state.node_db, root).await?;
    let mut results = sync::sync_peers(state, root, &peers).await?;
    let mut any_ok = results.iter().any(|r| r.ok);
    for r in results.iter().filter(|r| !r.ok) {
        tracing::debug!(root = %root, peer = %r.peer, error = ?r.error, "eager push: peer unreachable");
    }
    if !any_ok && !decision.was_failing {
        // The failure EDGE: reaching zero peers is the loudest possible signal that the peer
        // view is stale, so re-derive it from tree x directory right now rather than letting
        // the write wait out the backoff plus the derive sweep's beat. If derivation surfaces
        // anyone new, one immediate retry at just the newcomers - the freshly-resolved rows
        // are exactly the endpoints most likely to be alive (their records are current).
        sync::derive_peers_for(state, root).await;
        let refreshed = sync::peers_for(&state.node_db, root).await?;
        let newcomers: Vec<String> = refreshed
            .into_iter()
            .filter(|p| !peers.contains(p))
            .collect();
        if !newcomers.is_empty() {
            tracing::info!(root = %root, newcomers = newcomers.len(),
                "eager push found nobody home; derived fresh peers and retrying");
            let retry = sync::sync_peers(state, root, &newcomers).await?;
            any_ok = any_ok || retry.iter().any(|r| r.ok);
            results.extend(retry);
        }
    }
    if !any_ok && !decision.was_failing {
        tracing::warn!(root = %root, peers = results.len(),
            "eager push reached no peers; backing off (anti-entropy will catch up)");
    }
    let moved: u64 = results
        .iter()
        .filter_map(|r| r.stats.as_ref())
        .map(|s| s.sent + s.received)
        .sum();
    if any_ok && moved > 0 {
        tracing::info!(root = %root, entries_moved = moved, "eager push delivered");
    }
    state.resync.record_push(root, fp, any_ok, now_ms());
    Ok(())
}

/// One anti-entropy pass: for every agented identity with peers, a full exchange with up to
/// [`ANTI_ENTROPY_PEERS`] random peers - dirtiness is irrelevant, redundancy is the point.
/// Does not touch the tracker: entries it pulls re-dirty the frontier and the eager loop
/// relays them onward.
pub async fn anti_entropy_pass(state: AppState) -> anyhow::Result<()> {
    for root in sync::roots_with_peers(&state.node_db).await? {
        let agented = crate::identity::is_agented(&state.node_db, &root)
            .await
            .map_err(|e| anyhow!("{e}"))?;
        if !agented {
            continue;
        }

        let peers = sync::peers_for(&state.node_db, &root).await?;
        let sample: Vec<String> = {
            use rand::seq::SliceRandom;
            peers
                .choose_multiple(&mut rand::thread_rng(), ANTI_ENTROPY_PEERS)
                .cloned()
                .collect()
        };
        let results = sync::sync_peers(&state, &root, &sample).await?;
        for r in &results {
            match (&r.ok, &r.stats) {
                (true, Some(s)) if s.sent + s.received > 0 => {
                    tracing::info!(root = %root, peer = %r.peer, sent = s.sent,
                        received = s.received, "anti-entropy exchange moved entries");
                }
                (false, _) => {
                    tracing::warn!(root = %root, peer = %r.peer, error = ?r.error,
                        "anti-entropy exchange failed");
                }
                _ => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The debounce decision under time pressure. All clocks are explicit parameters, so these
    //! walk wall-clock scenarios tick by tick with plain numbers - no tokio, no paused time.

    use super::*;

    const DEBOUNCE: i64 = 3_000;
    const MAX_DELAY: i64 = 30_000;
    const RETRY: i64 = 30_000;

    fn fp(head: u64) -> Fingerprint {
        // The hash column derives from the head here so plain "the chain grew" scenarios
        // stay one-parameter; same_height_new_hash below varies it independently.
        vec![([0xAA; 32], 3, 0, head, [head as u8; 32])]
    }

    fn observe(prior: Option<RootState>, f: Fingerprint, now: i64) -> (RootState, bool) {
        observe_state(prior, f, now, DEBOUNCE, MAX_DELAY, RETRY)
    }

    #[test]
    fn a_same_height_replacement_is_movement() {
        // Eviction re-admitting an anchored prefix of equal length changes WHICH chain is
        // held without moving a seq. The snapshot must call that a change, or the eager loop
        // never pushes the correction (ChatGPT's third pitch, 2026-08-06: "a same-height
        // replacement changes authoritative content without changing that tracker's
        // snapshot").
        let before: Fingerprint = vec![([0xAA; 32], 3, 0, 7, [0xBB; 32])];
        let after: Fingerprint = vec![([0xAA; 32], 3, 0, 7, [0xCC; 32])];
        assert_ne!(before, after, "same height, different chain - the tracker must see it");
        let (settled, _) = observe(None, before.clone(), 0);
        let (state, _) = observe(Some(settled), after, DEBOUNCE + 1);
        assert!(state.dirty_since_ms.is_some(), "the replacement dirtied the root");
    }

    #[test]
    fn a_new_root_seeds_dirty_and_pushes_exactly_once() {
        // A root appearing mid-run (fresh adoption) may hold writes newer than its last
        // exchange - it must push even though this tracker never saw a change happen.
        let (st, push) = observe(None, fp(5), 1_000);
        assert!(!push, "the debounce still applies to the seed");
        let (mut st, push) = observe(Some(st), fp(5), 5_000);
        assert!(push, "a newly-tracked root pushes after the debounce");
        record_push_state(&mut st, fp(5), true, 5_000);
        let (_, push) = observe(Some(st), fp(5), 60_000);
        assert!(!push, "after that one push, unchanged frontiers stay clean");
    }

    #[test]
    fn a_root_with_no_entries_stays_clean() {
        let (st, push) = observe(None, Fingerprint::new(), 1_000);
        assert!(!push);
        let (_, push) = observe(Some(st), Fingerprint::new(), 60_000);
        assert!(!push, "nothing to share, nothing to dial");
    }

    #[test]
    fn a_change_pushes_only_after_the_debounce_quiets() {
        let (st, _) = observe(None, fp(1), 0);
        let (st, push) = observe(Some(st), fp(2), 2_000);
        assert!(!push, "the change itself is inside the debounce window");
        let (st, push) = observe(Some(st), fp(2), 4_000);
        assert!(!push, "2s of quiet < 3s debounce");
        let (_, push) = observe(Some(st), fp(2), 6_000);
        assert!(push, "3s+ of quiet opens the debounce");
    }

    #[test]
    fn continuous_writes_hit_the_max_latency_cap() {
        let (mut st, _) = observe(None, fp(0), 0);
        let mut now = 0;
        let mut head = 0;
        // A new write every tick: the debounce never opens...
        while now < MAX_DELAY - EAGER_TICK.as_millis() as i64 {
            now += EAGER_TICK.as_millis() as i64;
            head += 1;
            let (next, push) = observe(Some(st), fp(head), now);
            st = next;
            assert!(!push, "still churning at t={now}");
        }
        // ...until the dirty age crosses the cap.
        now += EAGER_TICK.as_millis() as i64 * 2;
        let (_, push) = observe(Some(st), fp(head + 1), now);
        assert!(
            push,
            "a continuously-written root must still push within the cap"
        );
    }

    #[test]
    fn a_successful_push_returns_the_root_to_clean() {
        let (st, _) = observe(None, fp(1), 0);
        let (mut st, push) = observe(Some(st), fp(2), 10_000);
        assert!(!push);
        let (mut st2, push) = observe(Some(st.clone()), fp(2), 14_000);
        assert!(push);
        record_push_state(&mut st2, fp(2), true, 14_000);
        let (_, push) = observe(Some(st2), fp(2), 20_000);
        assert!(!push, "pushed state is clean");

        // Mid-push write: the push captured fp(2) but fp(3) landed during the exchange.
        record_push_state(&mut st, fp(2), true, 14_000);
        let (st, _) = observe(Some(st), fp(3), 14_500);
        let (_, push) = observe(Some(st), fp(3), 18_000);
        assert!(push, "the write that landed mid-push re-dirties the root");
    }

    #[test]
    fn a_failed_push_backs_off_instead_of_redialing_every_tick() {
        let (st, _) = observe(None, fp(1), 0);
        let (st, push) = observe(Some(st), fp(2), 10_000);
        assert!(!push);
        let (mut st_at_push, push) = observe(Some(st), fp(2), 14_000);
        assert!(push);
        record_push_state(&mut st_at_push, fp(2), false, 14_000);
        let (st_backed, push) = observe(Some(st_at_push), fp(2), 20_000);
        assert!(!push, "inside the retry backoff");
        let (_, push) = observe(Some(st_backed), fp(2), 14_000 + RETRY + 1);
        assert!(push, "after the backoff the dirty root retries");
    }

    #[test]
    fn an_eviction_that_lowers_a_frontier_still_reads_as_a_change() {
        let (st, _) = observe(None, fp(5), 0);
        let (st, push) = observe(Some(st), fp(3), 2_000);
        assert!(!push, "inside the debounce");
        let (_, push) = observe(Some(st), fp(3), 6_000);
        assert!(
            push,
            "a chain moving DOWN (forgery eviction) must propagate too"
        );
    }
}
