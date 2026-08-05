//! The node's map of public frontiers: what we hold of each persona, per public service.
//!
//! ## What a frontier fingerprint is
//!
//! One 32-byte blake3 digest over every public chain a persona has on one service - and a
//! persona has many, because a chain is `(author, service)` and every computer in the persona
//! is its own author. Seven computers that all post are seven POSTS chains, seven head hashes,
//! one fingerprint. The list is sparse: a computer that has never posted has no POSTS chain,
//! so the ingredients are whatever chains exist, never a devices x services product.
//!
//! Sorted by author before hashing, so the digest is a property of the SET of heads rather than
//! of the order a database happened to return them in - two nodes holding the same thing must
//! agree, or the whole construction is worthless.
//!
//! ## What it is for
//!
//! Per-user databases are separate files. Without this table, "which personas changed?" means
//! opening every one of them; with it, one scan. That is the sweep behind fan-out, and behind
//! ever knowing that an identity we follow has moved (nothing continuously syncs a followed
//! identity today - `add_peer` fires only from adoption).
//!
//! ## What it is NOT
//!
//! Not orderable. A hash detects difference, never progress: given two fingerprints there is no
//! telling which is ahead, so this can say "go look" and can never say "we are behind". Deciding
//! who holds more is the exchange's job, where the entries are validated rather than believed.
//!
//! Not private. Only public services are hashed, because the count and cadence of private
//! activity is itself private metadata (PROJECT_PLAN, Chains) and this value's whole purpose is
//! to be compared with other nodes. The filter is `net::sync::is_private_service`, the same
//! predicate the sync gate enforces - one definition of private, not two.
use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// One persona-service row: what we hold, and how much of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub service: u32,
    pub fp: [u8; 32],
    /// How many of the persona's computers have written this service. Zero never appears - a
    /// service with no chains has no row - but it is what makes "we hold nothing of theirs"
    /// legible without decoding a hash.
    pub chains: i64,
    pub held_at_ms: i64,
}

/// The fingerprint of one service's chains, from that service's anchors.
///
/// Deliberately takes the anchors rather than a database: the construction is the part two
/// nodes must agree on exactly, so it is a function with vectors rather than a query.
pub fn fingerprint(anchors: &[([u8; 32], u32, [u8; 32])], service: u32) -> ([u8; 32], i64) {
    let mut mine: Vec<&([u8; 32], u32, [u8; 32])> =
        anchors.iter().filter(|(_, s, _)| *s == service).collect();
    mine.sort_by_key(|(author, _, _)| *author);
    let mut hasher = blake3::Hasher::new();
    for (author, svc, head) in &mine {
        hasher.update(author);
        hasher.update(&svc.to_be_bytes());
        hasher.update(head);
    }
    (*hasher.finalize().as_bytes(), mine.len() as i64)
}

/// The persona-level fingerprint: the per-service rows folded in service order.
///
/// Derived rather than stored, so "has anything at all changed about this person" costs a
/// four-row read instead of a second thing to keep current - and cannot disagree with the rows
/// it is made of.
pub fn persona_fingerprint(rows: &[Held]) -> [u8; 32] {
    let mut rows: Vec<&Held> = rows.iter().collect();
    rows.sort_by_key(|r| r.service);
    let mut hasher = blake3::Hasher::new();
    for r in rows {
        hasher.update(&r.service.to_be_bytes());
        hasher.update(&r.fp);
    }
    *hasher.finalize().as_bytes()
}

/// Recompute one persona's public frontiers and store them. Returns whether the persona-level
/// fingerprint MOVED - the edge, which is the whole reason the table exists.
///
/// Edge-triggered rather than level-triggered on purpose: "this differs from what we stored" is
/// true forever once it is true, and a fan-out driven by it would tell every subscriber on every
/// pass. "This changed during this pass" is true once. Today the only consumer is a log line;
/// when subscriptions land, that is where the notify hangs.
///
/// Rows for services that no longer have chains are deleted rather than left stale: this table
/// says what we hold NOW, and a fingerprint nobody deleted is worse than no fingerprint.
pub async fn refresh(state: &AppState, root_hex: &str) -> Result<bool> {
    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .with_context(|| format!("opening {root_hex} to read its frontier"))?;
    let anchors = crate::net::sync::public_anchors(&db).await?;
    let mut services: Vec<u32> = anchors.iter().map(|(_, s, _)| *s).collect();
    services.sort_unstable();
    services.dedup();

    // Write only what MOVED. A pass that rewrites every row to say "still the same" costs a
    // node holding a thousand personas four thousand writes per sweep to record that nothing
    // happened - and it makes `held_at_ms` mean "when we last looked", which nobody wants.
    // Skipping the no-ops makes it mean "when this changed", which is the fact fan-out needs.
    let was = held(&state.node_db, root_hex).await?;
    let before = persona_fingerprint(&was);
    let stored: std::collections::HashMap<u32, [u8; 32]> =
        was.into_iter().map(|h| (h.service, h.fp)).collect();
    let now = now_ms();
    for service in &services {
        let (fp, chains) = fingerprint(&anchors, *service);
        if stored.get(service) == Some(&fp) {
            continue;
        }
        state
            .node_db
            .execute(
                "INSERT INTO persona_frontiers (root_pubkey, service, held_fp, held_at_ms, chains)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (root_pubkey, service) DO UPDATE SET
                     held_fp = excluded.held_fp,
                     held_at_ms = excluded.held_at_ms,
                     chains = excluded.chains",
                (root_hex, *service as i64, fp.to_vec(), now, chains),
            )
            .await
            .context("storing a persona frontier")?;
    }
    // Services that went away (a chain evicted by the gate's disproof sweep, a persona
    // rebuilt from a shorter journal).
    let keep: Vec<String> = services.iter().map(|s| s.to_string()).collect();
    state
        .node_db
        .execute(
            &format!(
                "DELETE FROM persona_frontiers WHERE root_pubkey = ?1 AND service NOT IN ({})",
                if keep.is_empty() { "-1".into() } else { keep.join(",") }
            ),
            (root_hex,),
        )
        .await
        .context("clearing stale persona frontiers")?;
    Ok(persona_fingerprint(&held(&state.node_db, root_hex).await?) != before)
}

/// What we hold of this persona, newest computation first read.
pub async fn held(node_db: &Db, root_hex: &str) -> Result<Vec<Held>> {
    let rows: Vec<(i64, Vec<u8>, i64, i64)> = node_db
        .fetch_all(
            "SELECT service, held_fp, chains, held_at_ms FROM persona_frontiers
             WHERE root_pubkey = ?1 ORDER BY service",
            (root_hex,),
        )
        .await
        .context("reading persona frontiers")?;
    rows.into_iter()
        .map(|(service, fp, chains, held_at_ms)| {
            let fp: [u8; 32] = fp
                .try_into()
                .map_err(|_| anyhow::anyhow!("corrupt fingerprint in persona_frontiers"))?;
            Ok(Held {
                service: service as u32,
                fp,
                chains,
                held_at_ms,
            })
        })
        .collect()
}

/// The same digest, over what a PEER advertised.
///
/// Identical construction to `fingerprint` + `persona_fingerprint`, deliberately: a claim you
/// cannot compare with your own holdings is not worth storing. The peer's list arrives as
/// `Frontier` rows carrying `(author, service, floor, head, head_hash)`; floor and head are the
/// exchange's business and play no part here, exactly as they play no part in ours.
pub fn claimed_fingerprint(frontiers: &[ringtome_proto::sync::Frontier]) -> [u8; 32] {
    let anchors: Vec<([u8; 32], u32, [u8; 32])> = frontiers
        .iter()
        .filter(|f| !crate::net::sync::is_private_service(f.service))
        .map(|f| (f.author, f.service, f.head_hash))
        .collect();
    let mut services: Vec<u32> = anchors.iter().map(|(_, s, _)| *s).collect();
    services.sort_unstable();
    services.dedup();
    let rows: Vec<Held> = services
        .into_iter()
        .map(|service| {
            let (fp, chains) = fingerprint(&anchors, service);
            Held {
                service,
                fp,
                chains,
                held_at_ms: 0,
            }
        })
        .collect();
    persona_fingerprint(&rows)
}

/// What came of chasing a peer's claim. Only one of these is a fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Their frontier is behind ours. Normal, and useful - it is the signal to push.
    Behind,
    /// They had entries we lacked, and the entries validated.
    Ahead,
    /// They claimed a frontier they could not back up: nothing arrived, and we still disagree.
    /// The only one that earns backoff - and the reason the claim is stored with its verdict
    /// rather than alone, since otherwise every sweep chases it again, free for them and
    /// expensive for us.
    Unresolvable,
}

impl Verdict {
    fn as_str(self) -> &'static str {
        match self {
            Verdict::Behind => "behind",
            Verdict::Ahead => "ahead",
            Verdict::Unresolvable => "unresolvable",
        }
    }
}

/// Record what a peer said about a persona's public frontier. A hint, never a fact - stored so
/// a sweep can tell a claim it has already chased from one that has moved.
pub async fn record_claim(
    node_db: &Db,
    root_hex: &str,
    endpoint_id: &str,
    claimed: [u8; 32],
) -> Result<()> {
    node_db
        .execute(
            "UPDATE identity_peers SET seen_fp = ?1, seen_at_ms = ?2
             WHERE root_pubkey = ?3 AND endpoint_id = ?4",
            (claimed.to_vec(), now_ms(), root_hex, endpoint_id),
        )
        .await
        .context("recording a peer's frontier claim")?;
    Ok(())
}

/// Record what chasing that claim produced, so it is not chased again until it moves.
pub async fn record_verdict(
    node_db: &Db,
    root_hex: &str,
    endpoint_id: &str,
    chased: [u8; 32],
    verdict: Verdict,
) -> Result<()> {
    node_db
        .execute(
            "UPDATE identity_peers SET chased_fp = ?1, chased_at_ms = ?2, verdict = ?3
             WHERE root_pubkey = ?4 AND endpoint_id = ?5",
            (
                chased.to_vec(),
                now_ms(),
                verdict.as_str(),
                root_hex,
                endpoint_id,
            ),
        )
        .await
        .context("recording a chase verdict")?;
    Ok(())
}

/// Every persona this node holds anything of: the ones it hosts, and the ones it has fetched.
/// Both, because a followed identity we merely carry is exactly the case the sweep exists for.
async fn known_roots(node_db: &Db) -> Result<Vec<String>> {
    let mut roots = crate::identity::hosted_roots(node_db).await?;
    roots.extend(crate::idface::fetched_roots(node_db).await?);
    roots.sort();
    roots.dedup();
    Ok(roots)
}

/// One pass. `who` is the identity a write nudge named: a named pass refreshes only that
/// persona, since nobody else wrote. `None` - a tick, or a lag that can no longer say - is the
/// full sweep, and it is also how writes that arrived BY SYNC are noticed at all: those
/// deliberately never ring the bell (the relay damping in `imaol::append`), so a followed
/// identity's movement is found by the tick rather than announced.
///
/// A persona that fails to open is logged and skipped, never fatal - one unreadable database
/// must not stop the node learning that the other two hundred changed.
pub async fn sweep(state: AppState, who: Option<String>) -> Result<()> {
    let roots = match who {
        Some(root) => vec![root],
        None => known_roots(&state.node_db).await?,
    };
    for root in roots {
        match refresh(&state, &root).await {
            Ok(true) => {
                tracing::info!(root = %root, "public frontier moved");
                crate::fanout::after_public_move(&state, &root).await;
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(root = %root, error = ?e, "frontier refresh failed"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor(author: u8, service: u32, head: u8) -> ([u8; 32], u32, [u8; 32]) {
        ([author; 32], service, [head; 32])
    }

    #[test]
    fn covers_every_computer_on_the_service() {
        // Three computers posting is three chains and one fingerprint over all three.
        let three = [anchor(1, 3, 10), anchor(2, 3, 20), anchor(3, 3, 30)];
        let (fp, chains) = fingerprint(&three, 3);
        assert_eq!(chains, 3);
        let (fp_two, chains_two) = fingerprint(&three[..2], 3);
        assert_eq!(chains_two, 2);
        assert_ne!(fp, fp_two, "a computer we don't know about changes the answer");
    }

    #[test]
    fn is_a_property_of_the_set_not_the_order() {
        let forward = [anchor(1, 3, 10), anchor(2, 3, 20)];
        let backward = [anchor(2, 3, 20), anchor(1, 3, 10)];
        assert_eq!(fingerprint(&forward, 3).0, fingerprint(&backward, 3).0);
    }

    #[test]
    fn moves_when_a_head_moves() {
        let before = [anchor(1, 3, 10)];
        let after = [anchor(1, 3, 11)];
        assert_ne!(fingerprint(&before, 3).0, fingerprint(&after, 3).0);
    }

    #[test]
    fn separates_the_services() {
        // Adding a computer writes IDENTITY_PUBLIC. Posts must not notice.
        let anchors = [anchor(1, 3, 10), anchor(1, 0, 77)];
        let posts_before = fingerprint(&anchors, 3);
        let anchors_after = [anchor(1, 3, 10), anchor(1, 0, 78), anchor(2, 0, 5)];
        assert_eq!(
            posts_before.0,
            fingerprint(&anchors_after, 3).0,
            "a key-tree change must not wake a posts subscriber"
        );
        assert_ne!(fingerprint(&anchors, 0).0, fingerprint(&anchors_after, 0).0);
    }

    #[test]
    fn holding_nothing_is_a_value() {
        let (fp, chains) = fingerprint(&[], 3);
        assert_eq!(chains, 0);
        // Defined, comparable, and distinct from holding something - never a null.
        assert_eq!(fp, fingerprint(&[anchor(1, 0, 1)], 3).0, "same empty set");
        assert_ne!(fp, fingerprint(&[anchor(1, 3, 1)], 3).0);
    }

    #[test]
    fn the_persona_digest_folds_the_services() {
        let rows = |posts: u8| {
            vec![
                Held { service: 0, fp: [9; 32], chains: 1, held_at_ms: 0 },
                Held { service: 3, fp: [posts; 32], chains: 1, held_at_ms: 0 },
            ]
        };
        assert_eq!(persona_fingerprint(&rows(1)), persona_fingerprint(&rows(1)));
        assert_ne!(persona_fingerprint(&rows(1)), persona_fingerprint(&rows(2)));
        // Order of the rows read back must not matter, only their content.
        let mut reversed = rows(1);
        reversed.reverse();
        assert_eq!(persona_fingerprint(&rows(1)), persona_fingerprint(&reversed));
    }
}
