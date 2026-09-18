//! The room lane (CHAT.md, slice 2): a room's messages, one chain per `(key, CHAT, room)`,
//! folded into a node memo and read back as the room's recent history.
//!
//! What lives here is everything the room lane needs beyond the post the room is:
//!
//! * **Saying.** A message is an entry on the speaker's own chain, on the room's instance -
//!   sealed under the room post's key when the room is sealed, so the words travel as
//!   ciphertext wherever the chain goes (ruling 3).
//! * **The memo.** `room_messages` in node.db, folded from every CHAT chain this node holds
//!   whenever a persona's chain moves - the sealed pair's "interleave at read" at any N.
//! * **The lane's gates.** Whether an exchange naming a room is one this node is in
//!   (`rooms_here`), and whether a dialer may hold a sealed room's chains
//!   (`instances_dialer_may_hold`) - the sync serve side asks both (ruling 4).
//! * **Reaching the room.** A participant's node pushes its chain to the creator's node,
//!   the directory of record; a reader asks that node who has spoken and pulls each
//!   participant's chain from it, one room-scoped exchange per participant (ruling 4).
//! * **The budget.** A node keeps the last ten thousand messages of a room, pruning each
//!   speaker's chain beneath that cut (ruling 6); the chains sync as suffixes.
//!
//! Messages arrive by sync alone, on the beat: slow, complete, honest. Live delivery is
//! slice 3's.
use anyhow::{anyhow, Context, Result};
use ringtome_proto::registry::{entry_type, service, ChatMessage};
use ringtome_proto::Payload;

use crate::db::Db;
use crate::error::AppError;
use crate::record::store::Store;
use crate::AppState;

/// The room budget (CHAT.md, ruling 6): the newest messages a node keeps of one room, over
/// every speaker's chain. No knob.
pub const ROOM_BUDGET: u64 = 10_000;

/// One room's page of history, as the door serves it.
pub const HISTORY_PAGE: i64 = 50;

/// The rooms a persona has opened lately are the ones its node keeps synced (`sync_pass`).
const OPEN_ROOM_TTL_MS: i64 = 60 * 60 * 1000;

fn room_budget() -> u64 {
    if std::env::var("RINGTOME_LOCAL_TEST").is_ok() {
        if let Some(n) = std::env::var("RINGTOME_TEST_ROOM_BUDGET").ok().and_then(|v| v.parse::<u64>().ok()) {
            return n.max(1);
        }
    }
    ROOM_BUDGET
}

/// One message as the history door serves it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Message {
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_avatar: Option<String>,
    pub leaf: String,
    pub seq: u64,
    pub said_ms: i64,
    /// The words - `None` for a sealed message this reader has no key for.
    pub words: Option<String>,
    pub hash: String,
}

// ---------------------------------------------------------------------------------------------
// The room post, as this node holds it

/// The room's header and the stamp of its current version: the user db when the author is
/// held here, the fragment store otherwise. `None` when the post is not held at all.
/// user-db open 1 of 2 (tests/conventions.rs): the room post's own header.
pub async fn room_head(state: &AppState, author_hex: &str, doc: &[u8; 16]) -> Option<(ringtome_proto::registry::DocHeaderPlain, i64)> {
    if let Ok(Some(db)) = state.user_dbs.get(author_hex).await {
        if let Ok(Some(entry)) = crate::record::documents::public_header_entry(&db, doc).await {
            if let Payload::Inline(payload) = &entry.entry().payload {
                if let Ok(h) = ringtome_proto::registry::DocHeaderPlain::decode(payload) {
                    return Some((h, entry.entry().timestamp_ms));
                }
            }
        }
    }
    let entry = crate::fragments::held_entry(&state.node_db, author_hex, &hex::encode(doc)).await.ok().flatten()?;
    let Payload::Inline(payload) = &entry.entry().payload else { return None };
    let h = ringtome_proto::registry::DocHeaderPlain::decode(payload).ok()?;
    Some((h, entry.entry().timestamp_ms))
}

/// Is this post a room this node holds?
async fn is_room(state: &AppState, author_hex: &str, doc: &[u8; 16]) -> bool {
    room_head(state, author_hex, doc)
        .await
        .is_some_and(|(h, _)| h.format == Some(ringtome_proto::registry::doc_format::ROOM))
}

/// The room a chain instance names, as this node knows it: the author of a hosted
/// persona's room post (the node shelf memo), else a room a hosted persona opened.
async fn room_author_of(node_db: &Db, instance: &[u8; 16]) -> Result<Option<String>> {
    let doc_hex = hex::encode(instance);
    if let Some(author) = crate::nodeshelf::room_author(node_db, &doc_hex).await? {
        return Ok(Some(author));
    }
    let row: Option<(String,)> = node_db
        .fetch_optional("SELECT room_author FROM rooms_open WHERE room_doc = ?1 LIMIT 1", (doc_hex,))
        .await
        .context("reading an open room's author")?;
    Ok(row.map(|(a,)| a))
}

/// Is ANY of these instances a room this node is in - a hosted persona's own, or one a
/// hosted persona opened? The sync serve side's lane gate (CHAT.md, ruling 4).
pub async fn rooms_here(state: &AppState, instances: &[[u8; 16]]) -> bool {
    for i in instances {
        if room_author_of(&state.node_db, i).await.ok().flatten().is_some() {
            return true;
        }
    }
    false
}

/// The instances a dialer may hold chains of: every open room; a sealed room only when
/// the dialing endpoint serves a persona the room's seal admits (CHAT.md, ruling 4 - the
/// room's door at the lane, judged as the key lane judges).
pub async fn instances_dialer_may_hold(state: &AppState, instances: &[[u8; 16]], dialer_hex: &str) -> Vec<[u8; 16]> {
    let mut out = Vec::with_capacity(instances.len());
    for i in instances {
        let Some(author) = room_author_of(&state.node_db, i).await.ok().flatten() else { continue };
        let Some((head, _)) = room_head(state, &author, i).await else { continue };
        if !head.trusted_only {
            out.push(*i);
            continue;
        }
        // Who the dialer serves, from the peer ledger; any one of them admitted opens the lane.
        let dialer = crate::net::sync::endpoint_to_id(dialer_hex);
        let served = crate::net::sync::roots_served_by(&state.node_db, &dialer).await.unwrap_or_default();
        let doc_hex = hex::encode(i);
        for root in served {
            if crate::idface::seal_admits(state, &author, &doc_hex, &root, None).await {
                out.push(*i);
                break;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------------------------
// Opening, saying, reading

/// Note that a hosted persona opened a room: the beat keeps it synced for a while.
pub async fn open_room(node_db: &Db, root_hex: &str, author_hex: &str, doc_hex: &str) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO rooms_open (root_pubkey, room_author, room_doc, opened_ms, synced_ms)
             VALUES (?1, ?2, ?3, ?4, 0)
             ON CONFLICT (root_pubkey, room_author, room_doc) DO UPDATE SET opened_ms = excluded.opened_ms",
            (root_hex, author_hex, doc_hex, crate::clock::now_ms()),
        )
        .await
        .context("noting an open room")?;
    Ok(())
}

/// Forget an opened room (the leave door).
pub async fn close_room(node_db: &Db, root_hex: &str, author_hex: &str, doc_hex: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM rooms_open WHERE root_pubkey = ?1 AND room_author = ?2 AND room_doc = ?3",
            (root_hex, author_hex, doc_hex),
        )
        .await
        .context("forgetting an open room")?;
    Ok(())
}

/// Is the room closed (CHAT.md, ruling 10 - the settled wish on the room post)? The stamp
/// of the version that closed it, so history minted after it stays unserved.
pub async fn closed_at(state: &AppState, author_hex: &str, doc: &[u8; 16]) -> Option<i64> {
    let (head, stamp) = room_head(state, author_hex, doc).await?;
    head.settled.then_some(stamp)
}

/// Say one thing in a room: the message on this persona's own chain, on the room's
/// instance, sealed under the room's key when the room is (CHAT.md, ruling 3). The door
/// has already admitted the speaker; this refuses a closed room (ruling 10), a room whose
/// key this node cannot get, and silence.
pub async fn say(
    state: &AppState,
    data: &Store,
    root_hex: &str,
    author_hex: &str,
    doc: &[u8; 16],
    words: &str,
) -> Result<(u64, i64), AppError> {
    let words = words.trim();
    if words.is_empty() {
        return Err(AppError::BadRequest(crate::msg!("chat.say-something", "say something")));
    }
    if words.len() > ChatMessage::MAX_BODY_BYTES {
        return Err(AppError::BadRequest(crate::msg!("chat.that-is-too-long-for-one-message", "that is too long for one message")));
    }
    let Some((head, _)) = room_head(state, author_hex, doc).await else {
        return Err(AppError::NotFound(crate::msg!("chat.no-such-room-is-held-here", "no such room is held here")));
    };
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return Err(AppError::BadRequest(crate::msg!("chat.that-post-is-not-a-room", "that post is not a room")));
    }
    if head.settled {
        return Err(AppError::BadRequest(crate::msg!("chat.this-room-is-closed", "this room is closed - the conversation ended, and the record stands")));
    }
    let author = crate::pubkey::decode(author_hex).ok_or_else(|| AppError::BadRequest(crate::msg!("chat.bad-room-author", "bad room author")))?;
    let (body, sealed) = if head.trusted_only {
        let Some(key) = crate::idface::key_for(state, author_hex, doc, root_hex, None).await else {
            return Err(AppError::Forbidden(crate::msg!("chat.the-rooms-key-hasnt-arrived", "the room's key hasn't arrived here - the words would be unreadable")));
        };
        (crate::record::private::seal_post_body(&key, words.as_bytes())?, true)
    } else {
        (words.as_bytes().to_vec(), false)
    };
    let payload = ChatMessage { room_author: author, body, sealed }
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding a chat message: {e}")))?;
    let signed = crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        service::CHAT,
        Some(*doc),
        entry_type::CHAT_MESSAGE,
        Payload::Inline(payload),
    )
    .await?;
    let seq = signed.entry().seq;
    let said_ms = signed.entry().timestamp_ms;
    // Fold it into the memo now - the speaker's own page shows the words at once - and
    // push the chain to the creator's node, the room's directory of record.
    crate::fold::nudge(state, root_hex);
    let push_state = state.clone();
    let (push_root, push_author, push_doc) = (root_hex.to_string(), author_hex.to_string(), *doc);
    tokio::spawn(async move {
        push_room(&push_state, &push_root, &push_author, &push_doc).await;
    });
    Ok((seq, said_ms))
}

/// The room's recent history, newest first, as this node holds it - every speaker's chain
/// interleaved by claimed time (CHAT.md, ruling 3). A sealed message opens with the key the
/// reader may have; a closed room serves nothing said after the close (ruling 10).
pub async fn history(
    state: &AppState,
    viewer_hex: &str,
    author_hex: &str,
    doc: &[u8; 16],
    before_ms: Option<i64>,
    limit: i64,
) -> Result<(Vec<Message>, bool), AppError> {
    let doc_hex = hex::encode(doc);
    let closed = closed_at(state, author_hex, doc).await;
    let limit = limit.clamp(1, HISTORY_PAGE);
    type Row = (String, String, i64, i64, Vec<u8>, Vec<u8>, i64);
    let before = before_ms.unwrap_or(i64::MAX);
    let ceiling = closed.map_or(before, |c| c.min(before));
    let rows: Vec<Row> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, speaker_leaf, seq, said_ms, entry_hash, body, sealed FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3
             ORDER BY said_ms DESC, seq DESC LIMIT ?4",
            (author_hex, doc_hex.as_str(), ceiling, limit),
        )
        .await
        .context("reading a room's history")
        .map_err(AppError::Internal)?;
    let needs_key = rows.iter().any(|r| r.6 != 0);
    let key = if needs_key { crate::idface::key_for(state, author_hex, doc, viewer_hex, None).await } else { None };
    let speakers: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &speakers).await.unwrap_or_default();
    let items = rows
        .into_iter()
        .map(|(speaker, leaf, seq, said_ms, hash, body, sealed)| {
            let words = if sealed != 0 {
                key.and_then(|k| crate::record::private::open_post_body(&body, &k))
                    .and_then(|b| String::from_utf8(b).ok())
            } else {
                String::from_utf8(body).ok()
            };
            let byline = bylines.get(&speaker);
            Message {
                speaker_name: byline.and_then(|b| b.name.clone()),
                speaker_avatar: byline.and_then(|b| b.avatar.clone()),
                speaker,
                leaf,
                seq: seq as u64,
                said_ms,
                words,
                hash: hex::encode(hash),
            }
        })
        .collect();
    Ok((items, closed.is_some()))
}

/// Who has spoken in a room, as this node holds their chains - the directory answer.
pub async fn participants(node_db: &Db, author_hex: &str, doc_hex: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT DISTINCT speaker_root FROM room_messages WHERE room_author = ?1 AND room_doc = ?2
             ORDER BY speaker_root LIMIT ?3",
            (author_hex, doc_hex, ringtome_proto::fragment::MAX_ROOM_PARTICIPANTS as i64),
        )
        .await
        .context("listing a room's speakers")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// The fragment lane's directory answer (CHAT.md, ruling 4): who has spoken here, to a
/// dialer the room admits - anyone for an open room; for a sealed one, a dialer serving
/// `for_root` with `for_root` admitted by the seal. "Nobody" and "not for you" alike.
pub async fn answer_room(
    state: &AppState,
    conn: &iroh::endpoint::Connection,
    author: &[u8; 32],
    doc: &[u8; 16],
    for_root: &[u8; 32],
) -> ringtome_proto::fragment::FragmentMessage {
    let empty = ringtome_proto::fragment::FragmentMessage::Room { participants: Vec::new() };
    let author_hex = hex::encode(author);
    let doc_hex = hex::encode(doc);
    let Some((head, _)) = room_head(state, &author_hex, doc).await else { return empty };
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return empty;
    }
    if head.trusted_only {
        let for_hex = hex::encode(for_root);
        if !crate::idface::seal_admits(state, &author_hex, &doc_hex, &for_hex, None).await {
            return empty;
        }
        let dialer = conn.remote_id().to_string();
        if !crate::net::sync::endpoint_serves_any(&state.node_db, &[for_hex], &dialer).await.unwrap_or(false) {
            return empty;
        }
    }
    let roots = participants(&state.node_db, &author_hex, &doc_hex).await.unwrap_or_default();
    let participants = roots.iter().filter_map(|r| crate::pubkey::decode(r)).collect();
    ringtome_proto::fragment::FragmentMessage::Room { participants }
}

// ---------------------------------------------------------------------------------------------
// The memo, folded from the chains

/// Fold one persona's CHAT chains into the memo (the fold lane's hook, on a CHAT move):
/// every message on every room chain this node holds of theirs, keyed by the chain and
/// its seq so a re-fold costs nothing new. Then the room budget (ruling 6).
/// user-db open 2 of 2 (tests/conventions.rs): one persona per CHAT-move edge.
pub async fn refresh_from(state: &AppState, root: &str, _force: bool) {
    if let Err(e) = refresh_inner(state, root).await {
        tracing::debug!(root = %root, error = ?e, "room memo refresh failed");
    }
}

async fn refresh_inner(state: &AppState, root: &str) -> Result<()> {
    let Some(db) = state.user_dbs.get(root).await? else { return Ok(()) };
    let entries = crate::record::imaol::chat_entries(&db).await.map_err(|e| anyhow!("{e}"))?;
    let now = crate::clock::now_ms();
    let mut rooms: std::collections::BTreeSet<(String, String)> = Default::default();
    for signed in &entries {
        let entry = signed.entry();
        let Some(instance) = entry.chain.instance else { continue };
        let Payload::Inline(payload) = &entry.payload else { continue };
        let Ok(msg) = ChatMessage::decode(payload) else { continue };
        let room_author = hex::encode(msg.room_author);
        let room_doc = hex::encode(instance);
        rooms.insert((room_author.clone(), room_doc.clone()));
        state
            .node_db
            .execute(
                "INSERT OR IGNORE INTO room_messages
                   (room_author, room_doc, speaker_root, speaker_leaf, seq, said_ms, entry_hash, body, sealed, noted_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                (
                    room_author.as_str(),
                    room_doc.as_str(),
                    root,
                    hex::encode(entry.chain.author),
                    entry.seq as i64,
                    entry.timestamp_ms,
                    signed.hash().to_vec(),
                    msg.body.clone(),
                    i64::from(msg.sealed),
                    now,
                ),
            )
            .await
            .context("noting a room message")?;
    }
    for (room_author, room_doc) in rooms {
        enforce_budget(state, &db, &room_author, &room_doc).await?;
    }
    Ok(())
}

/// The room budget (CHAT.md, ruling 6): keep the newest `ROOM_BUDGET` messages of a room,
/// prune each speaker's chain held HERE beneath the cut, and the memo rows with them.
async fn enforce_budget(state: &AppState, db: &Db, room_author: &str, room_doc: &str) -> Result<()> {
    let budget = room_budget() as i64;
    let cut: Option<(i64,)> = state
        .node_db
        .fetch_optional(
            "SELECT said_ms FROM room_messages WHERE room_author = ?1 AND room_doc = ?2
             ORDER BY said_ms DESC, seq DESC LIMIT 1 OFFSET ?3",
            (room_author, room_doc, budget),
        )
        .await
        .context("finding a room's budget cut")?;
    let Some((cut_ms,)) = cut else { return Ok(()) };
    // Every chain with rows at or beneath the cut: its floor is its first row above it.
    let chains: Vec<(String, i64)> = state
        .node_db
        .fetch_all(
            "SELECT speaker_leaf, MIN(seq) FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms > ?3 GROUP BY speaker_leaf",
            (room_author, room_doc, cut_ms),
        )
        .await
        .context("finding the chains' floors")?;
    let Ok(instance) = hex::decode(room_doc).map(|b| <[u8; 16]>::try_from(b.as_slice())) else { return Ok(()) };
    let Ok(instance) = instance else { return Ok(()) };
    for (leaf, floor) in chains {
        crate::record::imaol::prune_chain_below(db, &leaf, service::CHAT, Some(instance), floor as u64)
            .await
            .map_err(|e| anyhow!("{e}"))?;
    }
    state
        .node_db
        .execute(
            "DELETE FROM room_messages WHERE room_author = ?1 AND room_doc = ?2 AND said_ms <= ?3",
            (room_author, room_doc, cut_ms),
        )
        .await
        .context("pruning a room's memo beneath its budget")?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Reaching the room: the creator's node is the directory of record

/// The endpoints that serve the room's creator, in the order the key lane asks them.
async fn creator_endpoints(state: &AppState, author_hex: &str) -> Vec<String> {
    let mut endpoints: Vec<String> = Vec::new();
    if let Ok(Some((_, Some(via)))) = crate::idface::foreign_fetch_row(state, author_hex).await {
        endpoints.push(via);
    }
    for leaf in crate::idface::stored_tree_leaves(state, author_hex).await {
        let ep = crate::idface::leaf_via_to_endpoint(state, author_hex, &leaf).await;
        if ep != leaf && !endpoints.contains(&ep) {
            endpoints.push(ep);
        }
    }
    for ep in crate::net::sync::peers_for(&state.node_db, author_hex).await.unwrap_or_default() {
        if !endpoints.contains(&ep) {
            endpoints.push(ep);
        }
    }
    endpoints
}

/// Push this persona's room chain to the creator's node (a participant's half of ruling
/// 4): one room-scoped exchange, at the first creator endpoint that answers. Nothing to
/// push when the creator is hosted here - the chain is already where the directory reads.
pub async fn push_room(state: &AppState, root_hex: &str, author_hex: &str, doc: &[u8; 16]) {
    if crate::identity::is_hosted(&state.node_db, author_hex).await.unwrap_or(false) {
        return;
    }
    for endpoint in creator_endpoints(state, author_hex).await {
        let Ok(addr) = crate::net::sync::dial_addr(state, &endpoint).await else { continue };
        match crate::net::sync::sync_room_with_peer(state, root_hex, addr, *doc).await {
            Ok(stats) => {
                tracing::debug!(root = %root_hex, room = %hex::encode(doc), sent = stats.sent, "room chain pushed to the creator's node");
                return;
            }
            Err(e) => tracing::debug!(root = %root_hex, endpoint = %endpoint, error = ?e, "room push failed"),
        }
    }
}

/// Pull a room: ask the creator's node who has spoken, then pull each speaker's chain for
/// this room from it (the reader's half of ruling 4), and fold what landed. Returns how
/// many speakers' chains were exchanged.
pub async fn sync_room(state: &AppState, root_hex: &str, author_hex: &str, doc: &[u8; 16]) -> Result<usize> {
    let doc_hex = hex::encode(doc);
    let creator_here = crate::identity::is_hosted(&state.node_db, author_hex).await.unwrap_or(false);
    let for_root = crate::pubkey::decode(root_hex).ok_or_else(|| anyhow!("bad root"))?;
    let author = crate::pubkey::decode(author_hex).ok_or_else(|| anyhow!("bad room author"))?;
    let endpoints = if creator_here { Vec::new() } else { creator_endpoints(state, author_hex).await };
    // The directory: local when the creator is hosted here, else the first creator endpoint
    // that answers.
    let mut speakers: Vec<String> = if creator_here {
        participants(&state.node_db, author_hex, &doc_hex).await?
    } else {
        let mut found: Option<Vec<[u8; 32]>> = None;
        for endpoint in &endpoints {
            match crate::net::fragment::fetch_room(state, endpoint, &author, doc, &for_root).await {
                Ok(list) => {
                    found = Some(list);
                    break;
                }
                Err(e) => tracing::debug!(endpoint = %endpoint, error = ?e, "room directory ask failed"),
            }
        }
        found.unwrap_or_default().iter().map(hex::encode).collect()
    };
    if !speakers.contains(&author_hex.to_string()) {
        speakers.push(author_hex.to_string());
    }
    speakers.retain(|s| s != root_hex);
    let mut exchanged = 0usize;
    for speaker in speakers {
        if crate::identity::is_hosted(&state.node_db, &speaker).await.unwrap_or(false) {
            continue; // their chain is already here, whole
        }
        // The creator's node holds every speaker's chain (ruling 6); the speaker's own
        // nodes are the fallback.
        let mut candidates = endpoints.clone();
        for leaf in crate::idface::stored_tree_leaves(state, &speaker).await {
            let ep = crate::idface::leaf_via_to_endpoint(state, &speaker, &leaf).await;
            if ep != leaf && !candidates.contains(&ep) {
                candidates.push(ep);
            }
        }
        for endpoint in candidates {
            let Ok(addr) = crate::net::sync::dial_addr(state, &endpoint).await else { continue };
            match crate::net::sync::sync_room_with_peer(state, &speaker, addr, *doc).await {
                Ok(_) => {
                    exchanged += 1;
                    crate::fold::nudge(state, &speaker);
                    break;
                }
                Err(e) => tracing::debug!(speaker = %speaker, endpoint = %endpoint, error = ?e, "room pull failed"),
            }
        }
    }
    state
        .node_db
        .execute(
            "UPDATE rooms_open SET synced_ms = ?1 WHERE root_pubkey = ?2 AND room_author = ?3 AND room_doc = ?4",
            (crate::clock::now_ms(), root_hex, author_hex, doc_hex.as_str()),
        )
        .await
        .context("stamping a room sync")?;
    Ok(exchanged)
}

/// The beat: every room a hosted persona opened lately, pulled. Slow and bounded on
/// purpose - live is slice 3's.
pub async fn sync_pass(state: AppState) -> Result<()> {
    let since = crate::clock::now_ms() - OPEN_ROOM_TTL_MS;
    let rows: Vec<(String, String, String)> = state
        .node_db
        .fetch_all(
            "SELECT root_pubkey, room_author, room_doc FROM rooms_open WHERE opened_ms > ?1
             ORDER BY synced_ms ASC LIMIT 32",
            (since,),
        )
        .await
        .context("listing open rooms")?;
    for (root, author, doc_hex) in rows {
        let Ok(Ok(doc)) = hex::decode(&doc_hex).map(|b| <[u8; 16]>::try_from(b.as_slice())) else { continue };
        if !is_room(&state, &author, &doc).await {
            continue;
        }
        if let Err(e) = sync_room(&state, &root, &author, &doc).await {
            tracing::debug!(root = %root, room = %doc_hex, error = ?e, "room sync failed");
        }
    }
    Ok(())
}

/// The test beat's form: every room this persona opened, pulled now.
pub async fn sync_open_rooms(state: &AppState, root_hex: &str) -> Result<usize> {
    let rows: Vec<(String, String)> = state
        .node_db
        .fetch_all("SELECT room_author, room_doc FROM rooms_open WHERE root_pubkey = ?1", (root_hex,))
        .await
        .context("listing a persona's open rooms")?;
    let mut n = 0;
    for (author, doc_hex) in rows {
        let Ok(Ok(doc)) = hex::decode(&doc_hex).map(|b| <[u8; 16]>::try_from(b.as_slice())) else { continue };
        n += sync_room(state, root_hex, &author, &doc).await?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_budget_has_no_knob_outside_the_rig() {
        assert_eq!(ROOM_BUDGET, 10_000);
        assert!(room_budget() >= 1);
    }

    #[test]
    fn a_message_seals_and_opens_under_the_room_key() {
        let key = [9u8; 32];
        let sealed = crate::record::private::seal_post_body(&key, b"the quiet one").unwrap();
        let msg = ChatMessage { room_author: [1u8; 32], body: sealed, sealed: true };
        let back = ChatMessage::decode(&msg.encode().unwrap()).unwrap();
        assert_eq!(crate::record::private::open_post_body(&back.body, &key).unwrap(), b"the quiet one");
        assert!(crate::record::private::open_post_body(&back.body, &[8u8; 32]).is_none(), "the wrong key opens nothing");
    }
}
