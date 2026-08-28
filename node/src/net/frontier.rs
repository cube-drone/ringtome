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
//! Since chain_heads (2026-08-05), "which personas changed?" is answered by the write-time
//! memo; this module DERIVES from it and keeps the three things a digest layer still owes:
//! the edge baseline (changed since fan-out last looked - the memo always shows NOW and
//! cannot be its own acknowledgment cursor), the wire-comparable fingerprint peer claims are
//! judged against, and the per-service rollup subscribers wake on.
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

// ---------------------------------------------------------------------------------------------
// The chain-heads memo: fed at write time, read here, reconciled by the sweep.

/// Record a chain's new tip, at the moment a writer stores the entry and holds the fact in
/// hand. Monotonic on seq: an out-of-order arrival (a re-offered older entry the gate
/// deduplicates) must not drag the memo backwards.
pub async fn note_head(
    node_db: &Db,
    root_hex: &str,
    author_hex: &str,
    service: u32,
    seq: u64,
    head_hash: &[u8; 32],
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO chain_heads
               (root_pubkey, author_pubkey, service, floor_seq, head_seq, head_hash, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)
             ON CONFLICT (root_pubkey, author_pubkey, service) DO UPDATE SET
                 head_seq = excluded.head_seq,
                 head_hash = excluded.head_hash,
                 updated_at_ms = excluded.updated_at_ms,
                 floor_seq = MIN(floor_seq, excluded.floor_seq)
             WHERE excluded.head_seq > head_seq",
            (
                root_hex,
                author_hex,
                service as i64,
                seq as i64,
                head_hash.to_vec(),
                now_ms(),
            ),
        )
        .await
        .context("noting a chain head")?;
    Ok(())
}

// (There is deliberately no `raise_floor` on the memo: retention prunes with only the user db
// in hand, and `reconcile_from_entries` already recomputes floors from what is stored - the
// memo heals on the sweep's beat, and the wire is never wrong because `local_frontiers` reads
// the entries table directly.)

/// An opaque CHANGE MARK for one service's frontier, off the memo: the held fingerprint
/// folded to an i64, `None` when no such chain is held at all. Compare by EQUALITY (a
/// different frontier is a different mark), never by ordering - a hash is not monotonic, and
/// `held_at_ms` cannot serve here because two moves inside one millisecond would make the
/// second invisible to an ordering test. One primary-key read: the probe a per-move consumer
/// wants before doing per-move work (edgegraph's fold gates on it, 2026-08-23 - the
/// follows-public chain moves at dial-mint cadence, but `after_public_move` fires at posting
/// cadence).
pub async fn service_mark(node_db: &Db, root_hex: &str, service: u32) -> Result<Option<i64>> {
    let row: Option<(Vec<u8>,)> = node_db
        .fetch_optional(
            "SELECT held_fp FROM persona_frontiers WHERE root_pubkey = ?1 AND service = ?2",
            (root_hex, service as i64),
        )
        .await
        .context("reading a service frontier mark")?;
    Ok(row.map(|(fp,)| {
        let mut eight = [0u8; 8];
        eight.copy_from_slice(&fp[..8.min(fp.len())]);
        i64::from_le_bytes(eight)
    }))
}

/// Forget every frontier row for an evicted persona - the memo of chains no longer held.
pub async fn forget_persona(node_db: &Db, root_hex: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM persona_frontiers WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("forgetting an evicted persona's frontiers")?;
    Ok(())
}

/// Does this persona have ANY chain on the given service, per the memo? A node.db probe on
/// the chain_heads primary key - what lets a fold hook that fires on every frontier move
/// answer "nothing to fold here" without opening the author's encrypted database
/// (notifications::refresh_from is the consumer; measured 2026-08-09 beside the minting
/// amplifier).
pub async fn has_service_chain(node_db: &Db, root_hex: &str, service: u32) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM chain_heads WHERE root_pubkey = ?1 AND service = ?2 LIMIT 1",
            (root_hex, service as i64),
        )
        .await
        .context("probing for a service chain")?;
    Ok(row.is_some())
}

/// Forget a chain the gate evicted - its rows are gone, so its tip is a lie.
pub async fn forget_chain(
    node_db: &Db,
    root_hex: &str,
    author_hex: &str,
    service: u32,
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM chain_heads
             WHERE root_pubkey = ?1 AND author_pubkey = ?2 AND service = ?3",
            (root_hex, author_hex, service as i64),
        )
        .await
        .context("forgetting an evicted chain")?;
    Ok(())
}

/// The public anchors of one persona, from the MEMO - no per-user file is opened. This is what
/// lets both the event path and the fingerprint live entirely in node.db.
async fn memo_public_anchors(
    node_db: &Db,
    root_hex: &str,
) -> Result<Vec<([u8; 32], u32, [u8; 32])>> {
    let rows: Vec<(String, i64, Vec<u8>)> = node_db
        .fetch_all(
            "SELECT author_pubkey, service, head_hash FROM chain_heads
             WHERE root_pubkey = ?1 ORDER BY author_pubkey, service",
            (root_hex,),
        )
        .await
        .context("reading the chain-heads memo")?;
    let mut out = Vec::with_capacity(rows.len());
    for (author_hex, svc, head) in rows {
        if crate::net::sync::is_private_service(svc as u32) {
            continue; // the fingerprint is told to other people; the wire is the boundary
        }
        let author = crate::pubkey::decode(&author_hex)
            .ok_or_else(|| anyhow::anyhow!("corrupt author in chain_heads"))?;
        let head: [u8; 32] = head
            .try_into()
            .map_err(|_| anyhow::anyhow!("corrupt head_hash in chain_heads"))?;
        out.push((author, svc as u32, head));
    }
    Ok(out)
}

/// Rebuild one persona's memo rows from its own entries table - the RECONCILER, and the only
/// path here that opens a per-user file. Dual writes aren't atomic across two databases, so a
/// crash between an entry landing and its memo note leaves the memo one write behind; the
/// stat-guarded sweep notices the file moved and calls this. Idempotent, whole-root.
pub async fn reconcile_from_entries(state: &AppState, root_hex: &str) -> Result<()> {
    let db = state
        .user_dbs
        .held(root_hex)
        .await
        .with_context(|| format!("opening {root_hex} to reconcile its memo"))?;
    reconcile_rows(&state.node_db, &db, root_hex).await
}

/// The reconciler's core, taking both databases rather than reaching for one - so the
/// database-open path can run it before anyone reads the memo, without an `AppState` it does
/// not have.
pub async fn reconcile_rows(node_db: &Db, user_db: &Db, root_hex: &str) -> Result<()> {
    // Through the owner's door: `entries` belongs to imaol + the sync gate, so the range
    // read lives there (sync::chain_ranges) and this module keeps only its own table's SQL.
    let rows = crate::net::sync::chain_ranges(user_db).await?;
    let now = now_ms();
    let mut keep: Vec<String> = Vec::new();
    for (author_hex, svc, floor, head, hash) in rows {
        keep.push(format!("'{author_hex}:{svc}'"));
        node_db
            .execute(
                "INSERT INTO chain_heads
                   (root_pubkey, author_pubkey, service, floor_seq, head_seq, head_hash, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (root_pubkey, author_pubkey, service) DO UPDATE SET
                     floor_seq = excluded.floor_seq,
                     head_seq = excluded.head_seq,
                     head_hash = excluded.head_hash,
                     updated_at_ms = excluded.updated_at_ms",
                (
                    root_hex,
                    author_hex.as_str(),
                    svc as i64,
                    floor as i64,
                    head as i64,
                    hash.to_vec(),
                    now,
                ),
            )
            .await
            .context("reconciling a chain head")?;
    }
    // Chains that vanished from entries (eviction, genesis cut) leave the memo too.
    node_db
        .execute(
            &format!(
                "DELETE FROM chain_heads WHERE root_pubkey = ?1
                   AND (author_pubkey || ':' || service) NOT IN ({})",
                if keep.is_empty() { "''".into() } else { keep.join(",") }
            ),
            (root_hex,),
        )
        .await
        .context("clearing vanished chains from the memo")?;
    Ok(())
}

/// Every chain this persona holds, from the MEMO: `(author_hex, service, floor, head, hash)`.
///
/// This is what `sync::local_frontiers` puts on the wire, so the trust argument matters and is
/// worth stating. The memo can lag but never lead: `note_head` runs *after* the row lands and
/// is monotone on seq, so a memo head is always ≤ the stored head - and under-reporting is the
/// safe direction (a peer re-offers what we already have and the gate deduplicates), where
/// over-reporting would mean claiming history we lack and never being sent it again. The one
/// way the memo could lead - a database that lost entries while node.db kept its rows - is
/// closed by reconciling against the log once per persona per process, at database open
/// (`db::UserDbManager::open`), before anything can read this.
pub async fn memo_chains(
    node_db: &Db,
    root_hex: &str,
) -> Result<Vec<(String, u32, u64, u64, [u8; 32])>> {
    type Row = (String, i64, i64, i64, Vec<u8>);
    let rows: Vec<Row> = node_db
        .fetch_all(
            "SELECT author_pubkey, service, floor_seq, head_seq, head_hash FROM chain_heads
             WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("reading chain heads from the memo")?;
    rows.into_iter()
        .map(|(author_hex, svc, floor, head, hash)| {
            let hash: [u8; 32] = hash
                .try_into()
                .map_err(|_| anyhow::anyhow!("corrupt head_hash in the chain-heads memo"))?;
            Ok((author_hex, svc as u32, floor as u64, head as u64, hash))
        })
        .collect()
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
/// The frontier refresh, answering WHICH public services moved (2026-08-28, the quadratic fold): the
/// fold lane routes each derived-state leg to the service it reads from, so a post does
/// not rescan the share chain and a share does not re-journal the shelf. Empty means
/// nothing moved. A service whose chain vanished counts as moved (its fingerprint went).
pub async fn refresh_moved(state: &AppState, root_hex: &str) -> Result<Vec<u32>> {
    // From the MEMO, never the per-user file: every writer of `entries` notes the tip at
    // write time (Db::memo), so the answer is already in node.db. The sweep reconciles the
    // rare crash-window drift; nothing else ever needs the encrypted file for this.
    let anchors = memo_public_anchors(&state.node_db, root_hex).await?;
    let mut services: Vec<u32> = anchors.iter().map(|(_, s, _)| *s).collect();
    services.sort_unstable();
    services.dedup();

    // Write only what MOVED. A pass that rewrites every row to say "still the same" costs a
    // node holding a thousand personas four thousand writes per sweep to record that nothing
    // happened - and it makes `held_at_ms` mean "when we last looked", which nobody wants.
    // Skipping the no-ops makes it mean "when this changed", which is the fact fan-out needs.
    let was = held(&state.node_db, root_hex).await?;
    let stored: std::collections::HashMap<u32, [u8; 32]> =
        was.into_iter().map(|h| (h.service, h.fp)).collect();
    let now = now_ms();
    let mut moved: Vec<u32> = Vec::new();
    for service in &services {
        let (fp, chains) = fingerprint(&anchors, *service);
        if stored.get(service) == Some(&fp) {
            continue;
        }
        moved.push(*service);
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
    for (service, _) in stored {
        if !services.contains(&service) {
            moved.push(service);
        }
    }
    moved.sort_unstable();
    moved.dedup();
    Ok(moved)
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
    let roots = match &who {
        Some(root) => vec![root.clone()],
        None => known_roots(&state.node_db).await?,
    };
    for root in roots {
        // The backstop's stat-guard: a named pass KNOWS its root wrote, but a full sweep is
        // recovery, and recovery must not open three hundred idle personas' encrypted files
        // to learn that nothing happened. A stat answers first - and only a STALE root pays
        // the reconcile, which is the one remaining reason this module opens a user file.
        if who.is_none() {
            match state.user_dbs.db_mtime_ms(&root) {
                Some(mt) if state.sweep_marks.is_stale("frontier", &root, mt) => {
                    state.sweep_marks.record("frontier", &root, mt);
                    if let Err(e) = reconcile_from_entries(&state, &root).await {
                        tracing::warn!(root = %root, error = ?e, "memo reconcile failed");
                        continue;
                    }
                }
                Some(_) => continue,
                None => continue, // no files: nothing to fold
            }
        } else if let Some(mt) = state.user_dbs.db_mtime_ms(&root) {
            state.sweep_marks.record("frontier", &root, mt);
        }
        // The chain itself is the fold lane's (fold.rs) - the sweep's job ends at
        // detecting that this root's files moved and nudging. `refresh` runs inside the
        // lane's chain, serialized, so its verdict cannot be raced into silence here.
        crate::fold::nudge(&state, &root);
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
