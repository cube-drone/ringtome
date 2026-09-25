//! Attention: the moment a badge would light, said out loud to whoever embeds this node - the
//! desktop app's notifications (Curtis, 2026-09-25: "anytime something happens that would trigger
//! a badge lighting up in app, we pop a desktop notification").
//!
//! **One source of truth, not two.** There is no event bus of badge-worthy happenings to hook,
//! and inventing one would be a second definition of "worth a badge" that drifts from the first
//! (STYLE: no event buses). So this reads exactly what the two dock badges count from - the bell's
//! rows (`routes::notification_items`, the same list the badge, the bell and "mark all read" use)
//! and the unseen lines of the rooms the chat badge counts (`routes::chat_rooms_with_seen`,
//! `chat::unseen_lines`) - and announces what is unseen and not yet announced. A desktop alert
//! can therefore never disagree with the badge: if it rang, the badge is lit.
//!
//! **"Not yet announced" is a set, never a clock.** Each persona keeps the keys of the unseen
//! items it last looked at; an unseen item not in that set is news. A time mark would miss what
//! arrives late wearing an old stamp - a message said while its speaker's node was offline, synced
//! an hour later, is still news here, and is exactly the one a person wants to hear about. The
//! set is replaced every pass by what is unseen NOW, so it is bounded by the badges themselves,
//! and something read on another device leaves it the moment the seen register syncs.
//!
//! **The first look announces nothing.** A persona's first pass only learns what is already
//! unseen: a launch must not replay the backlog the badge is already showing.
//!
//! **Woken like the live stream** (`routes::serve_stream`): the write-nudge bus names the root
//! that wrote (the bell's fold nudges, inbox transcription is a write), and a one-second tick
//! guarded by the database's mtime and the persona's view epoch catches room messages, which
//! bump the epoch rather than write. Idle, a tick costs two stats per persona. And when nobody is
//! listening - no subscriber, no test recorder - a pass does no work at all.
//!
//! What this does NOT do: decide whether anyone is looking. The embedder knows whether its
//! window is focused; this knows only that the badge lit.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::AppState;

/// How many alerts one pass may raise for one persona before they collapse into a summary.
const BURST: usize = 3;
/// How many unseen lines per room a pass reads: the newest, which is where news is.
const LINES_PER_ROOM: i64 = 20;
/// The test recorder's depth.
const RECORDED: usize = 200;

/// One thing worth a person's attention, worded and ready to show.
#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    /// Which persona it is for, hex.
    pub root: String,
    /// Who or what: a name, a room.
    pub title: String,
    /// What happened, or what was said.
    pub body: String,
    /// Where in the app it lives, as a UI path - the bell, or the room.
    pub route: String,
}

/// The node's announcer: a broadcast any embedder may subscribe to, plus a small recorder a
/// test rig can read back (`/test/attention`), armed only in local-test mode.
#[derive(Clone)]
pub struct Attention {
    tx: tokio::sync::broadcast::Sender<Alert>,
    recorded: Option<Arc<Mutex<VecDeque<Alert>>>>,
}

impl Attention {
    pub fn new(record: bool) -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        Self { tx, recorded: record.then(Default::default) }
    }

    /// Listen for alerts. A receiver that falls behind skips ahead (broadcast's lag), which
    /// for notifications is the right failure: the oldest news is the least worth showing.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Alert> {
        self.tx.subscribe()
    }

    /// The recorder's alerts for one persona, oldest first - the test rig's read.
    pub fn recorded(&self, root: &str) -> Vec<Alert> {
        self.recorded
            .as_ref()
            .map(|r| r.lock().expect("attention recorder poisoned").iter().filter(|a| a.root == root).cloned().collect())
            .unwrap_or_default()
    }

    fn wanted(&self) -> bool {
        self.tx.receiver_count() > 0 || self.recorded.is_some()
    }

    fn publish(&self, alert: Alert) {
        tracing::debug!(root = %alert.root, title = %alert.title, "attention");
        if let Some(r) = &self.recorded {
            let mut r = r.lock().expect("attention recorder poisoned");
            if r.len() >= RECORDED {
                r.pop_front();
            }
            r.push_back(alert.clone());
        }
        let _ = self.tx.send(alert);
    }
}

/// What one persona's last pass saw unseen.
#[derive(Default)]
struct Seen {
    bell: HashSet<String>,
    chat: HashSet<String>,
}

/// The watcher: spawned once at boot, runs for the node's life.
pub async fn watch(state: AppState) {
    let mut nudge = Some(state.user_dbs.subscribe_writes());
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut guards: HashMap<String, (Option<i64>, u64)> = HashMap::new();
    let mut seen: HashMap<String, Seen> = HashMap::new();
    loop {
        // Which personas might have moved: the tick's guarded set, or the nudge's writer.
        let mut dirty: HashSet<String> = HashSet::new();
        let mut everyone = false;
        tokio::select! {
            _ = tick.tick() => {
                if !state.attention.wanted() { continue; }
                let Ok(roots) = crate::identity::hosted_roots(&state.node_db).await else { continue };
                for root in roots {
                    let now = (state.user_dbs.db_mtime_ms(&root), state.view_epochs.get(&root));
                    if guards.get(&root) != Some(&now) {
                        guards.insert(root.clone(), now);
                        dirty.insert(root);
                    }
                }
            }
            who = crate::db::await_write_nudge(&mut nudge) => {
                if !state.attention.wanted() { continue; }
                match who {
                    Some(root) => { guards.remove(&root); dirty.insert(root); }
                    None => everyone = true, // lagged: nobody can rule themselves out
                }
            }
        }
        let Ok(hosted) = crate::identity::hosted_roots(&state.node_db).await else { continue };
        let many = hosted.len() > 1;
        for root in hosted.iter().filter(|r| everyone || dirty.contains(*r)) {
            // Primed means a pass has SUCCEEDED for this persona: only then is its set a
            // record of what was already unseen. (Not "the tick has seen it" - the guard is
            // written before the pass, and counting that replayed the backlog at launch.)
            let primed = seen.contains_key(root);
            let mut known = seen.remove(root).unwrap_or_default();
            match pass(&state, root, &mut known).await {
                Ok(alerts) => {
                    seen.insert(root.clone(), known);
                    if !primed {
                        continue; // the first look: learned what is unseen, announced nothing
                    }
                    let to = if many { persona_name(&state, root).await } else { None };
                    for mut alert in collapse(root, alerts) {
                        if let Some(name) = &to {
                            alert.title = format!("{} · {name}", alert.title);
                        }
                        state.attention.publish(alert);
                    }
                }
                Err(e) => {
                    if primed {
                        seen.insert(root.clone(), known); // keep the old record; retry next wake
                    }
                    guards.remove(root);
                    tracing::debug!(root = %root, error = %e, "attention pass failed");
                }
            }
        }
    }
}

/// One persona, once: everything unseen now, the set replaced, the new items returned.
async fn pass(state: &AppState, root: &str, known: &mut Seen) -> anyhow::Result<Vec<Alert>> {
    let data = crate::record::store::open_agented(state, root)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut alerts = Vec::new();

    let (items, _) = crate::identity::routes::notification_items(state, &data, root)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut bell = HashSet::new();
    for item in items.iter().filter(|i| !i.seen) {
        let key = format!("{}|{}|{}|{}", item.author, item.kind, item.doc_id, item.updated_ms);
        if !known.bell.contains(&key) {
            alerts.push(bell_alert(state, &data, root, item).await);
        }
        bell.insert(key);
    }

    let mut chat = HashSet::new();
    for (author, doc, since) in crate::identity::routes::chat_rooms_with_seen(&data, root)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        let lines = crate::chat::unseen_lines(state, &author, &doc, since, root, LINES_PER_ROOM).await?;
        if lines.is_empty() {
            continue;
        }
        let fresh: Vec<&crate::chat::UnseenLine> = lines.iter().filter(|l| !known.chat.contains(&l.hash)).collect();
        if !fresh.is_empty() {
            let room = room_name(state, &author, &doc).await;
            let route = format!("/home/chat/{author}/{doc}");
            // Newest first, as read: one alert per line, collapsed below if there are many.
            for line in fresh.into_iter().rev() {
                let who = line.speaker_name.clone().unwrap_or_else(|| short_name(&line.speaker));
                alerts.push(Alert {
                    root: root.to_string(),
                    title: crate::msg!("attention.speaker-in-room", "{who} in {room}", who = who, room = room).english,
                    body: line
                        .words
                        .clone()
                        .unwrap_or_else(|| crate::msg!("attention.a-new-message", "a new message").english),
                    route: route.clone(),
                });
            }
        }
        chat.extend(lines.into_iter().map(|l| l.hash));
    }

    known.bell = bell;
    known.chat = chat;
    Ok(alerts)
}

/// Too many at once reads as noise: past [`BURST`], each room's lines become one "N new
/// messages", and the bell's rows one "N new notifications".
fn collapse(root: &str, alerts: Vec<Alert>) -> Vec<Alert> {
    if alerts.len() <= BURST {
        return alerts;
    }
    let mut out: Vec<Alert> = Vec::new();
    let mut by_route: Vec<(String, Vec<Alert>)> = Vec::new();
    for a in alerts {
        match by_route.iter_mut().find(|(r, _)| *r == a.route) {
            Some((_, v)) => v.push(a),
            None => by_route.push((a.route.clone(), vec![a])),
        }
    }
    for (route, group) in by_route {
        let n = group.len();
        let last = group.into_iter().last().expect("a group has a member");
        if n == 1 {
            out.push(last);
        } else if route == BELL_ROUTE {
            out.push(Alert {
                root: root.to_string(),
                title: crate::msg!("attention.notifications", "Notifications").english,
                body: crate::msg!("attention.n-new-notifications", "{n} new notifications", n = n).english,
                route,
            });
        } else {
            out.push(Alert {
                root: root.to_string(),
                title: last.title,
                body: crate::msg!("attention.n-new-messages", "{n} new messages - latest: {words}", n = n, words = last.body).english,
                route,
            });
        }
    }
    out
}

const BELL_ROUTE: &str = "/home/notifications";

/// A bell row as one alert, in the bell's own words (js/apps/notifications.js's `sentence`).
async fn bell_alert(
    state: &AppState,
    data: &crate::record::store::Store,
    root: &str,
    item: &crate::identity::routes::NotificationItem,
) -> Alert {
    let who = if item.stranger {
        item.claimed_name
            .as_ref()
            .map(|c| crate::msg!("attention.claimed-name", "\"{name}\" (unverified)", name = c).english)
            .unwrap_or_else(|| short_name(&item.author))
    } else {
        item.author_name.clone().unwrap_or_else(|| short_name(&item.author))
    };
    // The post's title: the reader's own post for most kinds, the room for a room mention.
    let title = if item.doc_id.is_empty() || item.kind == crate::notifications::KIND_MENTIONED {
        None
    } else if item.kind == crate::notifications::KIND_ROOM_MENTION {
        match &item.detail {
            Some(author) => Some(room_name(state, author, &item.doc_id).await),
            None => None,
        }
    } else {
        let doc = hex::decode(&item.doc_id).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok());
        match doc {
            Some(doc) => crate::record::documents::public_doc(data.db(), &doc)
                .await
                .ok()
                .flatten()
                .map(|p| p.title)
                .filter(|t| !t.trim().is_empty()),
            None => None,
        }
    };
    use crate::notifications as k;
    let body = match (item.kind.as_str(), title) {
        (k::KIND_REBROADCAST, Some(t)) => crate::msg!("attention.shared-your-post", "shared your post \"{t}\"", t = t).english,
        (k::KIND_REBROADCAST, None) => crate::msg!("attention.shared-something-of-yours", "shared something of yours").english,
        (k::KIND_COMMENT, Some(t)) => crate::msg!("attention.replied-to-your-post", "replied to your post \"{t}\"", t = t).english,
        (k::KIND_COMMENT, None) => crate::msg!("attention.replied-to-one-of-your-posts", "replied to one of your posts").english,
        (k::KIND_TAGGED, t) => match (&item.detail, t) {
            (Some(words), Some(t)) => crate::msg!("attention.labelled-post-words", "labelled \"{t}\" \"{words}\"", t = t, words = words).english,
            (Some(words), None) => crate::msg!("attention.labelled-a-post-words", "labelled one of your posts \"{words}\"", words = words).english,
            (None, Some(t)) => crate::msg!("attention.labelled-post", "labelled your post \"{t}\"", t = t).english,
            (None, None) => crate::msg!("attention.labelled-a-post", "labelled one of your posts").english,
        },
        (k::KIND_MENTIONED, _) => crate::msg!("attention.mentioned-you-in-a-post", "mentioned you in a post").english,
        (k::KIND_ROOM_MENTION, Some(room)) => crate::msg!("attention.mentioned-you-in-room", "mentioned you in {room}", room = room).english,
        (k::KIND_ROOM_MENTION, None) => crate::msg!("attention.mentioned-you-in-a-room", "mentioned you in a room").english,
        _ => {
            let follows = item.interest.is_some();
            let vouches = item.trust.as_deref() == Some("max");
            match (follows, vouches, item.trust.is_some()) {
                (true, true, _) => crate::msg!("attention.follows-and-vouches", "follows and vouches for you").english,
                (true, false, true) => crate::msg!("attention.follows-and-trusts", "follows you publicly, and publishes their trust in you").english,
                (true, false, false) => crate::msg!("attention.follows-you", "follows you, publicly").english,
                (false, true, _) => crate::msg!("attention.vouches-for-you", "vouches for you, publicly").english,
                _ => crate::msg!("attention.trusts-you", "publishes their trust in you").english,
            }
        }
    };
    let route = if item.kind == crate::notifications::KIND_ROOM_MENTION {
        match &item.detail {
            Some(author) => format!("/home/chat/{author}/{}", item.doc_id),
            None => BELL_ROUTE.to_string(),
        }
    } else {
        BELL_ROUTE.to_string()
    };
    Alert { root: root.to_string(), title: who, body, route }
}

/// A room's name as its post titles it, or "a room" for a sealed or unheld one.
async fn room_name(state: &AppState, author: &str, doc: &str) -> String {
    match crate::identity::routes::held_public_header(state, author, doc).await {
        Ok(Some(h)) if !h.title.trim().is_empty() => h.title,
        _ => crate::msg!("attention.a-room", "a room").english,
    }
}

/// A persona's own name, for telling several apart on one machine.
async fn persona_name(state: &AppState, root: &str) -> Option<String> {
    crate::profiles::bylines(&state.node_db, &[root.to_string()])
        .await
        .ok()
        .and_then(|b| b.get(root).and_then(|b| b.name.clone()))
}

/// Someone with no name here: the first words of their speakable address.
fn short_name(root_hex: &str) -> String {
    crate::pubkey::decode(root_hex)
        .map(|r| {
            let full = crate::speakable::speakable(&r);
            full.rsplit_once('-').map(|(words, _)| words.to_string()).unwrap_or(full)
        })
        .unwrap_or_else(|| crate::msg!("attention.someone", "someone").english)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alert(route: &str, body: &str) -> Alert {
        Alert { root: "r".into(), title: "t".into(), body: body.into(), route: route.into() }
    }

    #[test]
    fn a_few_pass_through_and_a_burst_collapses_per_room() {
        let few = vec![alert(BELL_ROUTE, "a"), alert("/home/chat/x/y", "b")];
        assert_eq!(collapse("r", few).len(), 2, "under the burst, every alert stands");

        let many = vec![
            alert(BELL_ROUTE, "one"),
            alert(BELL_ROUTE, "two"),
            alert("/home/chat/x/y", "hi"),
            alert("/home/chat/x/y", "hello"),
            alert("/home/chat/z/w", "lone"),
        ];
        let out = collapse("r", many);
        assert_eq!(out.len(), 3, "one per room, one for the bell");
        assert!(out.iter().any(|a| a.route == BELL_ROUTE && a.body.contains("2 new notifications")));
        assert!(out.iter().any(|a| a.route == "/home/chat/x/y" && a.body.contains("2 new messages") && a.body.contains("hello")));
        assert!(out.iter().any(|a| a.route == "/home/chat/z/w" && a.body == "lone"), "a lone line stays itself");
    }
}
