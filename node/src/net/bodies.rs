//! The gravedigger's rounds: an index of missing bodies, checked up on periodically.
//!
//! Headers ride entry sync; bodies ride iroh-blobs behind them. The EVENT half of that lane
//! (sync.rs: every exchange ends in a body walk, and a fruitful walk re-rides the fan-out
//! edge) heals the ordinary case in about a round trip. This module is the RECOVERY half -
//! events for latency, sweeps for recovery - for the case where every event missed: the
//! pusher's poke failed in transit, and a node that only ever *responds* (a follower holding
//! a mirror) sees no further exchange until the author's next post.
//!
//! The design is three small moves on machinery that already exists:
//!   * the body walk already computes each persona's missing set on every exchange - it now
//!     RECORDS the shortfall in `missing_bodies` (replace-set per persona) instead of
//!     discarding it;
//!   * the sweep's worklist is `SELECT DISTINCT root FROM missing_bodies` - an empty ledger
//!     is a zero-cost tick, and the guard *is* the memo, no stat-marks needed;
//!   * per due persona it guesses who might have the bytes - the via that answered our
//!     fetch, the nodes that asked us, the device peers - and runs the same walk at each
//!     until whole. A blob fetch is hash-capability, so a wrong guess costs a dial and
//!     discloses nothing new (each candidate already knew of our interest in this persona).
//!
//! Owns the `missing_bodies` SQL (tests/conventions.rs). Backoff lives in `tries` /
//! `last_tried_ms`, which belong to the sweep alone - walks reconcile membership only, so
//! steady-state exchange churn never resets a backoff clock.

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// Asker candidates per healing attempt. Wider than the push's dial cap on purpose: healing
/// wants breadth (any one candidate holding the bytes ends the walk - the loop below exits
/// at whole), and the backoff ladder already paces how often a stubborn persona retries.
const ASKER_CANDIDATE_CAP: i64 = 64;

/// Note ONE blob as wanted, additively.
///
/// The counterpart to [`reconcile`], which replaces a whole persona's set from a body walk over
/// chains this node holds. A fragment's body has no such walk behind it - the document's author
/// is not synced here at all (`fragments`), so nothing would ever compute it into a missing set.
/// Without this, a shared document's words would depend entirely on the one direct fetch at
/// journal time succeeding, with no retry, forever.
///
/// Idempotent, and it never disturbs an existing row's backoff: re-noting a blob already wanted
/// must not reset the ladder that is pacing it.
pub async fn want(node_db: &Db, root_hex: &str, blob_hash: &[u8; 32]) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO missing_bodies (root_pubkey, blob_hash, first_noted_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (root_pubkey, blob_hash) DO NOTHING",
            (root_hex, blob_hash.to_vec(), now_ms()),
        )
        .await
        .context("noting a wanted body")?;
    Ok(())
}

/// Replace one persona's ledger rows with the freshly computed missing set. Called by the
/// body walk after every attempt, with whatever is STILL absent - so satisfied rows clear on
/// arrival regardless of which path the bytes took, and rows whose documents vanished
/// (retraction, repudiation) clear on the next look. An empty `still_missing` empties the
/// persona's ledger. Existing rows keep their backoff state; only membership changes.
pub async fn reconcile(node_db: &Db, root_hex: &str, still_missing: &[[u8; 32]]) -> Result<()> {
    let quoted: Vec<String> = still_missing
        .iter()
        .map(|h| format!("X'{}'", hex::encode(h)))
        .collect();
    node_db
        .execute(
            &format!(
                "DELETE FROM missing_bodies WHERE root_pubkey = ?1 AND blob_hash NOT IN ({})",
                if quoted.is_empty() { "X''".into() } else { quoted.join(",") }
            ),
            (root_hex,),
        )
        .await
        .context("clearing satisfied missing-body rows")?;
    let now = now_ms();
    for hash in still_missing {
        node_db
            .execute(
                "INSERT OR IGNORE INTO missing_bodies (root_pubkey, blob_hash, first_noted_ms)
                 VALUES (?1, ?2, ?3)",
                (root_hex, hash.to_vec(), now),
            )
            .await
            .context("noting a missing body")?;
    }
    Ok(())
}

/// How long a row rests after `tries` failed sweep attempts: 30s doubling to a one-hour
/// ceiling. Pure, so the ladder is testable without a clock.
fn backoff_ms(tries: i64) -> i64 {
    let capped = tries.clamp(0, 7) as u32; // 30s << 7 = 64min, past the ceiling already
    (30_000i64 << capped).min(3_600_000)
}

/// Is a row worth another attempt now? Never-tried rows are always due.
fn due(tries: i64, last_tried_ms: i64, now: i64) -> bool {
    last_tried_ms == 0 || last_tried_ms + backoff_ms(tries) <= now
}

/// Fetch exactly what the ledger says is missing, from one provider - the walk a FRAGMENT
/// author gets. `fetch_missing_bodies` recomputes its fetch list from a held chain's
/// `doc_versions`, and a fragment author has no chain here to walk (`user_dbs.held` refuses,
/// the walk heals nothing) - but the ledger already names the precise blobs, noted at fragment
/// intake, and a public blob's hash is the whole capability. Landed rows clear; the rest stay
/// for the next candidate or beat.
pub async fn fetch_wanted(state: &AppState, root_hex: &str, addr: iroh::EndpointAddr) -> u64 {
    let inner: Result<u64> = async {
        let rows: Vec<(Vec<u8>,)> = state
            .node_db
            .fetch_all(
                "SELECT blob_hash FROM missing_bodies WHERE root_pubkey = ?1",
                (root_hex,),
            )
            .await
            .context("reading wanted bodies")?;
        let mut hashes: Vec<iroh_blobs::Hash> = Vec::new();
        for (bytes,) in rows {
            if let Ok(h) = <[u8; 32]>::try_from(bytes.as_slice()) {
                let hash = iroh_blobs::Hash::from_bytes(h);
                if !state.files.has(hash).await {
                    hashes.push(hash);
                }
            }
        }
        if hashes.is_empty() {
            return Ok(0);
        }
        let fetched = state
            .files
            .fetch_many(&state.endpoint, addr, &hashes)
            .await as u64;
        for hash in &hashes {
            if state.files.has(*hash).await {
                state
                    .node_db
                    .execute(
                        "DELETE FROM missing_bodies WHERE root_pubkey = ?1 AND blob_hash = ?2",
                        (root_hex, hash.as_bytes().to_vec()),
                    )
                    .await
                    .context("clearing a landed body")?;
            }
        }
        Ok(fetched)
    }
    .await;
    inner.unwrap_or_else(|e| {
        tracing::debug!(root = %root_hex, error = ?e, "wanted-body fetch failed");
        0
    })
}

/// Heal one author's missing bodies NOW, from one named origin - the evented half of the
/// ledger (events for latency, sweeps for recovery), rung at fragment intake so a shared
/// post's words arrive on the heels of its header rather than a sweep beat later. Spawn-safe
/// and best-effort: a miss here is exactly what the sweep above recovers, from the same
/// origin among others.
pub async fn heal_from(state: &AppState, author_root: &str, origin_root: &str) {
    for c in crate::net::deliver::candidates(state, origin_root).await {
        let ep = crate::idface::leaf_via_to_endpoint(state, origin_root, &c).await;
        let Ok(addr) = crate::net::sync::dial_addr(state, &ep).await else {
            continue;
        };
        fetch_wanted(state, author_root, addr).await;
        if let Ok(0) = remaining(&state.node_db, author_root).await {
            return;
        }
    }
}

/// One pass of the rounds. For every persona with due rows: guess who might have the bytes,
/// run the ordinary body walk at each candidate (the walk itself reconciles the ledger as
/// bodies land), and mark whatever remains as tried so the backoff ladder advances.
pub async fn sweep(state: AppState) -> Result<()> {
    let rows: Vec<(String, i64, i64)> = state
        .node_db
        .fetch_all(
            "SELECT DISTINCT root_pubkey, tries, last_tried_ms FROM missing_bodies",
            (),
        )
        .await
        .context("reading the missing-bodies ledger")?;
    let now = now_ms();
    let mut roots: Vec<String> = Vec::new();
    for (root, tries, last_tried) in rows {
        if due(tries, last_tried, now) && !roots.contains(&root) {
            roots.push(root);
        }
    }

    for root in roots {
        // Candidates, most-likely first. All three tables remember nodes that already know
        // of this node's interest in the persona - asking them again discloses nothing new.
        let mut candidates: Vec<String> = Vec::new();
        if let Some(via) = crate::idface::fetched_via(&state.node_db, &root).await? {
            candidates.push(via);
        }
        for asker in crate::net::demand::askers_of(&state.node_db, &root, ASKER_CANDIDATE_CAP).await?
        {
            if !candidates.contains(&asker) {
                candidates.push(asker);
            }
        }
        for peer in crate::net::sync::peers_for(&state.node_db, &root).await? {
            if !candidates.contains(&peer) {
                candidates.push(peer);
            }
        }
        // The fragment ORIGINS (2026-08-14) - and for a reader past the chain, the only list
        // with anything in it. The three sources above all come from a relationship with the
        // AUTHOR (a profile fetch, their askers, their sync peers); a node holding this
        // persona's documents purely by way of a share has none of those, so its want rows
        // aged forever with zero candidates and the words never arrived. Who it does have is
        // whoever handed it the pointer - who by construction holds (or knows who holds) the
        // very bytes the pointer names.
        for origin in crate::fragments::origins_of(&state.node_db, &root)
            .await
            .unwrap_or_default()
        {
            for c in crate::net::deliver::candidates(&state, &origin).await {
                let ep = crate::idface::leaf_via_to_endpoint(&state, &origin, &c).await;
                if !candidates.contains(&ep) {
                    candidates.push(ep);
                }
            }
        }

        let mut healed = 0u64;
        for candidate in &candidates {
            let addr = match crate::net::sync::dial_addr(&state, candidate).await {
                Ok(a) => a,
                Err(_) => continue, // unparseable/unresolvable id - the next guess may not be
            };
            // The ledger-exact fetch first (it is what works for fragment authors, where the
            // chain walk below has nothing to open), then the walk, which can additionally
            // discover references nothing had noted yet.
            healed += fetch_wanted(&state, &root, addr.clone()).await;
            healed += crate::record::documents::fetch_missing_bodies(&state, &root, addr).await;
            if remaining(&state.node_db, &root).await? == 0 {
                break;
            }
        }
        if healed > 0 {
            tracing::info!(root = %root, healed, "recovered missing bodies on the sweep");
            crate::fanout::after_public_move(&state, &root).await;
        }
        // Whatever survived every candidate ages one rung; rows the walks cleared are gone
        // and never see this.
        state
            .node_db
            .execute(
                "UPDATE missing_bodies SET tries = tries + 1, last_tried_ms = ?2
                 WHERE root_pubkey = ?1",
                (root.as_str(), now),
            )
            .await
            .context("aging the missing-body rows that survived the rounds")?;
    }
    Ok(())
}

/// How many rows one persona still has on the ledger.
async fn remaining(node_db: &Db, root_hex: &str) -> Result<u64> {
    let row: Vec<(i64,)> = node_db
        .fetch_all(
            "SELECT COUNT(*) FROM missing_bodies WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("counting a persona's missing bodies")?;
    Ok(row.first().map(|(n,)| *n as u64).unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_climbs_and_caps() {
        assert_eq!(backoff_ms(0), 30_000, "first rest is 30s");
        assert_eq!(backoff_ms(1), 60_000);
        assert_eq!(backoff_ms(6), 1_920_000, "still doubling under the ceiling");
        assert_eq!(backoff_ms(7), 3_600_000, "the hour ceiling");
        assert_eq!(backoff_ms(50), 3_600_000, "and it never leaves it");
    }

    #[test]
    fn never_tried_rows_are_always_due() {
        assert!(due(0, 0, 1));
        assert!(due(99, 0, 1), "tries without a timestamp cannot delay a first attempt");
    }

    #[test]
    fn rested_rows_wait_their_rung_out() {
        let now = 1_000_000;
        assert!(!due(0, now - 29_999, now), "still resting");
        assert!(due(0, now - 30_000, now), "rested exactly long enough");
        assert!(!due(3, now - 200_000, now), "higher rungs rest longer (240s at 3)");
        assert!(due(3, now - 240_000, now));
    }

    async fn node_db() -> Db {
        crate::db::test_node_db().await
    }

    #[tokio::test]
    async fn reconcile_is_replace_set_per_persona() {
        let db = node_db().await;
        let (a, b, c) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        reconcile(&db, "aa11", &[a, b]).await.unwrap();
        assert_eq!(remaining(&db, "aa11").await.unwrap(), 2);

        // b arrived, c newly missing: membership follows the walk exactly.
        reconcile(&db, "aa11", &[a, c]).await.unwrap();
        let rows: Vec<(Vec<u8>,)> = db
            .fetch_all(
                "SELECT blob_hash FROM missing_bodies WHERE root_pubkey = 'aa11' ORDER BY blob_hash",
                (),
            )
            .await
            .unwrap();
        assert_eq!(rows, vec![(a.to_vec(),), (c.to_vec(),)]);

        // A whole persona coming up empty clears its ledger - and touches nobody else's.
        reconcile(&db, "bb22", &[b]).await.unwrap();
        reconcile(&db, "aa11", &[]).await.unwrap();
        assert_eq!(remaining(&db, "aa11").await.unwrap(), 0);
        assert_eq!(remaining(&db, "bb22").await.unwrap(), 1, "the neighbor's grave is not mine");
    }

    #[tokio::test]
    async fn reconcile_preserves_backoff_state_of_surviving_rows() {
        let db = node_db().await;
        let h = [4u8; 32];
        reconcile(&db, "aa11", &[h]).await.unwrap();
        db.execute(
            "UPDATE missing_bodies SET tries = 5, last_tried_ms = 777 WHERE root_pubkey = 'aa11'",
            (),
        )
        .await
        .unwrap();
        // The next walk sees it still missing: membership unchanged, backoff untouched -
        // steady exchange churn must never reset the ladder.
        reconcile(&db, "aa11", &[h]).await.unwrap();
        let rows: Vec<(i64, i64)> = db
            .fetch_all(
                "SELECT tries, last_tried_ms FROM missing_bodies WHERE root_pubkey = 'aa11'",
                (),
            )
            .await
            .unwrap();
        assert_eq!(rows, vec![(5, 777)]);
    }
}
