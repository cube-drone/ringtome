//! Mirror eviction (PROJECT_PLAN's Discovery, slice 4): the retention edge, made real for the first time.
//!
//! Before this sweep, nothing ever evicted a mirrored persona - every chain that arrived
//! stayed forever, which was invisible while every mirror was asked for and became a leak
//! the moment speculation minted mirrors on a hunch (slice 1) whose hunches recede. The
//! sweep's one judgment: **a mirror nobody wants is holding chains nobody asked to keep.**
//!
//! "Nobody wants" is the conjunction of every relationship that can want a persona here:
//!
//!   - not HOSTED (an agented persona is this node's own charge, never evicted),
//!   - no SUBSCRIPTION (nobody's dial names them - follow, rebroadcast, or trust),
//!   - no FRAGMENT rows (a fragment is a reader-facing promise; shares retire on their own
//!     schedule and keep the mirror while they stand),
//!   - no DEMAND row (no reader's rollup admits them - the withdrawn-vouch case this sweep
//!     was built for).
//!
//! Eviction takes the chain files (db, WAL, journal, sealed key) and every bookkeeping
//! trace - the quiet fetch registry, speculative feed rows, the byline, the frontier memo,
//! mirrored edges, deliverer stamps, outstanding wants and body wants. Blobs are the
//! reaper's: with the chain and fragments gone their references are gone, and refcount
//! collection already owns unreferenced bytes. Everything here goes through each table's
//! owner (the conventions cop's rule); this module touches no table of its own.
//!
//! Recreation is demand-driven and therefore safe: every door that could re-mint the mirror
//! (the sync serve's `wanted` gate, the wake pass, the acquisition pass) acts only on the
//! same relationships whose absence admitted the eviction - if one returns, the mirror
//! returns with it, refetched from the network that minted it.

use anyhow::Result;

use crate::AppState;

/// How long a mirror must sit UNTOUCHED (db mtime) before it is evictable - the grace that
/// keeps the sweep from racing an in-flight pull or promotion. LOCAL_TEST may shorten it.
const EVICTION_GRACE_MS: i64 = 60 * 60 * 1000;

/// The judgment, pure: every keeper is a reason to stay. There is deliberately NO
/// open-handle keeper: the handle cache holds any recently-touched database until LRU
/// pressure says otherwise, so "cached" is not "in use" - the first draft kept every
/// mirror on a quiet node forever, silently, and the acceptance test caught it on its
/// first green-side run. Active use is what the mtime grace measures (a touched file is a
/// rested-clock reset), and `evict_mirror` invalidates the cached handle itself.
/// A member VISIT is deliberately absent from this conjunction (2026-08-25): the ageless
/// visit registry made every once-viewed mirror immortal, and an aged one collapsed to
/// nothing under the rig's zero grace - the visit's real retention claim is the mtime
/// grace itself (a fetch writes the file, and a mirror is only evictable once it has sat
/// QUIET for the whole window). `evict_one` still forgets the visit row, so the door
/// registry never outlives the database it points at.
fn evictable(
    hosted: bool,
    dialed: bool,
    has_fragments: bool,
    demanded: bool,
    rested: bool,
    looked: bool,
) -> bool {
    !hosted && !dialed && !has_fragments && !demanded && !looked && rested
}

/// One pass of the sweep (registered in main.rs, slow beat): walk every database on disk,
/// keep everything anyone wants, evict the rest with their traces. Per-mirror failures are
/// absorbed and logged - one wedged file must not stop the fleet's retention - and the next
/// beat retries anything left behind.
pub async fn evict_pass(state: AppState) -> Result<()> {
    let grace_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_EVICT_GRACE_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(EVICTION_GRACE_MS)
    } else {
        EVICTION_GRACE_MS
    };
    evict_pass_with_grace(state, grace_ms).await
}

/// The pass with the grace in hand - the test beat's door (`/test/beat` "evict" rings it
/// with grace ZERO: "evict NOW" gates on claims, never on clocks, the same posture as
/// every forced-due sweep beat).
pub async fn evict_pass_with_grace(state: AppState, grace_ms: i64) -> Result<()> {
    let expiry = state.config.peek_expiry_ms;
    evict_pass_with_grace_and_expiry(state, grace_ms, expiry).await
}

/// The pass with the peek expiry named too - the test beat's door for the expiry claim.
pub async fn evict_pass_with_grace_and_expiry(
    state: AppState,
    grace_ms: i64,
    peek_expiry_ms: i64,
) -> Result<()> {
    let now = crate::clock::now_ms();
    if let Err(e) = expire_peeks(&state, now, peek_expiry_ms).await {
        tracing::warn!("peek expiry failed; next beat retries: {e:#}");
    }
    let corpus = state.user_dbs.held_roots()?;
    if corpus.is_empty() {
        return Ok(());
    }
    let hosted: std::collections::HashSet<String> = crate::identity::hosted_roots(&state.node_db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .collect();
    for root in corpus {
        let hosted_here = hosted.contains(&root);
        let dialed = !crate::net::subscriptions::dialed_by(&state.node_db, &root)
            .await?
            .is_empty();
        // A SHARE's fragments keep a mirror; a peek's own fragments are the peek's and go
        // with it (PROJECT_PLAN's Peeks, ruling 6) - they must not make a peek immortal.
        let has_fragments = crate::fragments::any_shared_for_author(&state.node_db, &root).await?;
        let demanded = crate::speculative::demand_exists(&state.node_db, &root).await?;
        let rested = state
            .user_dbs
            .db_mtime_ms(&root)
            .is_none_or(|mt| now - mt >= grace_ms);
        // A peek somebody looked at within the expiry keeps (PROJECT_PLAN's Peeks, ruling 6): the look is
        // the rest clock a peek is judged by, and `expire_peeks` above is its judge.
        let looked = crate::idface::looked_within(&state.node_db, &root, now, peek_expiry_ms).await;
        if !evictable(hosted_here, dialed, has_fragments, demanded, rested, looked) {
            continue;
        }
        if let Err(e) = evict_one(&state, &root).await {
            tracing::warn!(root = %root, "eviction failed; next beat retries: {e:#}");
        } else {
            tracing::info!(root = %root, "evicted a mirror nobody wants");
        }
    }
    Ok(())
}

/// The mechanics for one mirror: files first (the authoritative act), then every trace -
/// each through its table's owner, best-effort in a fixed order so a partial failure leaves
/// only forgettable residue for the next beat.
/// The peeks' own retirement (PROJECT_PLAN's Peeks, ruling 6): a peek nobody has looked at for the expiry
/// goes, and when every peek together exceeds the node-wide budget the least recently
/// looked at go until it fits. Both ignore the mtime grace - the look is the rest clock a
/// peek is judged by - and both take the peek's fragments with the mirror.
async fn expire_peeks(state: &AppState, now: i64, expiry_ms: i64) -> Result<()> {
    let rows = crate::idface::peek_registry(&state.node_db).await?;
    let mut peeks: Vec<(String, i64, i64)> = Vec::new();
    for (root, looked, bytes) in rows {
        if !crate::idface::peek_held(state, &root).await {
            continue;
        }
        if now - looked >= expiry_ms {
            match evict_one(state, &root).await {
                Ok(()) => tracing::info!(root = %root, "evicted a peek nobody has looked at"),
                Err(e) => tracing::warn!(root = %root, "peek eviction failed; next beat retries: {e:#}"),
            }
            continue;
        }
        peeks.push((root, looked, bytes));
    }
    let mut total: u64 = peeks.iter().map(|(_, _, b)| (*b).max(0) as u64).sum();
    let budget = state.config.peek_total_bytes;
    peeks.sort_by_key(|(_, looked, _)| *looked);
    for (root, _, bytes) in peeks {
        if total <= budget {
            break;
        }
        match evict_one(state, &root).await {
            Ok(()) => {
                total = total.saturating_sub(bytes.max(0) as u64);
                tracing::info!(root = %root, "evicted the least recently looked-at peek for the budget");
            }
            Err(e) => tracing::warn!(root = %root, "peek eviction failed; next beat retries: {e:#}"),
        }
    }
    Ok(())
}

async fn evict_one(state: &AppState, root: &str) -> Result<()> {
    state.user_dbs.evict_mirror(root).await?;
    crate::fragments::forget_peek(&state.node_db, root).await?;
    crate::speculative::forget_fetch(&state.node_db, root).await?;
    crate::idface::forget_foreign_fetch(&state.node_db, root)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    crate::fanout::excise_suggested(&state.node_db, root).await?;
    crate::profiles::forget(&state.node_db, root).await?;
    crate::net::frontier::forget_persona(&state.node_db, root).await?;
    crate::edgegraph::forget_author(&state.node_db, root).await?;
    crate::fragments::forget_deliverers(&state.node_db, root).await?;
    crate::fragments::forget_wants(&state.node_db, root).await?;
    crate::net::bodies::reconcile(&state.node_db, root, &[]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every keeper keeps, and only the fully-unwanted rested mirror goes. Planted red
    /// against an `evictable` that ignored the hosted flag before it was trusted.
    #[test]
    fn every_keeper_keeps() {
        let gone = |h, d, f, de, r, l| evictable(h, d, f, de, r, l);
        assert!(gone(false, false, false, false, true, false));
        assert!(!gone(false, false, false, false, true, true), "a peek somebody looked at keeps (PROJECT_PLAN's Peeks, ruling 6)");
        assert!(!gone(true, false, false, false, true, false), "hosted keeps");
        assert!(!gone(false, true, false, false, true, false), "a dial keeps");
        assert!(!gone(false, false, true, false, true, false), "a SHARE's fragment keeps (a peek's own does not reach here)");
        assert!(!gone(false, false, false, true, true, false), "demand keeps");
        assert!(!gone(false, false, false, false, false, false), "grace keeps - the member-visit
            protection too, since a fetch is a write and a written file is not rested");
    }
}
