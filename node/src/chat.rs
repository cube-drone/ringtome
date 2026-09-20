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
        let key = room_key(state, author_hex, doc, viewer_hex).await?;
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
    /// The emoji said in answer to this line (CHAT.md, slice 9), most first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub reactions: Vec<Reaction>,
    /// The words are a later edit's (slice 8).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub edited: bool,
    /// A moderation act, said in the room (ruling 8): `"muted"` or `"unmuted"`, and whom.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice_subject: Option<String>,
}

/// One stack of emoji under a line: the shortcode, how many said it, and who.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Reaction {
    pub emoji: String,
    pub count: usize,
    pub who: Vec<Reactor>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Reactor {
    pub root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// This persona's standing reactions with `emoji` on `target`, by entry hash - every one a
/// take-back must name, since the stack counts a person once however often they said it.
/// Sealed bodies open with the room's key.
async fn my_reactions(state: &AppState, root_hex: &str, author_hex: &str, doc: &[u8; 16], target: &[u8; 32], emoji: &str) -> Result<Vec<[u8; 32]>, AppError> {
    let rows: Vec<(Vec<u8>, Vec<u8>, i64)> = state
        .node_db
        .fetch_all(
            "SELECT entry_hash, body, sealed FROM room_reactions
             WHERE room_author = ?1 AND room_doc = ?2 AND target_hash = ?3 AND speaker_root = ?4 AND withdrawn = 0
             ORDER BY said_ms DESC, seq DESC",
            (author_hex, hex::encode(doc), target.to_vec(), root_hex),
        )
        .await
        .context("reading a persona's own reactions")
        .map_err(AppError::Internal)?;
    let needs_key = rows.iter().any(|r| r.2 != 0);
    let key = if needs_key { room_key(state, author_hex, doc, root_hex).await } else { None };
    let mut mine = Vec::new();
    for (hash, body, sealed) in rows {
        let said = if sealed != 0 {
            key.and_then(|k| crate::record::private::open_post_body(&body, &k)).and_then(|b| String::from_utf8(b).ok())
        } else {
            String::from_utf8(body).ok()
        };
        if said.as_deref() == Some(emoji) {
            if let Ok(h) = <[u8; 32]>::try_from(hash.as_slice()) {
                mine.push(h);
            }
        }
    }
    Ok(mine)
}

/// A reaction's body: one emoji shortcode, as the picker writes it.
fn is_shortcode(words: &str) -> bool {
    let inner = words.strip_prefix(':').and_then(|w| w.strip_suffix(':'));
    matches!(inner, Some(i) if !i.is_empty() && i.len() <= 48 && i.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'+' || b == b'-'))
}

/// The emoji stacked under each of `targets` (CHAT.md, slice 9): the memo's rows plus any
/// the archive handed over, one per person per emoji however often they said it, opened
/// with the room's key when sealed, most-said first. Names off the bylines memo.
async fn stack_reactions(
    state: &AppState,
    author_hex: &str,
    doc_hex: &str,
    targets: &[Vec<u8>],
    extra: Vec<(Vec<u8>, String, Vec<u8>, i64)>,
    key: Option<[u8; 32]>,
) -> HashMap<String, Vec<Reaction>> {
    let mut raw: Vec<(Vec<u8>, String, Vec<u8>, i64)> = extra;
    for chunk in targets.chunks(200) {
        let marks: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 3)).collect();
        let sql = format!(
            "SELECT target_hash, speaker_root, body, sealed FROM room_reactions
             WHERE room_author = ?1 AND room_doc = ?2 AND withdrawn = 0 AND target_hash IN ({})",
            marks.join(",")
        );
        let mut params: Vec<turso::Value> = vec![turso::Value::Text(author_hex.to_string()), turso::Value::Text(doc_hex.to_string())];
        params.extend(chunk.iter().map(|h| turso::Value::Blob(h.clone())));
        if let Ok(rows) = state.node_db.fetch_all::<(Vec<u8>, String, Vec<u8>, i64)>(&sql, params).await {
            raw.extend(rows);
        }
    }
    // (target, emoji) -> the people, each once.
    let mut stacks: HashMap<String, Vec<(String, Vec<String>)>> = HashMap::new();
    for (target, speaker, body, sealed) in raw {
        let emoji = if sealed != 0 {
            key.and_then(|k| crate::record::private::open_post_body(&body, &k)).and_then(|b| String::from_utf8(b).ok())
        } else {
            String::from_utf8(body).ok()
        };
        let Some(emoji) = emoji.filter(|e| is_shortcode(e)) else { continue };
        let per_target = stacks.entry(hex::encode(target)).or_default();
        match per_target.iter_mut().find(|(e, _)| *e == emoji) {
            Some((_, who)) => {
                if !who.contains(&speaker) {
                    who.push(speaker);
                }
            }
            None => per_target.push((emoji, vec![speaker])),
        }
    }
    let everyone: Vec<String> = stacks.values().flat_map(|v| v.iter().flat_map(|(_, who)| who.iter().cloned())).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &everyone).await.unwrap_or_default();
    stacks
        .into_iter()
        .map(|(target, mut per)| {
            per.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
            let stacked = per
                .into_iter()
                .map(|(emoji, who)| Reaction {
                    count: who.len(),
                    who: who
                        .into_iter()
                        .map(|root| Reactor { name: bylines.get(&root).and_then(|b| b.name.clone()), root })
                        .collect(),
                    emoji,
                })
                .collect();
            (target, stacked)
        })
        .collect()
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

/// A proof of the key for each room named whose key this node holds (CHAT.md; Curtis,
/// 2026-09-20): what the dialer shows a sealed room's door instead of a persona.
pub async fn key_proofs_for(
    state: &AppState,
    instances: &[[u8; 16]],
    our_endpoint: &[u8; 32],
    peer_endpoint: &[u8; 32],
) -> Vec<([u8; 16], [u8; 32])> {
    let mut out = Vec::new();
    for i in instances {
        let Some(key) = held_room_key(state, i).await else { continue };
        out.push((*i, ringtome_proto::sync::room_key_proof(&key, i, our_endpoint, peer_endpoint)));
    }
    out
}

/// A sealed room's door on the fragment lane: the asker's persona must be admitted by the
/// seal and served by the dialing endpoint - or, for a room its author marked onward, the
/// dialer may show the room's key instead (Curtis, 2026-09-20).
async fn fragment_door_admits(
    state: &AppState,
    conn: &iroh::endpoint::Connection,
    head: &ringtome_proto::registry::DocHeaderPlain,
    author_hex: &str,
    doc: &[u8; 16],
    for_root: &[u8; 32],
    key_proof: Option<[u8; 32]>,
) -> bool {
    if !head.trusted_only {
        return true;
    }
    let doc_hex = hex::encode(doc);
    let peer: [u8; 32] = *conn.remote_id().as_bytes();
    if head.onward {
        if let (Some(proof), Some(key)) = (key_proof, held_room_key(state, doc).await) {
            let ours: [u8; 32] = *state.endpoint.id().as_bytes();
            if proof_shows_key(&key, doc, &[(*doc, proof)], &peer, &ours) {
                return true;
            }
        }
    }
    let for_hex = hex::encode(for_root);
    if !crate::idface::seal_admits(state, author_hex, &doc_hex, &for_hex, None).await {
        return false;
    }
    crate::net::sync::endpoint_serves_any(&state.node_db, &[for_hex], &conn.remote_id().to_string())
        .await
        .unwrap_or(false)
}

/// One room's key proof for a fragment-lane ask (Curtis, 2026-09-20): the same keyed hash
/// the Hello carries, bound to this connection's two endpoints.
pub async fn key_proof_for(state: &AppState, instance: &[u8; 16], peer_endpoint: &[u8; 32]) -> Option<[u8; 32]> {
    let key = held_room_key(state, instance).await?;
    let ours: [u8; 32] = *state.endpoint.id().as_bytes();
    Some(ringtome_proto::sync::room_key_proof(&key, instance, &ours, peer_endpoint))
}

/// The key this node holds for a room, by instance: the room post's key, in the node's key
/// ring, whoever put it there - the author's own node at the mint, or the key lane.
async fn held_room_key(state: &AppState, instance: &[u8; 16]) -> Option<[u8; 32]> {
    let author = room_author_of(&state.node_db, instance).await.ok().flatten()?;
    crate::postkeys::lookup(&state.node_db, &author, &hex::encode(instance)).await.ok().flatten()
}

/// Does this dialer's Hello show the key to this room, bound to this connection?
fn proof_shows_key(key: &[u8; 32], instance: &[u8; 16], proofs: &[([u8; 16], [u8; 32])], prover: &[u8; 32], verifier: &[u8; 32]) -> bool {
    let want = ringtome_proto::sync::room_key_proof(key, instance, prover, verifier);
    // Constant time over the proof: a mismatch must not say HOW it missed.
    proofs
        .iter()
        .any(|(i, p)| i == instance && p.iter().zip(want.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0)
}

/// The instances a dialer may hold chains of: every open room; a sealed room when the
/// dialing endpoint serves a persona the room's seal admits (CHAT.md, ruling 4 - the room's
/// door at the lane, judged as the key lane judges), or - for a room its author marked
/// ONWARD - when the dialer shows the key itself (Curtis, 2026-09-20: "the node should
/// return a trusted+onward chain to anyone who can prove that they hold the key that could
/// read that chain"). The words are ciphertext to everyone else, and the key travels the
/// trust web the author asked for, so the proof is the honest gate. A plain sealed room
/// keeps the strict one: there the author's own list is the whole story, and an untrust
/// must still stop what comes next.
pub async fn instances_dialer_may_hold(
    state: &AppState,
    instances: &[[u8; 16]],
    key_proofs: &[([u8; 16], [u8; 32])],
    dialer_hex: &str,
    our_endpoint: &[u8; 32],
) -> Vec<[u8; 16]> {
    let mut out = Vec::with_capacity(instances.len());
    for i in instances {
        let Some(author) = room_author_of(&state.node_db, i).await.ok().flatten() else { continue };
        let Some((head, _)) = room_head(state, &author, i).await else { continue };
        if !head.trusted_only {
            out.push(*i);
            continue;
        }
        // Who the dialer serves, from the peer ledger; any one of them admitted opens the lane.
        // The key, shown: an onward room answers to it.
        if head.onward && !key_proofs.is_empty() {
            if let Some(key) = held_room_key(state, i).await {
                let prover = crate::pubkey::decode(&crate::net::sync::endpoint_to_id(dialer_hex)).unwrap_or([0u8; 32]);
                if proof_shows_key(&key, i, key_proofs, &prover, our_endpoint) {
                    out.push(*i);
                    continue;
                }
            }
        }
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
#[allow(clippy::too_many_arguments)]
pub async fn say(
    state: &AppState,
    data: &Store,
    root_hex: &str,
    author_hex: &str,
    doc: &[u8; 16],
    words: &str,
    reacts_to: Option<[u8; 32]>,
    retract: bool,
    edits: Option<[u8; 32]>,
    deletes: Option<[u8; 32]>,
    notice: Option<(u64, [u8; 32])>,
) -> Result<(u64, i64), AppError> {
    let words = words.trim();
    if words.is_empty() && deletes.is_none() {
        return Err(AppError::BadRequest(crate::msg!("chat.say-something", "say something")));
    }
    // An edit or a delete (slice 8) names a line of this speaker's own, held here and not
    // already deleted: the chain keeps every entry, the memo remembers the line's fate.
    for target in [edits, deletes].into_iter().flatten() {
        let own: Option<(i64,)> = state
            .node_db
            .fetch_optional(
                "SELECT deleted FROM room_messages WHERE room_author = ?1 AND room_doc = ?2 AND entry_hash = ?3 AND speaker_root = ?4",
                (author_hex, hex::encode(doc), target.to_vec(), root_hex),
            )
            .await
            .context("looking for the line to change")
            .map_err(AppError::Internal)?;
        match own {
            None => return Err(AppError::NotFound(crate::msg!("chat.thats-not-a-line-of-yours", "that isn't a line of yours here"))),
            Some((d,)) if d != 0 => return Err(AppError::BadRequest(crate::msg!("chat.that-line-is-already-deleted", "that line is already deleted"))),
            _ => {}
        }
    }
    // A delete says nothing of its own: the entry's body is the one word it is.
    let words = if deletes.is_some() { "deleted" } else { words };
    // A reaction (slice 9): one emoji shortcode, answering a line this node holds of the
    // room. No bake, no mentions, no notice - just the stack under the line. Taken back
    // (`retract`) by naming the reaction it withdraws: the chain keeps both, the memo stops
    // counting.
    let mut retracts: Option<[u8; 32]> = deletes;
    if let Some(target) = reacts_to {
        if !is_shortcode(words) {
            return Err(AppError::BadRequest(crate::msg!("chat.a-reaction-is-one-emoji", "a reaction is one emoji")));
        }
        if retract {
            let mut standing = my_reactions(state, root_hex, author_hex, doc, &target, words).await?;
            let Some(last) = standing.pop() else {
                return Err(AppError::NotFound(crate::msg!("chat.you-havent-said-that-emoji-here", "you haven't said that emoji here")));
            };
            // Every earlier copy but the last is taken back by its own quiet entry; the last
            // rides the ordinary road below, fold, topic and push included.
            for earlier in standing {
                let quiet = ChatMessage { room_author: crate::pubkey::decode(author_hex).unwrap_or([0u8; 32]), body: words.as_bytes().to_vec(), sealed: false, refs: Vec::new(), mentions: Vec::new(), reacts_to: Some(target), retracts: Some(earlier), edits: None, notice: None }
                    .encode()
                    .map_err(|e| AppError::Internal(anyhow!("encoding a take-back: {e}")))?;
                crate::record::imaol::append_on(data.db(), data.signer(), service::CHAT, Some(*doc), entry_type::CHAT_MESSAGE, Payload::Inline(quiet)).await?;
            }
            retracts = Some(last);
        }
        let held: Option<(i64,)> = state
            .node_db
            .fetch_optional(
                "SELECT 1 FROM room_messages WHERE room_author = ?1 AND room_doc = ?2 AND entry_hash = ?3",
                (author_hex, hex::encode(doc), target.to_vec()),
            )
            .await
            .context("looking for the line a reaction answers")
            .map_err(AppError::Internal)?;
        if held.is_none() {
            return Err(AppError::NotFound(crate::msg!("chat.no-such-line-to-react-to", "that line isn't here to react to")));
        }
    }
    if words.len() > ChatMessage::MAX_BODY_BYTES {
        return Err(AppError::BadRequest(crate::msg!("chat.that-is-too-long-for-one-message", "that is too long for one message")));
    }
    let Some((head, _)) = room_head(state, author_hex, doc).await else {
        return Err(AppError::NotFound(crate::msg!("chat.no-such-room-is-held-here", "can't find that room")));
    };
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return Err(AppError::BadRequest(crate::msg!("chat.that-post-is-not-a-room", "that post is not a room")));
    }
    if head.settled {
        return Err(AppError::BadRequest(crate::msg!("chat.this-room-is-closed", "this room is closed")));
    }
    // Muted (ruling 8): the room hid this persona, and an honest node does not grow a chain
    // whose words no floor will show. The creator's own notices are exempt, since the mute
    // is the creator's act and they are never muted in their own room.
    if notice.is_none() && muted_in(state, root_hex, author_hex, &hex::encode(doc)).await.contains(root_hex) {
        return Err(AppError::Forbidden(crate::msg!(
            "chat.youve-been-muted-by-the-room",
            "you've been muted by the room"
        )));
    }
    let author = crate::pubkey::decode(author_hex).ok_or_else(|| AppError::BadRequest(crate::msg!("chat.bad-room-author", "bad room author")))?;
    // The room's key first: a sealed room seals its words and its pictures under one key.
    let key = if head.trusted_only {
        let Some(key) = room_key(state, author_hex, doc, root_hex).await else {
            return Err(AppError::Forbidden(crate::msg!("chat.the-rooms-key-hasnt-arrived", "this room isn't ready on this computer yet")));
        };
        Some(key)
    } else {
        None
    };
    // Media rides the room the way it rides a share (ruling 11): the say bakes - a line's
    // words, never a reaction's emoji.
    let (words, refs) = if reacts_to.is_some() || deletes.is_some() {
        (words.to_string(), Vec::new())
    } else {
        bake_words(state, data, root_hex, &author, doc, &head, key, words).await?
    };
    if words.len() > ChatMessage::MAX_BODY_BYTES {
        return Err(AppError::BadRequest(crate::msg!("chat.that-is-too-long-for-one-message", "that is too long for one message")));
    }
    // The people the words name (slice 6): never the speaker; in a sealed room only those
    // the seal admits - the notice is served under the room's door, and a bell that rings
    // for a room one may not enter would say the room exists.
    let mut mentions: Vec<[u8; 32]> = Vec::new();
    let named_in_words = if reacts_to.is_some() || deletes.is_some() { Vec::new() } else { crate::record::bake::mentions(&words) };
    for named in named_in_words {
        let named_hex = hex::encode(named);
        if named_hex == root_hex || mentions.contains(&named) {
            continue;
        }
        if head.trusted_only && !crate::idface::seal_admits(state, author_hex, &hex::encode(doc), &named_hex, None).await {
            continue;
        }
        mentions.push(named);
    }
    mentions.truncate(ChatMessage::MAX_MENTIONS);
    tracing::debug!(room = %hex::encode(doc), named = mentions.len(), "room message names people");
    let (body, sealed) = match key {
        Some(key) => (crate::record::private::seal_post_body(&key, words.as_bytes())?, true),
        None => (words.into_bytes(), false),
    };
    let payload = ChatMessage { room_author: author, body, sealed, refs, mentions: mentions.clone(), reacts_to, retracts, edits, notice }
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
    // The bells (slice 6): one envelope per persona named, the message as evidence, knocked
    // eagerly - the mention's own road, under the room's door at the far end.
    if !mentions.is_empty() {
        let named: Vec<(String, ringtome_proto::SignedEntry)> = mentions.iter().map(|m| (hex::encode(m), signed.clone())).collect();
        crate::outbox::queue_notices(state, data, root_hex, named, ringtome_proto::deliver::notice_kind::ROOM_MENTION).await;
    }
    let push_state = state.clone();
    let (push_root, push_author, push_doc) = (root_hex.to_string(), author_hex.to_string(), *doc);
    tokio::spawn(async move {
        push_room(&push_state, &push_root, &push_author, &push_doc).await;
    });
    Ok((seq, said_ms))
}

/// The say's bake (ruling 11): the private media the words embed become public twins - in a
/// sealed room, sealed under the room's key with the room post as the seal's holder, so
/// admission to the room is admission to the picture and nothing new is granted - the
/// references are rewritten to them, and the message's refs are what was baked, as
/// `bake::publish` does for a post. Media from the open web is refused: the background bake
/// has no post to come back to, and a room says now.
#[allow(clippy::too_many_arguments)]
async fn bake_words(
    state: &AppState,
    data: &Store,
    root_hex: &str,
    author: &[u8; 32],
    doc: &[u8; 16],
    head: &ringtome_proto::registry::DocHeaderPlain,
    key: Option<[u8; 32]>,
    words: &str,
) -> Result<(String, Vec<[u8; 16]>), AppError> {
    use crate::record::bake::MediaRef;
    let refs = crate::record::bake::media_refs(words, root_hex);
    if refs.is_empty() {
        return Ok((words.to_string(), Vec::new()));
    }
    if refs.len() > ringtome_proto::DocHeaderPlain::MAX_REFS {
        return Err(AppError::BadRequest(crate::msg!(
            "chat.a-message-embeds-too-many-documents",
            "this message embeds {count} documents - one message may carry {cap}",
            count = refs.len(),
            cap = ringtome_proto::DocHeaderPlain::MAX_REFS
        )));
    }
    if refs.iter().any(|r| matches!(r, MediaRef::External { .. })) {
        return Err(AppError::BadRequest(crate::msg!(
            "chat.a-room-cant-bake-web-media",
            "save the picture and attach it here instead"
        )));
    }
    let docs = data.documents();
    let seal_of = key.map(|_| (*author, *doc));
    let mut swaps: Vec<(String, String)> = Vec::new();
    let mut baked: Vec<[u8; 16]> = Vec::new();
    for r in &refs {
        let MediaRef::PrivateDoc { target, doc_id: media } = r else { continue };
        if !docs.media_bytes_present(media).await? {
            return Err(AppError::BadRequest(crate::msg!(
                "chat.that-media-is-still-being-prepared",
                "that media is still being prepared - say it again in a moment"
            )));
        }
        let (public, fmt, anim) = docs.bake_private_media(media, key, seal_of, head.onward).await?;
        swaps.push((target.clone(), crate::record::bake::public_media_target(root_hex, &public, fmt, anim)));
        if !baked.contains(&public) {
            baked.push(public);
        }
    }
    crate::record::bake::media_budget(state, data, &baked).await?;
    Ok((crate::record::bake::rewrite(words, &swaps), baked))
}

/// A message's media is this node's to hold while the message is (ruling 11): cover rows
/// keyed by the message's hash, the twins wanted from the creator's node first - the
/// archive holds them - and the speaker's own nodes after. Never for a hosted speaker,
/// whose twins sit on their own chain here.
async fn cover_message(state: &AppState, room_author: &str, speaker: &str, hash_hex: &str, refs: &[[u8; 16]]) {
    let mut origins: Vec<String> = Vec::new();
    if !crate::identity::is_hosted(&state.node_db, room_author).await.unwrap_or(false) {
        origins.push(room_author.to_string());
    }
    if speaker != room_author {
        origins.push(speaker.to_string());
    }
    crate::fragments::cover_for_message(state, &origins, speaker, hash_hex, refs).await;
}

/// The room's key for this reader, through the onward hop when one brought it here (Contact
/// tags, ruling 7): the sharer's node holds the key and releases it to the people they
/// trust, so a room somebody passed along opens for its reader.
async fn room_key(state: &AppState, author_hex: &str, doc: &[u8; 16], viewer_hex: &str) -> Option<[u8; 32]> {
    let via = crate::fanout::introducer(&state.node_db, viewer_hex, author_hex, &hex::encode(doc)).await;
    crate::idface::key_for(state, author_hex, doc, viewer_hex, via.as_deref()).await
}

/// `held_count`, less what the muted said: what a card's "and N more" may honestly say
/// once a mute stands.
async fn held_count_unmuted(state: &AppState, author_hex: &str, doc_hex: &str, ceiling: i64, muted: &std::collections::HashSet<String>) -> i64 {
    let cap = ringtome_proto::fragment::MAX_ROOM_HISTORY_TOTAL as i64 + 1;
    let marks: Vec<String> = (0..muted.len()).map(|i| format!("?{}", i + 5)).collect();
    let sql = format!(
        "SELECT COUNT(*) FROM (SELECT 1 FROM room_messages
           WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3 AND deleted = 0
             AND speaker_root NOT IN ({}) LIMIT ?4)",
        marks.join(",")
    );
    let mut params: Vec<turso::Value> = vec![
        turso::Value::Text(author_hex.to_string()),
        turso::Value::Text(doc_hex.to_string()),
        turso::Value::Integer(ceiling),
        turso::Value::Integer(cap),
    ];
    params.extend(muted.iter().map(|m| turso::Value::Text(m.clone())));
    state.node_db.fetch_optional::<(i64,)>(&sql, params).await.ok().flatten().map_or(0, |(n,)| n)
}

/// Who the room's creator has muted (CHAT.md, ruling 8): their own present `mute` labels on
/// the room post, each naming a persona - the settled wish's shape, travelling with the post
/// like every label, sealed with it when the room is sealed and opened here for a reader the
/// seal admits. Honoured by this node for every surface it serves, which is what "honoured
/// by every honest client" means from the inside.
pub async fn muted_in(state: &AppState, viewer_hex: &str, author_hex: &str, doc_hex: &str) -> std::collections::HashSet<String> {
    // A deputy's mute is the creator's (ruling 8): the creator said whose word counts, and
    // this reads both lists off the same post. The creator is never muted in their own room,
    // whoever says otherwise.
    let deputies = deputies_in(state, viewer_hex, author_hex, doc_hex).await;
    let mut muted = labels_by(state, viewer_hex, author_hex, doc_hex, MUTE_KEY, |annotator| {
        annotator == author_hex || deputies.contains(annotator)
    })
    .await;
    muted.remove(author_hex);
    muted
}

/// The label a mute is said as.
pub const MUTE_KEY: &str = "mute";
/// ...and the one that says who may say it (CHAT.md, ruling 8's moderators list, which
/// Curtis calls deputies, 2026-09-20): the creator's own label naming a persona whose mutes
/// count as the creator's. Only the creator deputizes; a deputy cannot pass the badge on.
pub const DEPUTY_KEY: &str = "deputy";

/// The room's deputies: the creator's own `deputy` labels, read like every label.
pub async fn deputies_in(state: &AppState, viewer_hex: &str, author_hex: &str, doc_hex: &str) -> std::collections::HashSet<String> {
    labels_by(state, viewer_hex, author_hex, doc_hex, DEPUTY_KEY, |annotator| annotator == author_hex).await
}

/// Whether this persona may mute in this room: its creator, or one of their deputies.
pub async fn may_moderate(state: &AppState, viewer_hex: &str, author_hex: &str, doc_hex: &str) -> bool {
    viewer_hex == author_hex || deputies_in(state, viewer_hex, author_hex, doc_hex).await.contains(viewer_hex)
}

/// The values of one label on the room post, by annotators the caller vouches for.
async fn labels_by(
    state: &AppState,
    viewer_hex: &str,
    author_hex: &str,
    doc_hex: &str,
    key: &str,
    said_by: impl Fn(&str) -> bool,
) -> std::collections::HashSet<String> {
    let known = crate::annotations::for_posts(state, &[(author_hex.to_string(), doc_hex.to_string())], Some(viewer_hex))
        .await
        .unwrap_or_default();
    known
        .get(&(author_hex.to_string(), doc_hex.to_string()))
        .map(|list| {
            list.iter()
                .filter(|a| a.key == key && said_by(&a.annotator))
                .map(|a| a.value.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether the room is sealed: its reactions are sealed too, and stacking them wants the key.
async fn head_sealed(state: &AppState, author_hex: &str, doc: &[u8; 16]) -> bool {
    room_head(state, author_hex, doc).await.is_some_and(|(h, _)| h.trusted_only)
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

/// How many messages this node holds of a room, before its close if closed, capped at the
/// wire's ceiling - a card's "and N more" (Curtis, 2026-09-18).
async fn held_count(state: &AppState, author_hex: &str, doc_hex: &str, ceiling: i64) -> i64 {
    let cap = ringtome_proto::fragment::MAX_ROOM_HISTORY_TOTAL as i64 + 1;
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT COUNT(*) FROM (SELECT 1 FROM room_messages
               WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3 AND deleted = 0 LIMIT ?4)",
            (author_hex, doc_hex, ceiling, cap),
        )
        .await
        .ok()
        .flatten()
        .map_or(0, |(n,)| n)
}

/// The archive's answer (ruling 6): `(speaker root, signed entry)` for the room's messages
/// said before `before_ms`, newest first - the entries themselves off each speaker's chain
/// as this node holds it, for a dialer the room admits (the directory's own gate) - and
/// how many the room holds here, capped.
/// user-db open 4 of 5 (tests/conventions.rs): one per speaker on the page.
#[allow(clippy::too_many_arguments)]
pub async fn answer_room_history(
    state: &AppState,
    conn: &iroh::endpoint::Connection,
    author: &[u8; 32],
    doc: &[u8; 16],
    for_root: &[u8; 32],
    before_ms: u64,
    limit: u64,
    key_proof: Option<[u8; 32]>,
) -> (Vec<([u8; 32], Vec<u8>)>, u64) {
    let author_hex = hex::encode(author);
    let doc_hex = hex::encode(doc);
    let Some((head, _)) = room_head(state, &author_hex, doc).await else { return (Vec::new(), 0) };
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return (Vec::new(), 0);
    }
    if !fragment_door_admits(state, conn, &head, &author_hex, doc, for_root, key_proof).await {
        return (Vec::new(), 0);
    }
    let ceiling = closed_at(state, &author_hex, doc).await.unwrap_or(i64::MAX);
    let total = held_count(state, &author_hex, &doc_hex, ceiling).await as u64;
    let limit = limit.clamp(1, ringtome_proto::fragment::MAX_ROOM_HISTORY_LIMIT) as i64;
    let before = i64::try_from(before_ms).unwrap_or(i64::MAX);
    let rows: Vec<(String, Vec<u8>)> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, entry_hash FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3 AND deleted = 0
             ORDER BY said_ms DESC, seq DESC LIMIT ?4",
            (author_hex.as_str(), doc_hex.as_str(), before, limit),
        )
        .await
        .unwrap_or_default();
    // A page's edits ride with it (slice 8): the newest edit entry of each edited line.
    let edits: Vec<(String, Vec<u8>)> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, edit_hash FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3 AND deleted = 0 AND edit_hash IS NOT NULL
             ORDER BY said_ms DESC, seq DESC LIMIT ?4",
            (author_hex.as_str(), doc_hex.as_str(), before, limit),
        )
        .await
        .unwrap_or_default();
    // The page's reactions ride with it (slice 9): the stacks under a line the reader
    // does not keep come from the archive too.
    let mut rows = rows;
    let targets: Vec<Vec<u8>> = rows.iter().map(|(_, h)| h.clone()).collect();
    rows.extend(edits);
    for chunk in targets.chunks(200) {
        let marks: Vec<String> = (0..chunk.len()).map(|i| format!("?{}", i + 3)).collect();
        let sql = format!(
            "SELECT speaker_root, entry_hash FROM room_reactions
             WHERE room_author = ?1 AND room_doc = ?2 AND withdrawn = 0 AND target_hash IN ({})",
            marks.join(",")
        );
        let mut params: Vec<turso::Value> = vec![turso::Value::Text(author_hex.clone()), turso::Value::Text(doc_hex.clone())];
        params.extend(chunk.iter().map(|h| turso::Value::Blob(h.clone())));
        if let Ok(more) = state.node_db.fetch_all::<(String, Vec<u8>)>(&sql, params).await {
            rows.extend(more);
        }
    }
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
    (out, total)
}

/// What the archive answers: `(speaker root, signed entry)` pairs and its count of the room.
type HistoryAnswer = (Vec<([u8; 32], Vec<u8>)>, u64);

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
) -> (Vec<(String, ringtome_proto::SignedEntry)>, i64) {
    let Some(author) = crate::pubkey::decode(author_hex) else { return (Vec::new(), 0) };
    let Some(for_root) = crate::pubkey::decode(viewer_hex) else { return (Vec::new(), 0) };
    let mut fetched: Option<HistoryAnswer> = None;
    for endpoint in creator_endpoints(state, author_hex).await {
        match crate::net::fragment::fetch_room_history(state, &endpoint, &author, doc, &for_root, before_ms.max(0) as u64, limit as u64).await {
            Ok(answer) => {
                fetched = Some(answer);
                break;
            }
            Err(e) => tracing::debug!(endpoint = %endpoint, error = ?e, "room history ask failed"),
        }
    }
    let Some((items, total)) = fetched else { return (Vec::new(), 0) };
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
    (out, total as i64)
}

/// When a line was said, by its hash: what turns a line's address into the page it sits on
/// (Curtis, 2026-09-20). `None` when this computer does not hold that line.
pub async fn said_at(state: &AppState, author_hex: &str, doc_hex: &str, hash: &[u8; 32]) -> Option<i64> {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT said_ms FROM room_messages WHERE room_author = ?1 AND room_doc = ?2 AND entry_hash = ?3",
            (author_hex, doc_hex, hash.to_vec()),
        )
        .await
        .ok()
        .flatten()
        .map(|(ms,)| ms)
}

/// A plain-words match, as the database hands it back: `(room author, room, speaker, hash,
/// said_ms, words)`.
type PlainHit = (String, String, String, Vec<u8>, i64, Vec<u8>);

/// A line as a search reads it off the memo: `(speaker, hash, said_ms, words, sealed)`.
type SearchRow = (String, Vec<u8>, i64, Vec<u8>, i64);

/// One line a search found.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Hit {
    pub author: String,
    pub doc_id: String,
    pub title: String,
    pub hash: String,
    pub said_ms: i64,
    pub speaker: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker_name: Option<String>,
    pub words: String,
}

/// What a search needs to know about a room, asked once: its header (the title a hit wears,
/// and the seal's own word) and who is muted in it. `None` when this persona may not read it.
type RoomVerdict = (ringtome_proto::registry::DocHeaderPlain, std::collections::HashSet<String>);

async fn room_verdict(state: &AppState, viewer_hex: &str, author_hex: &str, doc_hex: &str) -> Option<RoomVerdict> {
    let doc = hex::decode(doc_hex).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())?;
    let (head, _) = room_head(state, author_hex, &doc).await?;
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return None;
    }
    // The room's own door decides, as it does everywhere else.
    if head.trusted_only && author_hex != viewer_hex {
        let via = crate::fanout::introducer(&state.node_db, viewer_hex, author_hex, doc_hex).await;
        if !crate::idface::seal_admits(state, author_hex, doc_hex, viewer_hex, via.as_deref()).await {
            return None;
        }
    }
    let muted = muted_in(state, viewer_hex, author_hex, doc_hex).await;
    Some((head, muted))
}

/// The newest lines searched in a SEALED room. The honest bound, and only here: a sealed
/// line must be opened before it can be read at all, so those rooms are walked one at a
/// time with the room's key in hand. Open rooms are matched by the database itself, across
/// every room at once, so nothing is skipped for being old (Curtis, 2026-09-20: a line he
/// could read on the floor was missed by a search that only looked at recent rooms).
const SEARCH_DEPTH: i64 = 4_000;
/// Lines handed back, at most.
const SEARCH_HITS: usize = 60;
/// Rows the plain-words pass may match before it stops looking.
const SEARCH_SCAN: i64 = 500;

/// Search every conversation this persona may read (Curtis, 2026-09-20): the words as they
/// were said, matched without regard for case, newest first. Sealed rooms open with the key
/// this node holds for them and stay shut without it; a muted speaker's lines are no more
/// searchable than they are readable; a deleted line is gone here too, and an edited one
/// matches its newest words.
pub async fn search(state: &AppState, viewer_hex: &str, needle: &str, limit: usize) -> Result<Vec<Hit>, AppError> {
    let needle = needle.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits: Vec<Hit> = Vec::new();
    // Rooms whose words are in the clear: the database matches them itself, every room at
    // once, newest first.
    let plain: Vec<PlainHit> = state
        .node_db
        .fetch_all(
            "SELECT room_author, room_doc, speaker_root, entry_hash, said_ms, COALESCE(edit_body, body)
             FROM room_messages
             WHERE deleted = 0 AND notice_kind IS NULL
               AND (CASE WHEN edit_body IS NULL THEN sealed ELSE edit_sealed END) = 0
               AND instr(lower(CAST(COALESCE(edit_body, body) AS TEXT)), ?1) > 0
             ORDER BY said_ms DESC, seq DESC LIMIT ?2",
            (needle.as_str(), SEARCH_SCAN),
        )
        .await
        .context("searching the rooms held here")
        .map_err(AppError::Internal)?;
    // ...and the sealed ones, which must be opened to be read: one room at a time, with its
    // key, newest lines first.
    let sealed_rooms: Vec<(String, String)> = state
        .node_db
        .fetch_all(
            "SELECT room_author, room_doc FROM room_messages
             WHERE (CASE WHEN edit_body IS NULL THEN sealed ELSE edit_sealed END) = 1
             GROUP BY room_author, room_doc ORDER BY MAX(said_ms) DESC",
            (),
        )
        .await
        .context("listing the sealed rooms to search")
        .map_err(AppError::Internal)?;

    // One verdict per room, asked once: may this persona read it at all, and who is muted
    // in it.
    let mut rooms: HashMap<(String, String), Option<RoomVerdict>> = HashMap::new();

    for (author_hex, doc_hex, speaker, hash, said_ms, body) in plain {
        let at = (author_hex.clone(), doc_hex.clone());
        if !rooms.contains_key(&at) {
            let verdict = room_verdict(state, viewer_hex, &author_hex, &doc_hex).await;
            rooms.insert(at.clone(), verdict);
        }
        let Some(Some((head, muted))) = rooms.get(&at) else { continue };
        if muted.contains(&speaker) {
            continue;
        }
        let Ok(words) = String::from_utf8(body) else { continue };
        hits.push(Hit {
            author: author_hex,
            doc_id: doc_hex,
            title: head.title.clone(),
            hash: hex::encode(hash),
            said_ms,
            speaker,
            speaker_name: None,
            words,
        });
    }

    for (author_hex, doc_hex) in sealed_rooms {
        let at = (author_hex.clone(), doc_hex.clone());
        if !rooms.contains_key(&at) {
            let verdict = room_verdict(state, viewer_hex, &author_hex, &doc_hex).await;
            rooms.insert(at.clone(), verdict);
        }
        let Some(Some((head, muted))) = rooms.get(&at).cloned() else { continue };
        let Ok(Ok(doc)) = hex::decode(&doc_hex).map(|b| <[u8; 16]>::try_from(b.as_slice())) else { continue };
        let Some(key) = room_key(state, &author_hex, &doc, viewer_hex).await else { continue };
        let rows: Vec<SearchRow> = state
            .node_db
            .fetch_all(
                "SELECT speaker_root, entry_hash, said_ms,
                        COALESCE(edit_body, body), CASE WHEN edit_body IS NULL THEN sealed ELSE edit_sealed END
                 FROM room_messages
                 WHERE room_author = ?1 AND room_doc = ?2 AND deleted = 0 AND notice_kind IS NULL
                 ORDER BY said_ms DESC, seq DESC LIMIT ?3",
                (author_hex.as_str(), doc_hex.as_str(), SEARCH_DEPTH),
            )
            .await
            .context("reading a sealed room to search it")
            .map_err(AppError::Internal)?;
        for (speaker, hash, said_ms, body, sealed) in rows {
            if muted.contains(&speaker) {
                continue;
            }
            let words = if sealed != 0 {
                crate::record::private::open_post_body(&body, &key).and_then(|b| String::from_utf8(b).ok())
            } else {
                String::from_utf8(body).ok()
            };
            let Some(words) = words else { continue };
            if !words.to_lowercase().contains(&needle) {
                continue;
            }
            hits.push(Hit {
                author: author_hex.clone(),
                doc_id: doc_hex.clone(),
                title: head.title.clone(),
                hash: hex::encode(hash),
                said_ms,
                speaker,
                speaker_name: None,
                words,
            });
        }
    }

    hits.sort_by_key(|h| std::cmp::Reverse(h.said_ms));
    hits.truncate(limit.clamp(1, SEARCH_HITS));
    let speakers: Vec<String> = hits.iter().map(|h| h.speaker.clone()).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &speakers).await.unwrap_or_default();
    for hit in hits.iter_mut() {
        hit.speaker_name = bylines.get(&hit.speaker).and_then(|b| b.name.clone());
    }
    Ok(hits)
}

/// The room's recent history, newest first, as this node holds it - every speaker's chain
/// interleaved by claimed time (CHAT.md, ruling 3). A sealed message opens with the key the
/// reader may have; a closed room serves nothing said after the close (ruling 10). When
/// this node keeps only the budget and the page runs past it, the archive fills the rest
/// (ruling 6). Returns the page, whether the room is closed, whether more may lie beneath
/// it, and how many messages the room holds as best this node knows - its own memo, or
/// the archive's word when the archive was asked - capped at the wire's ceiling, so a card
/// can say "and N more" (Curtis, 2026-09-18) without syncing the conversation.
#[allow(clippy::too_many_arguments)]
pub async fn history(
    state: &AppState,
    viewer_hex: &str,
    author_hex: &str,
    doc: &[u8; 16],
    before_ms: Option<i64>,
    limit: i64,
    // Landing on a line's address (Curtis, 2026-09-20): the conversation AROUND it, not the
    // page that ends at it - half the page behind it and half in front, so the floor reads
    // the way it reads anywhere else with that line in the middle of it.
    at_ms: Option<i64>,
) -> Result<(Vec<Message>, bool, bool, i64), AppError> {
    let doc_hex = hex::encode(doc);
    let closed = closed_at(state, author_hex, doc).await;
    let limit = limit.clamp(1, HISTORY_PAGE);
    let behind = if at_ms.is_some() { (limit + 1) / 2 } else { limit };
    type Row = (String, String, i64, i64, Vec<u8>, Vec<u8>, i64, i64, Option<i64>, Option<String>);
    let before = before_ms.unwrap_or(i64::MAX);
    let ceiling = closed.map_or(before, |c| c.min(before));
    let mut rows: Vec<Row> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, speaker_leaf, seq, said_ms, entry_hash,
                    COALESCE(edit_body, body), CASE WHEN edit_body IS NULL THEN sealed ELSE edit_sealed END,
                    edit_hash IS NOT NULL, notice_kind, notice_subject
             FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms < ?3 AND deleted = 0
             ORDER BY said_ms DESC, seq DESC LIMIT ?4",
            (author_hex, doc_hex.as_str(), ceiling, behind),
        )
        .await
        .context("reading a room's history")
        .map_err(AppError::Internal)?;
    // ...and what was said after it, so a landing is a window rather than an ending.
    if at_ms.is_some() {
        let ahead: Vec<Row> = state
            .node_db
            .fetch_all(
                "SELECT speaker_root, speaker_leaf, seq, said_ms, entry_hash,
                        COALESCE(edit_body, body), CASE WHEN edit_body IS NULL THEN sealed ELSE edit_sealed END,
                        edit_hash IS NOT NULL, notice_kind, notice_subject
                 FROM room_messages
                 WHERE room_author = ?1 AND room_doc = ?2 AND said_ms >= ?3 AND deleted = 0
                 ORDER BY said_ms ASC, seq ASC LIMIT ?4",
                (author_hex, doc_hex.as_str(), ceiling, limit - behind),
            )
            .await
            .context("reading a room's history forward")
            .map_err(AppError::Internal)?;
        rows.extend(ahead);
        rows.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| b.2.cmp(&a.2)));
    }
    // Past what this node keeps: the archive (ruling 6). Asked only when the local page
    // came up short and this node is not the archivist itself.
    let mut more = rows.len() as i64 >= behind;
    let mut total = held_count(state, author_hex, &doc_hex, closed.unwrap_or(i64::MAX)).await;
    let mut archived_reactions: Vec<(Vec<u8>, String, Vec<u8>, i64)> = Vec::new();
    if (rows.len() as i64) < limit && !archivist_here(state, author_hex, &doc_hex).await {
        let oldest = rows.last().map(|r| r.3).unwrap_or(ceiling);
        let want = limit - rows.len() as i64;
        let held: std::collections::HashSet<Vec<u8>> = rows.iter().map(|r| r.4.clone()).collect();
        let (archived, archive_total) = archive_history(state, viewer_hex, author_hex, doc, oldest, want).await;
        total = total.max(archive_total);
        let mut lines_from_archive = 0i64;
        // An archived line's edits arrive beside it (slice 8): the newest stands in.
        let mut archived_edits: HashMap<Vec<u8>, (i64, Vec<u8>, i64)> = HashMap::new();
        for (root, signed) in archived {
            if held.contains(signed.hash().as_slice()) {
                continue;
            }
            let entry = signed.entry();
            let Payload::Inline(payload) = &entry.payload else { continue };
            let Ok(msg) = ChatMessage::decode(payload) else { continue };
            if let Some(target) = msg.reacts_to {
                if msg.retracts.is_none() {
                    archived_reactions.push((target.to_vec(), root, msg.body, i64::from(msg.sealed)));
                }
                continue;
            }
            if let Some(target) = msg.edits {
                let slot = archived_edits.entry(target.to_vec()).or_insert((0, Vec::new(), 0));
                if entry.timestamp_ms > slot.0 {
                    *slot = (entry.timestamp_ms, msg.body, i64::from(msg.sealed));
                }
                continue;
            }
            if msg.retracts.is_some() || entry.timestamp_ms >= ceiling {
                continue;
            }
            lines_from_archive += 1;
            rows.push((
                root,
                hex::encode(entry.chain.author),
                entry.seq as i64,
                entry.timestamp_ms,
                signed.hash().to_vec(),
                msg.body,
                i64::from(msg.sealed),
                0,
                msg.notice.map(|(kind, _)| kind as i64),
                msg.notice.map(|(_, who)| hex::encode(who)),
            ));
        }
        for row in rows.iter_mut() {
            if let Some((_, body, sealed)) = archived_edits.remove(&row.4) {
                row.5 = body;
                row.6 = sealed;
                row.7 = 1;
            }
        }
        more = lines_from_archive >= want;
        rows.sort_by(|a, b| b.3.cmp(&a.3).then_with(|| b.2.cmp(&a.2)));
    }
    // The mute (ruling 8): a muted speaker's lines leave the floor, and the count with
    // them; the creator's own notice saying so stays, because the creator said it.
    let muted = muted_in(state, viewer_hex, author_hex, &doc_hex).await;
    if !muted.is_empty() {
        rows.retain(|r| !muted.contains(&r.0));
        total = held_count_unmuted(state, author_hex, &doc_hex, closed.unwrap_or(i64::MAX), &muted).await;
    }
    let needs_key = rows.iter().any(|r| r.6 != 0) || archived_reactions.iter().any(|r| r.3 != 0) || head_sealed(state, author_hex, doc).await;
    let key = if needs_key { room_key(state, author_hex, doc, viewer_hex).await } else { None };
    let targets: Vec<Vec<u8>> = rows.iter().map(|r| r.4.clone()).collect();
    let mut stacks = stack_reactions(state, author_hex, &doc_hex, &targets, archived_reactions, key).await;
    let speakers: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &speakers).await.unwrap_or_default();
    let items = rows
        .into_iter()
        .map(|(speaker, leaf, seq, said_ms, hash, body, sealed, edited, notice_kind, notice_subject)| {
            let words = if sealed != 0 {
                key.and_then(|k| crate::record::private::open_post_body(&body, &k))
                    .and_then(|b| String::from_utf8(b).ok())
            } else {
                String::from_utf8(body).ok()
            };
            let byline = bylines.get(&speaker);
            let hash_hex = hex::encode(hash);
            Message {
                speaker_name: byline.and_then(|b| b.name.clone()),
                speaker_avatar: byline.and_then(|b| b.avatar.clone()),
                speaker,
                leaf,
                seq: seq as u64,
                said_ms,
                words,
                reactions: stacks.remove(&hash_hex).unwrap_or_default(),
                hash: hash_hex,
                edited: edited != 0,
                notice: notice_kind.and_then(|k| match k as u64 {
                    ChatMessage::NOTICE_MUTED => Some("muted".to_string()),
                    ChatMessage::NOTICE_UNMUTED => Some("unmuted".to_string()),
                    ChatMessage::NOTICE_DEPUTIZED => Some("deputized".to_string()),
                    ChatMessage::NOTICE_UNDEPUTIZED => Some("undeputized".to_string()),
                    _ => None,
                }),
                notice_subject,
            }
        })
        .collect();
    Ok((items, closed.is_some(), more, total.min(ringtome_proto::fragment::MAX_ROOM_HISTORY_TOTAL as i64)))
}

/// Messages said in a room since `since_ms` by anyone but `not_speaker`: the chat badge's
/// arithmetic (Curtis, 2026-09-19), one count per room this persona is in.
pub async fn unseen_in(state: &AppState, author_hex: &str, doc_hex: &str, since_ms: i64, not_speaker: &str) -> Result<u64> {
    let rows: Vec<(String, i64)> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, COUNT(*) FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms > ?3 AND speaker_root != ?4 AND deleted = 0
             GROUP BY speaker_root",
            (author_hex, doc_hex, since_ms, not_speaker),
        )
        .await
        .context("counting a room's unseen messages")?;
    if rows.is_empty() {
        return Ok(0);
    }
    // A muted speaker never bolds a room (ruling 8): that is most of what moderation is for.
    let muted = muted_in(state, not_speaker, author_hex, doc_hex).await;
    Ok(rows.iter().filter(|(who, _)| !muted.contains(who)).map(|(_, n)| (*n).max(0) as u64).sum())
}

/// When each room this node holds last heard a message: `(room_author, room_doc) ->
/// said_ms` - what the chats column sorts and bolds by (Curtis, 2026-09-18).
pub async fn latest_by_room(node_db: &Db) -> Result<HashMap<(String, String), i64>> {
    let rows: Vec<(String, String, i64)> = node_db
        .fetch_all(
            "SELECT room_author, room_doc, MAX(said_ms) FROM room_messages WHERE deleted = 0 GROUP BY room_author, room_doc",
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
    key_proof: Option<[u8; 32]>,
) -> ringtome_proto::fragment::FragmentMessage {
    let empty = ringtome_proto::fragment::FragmentMessage::Room { participants: Vec::new() };
    let author_hex = hex::encode(author);
    let doc_hex = hex::encode(doc);
    let Some((head, _)) = room_head(state, &author_hex, doc).await else { return empty };
    if head.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return empty;
    }
    if !fragment_door_admits(state, conn, &head, &author_hex, doc, for_root, key_proof).await {
        return empty;
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
    let hosted = crate::identity::is_hosted(&state.node_db, root).await.unwrap_or(false);
    let mut covers: Vec<(String, String, Vec<[u8; 16]>)> = Vec::new();
    let mut landed = 0u64;
    for signed in &entries {
        let entry = signed.entry();
        let Some(instance) = entry.chain.instance else { continue };
        let Payload::Inline(payload) = &entry.payload else { continue };
        let Ok(msg) = ChatMessage::decode(payload) else { continue };
        let room_author = hex::encode(msg.room_author);
        let room_doc = hex::encode(instance);
        rooms.insert((room_author.clone(), room_doc.clone()));
        if let Some(earlier) = msg.retracts {
            // Taken back (slices 8 and 9): the earlier entry of this speaker's stops
            // counting - a reaction withdrawn, or a line deleted. Chain order puts the
            // original before its retraction, and a re-fold ignores the original's insert,
            // so the mark sticks.
            state
                .node_db
                .execute(
                    "UPDATE room_reactions SET withdrawn = 1 WHERE speaker_root = ?1 AND entry_hash = ?2",
                    (root, earlier.to_vec()),
                )
                .await
                .context("withdrawing a reaction")?;
            state
                .node_db
                .execute(
                    "UPDATE room_messages SET deleted = 1 WHERE speaker_root = ?1 AND entry_hash = ?2",
                    (root, earlier.to_vec()),
                )
                .await
                .context("deleting a line")?;
            continue;
        }
        if let Some(earlier) = msg.edits {
            // Edited (slice 8): the newest edit's words stand in the old line's place.
            state
                .node_db
                .execute(
                    "UPDATE room_messages SET edit_hash = ?3, edit_body = ?4, edit_sealed = ?5, edited_ms = ?6
                     WHERE speaker_root = ?1 AND entry_hash = ?2 AND (edited_ms IS NULL OR edited_ms < ?6)",
                    (root, earlier.to_vec(), signed.hash().to_vec(), msg.body.clone(), i64::from(msg.sealed), entry.timestamp_ms),
                )
                .await
                .context("editing a line")?;
            continue;
        }
        if let Some(target) = msg.reacts_to {
            // A reaction (slice 9) files under its target, never among the lines.
            state
                .node_db
                .execute(
                    "INSERT OR IGNORE INTO room_reactions
                       (room_author, room_doc, target_hash, speaker_root, speaker_leaf, seq, said_ms, entry_hash, body, sealed, noted_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                    (
                        room_author.as_str(),
                        room_doc.as_str(),
                        target.to_vec(),
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
                .context("noting a room reaction")?;
            continue;
        }
        landed += state
            .node_db
            .execute(
                "INSERT OR IGNORE INTO room_messages
                   (room_author, room_doc, speaker_root, speaker_leaf, seq, said_ms, entry_hash, body, sealed, noted_ms,
                    notice_kind, notice_subject)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
                    msg.notice.map(|(kind, _)| kind as i64),
                    msg.notice.map(|(_, who)| hex::encode(who)),
                ),
            )
            .await
            .context("noting a room message")?;
        if !msg.refs.is_empty() && !hosted {
            covers.push((room_author.clone(), hex::encode(signed.hash()), msg.refs.clone()));
        }
    }
    let mut pruned = false;
    for (room_author, room_doc) in rooms {
        pruned |= enforce_budget(state, &db, &room_author, &room_doc).await?;
    }
    // New words landed in the memo, which lives beside every reader's own data rather than
    // in it: nudge every hosted persona's live stream, so the chat badge moves the moment a
    // room does (Curtis, 2026-09-19) rather than at their next own write.
    if landed > 0 {
        if let Ok(readers) = crate::identity::hosted_roots(&state.node_db).await {
            for reader in readers {
                state.view_epochs.bump(&reader);
            }
        }
    }
    // The media the messages embed (ruling 11), off the fold's path: the cover walk dials
    // when a twin is missing, and a fold must not wait on the network. Only what the prune
    // left standing is wanted.
    if !covers.is_empty() {
        let state = state.clone();
        let speaker = root.to_string();
        tokio::spawn(async move {
            for (room_author, hash_hex, refs) in covers {
                let still: Option<(i64,)> = state
                    .node_db
                    .fetch_optional(
                        "SELECT 1 FROM room_messages WHERE speaker_root = ?1 AND entry_hash = ?2",
                        (speaker.as_str(), hex::decode(&hash_hex).unwrap_or_default()),
                    )
                    .await
                    .unwrap_or(None);
                if still.is_none() {
                    continue;
                }
                cover_message(&state, &room_author, &speaker, &hash_hex, &refs).await;
            }
        });
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
    // The pruned lines' media goes with them (ruling 11): their covers released, the twins
    // nothing covers forgotten.
    let dropped: Vec<(String, Vec<u8>)> = state
        .node_db
        .fetch_all(
            "SELECT speaker_root, entry_hash FROM room_messages
             WHERE room_author = ?1 AND room_doc = ?2 AND said_ms <= ?3",
            (room_author, room_doc, cut_ms),
        )
        .await
        .context("listing the lines a room's budget drops")?;
    let mut by_speaker: HashMap<String, Vec<String>> = HashMap::new();
    for (speaker, hash) in dropped {
        by_speaker.entry(speaker).or_default().push(hex::encode(hash));
    }
    for (speaker, hashes) in by_speaker {
        crate::fragments::release_covers(&state.node_db, &speaker, &hashes).await?;
    }
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
    state
        .node_db
        .execute(
            "DELETE FROM room_reactions WHERE room_author = ?1 AND room_doc = ?2 AND said_ms <= ?3",
            (room_author, room_doc, cut_ms),
        )
        .await
        .context("pruning a room's reactions beneath its budget")?;
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
    // A sealed room's door now answers to the key (Curtis, 2026-09-20), so fetch it before
    // asking - otherwise the first pull of a room somebody passed along has nothing to show
    // and waits for a read to prime it.
    if !creator_here {
        if let Some((head, _)) = room_head(state, author_hex, doc).await {
            if head.trusted_only {
                room_key(state, author_hex, doc, root_hex).await;
            }
        }
    }
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

// ---------------------------------------------------------------------------------------------
// The pulse: a busy room cycles in the feed (Curtis, 2026-09-18)

/// How long a room's last word, asked of its creator's node, is believed before asking again.
const PULSE_ASK_TTL_MS: i64 = 10 * 60 * 1000;
/// Rooms asked of their creators' nodes per pass: the pulse is periodic, not per word, on
/// purpose ("not every time somebody posts, because that could get expensive").
const PULSE_ASKS_PER_PASS: usize = 8;

/// When each room not held here was last asked (in memory: a memo that only paces dials).
static PULSED: std::sync::LazyLock<std::sync::Mutex<HashMap<(String, String), i64>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));

/// The room's newest word as its creator's node tells it: one entry over the fragment
/// lane, verified as signed and as this room's, its claimed time taken for the feed's
/// order and nothing else. No attribution check - the creator's node is the directory of
/// record (ruling 6), and a lie here misplaces a card, never a word.
async fn remote_latest(state: &AppState, viewer_hex: &str, author_hex: &str, doc: &[u8; 16]) -> Option<i64> {
    let author = crate::pubkey::decode(author_hex)?;
    let for_root = crate::pubkey::decode(viewer_hex)?;
    for endpoint in creator_endpoints(state, author_hex).await {
        let Ok((items, _)) = crate::net::fragment::fetch_room_history(state, &endpoint, &author, doc, &for_root, u64::MAX, 1).await else { continue };
        let mut newest: Option<i64> = None;
        for (_, bytes) in items {
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
            newest = Some(newest.map_or(entry.timestamp_ms, |n| n.max(entry.timestamp_ms)));
        }
        return newest;
    }
    None
}

/// The pass: every room in a feed here moves up to its last word. Rooms this node holds
/// are read off the memo, free; a room nobody here entered is asked of its creator's node,
/// a few per pass and each at most every ten minutes, so a busy room a reader only follows
/// still cycles - slowly, by design.
pub async fn pulse_pass(state: AppState) -> Result<()> {
    let rows = crate::fanout::rooms_in_feeds(&state.node_db).await?;
    if rows.is_empty() {
        return Ok(());
    }
    let local = latest_by_room(&state.node_db).await?;
    let now = crate::clock::now_ms();
    // One question per room, whoever's feed it sits in: the newest row's time is the bar.
    let mut rooms: HashMap<(String, String), (String, i64)> = HashMap::new();
    for (reader, author, doc, published_ms) in rows {
        let slot = rooms.entry((author, doc)).or_insert((reader.clone(), published_ms));
        if published_ms > slot.1 {
            *slot = (reader, published_ms);
        }
    }
    let mut asked = 0usize;
    for ((author, doc_hex), (reader, published_ms)) in rooms {
        let latest = match local.get(&(author.clone(), doc_hex.clone())) {
            Some(ms) => Some(*ms),
            None => {
                if asked >= PULSE_ASKS_PER_PASS {
                    continue;
                }
                let key = (author.clone(), doc_hex.clone());
                let due = PULSED.lock().map(|m| m.get(&key).is_none_or(|t| now - *t > PULSE_ASK_TTL_MS)).unwrap_or(true);
                if !due {
                    continue;
                }
                let Ok(Ok(doc)) = hex::decode(&doc_hex).map(|b| <[u8; 16]>::try_from(b.as_slice())) else { continue };
                asked += 1;
                if let Ok(mut m) = PULSED.lock() {
                    m.insert(key, now);
                }
                remote_latest(&state, &reader, &author, &doc).await
            }
        };
        if let Some(ms) = latest {
            if ms > published_ms {
                crate::fanout::bump_room_time(&state.node_db, &author, &doc_hex, ms).await?;
            }
        }
    }
    Ok(())
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
        let msg = ChatMessage { room_author: [1u8; 32], body: sealed, sealed: true, refs: Vec::new(), mentions: Vec::new(), reacts_to: None, retracts: None, edits: None, notice: None };
        let back = ChatMessage::decode(&msg.encode().unwrap()).unwrap();
        assert_eq!(crate::record::private::open_post_body(&back.body, &key).unwrap(), b"the quiet one");
        assert!(crate::record::private::open_post_body(&back.body, &[8u8; 32]).is_none(), "the wrong key opens nothing");
    }
}
