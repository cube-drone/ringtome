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
fn is_private_service(svc: u32) -> bool {
    svc == service::IDENTITY_PRIVATE
        || svc == service::GENERAL_PRIVATE
        || svc == service::DOCUMENTS_PRIVATE
        || svc == service::DOC_META_PRIVATE
}

/// This identity's held ranges, one per stored chain. Private chains appear only when the peer
/// has proven membership.
pub async fn local_frontiers(db: &Db, include_private: bool) -> Result<Vec<Frontier>> {
    let rows: Vec<(String, i64, i64, i64)> = db
        .fetch_all(
            "SELECT author_pubkey, service, MIN(seq), MAX(seq) FROM entries
         GROUP BY author_pubkey, service",
            (),
        )
        .await
        .context("reading local frontiers")?;

    rows.into_iter()
        .filter(|(_, svc, _, _)| include_private || !is_private_service(*svc as u32))
        .map(|(author_hex, svc, floor, head)| {
            let author = pubkey::decode(&author_hex)
                .ok_or_else(|| anyhow!("corrupt author pubkey in entries table"))?;
            Ok(Frontier {
                author,
                service: svc as u32,
                floor: floor as u64,
                head: head as u64,
            })
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
    let peer: HashMap<([u8; 32], u32), u64> = peer_frontiers
        .iter()
        .map(|f| ((f.author, f.service), f.head))
        .collect();

    let chains: Vec<(String, i64)> = db
        .fetch_all(
            "SELECT DISTINCT author_pubkey, service FROM entries ORDER BY service, author_pubkey",
            (),
        )
        .await
        .context("listing chains")?;

    let mut sent = 0u64;
    for (author_hex, svc) in chains {
        if !include_private && is_private_service(svc as u32) {
            continue;
        }
        let author = pubkey::decode(&author_hex)
            .ok_or_else(|| anyhow!("corrupt author pubkey in entries table"))?;
        let start = peer
            .get(&(author, svc as u32))
            .map(|head| head + 1)
            .unwrap_or(0);

        let rows: Vec<(Vec<u8>,)> = db
            .fetch_all(
                "SELECT bytes FROM entries
             WHERE author_pubkey = ?1 AND service = ?2 AND seq >= ?3 ORDER BY seq",
                (author_hex.as_str(), svc, start as i64),
            )
            .await
            .context("reading entries to send")?;

        for (bytes,) in rows {
            write_frame(send, &SyncMessage::Entry(bytes)).await?;
            sent += 1;
        }
    }
    Ok(sent)
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

    // Phase 2: proven-forgery eviction. A just-arrived revocation may disprove chains we
    // already stored (the attacker raced its forged prefix in ahead of the revoke); sweep
    // every ceiling against the store before deciding admissions.
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
            let (stored_now, refused, evicted) =
                admit_ceilinged_chain(db, &author, service::IDENTITY_PUBLIC, &c, &entries).await?;
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
            // content.
            _ => rejected += entries.len() as u64,
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
                admit_ceilinged_chain(db, &author, svc, &c, &entries).await?;
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
                            continue; // duplicate of something we hold
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

    Ok((received, rejected))
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
            continue; // sealed: the stored prefix is the anchored one
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

    let on_prefix: HashSet<[u8; 32]> = prefix.iter().map(|e| *e.hash()).collect();
    let refused = incoming
        .iter()
        .filter(|e| !on_prefix.contains(e.hash()))
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
    let (received, rejected) = ingest_batch(&db, root, incoming, peer_proven).await?;

    // Now send what the peer lacks - private chains only to a proven member.
    let sent = send_missing(&db, &peer_frontiers, &mut send, peer_proven).await?;
    write_frame(&mut send, &SyncMessage::Done).await?;
    send.finish().ok();
    conn.closed().await; // responder closes once it has ingested our stream

    // Entries landed; now the bodies they reference. Best-effort, never fails the exchange.
    let bodies_fetched =
        crate::record::documents::fetch_missing_bodies(state, root_hex, addr).await;

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

    // Serve only identities this node actually agents; anything else gets a polite empty
    // exchange (uniform behavior - we don't confirm what we do or don't hold).
    let agented = crate::identity::is_agented(&state.node_db, &root_hex)
        .await
        .map_err(|e| anyhow!("checking identity: {e}"))?;
    if !agented {
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
    conn.close(0u8.into(), b"done");
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
}
