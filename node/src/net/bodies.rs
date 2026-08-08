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

        let mut healed = 0u64;
        for candidate in &candidates {
            let addr = match crate::net::sync::dial_addr(&state, candidate).await {
                Ok(a) => a,
                Err(_) => continue, // unparseable/unresolvable id - the next guess may not be
            };
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
