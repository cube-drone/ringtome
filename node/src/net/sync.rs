//! The sync engine: Ringtome sync protocol v1 over iroh streams.
//!
//! One connection performs a **symmetric exchange**:
//!
//! ```text
//! requester -> responder:  Hello(root, my frontiers)
//! responder -> requester:  Hello(root, its frontiers), entries I lack, Done
//! requester -> responder:  entries it lacks, Done
//! ```
//!
//! Entries always stream **identity chains first** (service 0 sorts first), so the authority
//! context precedes the content it validates. Every arriving entry passes the **validation
//! gate** before storage - strict decode, signature, chain contiguity, key-tree membership,
//! revocation ceilings - because sync is the trust boundary: a row in `entries` is believed by
//! everything downstream, so nothing gets a row without earning it (PROJECT_PLAN, Iroh Protocol
//! Mapping: "gate here!").

use std::collections::{BTreeMap, HashMap, HashSet};

use anyhow::{anyhow, bail, Context, Result};
use iroh::endpoint::{Connection, SendStream};
use iroh::EndpointAddr;
use ringtome_proto::crown::KeyStatus;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::sync::{Frontier, MemberProof, SyncMessage};
use ringtome_proto::{validate_next, Ceiling, Crown, SignedEntry, ZERO_HASH};

use crate::clock::now_ms;
use crate::db::Db;
use crate::net::p2p::{read_frame, write_frame};
use crate::pubkey;
use crate::AppState;

/// Outcome of one exchange, for logs and API responses.
#[derive(Debug, Default, serde::Serialize)]
pub struct ExchangeStats {
    pub received: u64,
    pub rejected: u64,
    pub sent: u64,
    /// Document bodies fetched from this peer after the entry exchange (headers ride sync;
    /// bodies ride iroh-blobs - see `documents::fetch_missing_bodies`).
    pub bodies_fetched: u64,
}

/// Services that never cross the identity boundary: synced only between an identity's own
/// (member-proven) nodes. Everything about them is withheld from strangers - the entries, the
/// frontiers, even the count of chains (the *timing and volume* of private activity is itself
/// private metadata; PROJECT_PLAN, Chains).
pub fn is_private_service(svc: u32) -> bool {
    svc == service::IDENTITY_PRIVATE
        || svc == service::GENERAL_PRIVATE
        || svc == service::DOCUMENTS_PRIVATE
        || svc == service::DOC_META_PRIVATE
}

/// This identity's held ranges, one per stored chain. Private chains appear only when the peer
/// has proven membership.
pub async fn local_frontiers(db: &Db, include_private: bool) -> Result<Vec<Frontier>> {
    // The head's HASH rides along with its seq: a range says how far a chain goes, the anchor
    // says which chain it is. The correlated subquery rather than a bare column beside MAX() -
    // that shortcut is a SQLite dialect nicety, and this is protocol input.
    let rows: Vec<(String, i64, i64, i64, Vec<u8>)> = db
        .fetch_all(
            "SELECT e.author_pubkey, e.service, MIN(e.seq), MAX(e.seq),
                    (SELECT entry_hash FROM entries
                      WHERE author_pubkey = e.author_pubkey AND service = e.service
                      ORDER BY seq DESC LIMIT 1)
             FROM entries e
             GROUP BY e.author_pubkey, e.service",
            (),
        )
        .await
        .context("reading local frontiers")?;

    rows.into_iter()
        .filter(|(_, svc, _, _, _)| include_private || !is_private_service(*svc as u32))
        .map(|(author_hex, svc, floor, head, head_hash)| {
            let author = pubkey::decode(&author_hex)
                .ok_or_else(|| anyhow!("corrupt author pubkey in entries table"))?;
            let head_hash: [u8; 32] = head_hash
                .try_into()
                .map_err(|_| anyhow!("corrupt entry_hash at chain head"))?;
            Ok(Frontier {
                author,
                service: svc as u32,
                floor: floor as u64,
                head: head as u64,
                head_hash,
            })
        })
        .collect()
}

/// Every chain this identity stores, as `(author_hex, service, floor, head, head_hash)` -
/// the chain-heads memo's reconciliation read (`net::frontier::reconcile_from_entries`).
/// Lives here because `entries` is this module's table; the memo is fed at write time and
/// this is the recovery path that re-derives it after a crash between the dual writes.
pub async fn chain_ranges(db: &Db) -> Result<Vec<(String, u32, u64, u64, [u8; 32])>> {
    type Row = (String, i64, i64, i64, Vec<u8>);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT e.author_pubkey, e.service, MIN(e.seq), MAX(e.seq),
                    (SELECT entry_hash FROM entries
                      WHERE author_pubkey = e.author_pubkey AND service = e.service
                      ORDER BY seq DESC LIMIT 1)
             FROM entries e GROUP BY e.author_pubkey, e.service",
            (),
        )
        .await
        .context("reading chain ranges")?;
    rows.into_iter()
        .map(|(author_hex, svc, floor, head, hash)| {
            let hash: [u8; 32] = hash
                .try_into()
                .map_err(|_| anyhow!("corrupt entry_hash in entries table"))?;
            Ok((author_hex, svc as u32, floor as u64, head as u64, hash))
        })
        .collect()
}

/// Stream every stored entry the peer's frontiers say it lacks, identity chains first (service
/// ascending puts service 0 at the front), each chain in seq order. Returns entries sent.
/// Private chains are streamed only to member-proven peers.
async fn send_missing(
    db: &Db,
    peer_frontiers: &[Frontier],
    send: &mut SendStream,
    include_private: bool,
) -> Result<u64> {
    let mut sent = 0u64;
    for bytes in missing_for_peer(db, peer_frontiers, include_private).await? {
        write_frame(send, &SyncMessage::Entry(bytes)).await?;
        sent += 1;
    }
    Ok(sent)
}

/// The entry bytes a peer with these frontiers lacks - `send_missing` without the stream, so
/// the selection is testable against raw databases.
///
/// The ordinary rule: start just past their head. The exception is the EQUIVOCATION window:
/// a peer whose frontier matches ours in height but not in `head_hash` holds a different
/// chain than we do - "a peer comparing ranges alone sees agreement where there is a
/// divergence" (proto::sync::Frontier). Range arithmetic would send nothing forever, each
/// side concluding the other lacks nothing while their fingerprints disagree. So we send our
/// head entry anyway: one entry, and the receiver now holds two valid signatures at the same
/// (chain, seq) - portable, self-proving evidence of a fork ("forks are self-proving" -
/// PROJECT_PLAN, IM-AOL), which its gate records rather than stores. The check runs at the
/// peer's claimed head, whatever our own height - so unequal-length forks are caught too,
/// from whichever side holds an entry at the other's head; what nobody finds is the exact
/// fork POINT (that bisect is unnecessary for condemnation - one proven double-sign is
/// enough).
pub(crate) async fn missing_for_peer(
    db: &Db,
    peer_frontiers: &[Frontier],
    include_private: bool,
) -> Result<Vec<Vec<u8>>> {
    let peer: HashMap<([u8; 32], u32), (u64, [u8; 32])> = peer_frontiers
        .iter()
        .map(|f| ((f.author, f.service), (f.head, f.head_hash)))
        .collect();

    let chains: Vec<(String, i64)> = db
        .fetch_all(
            "SELECT DISTINCT author_pubkey, service FROM entries ORDER BY service, author_pubkey",
            (),
        )
        .await
        .context("listing chains")?;

    let mut out = Vec::new();
    for (author_hex, svc) in chains {
        if !include_private && is_private_service(svc as u32) {
            continue;
        }
        let author = pubkey::decode(&author_hex)
            .ok_or_else(|| anyhow!("corrupt author pubkey in entries table"))?;
        let claimed = peer.get(&(author, svc as u32));
        let start = claimed.map(|(head, _)| head + 1).unwrap_or(0);

        if let Some((peer_head, peer_hash)) = claimed {
            let ours: Option<(Vec<u8>, Vec<u8>)> = db
                .fetch_optional(
                    "SELECT entry_hash, bytes FROM entries
                     WHERE author_pubkey = ?1 AND service = ?2 AND seq = ?3",
                    (author_hex.as_str(), svc, *peer_head as i64),
                )
                .await
                .context("reading our entry at the peer's claimed head")?;
            if let Some((hash, bytes)) = ours {
                if hash.as_slice() != peer_hash.as_slice() {
                    out.push(bytes);
                }
            }
        }

        let rows: Vec<(Vec<u8>,)> = db
            .fetch_all(
                "SELECT bytes FROM entries
             WHERE author_pubkey = ?1 AND service = ?2 AND seq >= ?3 ORDER BY seq",
                (author_hex.as_str(), svc, start as i64),
            )
            .await
            .context("reading entries to send")?;
        out.extend(rows.into_iter().map(|(bytes,)| bytes));
    }
    Ok(out)
}

/// The validation gate: admit a batch of arrived entries into the store, or reject them.
///
/// Identity entries are admitted only if they chain contiguously from what we hold *and* their
/// author lands in the resolved key tree; content entries additionally require an Active author.
/// Chains under a revocation ceiling get neither of those paths: they are admitted only as the
/// exact **sealed prefix** the revocation's anchor pins (`admit_ceilinged_chain`), because a
/// revoked key is still attacker-held and can sign fresh under-ceiling history at will - the
/// anchor's hash, not its seq, is what separates grandfathered truth from fabrication.
/// Rejections are counted, logged, and never stored - a rejected entry simply does not exist as
/// far as this node's views are concerned.
///
/// `peer_proven`: whether the sending peer proved membership. Private-chain entries from an
/// unproven peer are rejected outright - an honest stranger never sends them (we withheld those
/// frontiers), so their arrival is either a bug or a probe, and either way the answer is no.
///
/// Also the raw-entry journal's replay path (`record::journal::rebuild_from_journal`): the
/// journal is just what sync would send, written down, so rebuild enters through this same gate
/// rather than growing a second insert path.
pub(crate) async fn ingest_batch(
    db: &Db,
    root: [u8; 32],
    raw: Vec<Vec<u8>>,
    peer_proven: bool,
) -> Result<(u64, u64)> {
    // One batch at a time per identity: concurrent exchanges (eager push makes simultaneous
    // bidirectional syncs routine) would race between head-read and insert and die on the
    // entry_hash UNIQUE constraint instead of duplicate-skipping. See Db::lock_ingest.
    let _gate = db.lock_ingest().await;

    let mut rejected = 0u64;
    let mut received = 0u64;
    let mut evicted_rows = 0u64;

    // Strict decode + signature check; split identity vs content.
    let mut identity_candidates: Vec<SignedEntry> = Vec::new();
    let mut content_candidates: Vec<SignedEntry> = Vec::new();
    for bytes in raw {
        match SignedEntry::decode(&bytes) {
            Ok(e) if e.verify().is_ok() => {
                if !peer_proven && is_private_service(e.entry().chain.service) {
                    rejected += 1;
                } else if e.entry().chain.service == service::IDENTITY_PUBLIC {
                    identity_candidates.push(e);
                } else {
                    content_candidates.push(e);
                }
            }
            _ => rejected += 1,
        }
    }

    // Phase 1: resolve the key tree over stored ∪ *every* arriving identity entry. No
    // structural prefilter: the crown linearizes by hash links and resolves forks itself, and
    // it must see both branches of a fork to convict the forker and pick the convergent winner.
    // Resolution is not admission - storage is decided below, against the resolved tree.
    let stored_identity = load_identity_entries(db).await?;
    let mut tree_input = stored_identity.clone();
    tree_input.extend(identity_candidates.iter().cloned());
    let tree = Crown::build(root, &tree_input)
        .map_err(|e| anyhow!("key tree resolution during ingest: {e}"))?;

    // Phase 2: eviction. A just-arrived revocation may disprove chains we already stored (the
    // attacker raced its forged prefix in ahead of the revoke) or quarantine chains it never
    // anchored (a genesis-cut repudiation anchors nothing on purpose); sweep the store against
    // the resolved tree before deciding admissions.
    evicted_rows += evict_disproven_chains(db, &tree).await?;

    // Phase 3: identity entries, per author in seq order.
    identity_candidates.sort_by_key(|e| (e.entry().chain.author, e.entry().seq));
    let mut identity_by_author: BTreeMap<[u8; 32], Vec<SignedEntry>> = BTreeMap::new();
    for e in identity_candidates {
        identity_by_author
            .entry(e.entry().chain.author)
            .or_default()
            .push(e);
    }
    for (author, entries) in identity_by_author {
        if let Some(c) = tree.ceiling(&author, service::IDENTITY_PUBLIC) {
            let (stored_now, refused, evicted) = admit_ceilinged_chain(
                db,
                &author,
                service::IDENTITY_PUBLIC,
                &c,
                tree.revocation_of(&author),
                &entries,
            )
            .await?;
            received += stored_now.len() as u64;
            rejected += refused;
            evicted_rows += evicted;
            continue;
        }
        match tree.status(&author) {
            KeyStatus::Active => {
                let mut prev = stored_chain_head(db, &author, service::IDENTITY_PUBLIC).await?;
                for e in entries {
                    // Already held? (Peer resent below our head.) Skip silently.
                    if let Some(p) = &prev {
                        if e.entry().seq <= p.entry().seq {
                            continue;
                        }
                    }
                    match validate_next(prev.as_ref(), &e) {
                        Ok(()) => {
                            store_entry(db, &e).await?;
                            received += 1;
                            prev = Some(e);
                        }
                        Err(_) => rejected += 1,
                    }
                }
            }
            // Unknown: a stranger's self-consistent chain is still a stranger's chain.
            // Invalid: structurally void - nothing it signs can earn a row. Retired/Repudiated
            // *without* an identity ceiling: the revocation anchored no identity chain, so an
            // identity chain from that key has no proven standing - seal-or-nothing, same as
            // content. One exception: the credited *self*-revocation as the chain's first
            // entry. A key that retired before ever writing identity history had nothing to
            // anchor - the revoke IS the whole chain - and refusing it forgets the retirement.
            _ => {
                let origin = tree.revocation_of(&author);
                for e in entries {
                    let is_founding_self_revoke = Some(*e.hash()) == origin
                        && e.entry().seq == 0
                        && e.entry().prev_hash == ZERO_HASH;
                    if is_founding_self_revoke {
                        if stored_chain_head(db, &author, service::IDENTITY_PUBLIC)
                            .await?
                            .is_none()
                        {
                            store_entry(db, &e).await?;
                            received += 1;
                        }
                    } else {
                        rejected += 1;
                    }
                }
            }
        }
    }

    // Phase 4: content entries, gated by the resolved tree: Active authors extend their chains
    // contiguously; ceilinged chains are admitted only as their sealed prefix; everyone else -
    // strangers, the structurally void, and revoked keys on chains the revocation never
    // anchored - is refused.
    content_candidates.sort_by_key(|e| {
        (
            e.entry().chain.author,
            e.entry().chain.service,
            e.entry().seq,
        )
    });
    let mut content_by_chain: BTreeMap<([u8; 32], u32), Vec<SignedEntry>> = BTreeMap::new();
    for e in content_candidates {
        content_by_chain
            .entry((e.entry().chain.author, e.entry().chain.service))
            .or_default()
            .push(e);
    }
    for ((author, svc), entries) in content_by_chain {
        if matches!(
            tree.status(&author),
            KeyStatus::Invalid | KeyStatus::Unknown
        ) {
            rejected += entries.len() as u64;
            continue;
        }
        if let Some(c) = tree.ceiling(&author, svc) {
            let (stored_now, refused, evicted) =
                admit_ceilinged_chain(db, &author, svc, &c, None, &entries).await?;
            for e in &stored_now {
                apply_content_views(db, e).await?;
            }
            received += stored_now.len() as u64;
            rejected += refused;
            evicted_rows += evicted;
            continue;
        }
        match tree.status(&author) {
            KeyStatus::Active => {
                let mut prev = stored_chain_head(db, &author, svc).await?;
                for e in entries {
                    if let Some(p) = &prev {
                        if e.entry().seq <= p.entry().seq {
                            // At or below our head: usually a duplicate resend - but a valid
                            // signature at a position we hold, with a DIFFERENT hash, is the
                            // single-writer key contradicting itself. Record the proof; never
                            // store the second branch (neither branch is "the" chain now,
                            // and displacing stored history on a live fork would let the
                            // equivocator steer every replica it dials).
                            note_if_equivocation(db, &e).await?;
                            continue;
                        }
                    }
                    match validate_next(prev.as_ref(), &e) {
                        Ok(()) => {
                            store_entry(db, &e).await?;
                            apply_content_views(db, &e).await?;
                            received += 1;
                            prev = Some(e);
                        }
                        Err(_) => rejected += 1,
                    }
                }
            }
            // Retired/repudiated, and the revocation anchored no ceiling for this chain: the
            // revoker never vouched for it, so nothing on it is honored history.
            _ => rejected += entries.len() as u64,
        }
    }

    // Evicted rows may have been folded into materialized views before they were disproven;
    // rebuild the views from the surviving log.
    if evicted_rows > 0 {
        crate::record::imaol::rebuild_views(db)
            .await
            .map_err(|e| anyhow!("rebuilding views after forgery eviction: {e}"))?;
    }

    // Equivocation evidence is the quarantine's clock and the crown is its judge: the moment
    // a key with recorded evidence stops being Active (a revocation arrived - possibly in
    // this very batch, possibly the empty sweep a local revoke runs), the anchored-prefix
    // machinery decides what is honored history, and the quarantine has nothing left to hold.
    clear_adjudicated_equivocations(db, &tree).await?;

    Ok((received, rejected))
}

/// Record proof that a single-writer key signed two different entries at one (service, seq),
/// if this arrival is one. Called for every at-or-below-head arrival in the Active path: the
/// common case (an identical resend) returns after one indexed hash compare; the fork case
/// stores BOTH signed envelopes - portable, checkable proof regardless of what later becomes
/// of the entries table. While evidence stands on a public content chain, the persona's
/// shelf presents nothing (documents::public_docs) - neither branch is uncomplicated truth.
async fn note_if_equivocation(db: &Db, arrived: &SignedEntry) -> Result<()> {
    let entry = arrived.entry();
    let author_hex = hex::encode(entry.chain.author);
    let held: Option<(Vec<u8>, Vec<u8>)> = db
        .fetch_optional(
            "SELECT entry_hash, bytes FROM entries
             WHERE author_pubkey = ?1 AND service = ?2 AND seq = ?3",
            (
                author_hex.as_str(),
                i64::from(entry.chain.service),
                entry.seq as i64,
            ),
        )
        .await
        .context("reading the held entry at a duplicate's position")?;
    let Some((held_hash, held_bytes)) = held else {
        return Ok(()); // a hole below our head is a store gap, not a contradiction
    };
    if held_hash.as_slice() == arrived.hash().as_slice() {
        return Ok(()); // the ordinary duplicate resend
    }
    tracing::warn!(
        author = %author_hex,
        service = entry.chain.service,
        seq = entry.seq,
        "equivocation proven: two valid signatures at one chain position - quarantining"
    );
    db.execute(
        "INSERT OR IGNORE INTO equivocations
           (author_pubkey, service, seq, held_hash, other_hash, held_bytes, other_bytes, noted_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (
            author_hex.as_str(),
            i64::from(entry.chain.service),
            entry.seq as i64,
            held_hash,
            arrived.hash().to_vec(),
            held_bytes,
            arrived.bytes().to_vec(),
            crate::clock::now_ms(),
        ),
    )
    .await
    .context("recording equivocation evidence")?;
    Ok(())
}

/// Does this persona's store hold unresolved fork evidence on any PUBLIC content chain? The
/// quarantine read: while true, the public shelf presents nothing. Identity-chain forks are
/// excluded - the crown sees both branches and convicts on its own - and private-chain
/// evidence is a matter between the persona's own devices, not a public-presentation fact.
pub async fn has_public_equivocation(db: &Db) -> Result<bool> {
    let rows: Vec<(i64,)> = db
        .fetch_all("SELECT DISTINCT service FROM equivocations", ())
        .await
        .context("reading equivocation services")?;
    Ok(rows.iter().any(|(s,)| {
        let svc = *s as u32;
        !is_private_service(svc) && svc != service::IDENTITY_PUBLIC
    }))
}

/// Drop evidence for every no-longer-Active author: the revocation's anchors now govern what
/// is honored history, which is the resolution the quarantine existed to wait for. Replays of
/// the losing branch after this are the ceiling machinery's problem (seal-or-nothing), and
/// re-recording is impossible - evidence is only noted on the Active path.
async fn clear_adjudicated_equivocations(db: &Db, tree: &Crown) -> Result<()> {
    let rows: Vec<(String,)> = db
        .fetch_all("SELECT DISTINCT author_pubkey FROM equivocations", ())
        .await
        .context("listing equivocating authors")?;
    for (author_hex,) in rows {
        let Some(author) = pubkey::decode(&author_hex) else {
            continue;
        };
        if !matches!(tree.status(&author), KeyStatus::Active) {
            db.execute(
                "DELETE FROM equivocations WHERE author_pubkey = ?1",
                (author_hex.as_str(),),
            )
            .await
            .context("clearing adjudicated equivocation evidence")?;
            tracing::info!(author = %author_hex, "equivocation adjudicated by the crown - quarantine lifted");
        }
    }
    Ok(())
}

/// Proven-forgery eviction (PROJECT_PLAN, Anchored Revocations). For every ceiling the resolved
/// tree knows, check the *stored* chain against the anchor: a stored entry at `final_seq` whose
/// hash is not `head_hash` proves the stored chain is a fabrication - the attacker delivered a
/// forged prefix before the revocation reached us - and every row of it is deleted. The whole
/// chain goes, not just the rows at or below the seal: rows above `final_seq` hash-link through
/// the disproven entry (they are the same fabrication), and a dangling suffix would wedge
/// frontier-driven resync (peers send from our head onward, so the sealed prefix would never
/// re-arrive).
///
/// This does not violate monotonic memory. That promise protects *honest* history - a relying
/// party never forgets a revocation or downgrades to weaker authority it has seen. These rows
/// are cryptographically proven fabrications: the revoker's signed anchor and the stored entry's
/// own signature cannot both be honest at one (seq, chain), and the anchor is the senior word.
/// Incomplete-but-consistent stored prefixes are left alone - nothing is proven against them,
/// they may yet complete honestly on a later sync, and the seal-or-nothing gate keeps them from
/// being over-trusted meanwhile.
async fn evict_disproven_chains(db: &Db, tree: &Crown) -> Result<u64> {
    let mut evicted = 0u64;

    // Sweep one: content chains of the quarantined that no revocation anchored. The gate
    // refuses these as arrivals ("revoked keys on chains the revocation never anchored"), so
    // stored rows are pre-revocation leftovers with no proven standing - and for a
    // genesis-cut repudiation ("it was never me", zero anchors) they are the entire point:
    // nothing the key ever signed is credited, so nothing it signed keeps a row. Repudiated
    // and Invalid (the killed subtree) alike; Retired keys keep their rows - friendly
    // straggler tolerance - and identity chains stay everywhere, as evidence the crown reads.
    for (key, status) in tree.members() {
        if !matches!(status, KeyStatus::Repudiated | KeyStatus::Invalid) {
            continue;
        }
        let author_hex = hex::encode(key);
        let chains: Vec<(i64,)> = db
            .fetch_all(
                "SELECT DISTINCT service FROM entries WHERE author_pubkey = ?1",
                (author_hex.as_str(),),
            )
            .await
            .context("listing a quarantined key's stored chains")?;
        for (svc,) in chains {
            let svc = svc as u32;
            if svc == service::IDENTITY_PUBLIC || tree.ceiling(key, svc).is_some() {
                continue;
            }
            let rows_affected = db
                .execute(
                    "DELETE FROM entries WHERE author_pubkey = ?1 AND service = ?2",
                    (author_hex.as_str(), i64::from(svc)),
                )
                .await
                .context("evicting a quarantined key's unanchored chain")?;
            evicted += rows_affected;
            // The evicted chain's memo row is a lie now; the memo forgets with it.
            if let (Some(memo), Some(root)) = (db.memo(), db.root()) {
                let _ = crate::net::frontier::forget_chain(memo, root, &author_hex, svc).await;
            }
            tracing::warn!(
                author = %author_hex,
                service = svc,
                rows = rows_affected,
                "quarantined key's chain has no anchoring revocation; evicted uncredited rows"
            );
        }
    }

    // Sweep two: anchored chains whose stored prefix contradicts the anchor.
    for ((key, svc), c) in tree.ceilings() {
        // A final_seq beyond i64 can have no stored row at all; nothing to disprove.
        let Ok(final_seq) = i64::try_from(c.final_seq) else {
            continue;
        };
        let author_hex = hex::encode(key);
        let row: Option<(Vec<u8>,)> = db
            .fetch_optional(
                "SELECT entry_hash FROM entries
             WHERE author_pubkey = ?1 AND service = ?2 AND seq = ?3",
                (author_hex.as_str(), i64::from(*svc), final_seq),
            )
            .await
            .context("checking stored chain against revocation anchor")?;
        let Some((hash,)) = row else {
            continue; // incomplete: unproven either way, leave it
        };
        if hash.as_slice() == c.head_hash {
            // Sealed - but a seal bounds the PAST. Rows beyond the cut are exactly the future
            // the revocation distrusts, stored here only because they raced in while the key
            // still looked Active (the revoker's own store can't hold any - its anchors ARE
            // its heads - but a peer that had synced further can). The one lawful survivor is
            // the credited self-revocation, which can only live one seq past its own seal.
            let origin: Vec<u8> = tree
                .revocation_of(key)
                .map(|h| h.to_vec())
                .unwrap_or_default();
            let rows_affected = db
                .execute(
                    "DELETE FROM entries
                     WHERE author_pubkey = ?1 AND service = ?2 AND seq > ?3 AND entry_hash != ?4",
                    (author_hex.as_str(), i64::from(*svc), final_seq, origin),
                )
                .await
                .context("evicting rows beyond a revocation ceiling")?;
            if rows_affected > 0 {
                evicted += rows_affected;
                tracing::warn!(
                    author = %author_hex,
                    service = *svc,
                    final_seq = c.final_seq,
                    rows = rows_affected,
                    "stored rows beyond the revocation cut; evicted distrusted suffix"
                );
            }
            continue;
        }
        if let (Some(memo), Some(root)) = (db.memo(), db.root()) {
            let _ = crate::net::frontier::forget_chain(memo, root, &author_hex, *svc).await;
        }
        let rows_affected = db
            .execute(
                "DELETE FROM entries WHERE author_pubkey = ?1 AND service = ?2",
                (author_hex.as_str(), i64::from(*svc)),
            )
            .await
            .context("evicting disproven chain")?;
        evicted += rows_affected;
        tracing::warn!(
            author = %author_hex,
            service = *svc,
            final_seq = c.final_seq,
            rows = rows_affected,
            "stored chain contradicts its revocation anchor; evicted proven-forged rows"
        );
    }
    Ok(evicted)
}

/// Seal-or-nothing admission for a chain under a revocation ceiling. Under-ceiling entries are
/// admitted only as the complete **sealed prefix**: stored ∪ incoming must reach `final_seq`,
/// and the prefix is assembled by walking hash links *down from the anchor's own hash*, so every
/// admitted entry is transitively pinned by the revoker's seal. Anything else is refused: a
/// partial prefix (provisional acceptance is exactly the hole a still-held revoked key forks
/// into), an under-ceiling entry off the anchored chain (a forgery wearing an old seq), or an
/// entry beyond the seal. Refusal is retriable, and honest sync converges: an honest revoker's
/// nodes hold the sealed prefix whole, so some later exchange ships it whole.
///
/// A stored row displaced by the assembled prefix (same seq, different hash) is a proven
/// forgery - only one branch of that fork carries the revoker's seal - and is deleted before the
/// sealed entry is stored, the same monotonic-memory-compatible eviction as
/// [`evict_disproven_chains`].
///
/// Returns (entries newly stored, incoming refused, stored rows evicted).
async fn admit_ceilinged_chain(
    db: &Db,
    author: &[u8; 32],
    svc: u32,
    ceiling: &Ceiling,
    // The credited revocation's entry hash (`Crown::revocation_of`), passed only for the
    // author's identity chain - the one chain a self-revocation can live on.
    origin: Option<[u8; 32]>,
    incoming: &[SignedEntry],
) -> Result<(Vec<SignedEntry>, u64, u64)> {
    let stored = stored_chain(db, author, svc).await?;
    let mut by_hash: HashMap<[u8; 32], &SignedEntry> = HashMap::new();
    for e in stored.iter().chain(incoming.iter()) {
        if e.entry().seq <= ceiling.final_seq {
            by_hash.insert(*e.hash(), e);
        }
    }

    let prefix: Option<Vec<&SignedEntry>> =
        usize::try_from(ceiling.final_seq)
            .ok()
            .and_then(|final_seq| {
                if by_hash.len() <= final_seq {
                    return None; // cannot possibly hold seqs 0..=final_seq
                }
                let mut want = ceiling.head_hash;
                let mut out: Vec<&SignedEntry> = Vec::with_capacity(final_seq + 1);
                for seq in (0..=final_seq).rev() {
                    let e = *by_hash.get(&want)?;
                    if e.entry().seq != seq as u64 {
                        return None;
                    }
                    want = e.entry().prev_hash;
                    out.push(e);
                }
                (want == ZERO_HASH).then(|| {
                    out.reverse();
                    out
                })
            });
    let Some(prefix) = prefix else {
        // No sealed prefix assemblable yet: admit nothing, keep what we hold. Fail closed.
        return Ok((Vec::new(), incoming.len() as u64, 0));
    };

    let stored_by_seq: BTreeMap<u64, &SignedEntry> =
        stored.iter().map(|e| (e.entry().seq, e)).collect();
    let mut stored_now: Vec<SignedEntry> = Vec::new();
    let mut evicted = 0u64;
    for e in &prefix {
        match stored_by_seq.get(&e.entry().seq) {
            Some(held) if held.hash() == e.hash() => {} // already held
            Some(_) => {
                db.execute(
                    "DELETE FROM entries WHERE author_pubkey = ?1 AND service = ?2 AND seq = ?3",
                    (hex::encode(author), i64::from(svc), e.entry().seq as i64),
                )
                .await
                .context("evicting row displaced by the sealed prefix")?;
                evicted += 1;
                tracing::warn!(
                    author = %hex::encode(author),
                    service = svc,
                    seq = e.entry().seq,
                    "stored row displaced by the sealed prefix; evicted proven-forged row"
                );
                store_entry(db, e).await?;
                stored_now.push((*e).clone());
            }
            None => {
                store_entry(db, e).await?;
                stored_now.push((*e).clone());
            }
        }
    }

    // The one entry allowed beyond the seal: the revoke that *created* this ceiling. A revoke
    // can never anchor itself, so a self-retirement's revoke sits one seq past its own sealed
    // prefix - refuse it and this store forgets the retirement ever happened, then re-admits
    // fresh writes from a dumpster-dived key. The hash pins the exact entry the resolved tree
    // credited (competing forks already settled), and a senior-issued revoke lives on the
    // senior's unceilinged chain, so it never lands in this author's batch.
    if let Some(origin) = origin {
        if !stored.iter().any(|e| e.hash() == &origin) {
            if let Some(e) = incoming.iter().find(|e| *e.hash() == origin) {
                store_entry(db, e).await?;
                stored_now.push(e.clone());
            }
        }
    }

    let on_prefix: HashSet<[u8; 32]> = prefix.iter().map(|e| *e.hash()).collect();
    let refused = incoming
        .iter()
        .filter(|e| !on_prefix.contains(e.hash()) && Some(*e.hash()) != origin)
        .count() as u64;
    Ok((stored_now, refused, evicted))
}

/// Every stored entry of one chain, in seq order.
async fn stored_chain(db: &Db, author: &[u8; 32], svc: u32) -> Result<Vec<SignedEntry>> {
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT bytes FROM entries WHERE author_pubkey = ?1 AND service = ?2 ORDER BY seq",
            (hex::encode(author), i64::from(svc)),
        )
        .await
        .context("reading stored chain")?;
    rows.into_iter()
        .map(|(b,)| SignedEntry::decode(&b).map_err(|e| anyhow!("stored entry fails decode: {e}")))
        .collect()
}

async fn load_identity_entries(db: &Db) -> Result<Vec<SignedEntry>> {
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT bytes FROM entries WHERE service = ?1 ORDER BY author_pubkey, seq",
            (i64::from(service::IDENTITY_PUBLIC),),
        )
        .await
        .context("loading identity chains")?;
    rows.into_iter()
        .map(|(b,)| SignedEntry::decode(&b).map_err(|e| anyhow!("stored entry fails decode: {e}")))
        .collect()
}

async fn stored_chain_head(db: &Db, author: &[u8; 32], svc: u32) -> Result<Option<SignedEntry>> {
    let row: Option<(Vec<u8>,)> = db
        .fetch_optional(
            "SELECT bytes FROM entries WHERE author_pubkey = ?1 AND service = ?2
         ORDER BY seq DESC LIMIT 1",
            (hex::encode(author), i64::from(svc)),
        )
        .await
        .context("reading stored chain head")?;
    row.map(|(b,)| SignedEntry::decode(&b).map_err(|e| anyhow!("stored entry fails decode: {e}")))
        .transpose()
}

async fn store_entry(db: &Db, e: &SignedEntry) -> Result<()> {
    let entry_meta = (
        hex::encode(e.entry().chain.author),
        e.entry().chain.service,
        e.entry().seq,
        *e.hash(),
    );
    // Write-ahead: the journal frame lands (fsynced) before the row does, so journal ⊇ database
    // survives a crash between the two (record::journal).
    db.journal_append(e.bytes())
        .context("journaling synced entry")?;
    db.execute(
        "INSERT INTO entries
           (author_pubkey, service, seq, entry_hash, prev_hash, entry_type, timestamp_ms,
            received_at_ms, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        (
            hex::encode(e.entry().chain.author),
            i64::from(e.entry().chain.service),
            e.entry().seq as i64,
            e.hash().as_slice(),
            e.entry().prev_hash.as_slice(),
            i64::from(e.entry().entry_type),
            e.entry().timestamp_ms,
            now_ms(),
            e.bytes(),
        ),
    )
    .await
    .context("storing synced entry")?;

    // The memo, fed at the source (see imaol::append's twin): an ingested entry is a tip too.
    if let (Some(memo), Some(root)) = (db.memo(), db.root()) {
        let (author_hex, service, seq, hash) = &entry_meta;
        if let Err(err) = crate::net::frontier::note_head(memo, root, author_hex, *service, *seq, hash).await
        {
            tracing::debug!(error = ?err, "noting an ingested chain head failed (sweep reconciles)");
        }
    }
    Ok(())
}

/// Fold a freshly-admitted content entry into the materialized views.
async fn apply_content_views(db: &Db, e: &SignedEntry) -> Result<()> {
    if e.entry().chain.service == service::PROFILE_PUBLIC
        && e.entry().entry_type == entry_type::PROFILE_SET
    {
        crate::record::imaol::apply_profile_set(db, e)
            .await
            .map_err(|err| anyhow!("applying profile view: {err}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Membership proofs (the private-chain gate's identity check)

/// Our member proof for this connection, if this node agents the identity: the leaf key signs
/// (root, our endpoint, their endpoint), so the proof is bound to this exact channel and
/// worthless anywhere else.
async fn our_member_proof(
    state: &AppState,
    root: [u8; 32],
    our_endpoint: &[u8; 32],
    peer_endpoint: &[u8; 32],
) -> Option<MemberProof> {
    let root_hex = hex::encode(root);
    match crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, &root_hex).await {
        Ok(Some(leaf)) => Some(MemberProof::create(
            &root,
            our_endpoint,
            peer_endpoint,
            &leaf,
        )),
        Ok(None) => None,
        Err(e) => {
            tracing::warn!(root = %root_hex, "could not load leaf key for member proof: {e}");
            None
        }
    }
}

/// Verify a peer's member proof: channel-bound signature *and* the leaf is Active in our own
/// resolved tree. The transport authenticates the endpoints; the tree makes it authorization.
/// Everything fails toward "stranger."
async fn peer_is_member(
    db: &Db,
    root: [u8; 32],
    proof: &Option<MemberProof>,
    prover_endpoint: &[u8; 32],
    verifier_endpoint: &[u8; 32],
) -> bool {
    let Some(p) = proof else {
        return false;
    };
    if p.verify(&root, prover_endpoint, verifier_endpoint).is_err() {
        return false;
    }
    match crate::record::imaol::load_key_tree(db, &hex::encode(root)).await {
        Ok(tree) => tree.status(&p.leaf) == KeyStatus::Active,
        Err(e) => {
            tracing::warn!("key tree unavailable while checking member proof: {e}");
            false
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Roles

/// Requester role: connect to a peer and run the full symmetric exchange for one identity.
///
/// Verify-then-reveal: our first Hello carries our proof but only *public* frontiers - we cannot
/// know the responder is a member until its Hello arrives, and frontier metadata (which private
/// chains exist, how active they are) is itself private. The cost is that a proven responder
/// re-offers private entries we already hold; ingest's duplicate-skip absorbs that at this
/// scale.
pub async fn sync_with_peer(
    state: &AppState,
    root_hex: &str,
    addr: EndpointAddr,
) -> Result<ExchangeStats> {
    let root = pubkey::decode(root_hex).ok_or_else(|| anyhow!("bad root pubkey"))?;
    let db = state.user_dbs.get(root_hex).await?;

    let conn = state
        .endpoint
        .connect(addr.clone(), ringtome_proto::sync::SYNC_ALPN)
        .await
        .map_err(|e| anyhow!("connecting to peer: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.context("opening sync stream")?;
    let our_id: [u8; 32] = *state.endpoint.id().as_bytes();
    let peer_id: [u8; 32] = *conn.remote_id().as_bytes();

    write_frame(
        &mut send,
        &SyncMessage::Hello {
            root,
            frontiers: local_frontiers(&db, false).await?,
            proof: our_member_proof(state, root, &our_id, &peer_id).await,
        },
    )
    .await?;

    // Responder: Hello, entries we lack, Done.
    let (peer_frontiers, peer_proven) = match read_frame(&mut recv).await? {
        Some(SyncMessage::Hello {
            root: peer_root,
            frontiers,
            proof,
        }) => {
            if peer_root != root {
                bail!("peer answered for a different identity");
            }
            let proven = peer_is_member(&db, root, &proof, &peer_id, &our_id).await;
            (frontiers, proven)
        }
        other => bail!("expected Hello from peer, got {other:?}"),
    };
    let mut incoming = Vec::new();
    loop {
        match read_frame(&mut recv).await? {
            Some(SyncMessage::Entry(bytes)) => incoming.push(bytes),
            Some(SyncMessage::Done) | None => break,
            Some(other) => bail!("unexpected frame mid-stream: {other:?}"),
        }
    }
    // What they claim, before we act on it: the same digest we compute over our own holdings,
    // so the two are comparable (net::frontier). Best-effort - a bookkeeping failure must not
    // fail an exchange that is otherwise working.
    let claimed = crate::net::frontier::claimed_fingerprint(&peer_frontiers);
    let peer_hex = hex::encode(peer_id);
    if let Err(e) =
        crate::net::frontier::record_claim(&state.node_db, root_hex, &peer_hex, claimed).await
    {
        tracing::debug!(error = ?e, "recording a peer frontier claim failed");
    }

    let (received, rejected) = ingest_batch(&db, root, incoming, peer_proven).await?;

    // Now send what the peer lacks - private chains only to a proven member.
    let sent = send_missing(&db, &peer_frontiers, &mut send, peer_proven).await?;
    write_frame(&mut send, &SyncMessage::Done).await?;
    send.finish().ok();
    conn.closed().await; // responder closes once it has ingested our stream

    // And what came of the claim. The order matters: our own frontier is recomputed AFTER the
    // ingest, so "do we still disagree" is asked of what we now hold, not what we held when
    // they spoke. A claim that delivered nothing and still differs is the only fault - and it
    // is the one that must not be chased again until it moves.
    match crate::net::frontier::refresh(state, root_hex).await {
        Ok(true) => crate::fanout::after_public_move(state, root_hex).await,
        Ok(false) => {}
        Err(e) => tracing::debug!(error = ?e, "post-exchange frontier refresh failed"),
    }
    if received > 0 {
        // The requester ingests too (see serve's twin comment): cross-device dials arrive here.
        crate::net::subscriptions::refresh_root(state, root_hex).await;
    }
    let verdict = if received > 0 {
        crate::net::frontier::Verdict::Ahead
    } else {
        let ours = crate::net::frontier::persona_fingerprint(
            &crate::net::frontier::held(&state.node_db, root_hex)
                .await
                .unwrap_or_default(),
        );
        if ours == claimed {
            crate::net::frontier::Verdict::Behind
        } else {
            crate::net::frontier::Verdict::Unresolvable
        }
    };
    if let Err(e) =
        crate::net::frontier::record_verdict(&state.node_db, root_hex, &peer_hex, claimed, verdict)
            .await
    {
        tracing::debug!(error = ?e, "recording a chase verdict failed");
    }

    // Entries landed; now the bodies they reference. Best-effort, never fails the exchange.
    let bodies_fetched =
        crate::record::documents::fetch_missing_bodies(state, root_hex, addr).await;

    // A body landing is availability moving, even though no frontier did: nodes that heard
    // the header from us may have dialed back for bytes we didn't have yet (the multi-hop
    // race: device -> this node -> follower). Ride the fan-out edge again so they can finish;
    // when entries also landed the caller fires the same edge and this one is a cheap
    // idempotent second pass.
    if bodies_fetched > 0 {
        crate::fanout::after_public_move(state, root_hex).await;
    }

    Ok(ExchangeStats {
        received,
        rejected,
        sent,
        bodies_fetched,
    })
}

/// Responder role: called from the accept loop with an established connection.
pub async fn serve(conn: Connection, state: AppState) -> Result<()> {
    let (mut send, mut recv) = conn.accept_bi().await.context("accepting sync stream")?;
    let our_id: [u8; 32] = *state.endpoint.id().as_bytes();
    let peer_id: [u8; 32] = *conn.remote_id().as_bytes();

    let (root, peer_frontiers, peer_proof) = match read_frame(&mut recv).await? {
        Some(SyncMessage::Hello {
            root,
            frontiers,
            proof,
        }) => (root, frontiers, proof),
        other => bail!("expected Hello, got {other:?}"),
    };
    let root_hex = hex::encode(root);

    // Serve identities this node agents - and ACCEPT exchanges for personas someone here
    // WANTS: a followed or previously-fetched persona's updates are welcome, which is how a
    // push from their node reaches ours without us asking first. Anything else still gets the
    // polite empty exchange (uniform behavior - we don't confirm what we do or don't hold).
    // Accepting for a wanted persona does disclose node-level interest, but only the interest
    // our own fetch already disclosed the day it created the want; the exchange's member
    // proofs keep everything private out of it regardless of why we accepted.
    let agented = crate::identity::is_agented(&state.node_db, &root_hex)
        .await
        .map_err(|e| anyhow!("checking identity: {e}"))?;
    let wanted = agented
        || !crate::net::subscriptions::followers_of(&state.node_db, &root_hex)
            .await?
            .is_empty()
        || crate::idface::has_fetched(&state.node_db, &root_hex).await?;
    if !wanted {
        write_frame(
            &mut send,
            &SyncMessage::Hello {
                root,
                frontiers: vec![],
                proof: None,
            },
        )
        .await?;
        write_frame(&mut send, &SyncMessage::Done).await?;
        send.finish().ok();
        conn.closed().await;
        return Ok(());
    }

    // They dialed us and named this persona: that is a demand edge, recorded before anything
    // else happens because the asking is the fact, whatever the exchange goes on to transfer.
    // Deliberately AFTER the agented check above - a node we don't serve gets a uniform empty
    // answer, and writing a row for it would make our silence measurable.
    if let Err(e) =
        crate::net::demand::record_ask(&state.node_db, &root_hex, &hex::encode(peer_id)).await
    {
        tracing::debug!(error = ?e, "recording a demand edge failed");
    }

    let db = state.user_dbs.get(&root_hex).await?;
    let peer_proven = peer_is_member(&db, root, &peer_proof, &peer_id, &our_id).await;

    // Our Hello carries our own proof (so the requester will send *us* private entries) and our
    // frontiers - private ones included only for a proven member.
    write_frame(
        &mut send,
        &SyncMessage::Hello {
            root,
            frontiers: local_frontiers(&db, peer_proven).await?,
            proof: our_member_proof(&state, root, &our_id, &peer_id).await,
        },
    )
    .await?;
    let sent = send_missing(&db, &peer_frontiers, &mut send, peer_proven).await?;
    write_frame(&mut send, &SyncMessage::Done).await?;

    // Then ingest the requester's half of the exchange.
    let mut incoming = Vec::new();
    loop {
        match read_frame(&mut recv).await? {
            Some(SyncMessage::Entry(bytes)) => incoming.push(bytes),
            Some(SyncMessage::Done) | None => break,
            Some(other) => bail!("unexpected frame mid-stream: {other:?}"),
        }
    }
    let (received, rejected) = ingest_batch(&db, root, incoming, peer_proven).await?;
    tracing::info!(
        root = %root_hex,
        remote = %conn.remote_id(),
        peer_proven,
        sent, received, rejected,
        "served sync exchange"
    );
    // A push just landed something. The frontier map's edge is what fan-out hangs off, and the
    // 30s sweep would find this eventually - but "eventually" is the wrong latency for the one
    // moment we KNOW something arrived, so ask directly.
    if received > 0 {
        match crate::net::frontier::refresh(&state, &root_hex).await {
            Ok(true) => crate::fanout::after_public_move(&state, &root_hex).await,
            Ok(false) => {}
            Err(e) => tracing::debug!(error = ?e, "post-ingest frontier refresh failed"),
        }
        // Private records ride the same exchange (member-proven peers), and a contact dial
        // turned elsewhere must reach this node's memo by EVENT, not by backstop.
        crate::net::subscriptions::refresh_root(&state, &root_hex).await;
    }
    conn.close(0u8.into(), b"done");

    // The responder's half of the body lane: the peer that dialed us is online RIGHT NOW -
    // dial back by endpoint id and fetch any referenced blobs we lack, instead of sitting
    // bodiless until our own next initiated sync (eager push makes the WRITER the initiator,
    // so "catch up next time" meant an editor on this node could stare at a null body for a
    // whole anti-entropy interval). Spawned: never blocks or fails the exchange.
    //
    // UNGATED on `received` (2026-08-06): this used to run only when entries landed, which
    // left a follower that lost the multi-hop body race (header pushed onward before its body
    // arrived at the pusher) bodiless until the author's NEXT post - the only exchanges such
    // a node ever sees are inbound pushes. Now every inbound exchange is a chance to finish;
    // the walk exits at one query when nothing is missing. The `after_public_move` on a
    // fruitful fetch is the same edge the initiator side rides: bodies arriving here may be
    // the bytes a node further downstream is waiting on.
    {
        let state = state.clone();
        let remote = conn.remote_id();
        tokio::spawn(async move {
            let addr = EndpointAddr::new(remote);
            let fetched =
                crate::record::documents::fetch_missing_bodies(&state, &root_hex, addr).await;
            if fetched > 0 {
                tracing::info!(root = %root_hex, fetched, "backfilled bodies after serving sync");
                crate::fanout::after_public_move(&state, &root_hex).await;
            }
        });
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Peer bookkeeping (node.db)

/// Remember a peer for an identity. Endpoint ids only - addresses are the discovery layer's
/// problem, resolved at dial time (hints are keys, never addresses).
pub async fn add_peer(node_db: &Db, root_hex: &str, endpoint_id: &str) -> Result<()> {
    node_db
        .execute(
            "INSERT OR IGNORE INTO identity_peers (root_pubkey, endpoint_id, added_at_ms)
         VALUES (?1, ?2, ?3)",
            (root_hex, endpoint_id, now_ms()),
        )
        .await
        .context("recording peer")?;
    Ok(())
}

/// Known peer endpoint ids for an identity.
pub async fn peers_for(node_db: &Db, root_hex: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT endpoint_id FROM identity_peers WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("listing peers")?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// The same peers ordered by how recently a sync actually reached them - the "biased toward
/// nodes online at production time" signal minted addresses want for their `?via=` hints
/// (Addressing). Never-synced peers sort last (recorded at adoption but unproven); ties by
/// most recently added.
pub async fn liveliest_peers(node_db: &Db, root_hex: &str, cap: u32) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT endpoint_id FROM identity_peers WHERE root_pubkey = ?1
             ORDER BY last_synced_ms IS NULL, last_synced_ms DESC, added_at_ms DESC
             LIMIT ?2",
            (root_hex, cap),
        )
        .await
        .context("listing liveliest peers")?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Distinct roots that have at least one known peer - the background sync worklist.
pub async fn roots_with_peers(node_db: &Db) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT DISTINCT root_pubkey FROM identity_peers", ())
        .await
        .context("listing roots with peers")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Outcome of one peer's exchange within a multi-peer sync, shaped for logs and the sync route's
/// JSON response.
#[derive(Debug, serde::Serialize)]
pub struct PeerSyncResult {
    pub peer: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<ExchangeStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Full exchange with the given peers of one identity: dial, sync, mark synced. Per-peer
/// failures land in the results, never in `Err` - an unreachable peer is a normal day on a p2p
/// network. Callers choose the peer set (the sync route and eager push: all known peers;
/// anti-entropy: a random sample).
pub async fn sync_peers(
    state: &AppState,
    root_hex: &str,
    peers: &[String],
) -> Result<Vec<PeerSyncResult>> {
    let mut results = Vec::new();
    for peer_id in peers {
        // Resolve at dial time: id -> addresses via the directory (or iroh's own discovery).
        let attempt = async {
            let addr = dial_addr(state, peer_id).await?;
            sync_with_peer(state, root_hex, addr).await
        };
        match attempt.await {
            Ok(stats) => {
                mark_synced(&state.node_db, root_hex, peer_id).await?;
                results.push(PeerSyncResult {
                    peer: peer_id.clone(),
                    ok: true,
                    stats: Some(stats),
                    error: None,
                });
            }
            Err(e) => results.push(PeerSyncResult {
                peer: peer_id.clone(),
                ok: false,
                stats: None,
                error: Some(format!("{e:#}")),
            }),
        }
    }
    Ok(results)
}

/// Build a dialable address for a peer: the endpoint id, plus whatever addresses the directory
/// knows. In mainline mode the address set is usually empty and iroh's own discovery fills it
/// in; in local mode the stub's endpoint record supplies it; in Off mode a bare id only works if
/// iroh has the peer cached from a previous connection.
pub async fn dial_addr(state: &AppState, endpoint_id: &str) -> Result<EndpointAddr> {
    let id: iroh::PublicKey = endpoint_id
        .parse()
        .map_err(|_| anyhow!("bad endpoint id"))?;
    let mut ea = EndpointAddr::new(id);
    if let Some(addrs) = state.directory.resolve_endpoint(endpoint_id).await? {
        for a in &addrs {
            let sock: std::net::SocketAddr = a.parse().context("bad socket address")?;
            ea = ea.with_ip_addr(sock);
        }
    }
    Ok(ea)
}

/// Build a connectable address from an endpoint id and socket-address strings.
pub fn endpoint_addr(endpoint_id: &str, addrs: &[String]) -> Result<EndpointAddr> {
    let id: iroh::PublicKey = endpoint_id
        .parse()
        .map_err(|_| anyhow!("bad endpoint id"))?;
    let mut ea = EndpointAddr::new(id);
    for a in addrs {
        let sock: std::net::SocketAddr = a.parse().context("bad socket address")?;
        ea = ea.with_ip_addr(sock);
    }
    Ok(ea)
}

pub async fn mark_synced(node_db: &Db, root_hex: &str, endpoint_id: &str) -> Result<()> {
    node_db
        .execute(
            "UPDATE identity_peers SET last_synced_ms = ?1 WHERE root_pubkey = ?2 AND endpoint_id = ?3",
            (now_ms(), root_hex, endpoint_id),
        )
        .await
        .context("marking peer synced")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The gate under attack. The scenario throughout: root authorizes leaf K; K writes an
    //! honest chain; K is compromised and root repudiates it, anchoring K's real heads. The
    //! attacker still *holds* K, so it can sign an alternative under-ceiling history with
    //! perfectly valid signatures - the seal's hash, not its seq, is the only thing that
    //! separates the two. These tests drive `ingest_batch` directly (the sync framing above it
    //! adds nothing to the trust decisions).

    use super::*;
    use ringtome_proto::{
        Anchor, Authorize, ChainId, Disposition, Entry, Payload, Revoke, SigningKey, ENTRY_VERSION,
    };

    async fn test_db() -> Db {
        crate::db::test_user_db().await
    }

    /// One (key, service) chain under construction - dense seqs, real hash links.
    struct Chain {
        sk: SigningKey,
        svc: u32,
        seq: u64,
        prev: [u8; 32],
    }

    impl Chain {
        fn new(seed: u8, svc: u32) -> Self {
            Self {
                sk: SigningKey::from_bytes(&[seed; 32]),
                svc,
                seq: 0,
                prev: ZERO_HASH,
            }
        }

        /// A second pen at the same position: clone the chain state so the SAME key can sign
        /// two different continuations of one prefix - the equivocator's move.
        fn fork(&self) -> Chain {
            Chain {
                sk: self.sk.clone(),
                svc: self.svc,
                seq: self.seq,
                prev: self.prev,
            }
        }

        fn pk(&self) -> [u8; 32] {
            self.sk.verifying_key().to_bytes()
        }

        fn append(&mut self, type_id: u32, payload: Vec<u8>) -> SignedEntry {
            let entry = Entry {
                v: ENTRY_VERSION,
                entry_type: type_id,
                chain: ChainId {
                    author: self.pk(),
                    service: self.svc,
                },
                seq: self.seq,
                prev_hash: self.prev,
                timestamp_ms: 1_700_000_000_000 + self.seq as i64,
                payload: Payload::Inline(payload),
            };
            let signed = SignedEntry::create(&entry, &self.sk).unwrap();
            self.seq += 1;
            self.prev = *signed.hash();
            signed
        }
    }

    struct Scenario {
        root: [u8; 32],
        k: [u8; 32],
        /// Root's identity chain, entry 0: authorize K.
        authorize: SignedEntry,
        /// Root's identity chain, entry 1: repudiate K, anchoring the honest posts head.
        revoke: SignedEntry,
        /// K's honest posts chain, seqs 0..=2 - the anchored history.
        honest: Vec<SignedEntry>,
        /// The attacker's alternative posts chain, same key, same seqs, valid signatures.
        forged: Vec<SignedEntry>,
    }

    fn scenario() -> Scenario {
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let mut k_posts = Chain::new(2, service::POSTS);
        let k = k_posts.pk();

        let authorize = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: k,
                usurpers: vec![root_chain.pk()],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let honest: Vec<SignedEntry> = (0..3u8)
            .map(|n| k_posts.append(entry_type::POST, vec![0xa0, n]))
            .collect();
        let mut forged_posts = Chain::new(2, service::POSTS);
        let forged: Vec<SignedEntry> = (0..3u8)
            .map(|n| forged_posts.append(entry_type::POST, vec![0xbb, n]))
            .collect();
        let revoke = root_chain.append(
            entry_type::REVOKE,
            Revoke {
                target: k,
                disposition: Disposition::Repudiation,
                anchors: vec![Anchor {
                    service: service::POSTS,
                    seq: 2,
                    head_hash: *honest[2].hash(),
                }],
            }
            .encode()
            .unwrap(),
        );

        Scenario {
            root: root_chain.pk(),
            k,
            authorize,
            revoke,
            honest,
            forged,
        }
    }

    async fn ingest(db: &Db, root: [u8; 32], entries: &[SignedEntry]) -> (u64, u64) {
        let raw = entries.iter().map(|e| e.bytes().to_vec()).collect();
        ingest_batch(db, root, raw, false).await.unwrap()
    }

    async fn stored_hashes(db: &Db, author: &[u8; 32], svc: u32) -> Vec<[u8; 32]> {
        stored_chain(db, author, svc)
            .await
            .unwrap()
            .iter()
            .map(|e| *e.hash())
            .collect()
    }

    fn hashes(entries: &[SignedEntry]) -> Vec<[u8; 32]> {
        entries.iter().map(|e| *e.hash()).collect()
    }

    #[tokio::test]
    async fn a_forged_prefix_under_a_known_ceiling_is_refused() {
        // The attack verbatim: a fresh store that knows the ceiling but holds none of K's
        // chain is offered the attacker's under-ceiling history - every seq within the seal,
        // every signature valid. Without the hash check this batch walks straight in.
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize, s.revoke]).await, (2, 0));

        let (received, rejected) = ingest(&db, s.root, &s.forged).await;
        assert_eq!(
            (received, rejected),
            (0, 3),
            "the forged prefix is refused whole"
        );
        assert!(stored_hashes(&db, &s.k, service::POSTS).await.is_empty());
    }

    #[tokio::test]
    async fn the_honest_sealed_prefix_is_accepted() {
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize, s.revoke]).await, (2, 0));

        let (received, rejected) = ingest(&db, s.root, &s.honest).await;
        assert_eq!((received, rejected), (3, 0));
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.honest),
            "the anchored history lands intact"
        );
    }

    #[tokio::test]
    async fn a_partial_prefix_is_refused_until_it_completes() {
        // No provisional acceptance: an honest-but-partial under-ceiling batch is refused
        // (that is the hole an attacker forks into), and a later batch shipping the sealed
        // prefix whole is accepted - honest peers hold it whole, so honest sync converges.
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize, s.revoke]).await, (2, 0));

        assert_eq!(ingest(&db, s.root, &s.honest[..2]).await, (0, 2));
        assert!(stored_hashes(&db, &s.k, service::POSTS).await.is_empty());

        assert_eq!(ingest(&db, s.root, &s.honest).await, (3, 0));
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.honest)
        );
    }

    #[tokio::test]
    async fn a_stored_consistent_prefix_completes_across_the_ceiling() {
        // The other half of seal-or-nothing: entries stored *before* the revocation arrived
        // are honest-but-incomplete, not disproven - they stay, and the seal completes from
        // the combined stored ∪ incoming set.
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize.clone()]).await, (1, 0));
        assert_eq!(ingest(&db, s.root, &s.honest[..2]).await, (2, 0));

        // The revocation arrives; the stored prefix is consistent with the anchor, so nothing
        // is evicted.
        assert_eq!(ingest(&db, s.root, &[s.revoke]).await, (1, 0));
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.honest[..2]),
            "incomplete-but-consistent history is left in place"
        );

        // The final anchored entry completes the seal against what is already stored.
        assert_eq!(ingest(&db, s.root, &s.honest[2..]).await, (1, 0));
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.honest)
        );
    }

    #[tokio::test]
    async fn a_self_retirement_is_stored_and_outlives_its_own_seal() {
        // A revoke can never anchor itself, so a self-retirement lands one seq beyond its own
        // seal. Regression: the gate used to admit only the sealed prefix, so the retirement
        // never persisted here - and on the next resolve from storage the dumpster-dived key
        // was Active again. The `origin` carve-out keeps exactly that one entry, nothing after.
        let db = test_db().await;
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let mut k_ident = Chain::new(2, service::IDENTITY_PUBLIC);
        let k = k_ident.pk();

        let authorize = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: k,
                usurpers: vec![root_chain.pk()],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let grandchild = Chain::new(3, service::IDENTITY_PUBLIC);
        let g_auth = k_ident.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: grandchild.pk(),
                usurpers: vec![root_chain.pk(), k],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let retire = k_ident.append(
            entry_type::REVOKE,
            Revoke {
                target: k,
                disposition: Disposition::Retirement,
                anchors: vec![Anchor {
                    service: service::IDENTITY_PUBLIC,
                    seq: 0,
                    head_hash: *g_auth.hash(),
                }],
            }
            .encode()
            .unwrap(),
        );

        let batch = [authorize, g_auth.clone(), retire.clone()];
        let (received, rejected) = ingest(&db, root_chain.pk(), &batch).await;
        assert_eq!((received, rejected), (3, 0), "the retirement itself lands");
        assert_eq!(
            stored_hashes(&db, &k, service::IDENTITY_PUBLIC).await,
            vec![*g_auth.hash(), *retire.hash()],
            "sealed prefix plus the origin revoke, in place"
        );

        // The dumpster-diver continuation: the retired key mints a phantom child beyond its
        // seal. The *stored* set alone must still know the retirement and refuse it.
        let phantom = Chain::new(9, service::IDENTITY_PUBLIC);
        let phantom_auth = k_ident.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: phantom.pk(),
                usurpers: vec![root_chain.pk(), k],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let (received, rejected) = ingest(&db, root_chain.pk(), &[phantom_auth]).await;
        assert_eq!((received, rejected), (0, 1), "post-seal mints stay refused");
    }

    #[tokio::test]
    async fn stored_rows_beyond_the_cut_are_evicted_when_the_revocation_arrives() {
        // The racing peer: this node had synced MORE of K than the revoker ever saw, so the
        // revocation's anchor falls below our stored head. The rows beyond the cut are the
        // future the revocation distrusts - accepted honestly while K looked Active, and
        // swept the moment the revocation lands.
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize.clone()]).await, (1, 0));
        assert_eq!(ingest(&db, s.root, &s.honest).await, (3, 0)); // seqs 0..=2 stored

        // Root repudiates K anchoring seq 1 - it never saw seq 2.
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let _reauthorize = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: s.k,
                usurpers: vec![root_chain.pk()],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let revoke = root_chain.append(
            entry_type::REVOKE,
            Revoke {
                target: s.k,
                disposition: Disposition::Repudiation,
                anchors: vec![Anchor {
                    service: service::POSTS,
                    seq: 1,
                    head_hash: *s.honest[1].hash(),
                }],
            }
            .encode()
            .unwrap(),
        );

        let (received, _rejected) = ingest(&db, s.root, &[revoke]).await;
        assert_eq!(received, 1, "the revocation lands");
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.honest[..2]),
            "the sealed prefix stands; the row beyond the cut is swept"
        );
    }

    #[tokio::test]
    async fn a_genesis_repudiation_evicts_everything_the_key_signed() {
        // "It was never me": a repudiation with zero anchors credits no history, so stored
        // content the key signed before the revocation arrived - accepted honestly while it
        // looked Active - is swept. Contrast the anchored ("it was me until now") cut, whose
        // sealed prefix stays: that case is a_stored_consistent_prefix_completes_across_the_
        // ceiling, above.
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize.clone()]).await, (1, 0));
        assert_eq!(ingest(&db, s.root, &s.honest).await, (3, 0));

        // Root repudiates K anchoring NOTHING - built directly, since scenario()'s revoke is
        // the anchored kind. Root's chain already holds the authorize at seq 0.
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let _reauthorize = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: s.k,
                usurpers: vec![root_chain.pk()],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let genesis_revoke = root_chain.append(
            entry_type::REVOKE,
            Revoke {
                target: s.k,
                disposition: Disposition::Repudiation,
                anchors: vec![],
            }
            .encode()
            .unwrap(),
        );

        let (received, _rejected) = ingest(&db, s.root, &[genesis_revoke]).await;
        assert_eq!(received, 1, "the revocation itself lands");
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            Vec::<[u8; 32]>::new(),
            "no anchor, no credit: the posts are gone"
        );
    }

    #[tokio::test]
    async fn an_anchorless_self_retirement_is_stored_and_remembered() {
        // The adopted-leaf shape: a key that never wrote identity history retires itself, so
        // the revoke is its chain's FIRST entry and the revocation anchors no identity chain
        // at all. Seal-or-nothing would refuse the whole chain - and forget the retirement.
        let db = test_db().await;
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let mut k_ident = Chain::new(2, service::IDENTITY_PUBLIC);
        let k = k_ident.pk();

        let authorize = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: k,
                usurpers: vec![root_chain.pk()],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let retire = k_ident.append(
            entry_type::REVOKE,
            Revoke {
                target: k,
                disposition: Disposition::Retirement,
                anchors: vec![],
            }
            .encode()
            .unwrap(),
        );

        let (received, rejected) =
            ingest(&db, root_chain.pk(), &[authorize, retire.clone()]).await;
        assert_eq!((received, rejected), (2, 0), "the founding self-revoke lands");
        assert_eq!(
            stored_hashes(&db, &k, service::IDENTITY_PUBLIC).await,
            vec![*retire.hash()],
            "the revoke is the whole stored chain"
        );

        // The dumpster-diver continuation must bounce off the stored set alone.
        let phantom = Chain::new(9, service::IDENTITY_PUBLIC);
        let phantom_auth = k_ident.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: phantom.pk(),
                usurpers: vec![root_chain.pk(), k],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let (received, rejected) = ingest(&db, root_chain.pk(), &[phantom_auth]).await;
        assert_eq!(
            (received, rejected),
            (0, 1),
            "post-retirement mints stay refused"
        );
    }

    #[tokio::test]
    async fn a_raced_in_forgery_is_evicted_when_the_revocation_arrives() {
        // The race: the attacker delivers the forged chain BEFORE the revoke reaches this
        // node - K still looks Active, the chain is contiguous, and the gate rightly accepts
        // it. The arriving revocation then proves those rows forged (the anchor and the stored
        // entry cannot both be honest at one seq), they are evicted, and the honest prefix is
        // accepted afterward. Deleting them does not violate monotonic memory: that protects
        // honest history, not cryptographically-proven fabrications.
        let db = test_db().await;
        let s = scenario();
        assert_eq!(ingest(&db, s.root, &[s.authorize.clone()]).await, (1, 0));
        assert_eq!(ingest(&db, s.root, &s.forged).await, (3, 0));
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.forged),
            "pre-revocation, the forgery is indistinguishable and lands"
        );

        assert_eq!(ingest(&db, s.root, &[s.revoke]).await, (1, 0));
        assert!(
            stored_hashes(&db, &s.k, service::POSTS).await.is_empty(),
            "the revocation's anchor convicts the stored rows; they are gone"
        );

        assert_eq!(ingest(&db, s.root, &s.honest).await, (3, 0));
        assert_eq!(
            stored_hashes(&db, &s.k, service::POSTS).await,
            hashes(&s.honest),
            "the sealed history replaces the fabrication"
        );
    }

    #[tokio::test]
    async fn a_forged_identity_prefix_never_mints_members() {
        // The identity-chain variant: K's forged identity chain authorizes a phantom child.
        // Under a seq-only ceiling the phantom's authorization is "within" the seal; the hash
        // check refuses the row entirely, and the honest identity prefix is accepted later.
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let mut k_id = Chain::new(2, service::IDENTITY_PUBLIC);
        let k = k_id.pk();
        let child = Chain::new(3, service::IDENTITY_PUBLIC);
        let phantom = Chain::new(9, service::IDENTITY_PUBLIC);

        let authorize_k = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: k,
                usurpers: vec![root_chain.pk()],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let honest_auth = k_id.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: child.pk(),
                usurpers: vec![root_chain.pk(), k],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let mut forged_k = Chain::new(2, service::IDENTITY_PUBLIC);
        let forged_auth = forged_k.append(
            entry_type::AUTHORIZE,
            Authorize {
                child: phantom.pk(),
                usurpers: vec![root_chain.pk(), k],
                enc_pubkey: None,
            }
            .encode()
            .unwrap(),
        );
        let revoke = root_chain.append(
            entry_type::REVOKE,
            Revoke {
                target: k,
                disposition: Disposition::Repudiation,
                anchors: vec![Anchor {
                    service: service::IDENTITY_PUBLIC,
                    seq: 0,
                    head_hash: *honest_auth.hash(),
                }],
            }
            .encode()
            .unwrap(),
        );
        let root = root_chain.pk();

        let db = test_db().await;
        assert_eq!(ingest(&db, root, &[authorize_k, revoke]).await, (2, 0));
        assert_eq!(
            ingest(&db, root, &[forged_auth]).await,
            (0, 1),
            "the phantom authorization is refused, not merely uncredited"
        );
        assert!(stored_hashes(&db, &k, service::IDENTITY_PUBLIC)
            .await
            .is_empty());

        assert_eq!(ingest(&db, root, &[honest_auth.clone()]).await, (1, 0));
        assert_eq!(
            stored_hashes(&db, &k, service::IDENTITY_PUBLIC).await,
            vec![*honest_auth.hash()]
        );
    }

    #[tokio::test]
    async fn roots_with_peers_lists_each_root_once() {
        let node_db = crate::db::test_node_db().await;
        add_peer(&node_db, "aa11", "endpoint-one").await.unwrap();
        add_peer(&node_db, "aa11", "endpoint-two").await.unwrap();
        add_peer(&node_db, "bb22", "endpoint-one").await.unwrap();

        let mut roots = roots_with_peers(&node_db).await.unwrap();
        roots.sort();
        assert_eq!(roots, vec!["aa11".to_string(), "bb22".to_string()]);
    }

    /// ChatGPT's third pitched test (2026-08-06): equal-height public equivocation must be
    /// detected, contained, and resolvable. The wire carries head_hash precisely because two
    /// forked chains at one height agree by range arithmetic - this drives the whole arc:
    /// the proof entry crossing the wire, the gate recording rather than storing it, the
    /// shelf going dark while the contradiction stands, and the crown's anchors resolving it.
    #[tokio::test]
    async fn equal_height_public_fork_is_quarantined_then_resolved_by_anchor() {
        use ringtome_proto::DocHeaderPlain;
        fn post(chain: &mut Chain, id: u8, title: &str) -> SignedEntry {
            let header = DocHeaderPlain {
                doc_id: [id; 16],
                parents: vec![],
                file_hash: [id; 32],
                body_hash: [id; 32],
                title: title.into(),
                format: None,
                width: None,
                height: None,
                duration_ms: None,
                thumb_hash: None,
                preview_hash: None,
            };
            chain.append(entry_type::DOC_HEADER, header.encode().unwrap())
        }
        let shelf = |docs: Vec<crate::record::documents::PublicDoc>| -> Vec<String> {
            let mut titles: Vec<String> = docs.into_iter().map(|d| d.title).collect();
            titles.sort();
            titles
        };

        // Root authorizes K; K posts a common prefix, then the same key signs two different
        // entries at seq 1: `left` and `right`, both valid, different hashes.
        let mut root_chain = Chain::new(1, service::IDENTITY_PUBLIC);
        let mut posts = Chain::new(2, service::POSTS);
        let k = posts.pk();
        let authorize = root_chain.append(
            entry_type::AUTHORIZE,
            Authorize { child: k, usurpers: vec![root_chain.pk()], enc_pubkey: None }
                .encode()
                .unwrap(),
        );
        let common = post(&mut posts, 0x0a, "common");
        let mut other_pen = posts.fork();
        let left = post(&mut posts, 0x0b, "left");
        let right = post(&mut other_pen, 0x0c, "right");
        assert_eq!(left.entry().seq, right.entry().seq, "the fork is at one height");
        assert_ne!(left.hash(), right.hash());

        // Node B holds the left branch; node C holds the right.
        let b = test_db().await;
        let c = test_db().await;
        let root = root_chain.pk();
        assert_eq!(ingest(&b, root, &[authorize.clone(), common.clone(), left.clone()]).await, (3, 0));
        assert_eq!(ingest(&c, root, &[authorize.clone(), common.clone(), right.clone()]).await, (3, 0));

        // CONTAINMENT, wire half: range arithmetic sees agreement (equal heads), but the
        // head-hash mismatch makes each side send its head entry - the proof crosses.
        let b_frontiers = local_frontiers(&b, false).await.unwrap();
        let c_frontiers = local_frontiers(&c, false).await.unwrap();
        let b_sends = missing_for_peer(&b, &c_frontiers, false).await.unwrap();
        let c_sends = missing_for_peer(&c, &b_frontiers, false).await.unwrap();
        assert_eq!(b_sends, vec![left.bytes().to_vec()], "B offers its head as proof");
        assert_eq!(c_sends, vec![right.bytes().to_vec()], "C offers its head as proof");

        // CONTAINMENT, gate half: the proof arrives; neither branch overwrites the other,
        // the second branch is NOT a second post, and the evidence is on the record.
        assert_eq!(ingest(&b, root, &[right.clone()]).await, (0, 0), "recorded, not stored");
        assert_eq!(ingest(&c, root, &[left.clone()]).await, (0, 0));
        assert_eq!(
            stored_hashes(&b, &k, service::POSTS).await,
            vec![*common.hash(), *left.hash()],
            "B's chain is exactly what it was"
        );
        assert_eq!(
            stored_hashes(&c, &k, service::POSTS).await,
            vec![*common.hash(), *right.hash()]
        );
        assert!(has_public_equivocation(&b).await.unwrap(), "the contradiction is on record");
        assert!(has_public_equivocation(&c).await.unwrap());

        // CONTAINMENT, presentation half: while the fork stands, the shelf presents nothing -
        // not the disputed head, not even the common prefix. Neither branch is truth yet.
        assert_eq!(
            shelf(crate::record::documents::public_docs(&b, None, 10).await.unwrap()),
            Vec::<String>::new(),
            "B's shelf is dark under quarantine"
        );
        assert_eq!(
            shelf(crate::record::documents::public_docs(&c, None, 10).await.unwrap()),
            Vec::<String>::new()
        );

        // Idempotence: the same proof arriving again (anti-entropy re-sends) changes nothing.
        assert_eq!(ingest(&b, root, &[right.clone()]).await, (0, 0));
        assert!(has_public_equivocation(&b).await.unwrap());

        // RESOLUTION: the senior repudiates K, anchoring the exact prefix ending in `left`.
        let revoke = root_chain.append(
            entry_type::REVOKE,
            Revoke {
                target: k,
                disposition: Disposition::Repudiation,
                anchors: vec![Anchor {
                    service: service::POSTS,
                    seq: left.entry().seq,
                    head_hash: *left.hash(),
                }],
            }
            .encode()
            .unwrap(),
        );

        // C holds the losing branch: the ceiling evicts it, the sealed prefix ships whole
        // (the revoker's nodes hold it - here, the same batch), and the quarantine lifts.
        ingest(&c, root, &[revoke.clone(), common.clone(), left.clone()]).await;
        assert_eq!(
            stored_hashes(&c, &k, service::POSTS).await,
            vec![*common.hash(), *left.hash()],
            "C converged on the anchored prefix - right is gone"
        );
        assert!(!has_public_equivocation(&c).await.unwrap(), "the crown adjudicated");
        assert_eq!(
            shelf(crate::record::documents::public_docs(&c, None, 10).await.unwrap()),
            vec!["common".to_string(), "left".to_string()],
            "the shelf returns with the honored history, and only it"
        );

        // B held the winning branch all along: the revocation alone lifts its quarantine.
        ingest(&b, root, &[revoke.clone()]).await;
        assert_eq!(stored_hashes(&b, &k, service::POSTS).await, vec![*common.hash(), *left.hash()]);
        assert!(!has_public_equivocation(&b).await.unwrap());
        assert_eq!(
            shelf(crate::record::documents::public_docs(&b, None, 10).await.unwrap()),
            vec!["common".to_string(), "left".to_string()]
        );

        // Replaying the losing branch after adjudication: refused by the ceiling (the sealed
        // prefix is the only admissible history), and the quarantine does NOT re-arm - the
        // evidence path only runs for Active keys.
        assert_eq!(ingest(&c, root, &[right.clone()]).await, (0, 1));
        assert_eq!(
            stored_hashes(&c, &k, service::POSTS).await,
            vec![*common.hash(), *left.hash()]
        );
        assert!(!has_public_equivocation(&c).await.unwrap());
    }
}
