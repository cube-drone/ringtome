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

use std::collections::{BTreeMap, HashMap};

use anyhow::{anyhow, bail, Context, Result};
use iroh::endpoint::{Connection, SendStream};
use iroh::EndpointAddr;
use ringtome_proto::keytree::KeyStatus;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::sync::{Frontier, MemberProof, SyncMessage};
use ringtome_proto::{validate_next, KeyTree, SignedEntry};
use sqlx::SqlitePool;

use crate::clock::now_ms;
use crate::p2p::{read_frame, write_frame};
use crate::pubkey;
use crate::AppState;

/// Outcome of one exchange, for logs and API responses.
#[derive(Debug, Default, serde::Serialize)]
pub struct ExchangeStats {
    pub received: u64,
    pub rejected: u64,
    pub sent: u64,
}

/// Services that never cross the identity boundary: synced only between an identity's own
/// (member-proven) nodes. Everything about them is withheld from strangers - the entries, the
/// frontiers, even the count of chains (the *timing and volume* of private activity is itself
/// private metadata; PROJECT_PLAN, Chains).
fn is_private_service(svc: u32) -> bool {
    svc == service::IDENTITY_PRIVATE || svc == service::PRIVATE
}

/// This identity's held ranges, one per stored chain. Private chains appear only when the peer
/// has proven membership.
pub async fn local_frontiers(db: &SqlitePool, include_private: bool) -> Result<Vec<Frontier>> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT author_pubkey, service, MIN(seq), MAX(seq) FROM entries
         GROUP BY author_pubkey, service",
    )
    .fetch_all(db)
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
    db: &SqlitePool,
    peer_frontiers: &[Frontier],
    send: &mut SendStream,
    include_private: bool,
) -> Result<u64> {
    let peer: HashMap<([u8; 32], u32), u64> = peer_frontiers
        .iter()
        .map(|f| ((f.author, f.service), f.head))
        .collect();

    let chains: Vec<(String, i64)> = sqlx::query_as(
        "SELECT DISTINCT author_pubkey, service FROM entries ORDER BY service, author_pubkey",
    )
    .fetch_all(db)
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

        let rows: Vec<(Vec<u8>,)> = sqlx::query_as(
            "SELECT bytes FROM entries
             WHERE author_pubkey = ?1 AND service = ?2 AND seq >= ?3 ORDER BY seq",
        )
        .bind(&author_hex)
        .bind(svc)
        .bind(start as i64)
        .fetch_all(db)
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
/// author lands in the resolved key tree; content entries additionally require an Active (or
/// Retired, within-ceiling) author. Rejections are counted, logged, and never stored - a
/// rejected entry simply does not exist as far as this node's views are concerned.
///
/// `peer_proven`: whether the sending peer proved membership. Private-chain entries from an
/// unproven peer are rejected outright - an honest stranger never sends them (we withheld those
/// frontiers), so their arrival is either a bug or a probe, and either way the answer is no.
async fn ingest_batch(
    db: &SqlitePool,
    root: [u8; 32],
    raw: Vec<Vec<u8>>,
    peer_proven: bool,
) -> Result<(u64, u64)> {
    let mut rejected = 0u64;

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

    // Phase 1: structurally admit identity entries (contiguity from stored heads), per author,
    // in seq order - but hold them aside until the tree pass approves their authors.
    let stored_identity = load_identity_entries(db).await?;
    let mut stored_heads: BTreeMap<[u8; 32], SignedEntry> = BTreeMap::new();
    for e in &stored_identity {
        stored_heads.insert(e.entry().chain.author, e.clone()); // ascending order: last wins
    }

    identity_candidates.sort_by_key(|e| (e.entry().chain.author, e.entry().seq));
    let mut admitted_identity: Vec<SignedEntry> = Vec::new();
    let mut head_cursor = stored_heads.clone();
    for e in identity_candidates {
        let author = e.entry().chain.author;
        let prev = head_cursor.get(&author);
        // Already held? (Peer resent below our head.) Skip silently.
        if let Some(p) = prev {
            if e.entry().seq <= p.entry().seq {
                continue;
            }
        }
        match validate_next(prev, &e) {
            Ok(()) => {
                head_cursor.insert(author, e.clone());
                admitted_identity.push(e);
            }
            Err(_) => rejected += 1,
        }
    }

    // Phase 2: resolve the tree over stored + admitted, then drop admitted entries whose author
    // never became a member (a stranger's self-consistent chain is still a stranger's chain),
    // or whose seq lies beyond the author's identity-chain ceiling.
    let mut tree_input = stored_identity.clone();
    tree_input.extend(admitted_identity.iter().cloned());
    let tree = KeyTree::build(root, &tree_input)
        .map_err(|e| anyhow!("key tree resolution during ingest: {e}"))?;

    let mut received = 0u64;
    for e in &admitted_identity {
        let author = e.entry().chain.author;
        if tree.status(&author) == KeyStatus::Unknown {
            rejected += 1;
            continue;
        }
        if let Some(c) = tree.ceiling(&author, service::IDENTITY_PUBLIC) {
            if e.entry().seq > c.final_seq {
                rejected += 1;
                continue;
            }
        }
        store_entry(db, e).await?;
        received += 1;
    }

    // Phase 3: content entries, gated by the (now-updated) tree: member author in good standing,
    // within any ceiling, contiguous with our stored head.
    content_candidates.sort_by_key(|e| {
        (
            e.entry().chain.author,
            e.entry().chain.service,
            e.entry().seq,
        )
    });
    let mut content_heads: BTreeMap<([u8; 32], u32), SignedEntry> = BTreeMap::new();
    for e in content_candidates {
        let author = e.entry().chain.author;
        let svc = e.entry().chain.service;

        // Active keys write freely; retired/repudiated keys' *anchored history* is honored
        // (that's what the anchors are for) but anything beyond an anchor - or on a chain the
        // revocation didn't anchor at all - is refused.
        let allowed = match tree.status(&author) {
            KeyStatus::Active => tree
                .ceiling(&author, svc)
                .is_none_or(|c| e.entry().seq <= c.final_seq),
            KeyStatus::Retired | KeyStatus::Repudiated => tree
                .ceiling(&author, svc)
                .is_some_and(|c| e.entry().seq <= c.final_seq),
            KeyStatus::Invalid | KeyStatus::Unknown => false,
        };
        if !allowed {
            rejected += 1;
            continue;
        }

        let prev = match content_heads.get(&(author, svc)) {
            Some(p) => Some(p.clone()),
            None => stored_chain_head(db, &author, svc).await?,
        };
        if let Some(p) = &prev {
            if e.entry().seq <= p.entry().seq {
                continue; // duplicate of something we hold
            }
        }
        match validate_next(prev.as_ref(), &e) {
            Ok(()) => {
                store_entry(db, &e).await?;
                apply_content_views(db, &e).await?;
                content_heads.insert((author, svc), e);
                received += 1;
            }
            Err(_) => rejected += 1,
        }
    }

    Ok((received, rejected))
}

async fn load_identity_entries(db: &SqlitePool) -> Result<Vec<SignedEntry>> {
    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT bytes FROM entries WHERE service = ?1 ORDER BY author_pubkey, seq")
            .bind(i64::from(service::IDENTITY_PUBLIC))
            .fetch_all(db)
            .await
            .context("loading identity chains")?;
    rows.into_iter()
        .map(|(b,)| SignedEntry::decode(&b).map_err(|e| anyhow!("stored entry fails decode: {e}")))
        .collect()
}

async fn stored_chain_head(
    db: &SqlitePool,
    author: &[u8; 32],
    svc: u32,
) -> Result<Option<SignedEntry>> {
    let row: Option<(Vec<u8>,)> = sqlx::query_as(
        "SELECT bytes FROM entries WHERE author_pubkey = ?1 AND service = ?2
         ORDER BY seq DESC LIMIT 1",
    )
    .bind(hex::encode(author))
    .bind(i64::from(svc))
    .fetch_optional(db)
    .await
    .context("reading stored chain head")?;
    row.map(|(b,)| SignedEntry::decode(&b).map_err(|e| anyhow!("stored entry fails decode: {e}")))
        .transpose()
}

async fn store_entry(db: &SqlitePool, e: &SignedEntry) -> Result<()> {
    sqlx::query(
        "INSERT INTO entries
           (author_pubkey, service, seq, entry_hash, prev_hash, entry_type, timestamp_ms,
            received_at_ms, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )
    .bind(hex::encode(e.entry().chain.author))
    .bind(i64::from(e.entry().chain.service))
    .bind(e.entry().seq as i64)
    .bind(e.hash().as_slice())
    .bind(e.entry().prev_hash.as_slice())
    .bind(i64::from(e.entry().entry_type))
    .bind(e.entry().timestamp_ms)
    .bind(now_ms())
    .bind(e.bytes())
    .execute(db)
    .await
    .context("storing synced entry")?;
    Ok(())
}

/// Fold a freshly-admitted content entry into the materialized views.
async fn apply_content_views(db: &SqlitePool, e: &SignedEntry) -> Result<()> {
    if e.entry().chain.service == service::PROFILE
        && e.entry().entry_type == entry_type::PROFILE_SET
    {
        crate::imaol::apply_profile_set(db, e)
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
    db: &SqlitePool,
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
    match crate::imaol::load_key_tree(db, &hex::encode(root)).await {
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
        .connect(addr, ringtome_proto::sync::SYNC_ALPN)
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

    Ok(ExchangeStats {
        received,
        rejected,
        sent,
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
pub async fn add_peer(node_db: &SqlitePool, root_hex: &str, endpoint_id: &str) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO identity_peers (root_pubkey, endpoint_id, added_at_ms)
         VALUES (?1, ?2, ?3)",
    )
    .bind(root_hex)
    .bind(endpoint_id)
    .bind(now_ms())
    .execute(node_db)
    .await
    .context("recording peer")?;
    Ok(())
}

/// Known peer endpoint ids for an identity.
pub async fn peers_for(node_db: &SqlitePool, root_hex: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT endpoint_id FROM identity_peers WHERE root_pubkey = ?1")
            .bind(root_hex)
            .fetch_all(node_db)
            .await
            .context("listing peers")?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
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

pub async fn mark_synced(node_db: &SqlitePool, root_hex: &str, endpoint_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE identity_peers SET last_synced_ms = ?1 WHERE root_pubkey = ?2 AND endpoint_id = ?3",
    )
    .bind(now_ms())
    .bind(root_hex)
    .bind(endpoint_id)
    .execute(node_db)
    .await
    .context("marking peer synced")?;
    Ok(())
}
