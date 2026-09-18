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
//! Sync is the durable lane; the fold heals whatever the live lane dropped. **Live** (slice 3,
//! ruling 5) is iroh-gossip: one topic per room, its id derived from the room's key for a
//! sealed room and from the post for an open one, carrying the same signed entries the
//! chains carry - a message is appended to the speaker's chain first, then published on the
//! topic, and a receiving node verifies and folds it through the very gate sync uses.
//! Presence and typing are beacons on the same topic, ephemeral, never persisted.
use anyhow::{anyhow, Context, Result};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
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

/// The topic id's domain (CHAT.md, ruling 5): a sealed room's topic derives from its KEY,
/// so only key-holders can compute it; an open room's from the post's own name.
const TOPIC_DOMAIN: &[u8] = b"ringtome-chat/";

/// Frame kinds on a room's topic.
const FRAME_ENTRY: u8 = 0;
const FRAME_PRESENCE: u8 = 1;

/// How long a presence beacon counts as "here", and a typing beacon as typing.
const PRESENCE_TTL_MS: i64 = 30_000;
const TYPING_TTL_MS: i64 = 6_000;

/// What a room's live lane tells the sockets watching it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LiveEvent {
    /// A message landed in the memo - re-read the floor.
    Message,
    /// Who is here, or typing, changed.
    Presence,
}

struct Presence {
    seen_ms: i64,
    typing_ms: i64,
}

/// One room this node is live in.
pub struct RoomLive {
    room_author: String,
    /// The hosted persona whose entering joined the topic - whose door the receive path
    /// pulls missing speakers through.
    viewer_root: String,
    sender: tokio::sync::Mutex<iroh_gossip::api::GossipSender>,
    events: tokio::sync::broadcast::Sender<LiveEvent>,
    presence: Mutex<HashMap<String, Presence>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RoomLive {
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<LiveEvent> {
        self.events.subscribe()
    }

    /// Who is here and who is typing, right now.
    pub fn presence_now(&self) -> (Vec<String>, Vec<String>) {
        let now = crate::clock::now_ms();
        let map = self.presence.lock().expect("presence poisoned");
        let mut here: Vec<String> = map.iter().filter(|(_, p)| now - p.seen_ms < PRESENCE_TTL_MS).map(|(r, _)| r.clone()).collect();
        let mut typing: Vec<String> = map.iter().filter(|(_, p)| now - p.typing_ms < TYPING_TTL_MS).map(|(r, _)| r.clone()).collect();
        here.sort();
        typing.sort();
        (here, typing)
    }

    /// Note a beacon: `Some(true)` typing, `Some(false)` stopped, `None` a plain "still
    /// here" that leaves the typing state alone (a heartbeat mid-sentence must not clear it).
    fn note_presence(&self, root: &str, typing: Option<bool>) {
        let now = crate::clock::now_ms();
        let mut map = self.presence.lock().expect("presence poisoned");
        let p = map.entry(root.to_string()).or_insert(Presence { seen_ms: now, typing_ms: 0 });
        p.seen_ms = now;
        match typing {
            Some(true) => p.typing_ms = now,
            Some(false) => p.typing_ms = 0,
            None => {}
        }
    }
}

/// The topics this node is in, by room.
#[derive(Clone, Default)]
pub struct Live(Arc<Mutex<HashMap<[u8; 16], Arc<RoomLive>>>>);

impl Live {
    pub fn get(&self, doc: &[u8; 16]) -> Option<Arc<RoomLive>> {
        self.0.lock().expect("live rooms poisoned").get(doc).cloned()
    }
}

/// The room's topic id (ruling 5), for a viewer: `None` for a sealed room whose key this
/// node cannot get - no key, no topic, which is the whole point of deriving it so.
async fn topic_id(state: &AppState, author_hex: &str, doc: &[u8; 16], viewer_hex: &str, sealed: bool) -> Option<iroh_gossip::TopicId> {
    let mut hasher = blake3::Hasher::new();
    hasher.update(TOPIC_DOMAIN);
    if sealed {
        let key = crate::idface::key_for(state, author_hex, doc, viewer_hex, None).await?;
        hasher.update(&key);
    } else {
        hasher.update(author_hex.as_bytes());
        hasher.update(doc);
    }
    Some(iroh_gossip::TopicId::from_bytes(*hasher.finalize().as_bytes()))
}

/// Join a room's topic for a hosted persona, or hand back the join already standing. The
/// bootstrap is the creator's endpoints and every known speaker's - peers this node has
/// dialled on the room's lane, whose paths its endpoint remembers.
pub async fn join(state: &AppState, viewer_hex: &str, author_hex: &str, doc: &[u8; 16]) -> Result<Arc<RoomLive>> {
    if let Some(live) = state.live.get(doc) {
        return Ok(live);
    }
    let Some((head, _)) = room_head(state, author_hex, doc).await else {
        return Err(anyhow!("no such room is held here"));
    };
    let topic = topic_id(state, author_hex, doc, viewer_hex, head.trusted_only)
        .await
        .ok_or_else(|| anyhow!("the room's key hasn't arrived - no topic without it"))?;
    let doc_hex = hex::encode(doc);
    let mut bootstrap: Vec<String> = creator_endpoints(state, author_hex).await;
    for speaker in participants(&state.node_db, author_hex, &doc_hex).await.unwrap_or_default() {
        for leaf in crate::idface::stored_tree_leaves(state, &speaker).await {
            let ep = crate::idface::leaf_via_to_endpoint(state, &speaker, &leaf).await;
            if ep != leaf && !bootstrap.contains(&ep) {
                bootstrap.push(ep);
            }
        }
    }
    let ours = state.endpoint.id().to_string();
    let bootstrap: Vec<iroh::EndpointId> = bootstrap
        .iter()
        .filter(|e| **e != ours)
        .filter_map(|e| e.parse().ok())
        .collect();
    let sub = state
        .gossip
        .subscribe(topic, bootstrap)
        .await
        .map_err(|e| anyhow!("joining the room's topic: {e}"))?;
    let (sender, receiver) = sub.split();
    let (events, _) = tokio::sync::broadcast::channel(64);
    let live = Arc::new(RoomLive {
        room_author: author_hex.to_string(),
        viewer_root: viewer_hex.to_string(),
        sender: tokio::sync::Mutex::new(sender),
        events,
        presence: Mutex::new(HashMap::new()),
        task: Mutex::new(None),
    });
    let task = tokio::spawn(run_topic(state.clone(), *doc, receiver, live.clone()));
    *live.task.lock().expect("task poisoned") = Some(task);
    let mut map = state.live.0.lock().expect("live rooms poisoned");
    let live = map.entry(*doc).or_insert(live).clone();
    tracing::info!(room = %doc_hex, "joined the room's live lane");
    Ok(live)
}

/// Leave a room's topic: the task ends, the presence is forgotten.
pub fn leave_live(state: &AppState, doc: &[u8; 16]) {
    let removed = state.live.0.lock().expect("live rooms poisoned").remove(doc);
    if let Some(live) = removed {
        if let Some(task) = live.task.lock().expect("task poisoned").take() {
            task.abort();
        }
    }
}

/// The topic's receive loop: every frame verified and folded through the gate sync uses,
/// so the live lane can only ever hand the memo what a sync could have (ruling 5).
async fn run_topic(state: AppState, doc: [u8; 16], mut receiver: iroh_gossip::api::GossipReceiver, live: Arc<RoomLive>) {
    use n0_future::StreamExt;
    while let Some(event) = receiver.next().await {
        match event {
            Ok(iroh_gossip::api::Event::Received(msg)) => on_frame(&state, &doc, &msg.content, &live).await,
            Ok(iroh_gossip::api::Event::Lagged) => {
                // Dropped frames are the sync lane's to heal: pull the room now.
                let (viewer, author) = (live.viewer_root.clone(), live.room_author.clone());
                let state = state.clone();
                tokio::spawn(async move {
                    let _ = sync_room(&state, &viewer, &author, &doc).await;
                });
            }
            Ok(_) => {}
            Err(e) => {
                tracing::debug!(room = %hex::encode(doc), error = ?e, "the room's topic ended");
                break;
            }
        }
    }
}

async fn on_frame(state: &AppState, doc: &[u8; 16], frame: &[u8], live: &Arc<RoomLive>) {
    let Some((&kind, rest)) = frame.split_first() else { return };
    if rest.len() < 32 {
        return;
    }
    let (root, payload) = rest.split_at(32);
    let root_hex = hex::encode(root);
    match kind {
        FRAME_PRESENCE => {
            let typing = match payload.first() {
                Some(1) => Some(true),
                Some(0) => Some(false),
                _ => None,
            };
            live.note_presence(&root_hex, typing);
            let _ = live.events.send(LiveEvent::Presence);
        }
        FRAME_ENTRY => {
            let Ok(signed) = ringtome_proto::SignedEntry::decode(payload) else { return };
            let entry = signed.entry();
            if entry.chain.service != service::CHAT || entry.chain.instance != Some(*doc) || entry.entry_type != entry_type::CHAT_MESSAGE {
                return;
            }
            let Payload::Inline(bytes) = &entry.payload else { return };
            let Ok(msg) = ChatMessage::decode(bytes) else { return };
            if hex::encode(msg.room_author) != live.room_author {
                return;
            }
            live.note_presence(&root_hex, Some(false));
            ingest_live(state, &root_hex, payload.to_vec(), doc, live).await;
        }
        _ => {}
    }
}

/// A message off the topic, through the gate: the speaker's own database, their key tree,
/// the chain's link - the ingest sync runs. A speaker this node holds nothing of, or a gap
/// beneath the message, is the sync lane's to fill: pull the room and let the fold catch up.
async fn ingest_live(state: &AppState, root_hex: &str, bytes: Vec<u8>, doc: &[u8; 16], live: &Arc<RoomLive>) {
    let Some(root) = crate::pubkey::decode(root_hex) else { return };
    let held = state.user_dbs.get(root_hex).await.ok().flatten();
    let mut landed = false;
    if let Some(db) = held {
        let outcome = crate::net::sync::ingest_batch(
            &db,
            root,
            vec![bytes],
            false,
            Some(state.config.identity_chain_ceiling),
            Some(crate::net::sync::ROOM_SCOPE),
        )
        .await;
        landed = matches!(outcome, Ok(o) if o.received > 0);
    }
    if landed {
        crate::fold::fold_now(state, root_hex).await;
        let _ = live.events.send(LiveEvent::Message);
        return;
    }
    // Unknown speaker, or a link this node lacks: the durable lane heals it.
    let (viewer, author) = (live.viewer_root.clone(), live.room_author.clone());
    let state = state.clone();
    let doc = *doc;
    let events = live.events.clone();
    tokio::spawn(async move {
        if sync_room(&state, &viewer, &author, &doc).await.is_ok() {
            let _ = events.send(LiveEvent::Message);
        }
    });
}

fn entry_frame(root_hex: &str, bytes: &[u8]) -> Option<bytes::Bytes> {
    let root = crate::pubkey::decode(root_hex)?;
    let mut frame = Vec::with_capacity(1 + 32 + bytes.len());
    frame.push(FRAME_ENTRY);
    frame.extend_from_slice(&root);
    frame.extend_from_slice(bytes);
    Some(bytes::Bytes::from(frame))
}

/// Publish a just-appended message on the room's topic (ruling 5: append first, publish
/// after), and tell this node's own sockets.
pub async fn broadcast_entry(state: &AppState, doc: &[u8; 16], root_hex: &str, bytes: &[u8]) {
    let Some(live) = state.live.get(doc) else { return };
    live.note_presence(root_hex, Some(false));
    let _ = live.events.send(LiveEvent::Message);
    let Some(frame) = entry_frame(root_hex, bytes) else { return };
    let sender = live.sender.lock().await;
    if let Err(e) = sender.broadcast(frame).await {
        tracing::debug!(room = %hex::encode(doc), error = ?e, "publishing a message on the topic failed");
    }
}

/// A presence beacon: "I am here", and typing started, stopped, or unchanged (`None` - the
/// heartbeat), for the room's live peers and this node's own sockets.
pub async fn beacon(state: &AppState, doc: &[u8; 16], root_hex: &str, typing: Option<bool>) {
    let Some(live) = state.live.get(doc) else { return };
    live.note_presence(root_hex, typing);
    let _ = live.events.send(LiveEvent::Presence);
    let Some(root) = crate::pubkey::decode(root_hex) else { return };
    let mut frame = Vec::with_capacity(34);
    frame.push(FRAME_PRESENCE);
    frame.extend_from_slice(&root);
    frame.push(match typing {
        Some(true) => 1,
        Some(false) => 0,
        None => 2,
    });
    let sender = live.sender.lock().await;
    if let Err(e) = sender.broadcast(bytes::Bytes::from(frame)).await {
        tracing::debug!(room = %hex::encode(doc), error = ?e, "presence beacon failed");
    }
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
    // Fold it into the memo now - the speaker's own page shows the words at once - then
    // publish it on the room's topic (ruling 5: append first, publish after) and push the
    // chain to the creator's node, the room's directory of record.
    crate::fold::fold_now(state, root_hex).await;
    broadcast_entry(state, doc, root_hex, signed.bytes()).await;
    let push_state = state.clone();
    let (push_root, push_author, push_doc) = (root_hex.to_string(), author_hex.to_string(), *doc);
    tokio::spawn(async move {
        push_room(&push_state, &push_root, &push_author, &push_doc).await;
    });
    Ok((seq, said_ms))
}

/// Is this node the room's archivist (CHAT.md, ruling 6): the creator's node, which keeps its
/// own rooms whole without being asked, or one whose operator pressed full-sync?
pub async fn archivist_here(state: &AppState, author_hex: &str, doc_hex: &str) -> bool {
    if crate::identity::is_hosted(&state.node_db, author_hex).await.unwrap_or(false) {
        return true;
    }
    archived(&state.node_db, author_hex, doc_hex).await.unwrap_or(false)
}

/// The full-sync mark (ruling 6).
pub async fn archived(node_db: &Db, author_hex: &str, doc_hex: &str) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT since_ms FROM room_archives WHERE room_author = ?1 AND room_doc = ?2",
            (author_hex, doc_hex),
        )
        .await
        .context("reading a room's archive mark")?;
    Ok(row.is_some())
}

/// Press or release full-sync on a room (ruling 6): marked, the room is never pruned here;
/// released, the budget applies again on the next fold.
pub async fn set_archived(node_db: &Db, author_hex: &str, doc_hex: &str, on: bool) -> Result<()> {
    if on {
        node_db
            .execute(
                "INSERT OR IGNORE INTO room_archives (room_author, room_doc, since_ms) VALUES (?1, ?2, ?3)",
                (author_hex, doc_hex, crate::clock::now_ms()),
            )
            .await
            .context("marking a room archived")?;
    } else {
        node_db
            .execute(
                "DELETE FROM room_archives WHERE room_author = ?1 AND room_doc = ?2",
                (author_hex, doc_hex),
            )
            .await
            .context("releasing a room's archive mark")?;
    }
    Ok(())
}

/// The archive's answer (ruling 6): `(speaker root, signed entry)` for the room's messages
/// said before `before_ms`, newest first - the entries themselves off each speaker's chain
/// as this node holds it, for a dialer the room admits (the directory's own gate).
/// user-db open 4 of 5 (tests/conventions.rs): one per speaker on the page.
pub async fn answer_room_history(
    state: &AppState,
    conn: &iroh::endpoint::Connection,
    author: &[u8; 32],
    doc: &[u8; 16],
    for_root: &[u8; 32],
    before_ms: u64,
    limit: u64,
) -> Vec<([u8; 32], Vec<u8>)> {
    let author_hex = hex::encode(author);
    let doc_hex = hex::encode(doc);
    let Some((head, _)) = room_head(state, &author_hex, doc).await else { return Vec::new() };
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return Vec::new();
    }
    if head.trusted_only {
        let for_hex = hex::encode(for_root);
        if !crate::idface::seal_admits(state, &author_hex, &doc_hex, &for_hex, None).await {
            return Vec::new();
        }
        let dialer = conn.remote_id().to_string();
        if !crate::net::sync::endpoint_serves_any(&state.node_db, &[for_hex], &dialer).await.unwrap_or(false) {
            return Vec::new();
        }
    }
    let limit = limit.clamp(1, ringtome_proto::fragment::MAX_ROOM_HISTORY_LIMIT) as i64;
    let before = i64::try_from(before_ms).unwrap_or(i64::MAX);
    let rows: Vec<(String, Vec<u8>)> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, entry_hash FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3
             ORDER BY said_ms DESC, seq DESC LIMIT ?4",
            (author_hex.as_str(), doc_hex.as_str(), before, limit),
        )
        .await
        .unwrap_or_default();
    let mut out = Vec::with_capacity(rows.len());
    let mut dbs: HashMap<String, Db> = HashMap::new();
    for (speaker, hash) in rows {
        let Some(root) = crate::pubkey::decode(&speaker) else { continue };
        if !dbs.contains_key(&speaker) {
            match state.user_dbs.get(&speaker).await {
                Ok(Some(db)) => {
                    dbs.insert(speaker.clone(), db);
                }
                _ => continue,
            }
        }
        let Some(db) = dbs.get(&speaker) else { continue };
        let Ok(hash) = <[u8; 32]>::try_from(hash.as_slice()) else { continue };
        if let Ok(Some(entry)) = crate::record::imaol::entry_by_hash(db, &hash).await {
            out.push((root, entry.bytes().to_vec()));
        }
    }
    out
}

/// The reader's road to the archive (ruling 6): older messages than this node keeps, asked
/// of the creator's node, each entry verified here - the signature, the room it names -
/// and its attribution checked against the speaker's key tree as this node holds it; an
/// entry whose speaker this node knows nothing of is dropped, never shown on a stranger's
/// word. Served, not kept: the budget stays the budget.
/// user-db open 5 of 5 (tests/conventions.rs): the attribution check, one per speaker.
async fn archive_history(
    state: &AppState,
    viewer_hex: &str,
    author_hex: &str,
    doc: &[u8; 16],
    before_ms: i64,
    limit: i64,
) -> Vec<(String, ringtome_proto::SignedEntry)> {
    let Some(author) = crate::pubkey::decode(author_hex) else { return Vec::new() };
    let Some(for_root) = crate::pubkey::decode(viewer_hex) else { return Vec::new() };
    let mut fetched: Option<Vec<([u8; 32], Vec<u8>)>> = None;
    for endpoint in creator_endpoints(state, author_hex).await {
        match crate::net::fragment::fetch_room_history(state, &endpoint, &author, doc, &for_root, before_ms.max(0) as u64, limit as u64).await {
            Ok(items) => {
                fetched = Some(items);
                break;
            }
            Err(e) => tracing::debug!(endpoint = %endpoint, error = ?e, "room history ask failed"),
        }
    }
    let Some(items) = fetched else { return Vec::new() };
    let mut trees: HashMap<String, Option<ringtome_proto::Crown>> = HashMap::new();
    let mut out = Vec::with_capacity(items.len());
    for (root, bytes) in items {
        let root_hex = hex::encode(root);
        let Ok(signed) = ringtome_proto::SignedEntry::decode(&bytes) else { continue };
        if signed.verify().is_err() {
            continue;
        }
        let entry = signed.entry();
        if entry.chain.service != service::CHAT || entry.chain.instance != Some(*doc) || entry.entry_type != entry_type::CHAT_MESSAGE {
            continue;
        }
        let Payload::Inline(payload) = &entry.payload else { continue };
        let Ok(msg) = ChatMessage::decode(payload) else { continue };
        if msg.room_author != author {
            continue;
        }
        if !trees.contains_key(&root_hex) {
            let tree = match state.user_dbs.get(&root_hex).await {
                Ok(Some(db)) => crate::record::imaol::load_key_tree(&db, &root_hex).await.ok(),
                _ => None,
            };
            trees.insert(root_hex.clone(), tree);
        }
        let Some(Some(tree)) = trees.get(&root_hex) else { continue };
        if tree.status(&entry.chain.author) != ringtome_proto::KeyStatus::Active {
            continue;
        }
        out.push((root_hex, signed));
    }
    out
}

/// The room's recent history, newest first, as this node holds it - every speaker's chain
/// interleaved by claimed time (CHAT.md, ruling 3). A sealed message opens with the key the
/// reader may have; a closed room serves nothing said after the close (ruling 10). When
/// this node keeps only the budget and the page runs past it, the archive fills the rest
/// (ruling 6). Returns the page, whether the room is closed, and whether more may lie
/// beneath it.
pub async fn history(
    state: &AppState,
    viewer_hex: &str,
    author_hex: &str,
    doc: &[u8; 16],
    before_ms: Option<i64>,
    limit: i64,
) -> Result<(Vec<Message>, bool, bool), AppError> {
    let doc_hex = hex::encode(doc);
    let closed = closed_at(state, author_hex, doc).await;
    let limit = limit.clamp(1, HISTORY_PAGE);
    type Row = (String, String, i64, i64, Vec<u8>, Vec<u8>, i64);
    let before = before_ms.unwrap_or(i64::MAX);
    let ceiling = closed.map_or(before, |c| c.min(before));
    let mut rows: Vec<Row> = state
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
    // Past what this node keeps: the archive (ruling 6). Asked only when the local page
    // came up short and this node is not the archivist itself.
    let mut more = rows.len() as i64 >= limit;
    if (rows.len() as i64) < limit && !archivist_here(state, author_hex, &doc_hex).await {
        let oldest = rows.last().map(|r| r.3).unwrap_or(ceiling);
        let want = limit - rows.len() as i64;
        let held: std::collections::HashSet<Vec<u8>> = rows.iter().map(|r| r.4.clone()).collect();
        let archived = archive_history(state, viewer_hex, author_hex, doc, oldest, want).await;
        more = archived.len() as i64 >= want;
        for (root, signed) in archived {
            if held.contains(signed.hash().as_slice()) {
                continue;
            }
            let entry = signed.entry();
            let Payload::Inline(payload) = &entry.payload else { continue };
            let Ok(msg) = ChatMessage::decode(payload) else { continue };
            if entry.timestamp_ms >= ceiling {
                continue;
            }
            rows.push((root, hex::encode(entry.chain.author), entry.seq as i64, entry.timestamp_ms, signed.hash().to_vec(), msg.body, i64::from(msg.sealed)));
        }
        rows.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| b.2.cmp(&a.2)));
    }
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
    Ok((items, closed.is_some(), more))
}

/// When each room this node holds last heard a message: `(room_author, room_doc) ->
/// said_ms` - what the chats column sorts and bolds by (Curtis, 2026-09-18).
pub async fn latest_by_room(node_db: &Db) -> Result<HashMap<(String, String), i64>> {
    let rows: Vec<(String, String, i64)> = node_db
        .fetch_all(
            "SELECT room_author, room_doc, MAX(said_ms) FROM room_messages GROUP BY room_author, room_doc",
            (),
        )
        .await
        .context("reading each room's latest message")?;
    Ok(rows.into_iter().map(|(a, d, ms)| ((a, d), ms)).collect())
}

/// The chatters (Curtis, 2026-09-18): everyone who has visibly spoken in a room as this
/// node holds it, newest speaker first, each with when they last spoke. Nobody is "in" a
/// room - people are here-and-typing, or unseen - so this is the room's only roster.
pub async fn chatters(node_db: &Db, author_hex: &str, doc_hex: &str) -> Result<Vec<(String, i64)>> {
    let rows: Vec<(String, i64)> = node_db
        .fetch_all(
            "SELECT speaker_root, MAX(said_ms) AS last_ms FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2
             GROUP BY speaker_root ORDER BY last_ms DESC LIMIT ?3",
            (author_hex, doc_hex, ringtome_proto::fragment::MAX_ROOM_PARTICIPANTS as i64),
        )
        .await
        .context("listing a room's chatters")?;
    Ok(rows)
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
/// user-db open 2 of 5 (tests/conventions.rs): one persona per CHAT-move edge.
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
    let mut pruned = false;
    for (room_author, room_doc) in rooms {
        pruned |= enforce_budget(state, &db, &room_author, &room_doc).await?;
    }
    // A prune moved a chain's FLOOR, which the frontier memo never raises on its own (it
    // heals on the sweep's beat): reconcile now, so the next Hello claims the true floor
    // and the archive can plan a backfill beneath it (ruling 6 - the full-sync pull).
    if pruned {
        if let Err(e) = crate::net::frontier::reconcile_from_entries(state, root).await {
            tracing::debug!(root = %root, error = ?e, "floor reconcile after a room prune failed");
        }
    }
    Ok(())
}

/// The room budget (CHAT.md, ruling 6): keep the newest `ROOM_BUDGET` messages of a room,
/// prune each speaker's chain held HERE beneath the cut, and the memo rows with them.
/// Answers whether anything was pruned.
async fn enforce_budget(state: &AppState, db: &Db, room_author: &str, room_doc: &str) -> Result<bool> {
    // The archivist keeps the room whole (ruling 6): the creator's node, or a node whose
    // operator pressed full-sync.
    if archivist_here(state, room_author, room_doc).await {
        return Ok(false);
    }
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
    let Some((cut_ms,)) = cut else { return Ok(false) };
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
    let Ok(instance) = hex::decode(room_doc).map(|b| <[u8; 16]>::try_from(b.as_slice())) else { return Ok(false) };
    let Ok(instance) = instance else { return Ok(false) };
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
    Ok(true)
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
    let mut landed = false;
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
                Ok(stats) => {
                    exchanged += 1;
                    // Awaited, so the door's answer means the floor is current (a page that
                    // read right after the pull found nothing, 2026-09-18).
                    crate::fold::fold_now(state, &speaker).await;
                    if stats.received > 0 {
                        landed = true;
                    }
                    break;
                }
                Err(e) => tracing::debug!(speaker = %speaker, endpoint = %endpoint, error = ?e, "room pull failed"),
            }
        }
    }
    // What the durable lane brought is news to the sockets too.
    if landed {
        if let Some(live) = state.live.get(doc) {
            let _ = live.events.send(LiveEvent::Message);
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

/// The full-sync pull (ruling 6): every speaker's chain walked down from this node's floor
/// to its beginning, a budget's worth per exchange, from the creator's node - the room held
/// whole from then on, with the archive mark keeping it so. Bounded rounds; the beat's
/// ordinary pull keeps the top current afterwards.
pub async fn archive_pull(state: &AppState, root_hex: &str, author_hex: &str, doc: &[u8; 16]) -> Result<usize> {
    let for_root = crate::pubkey::decode(root_hex).ok_or_else(|| anyhow!("bad root"))?;
    let author = crate::pubkey::decode(author_hex).ok_or_else(|| anyhow!("bad room author"))?;
    let endpoints = creator_endpoints(state, author_hex).await;
    let mut speakers: Vec<String> = Vec::new();
    for endpoint in &endpoints {
        if let Ok(list) = crate::net::fragment::fetch_room(state, endpoint, &author, doc, &for_root).await {
            speakers = list.iter().map(hex::encode).collect();
            break;
        }
    }
    if !speakers.contains(&author_hex.to_string()) {
        speakers.push(author_hex.to_string());
    }
    let ask = crate::net::sync::Ask { ceiling: 0, below: ROOM_BUDGET };
    let mut pulled = 0usize;
    for speaker in speakers {
        if crate::identity::is_hosted(&state.node_db, &speaker).await.unwrap_or(false) {
            continue;
        }
        for _round in 0..64 {
            let mut received = 0u64;
            for endpoint in &endpoints {
                let Ok(addr) = crate::net::sync::dial_addr(state, endpoint).await else { continue };
                match crate::net::sync::sync_with_peer_asking(state, &speaker, addr, crate::net::sync::ROOM_SCOPE, &[*doc], ask).await {
                    Ok(stats) => {
                        received = stats.received;
                        break;
                    }
                    Err(e) => tracing::debug!(speaker = %speaker, endpoint = %endpoint, error = ?e, "archive pull failed"),
                }
            }
            if received == 0 {
                break;
            }
            pulled += received as usize;
        }
        // Forced: a backfill moves the chain's floor, not its head, and the ordinary fold's
        // change gate watches heads.
        crate::fold::fold_now_forced(state, &speaker).await;
    }
    Ok(pulled)
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
