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
//! bump the epoch rather than write. Idle, a tick costs two stats per persona.
//!
//! **Only the personas somebody is listening for.** An embedder (the desktop app) and the test
//! recorder listen for everyone; Web Push (webpush.rs) listens only for the personas with a
//! subscription. A hosted node whose members never turned push on does no work here at all.
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
    /// The picture the words carry, if any (2026-09-27, Curtis: "can we actually include the
    /// image in the notification"): a room line's first still, as the public twin path it
    /// was baked to - `/id/<speaker>/docs/<twin>/body/media.avif`. A browser fetches it itself
    /// (sw.js), under the reader's own session, which is what a sealed room's twin asks for.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picture: Option<String>,
    /// That picture as a small PNG, for an embedder to hand its operating system - rendered
    /// only while an embedder listens (`watch_window`), since not every platform's
    /// notification reads AVIF. Its size is what the test recorder shows.
    #[serde(
        rename = "picture_png_bytes",
        serialize_with = "png_size",
        skip_serializing_if = "Option::is_none"
    )]
    pub picture_png: Option<Arc<Vec<u8>>>,
}

fn png_size<S: serde::Serializer>(png: &Option<Arc<Vec<u8>>>, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_u64(png.as_ref().map_or(0, |p| p.len() as u64))
}

/// The side a notification's picture is bounded to: bigger than any banner shows it.
const PICTURE_BOUND: u32 = 720;

/// The node's announcer: a broadcast any embedder may subscribe to, plus a small recorder a
/// test rig can read back (`/test/attention`), armed only in local-test mode.
#[derive(Clone)]
pub struct Attention {
    tx: tokio::sync::broadcast::Sender<Alert>,
    recorded: Option<Arc<Mutex<VecDeque<Alert>>>>,
    /// Somebody listens for every persona (the test recorder).
    everyone: Arc<std::sync::atomic::AtomicBool>,
    /// The desktop app listens - for the personas of whichever account is signed in to its own
    /// window, and nobody else's (Curtis, 2026-09-28: a desktop node is multi-user now, and one
    /// person's messages must not pop up on the screen of whoever sits at it).
    embedder: Arc<std::sync::atomic::AtomicBool>,
    /// That account, as the window's own requests say (auth/extractor.rs), and its personas,
    /// refreshed by the watcher.
    window_account: Arc<Mutex<Option<String>>>,
    window_roots: Arc<Mutex<HashSet<String>>>,
    /// The personas Web Push listens for: those with at least one subscription.
    push_roots: Arc<Mutex<HashSet<String>>>,
}

impl Attention {
    pub fn new(record: bool) -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(64);
        Self {
            tx,
            recorded: record.then(Default::default),
            everyone: Arc::new(std::sync::atomic::AtomicBool::new(record)),
            embedder: Default::default(),
            window_account: Default::default(),
            window_roots: Default::default(),
            push_roots: Default::default(),
        }
    }

    /// Listen for alerts. A receiver that falls behind skips ahead (broadcast's lag), which
    /// for notifications is the right failure: the oldest news is the least worth showing.
    /// Subscribing alone watches nobody new: say whom with [`Self::watch_window`] or
    /// [`Self::watch_for_push`].
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Alert> {
        self.tx.subscribe()
    }

    /// Watch the personas of the account signed in to the embedder's window (`Bound::attention`).
    pub fn watch_window(&self) {
        self.embedder.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Who is signed in to the embedder's window: an account id, or nobody. Its personas are
    /// picked up by the watcher's next tick; nobody's are dropped at once.
    pub fn set_window_account(&self, account: Option<String>) {
        let mut held = self.window_account.lock().expect("window account poisoned");
        if *held == account {
            return;
        }
        // Whoever it was, their personas stop now; the new account's start at the next tick.
        self.window_roots.lock().expect("window roots poisoned").clear();
        *held = account;
    }

    /// The account the window is signed in as. Only ever set on a node with a launch token - the
    /// desktop app's, or the rig's device node - since only the window can say (auth/extractor.rs).
    pub fn window_account(&self) -> Option<String> {
        self.window_account.lock().expect("window account poisoned").clone()
    }

    fn set_window_roots(&self, roots: HashSet<String>) {
        *self.window_roots.lock().expect("window roots poisoned") = roots;
    }

    /// Watch one persona for Web Push (a subscription exists).
    pub fn watch_for_push(&self, root: &str) {
        self.push_roots.lock().expect("push roots poisoned").insert(root.to_string());
    }

    /// Stop watching one persona for Web Push (its last subscription went).
    pub fn unwatch_for_push(&self, root: &str) {
        self.push_roots.lock().expect("push roots poisoned").remove(root);
    }

    /// The recorder's alerts for one persona, oldest first - the test rig's read.
    pub fn recorded(&self, root: &str) -> Vec<Alert> {
        self.recorded
            .as_ref()
            .map(|r| {
                r.lock()
                    .expect("attention recorder poisoned")
                    .iter()
                    .filter(|a| a.root == root)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Is anybody listening for this persona?
    fn wanted(&self, root: &str) -> bool {
        self.everyone.load(std::sync::atomic::Ordering::SeqCst)
            || self.window_roots.lock().expect("window roots poisoned").contains(root)
            || self.push_roots.lock().expect("push roots poisoned").contains(root)
    }

    /// Does an embedder listen - someone who will want an alert's picture as a file?
    fn embedded(&self) -> bool {
        self.everyone.load(std::sync::atomic::Ordering::SeqCst)
            || self.embedder.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Is anybody listening for anyone? (What lets an idle tick skip even the hosted-roots read.)
    fn any_wanted(&self) -> bool {
        self.everyone.load(std::sync::atomic::Ordering::SeqCst)
            || !self.window_roots.lock().expect("window roots poisoned").is_empty()
            || !self.push_roots.lock().expect("push roots poisoned").is_empty()
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
                // The window's personas, read afresh: a persona made a moment ago is watched
                // from the next tick, and a signed-out window watches none.
                if let Some(account) = state.attention.window_account() {
                    if let Ok(roots) = roots_of(&state, &account).await {
                        state.attention.set_window_roots(roots);
                    }
                }
                if !state.attention.any_wanted() { continue; }
                let Ok(roots) = crate::identity::hosted_roots(&state.node_db).await else { continue };
                for root in roots.into_iter().filter(|r| state.attention.wanted(r)) {
                    let now = (state.user_dbs.db_mtime_ms(&root), state.view_epochs.get(&root));
                    if guards.get(&root) != Some(&now) {
                        guards.insert(root.clone(), now);
                        dirty.insert(root);
                    }
                }
            }
            who = crate::db::await_write_nudge(&mut nudge) => {
                if !state.attention.any_wanted() { continue; }
                match who {
                    Some(root) => { guards.remove(&root); dirty.insert(root); }
                    None => everyone = true, // lagged: nobody can rule themselves out
                }
            }
        }
        let Ok(hosted) = crate::identity::hosted_roots(&state.node_db).await else { continue };
        let many = hosted.len() > 1;
        for root in
            hosted.iter().filter(|r| (everyone || dirty.contains(*r)) && state.attention.wanted(r))
        {
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
                        if alert.picture.is_some() {
                            // The line can fold here a moment before its picture's bytes
                            // (fragments' eager heal is detached): the picture waits for them
                            // on its own, not on this loop.
                            let (state, root) = (state.clone(), root.clone());
                            tokio::spawn(async move {
                                with_picture(&state, &root, &mut alert).await;
                                state.attention.publish(alert);
                            });
                            continue;
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

/// The personas an account holds on this node.
async fn roots_of(state: &AppState, account: &str) -> anyhow::Result<HashSet<String>> {
    let account = uuid::Uuid::parse_str(account)?;
    let held = crate::identity::list_for_account(&state.node_db, &account)
        .await
        .map_err(|e| anyhow::anyhow!("listing the window account's personas: {e:?}"))?;
    Ok(held.into_iter().map(|i| i.root_pubkey).collect())
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
    for (author, doc, since) in crate::identity::routes::chat_rooms_with_seen(state, &data, root)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        let lines =
            crate::chat::unseen_lines(state, &author, &doc, since, root, LINES_PER_ROOM).await?;
        if lines.is_empty() {
            continue;
        }
        let fresh: Vec<&crate::chat::UnseenLine> =
            lines.iter().filter(|l| !known.chat.contains(&l.hash)).collect();
        if !fresh.is_empty() {
            let room = room_name(state, &author, &doc).await;
            let route = room_route(&author, &doc);
            // Newest first, as read: one alert per line, collapsed below if there are many.
            for line in fresh.into_iter().rev() {
                let who = line.speaker_name.clone().unwrap_or_else(|| short_name(&line.speaker));
                let (body, picture) = match &line.words {
                    Some(words) => line_words(words, &line.speaker),
                    None => (crate::msg!("attention.a-new-message", "a new message").english, None),
                };
                alerts.push(Alert {
                    root: root.to_string(),
                    title: crate::msg!(
                        "attention.speaker-in-room",
                        "{who} in {room}",
                        who = who,
                        room = room
                    )
                    .english,
                    body,
                    route: route.clone(),
                    picture,
                    picture_png: None,
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
                body: crate::msg!("attention.n-new-notifications", "{n} new notifications", n = n)
                    .english,
                route,
                picture: None,
                picture_png: None,
            });
        } else {
            out.push(Alert {
                root: root.to_string(),
                title: last.title,
                body: crate::msg!(
                    "attention.n-new-messages",
                    "{n} new messages - latest: {words}",
                    n = n,
                    words = last.body
                )
                .english,
                route,
                picture: last.picture,
                picture_png: None,
            });
        }
    }
    out
}

const BELL_ROUTE: &str = "/ringtome/notifications";

/// A room's address in the app (PROJECT_PLAN's "`/ringtome/` replaces `/home`, `/in` and `/id`",
/// 2026-09-28): `/ringtome/user/<author, short form>/room/<doc>`. An author that is not a hex root
/// keeps its spelling - the app's resolver answers for it either way.
fn room_route(author_hex: &str, doc: &str) -> String {
    let seg = hex::decode(author_hex)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b).ok())
        .map(|root| {
            crate::speakable::speakable(&root).rsplit('-').next().unwrap_or_default().to_string()
        })
        .unwrap_or_else(|| author_hex.to_string());
    format!("/ringtome/user/{seg}/room/{doc}")
}

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
            .map(|c| {
                crate::msg!("attention.claimed-name", "\"{name}\" (unverified)", name = c).english
            })
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
        let doc =
            hex::decode(&item.doc_id).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok());
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
    // A contract is the bank's own news, about the reader themselves (notifications.rs
    // `KIND_CONTRACT`): its own sentence, under the bank's name rather than the reader's. Without
    // this arm a contract fell through to the band ladder below and, carrying no bands, said
    // "publishes their trust in you" - from the reader, to the reader, once per contract (Curtis,
    // 2026-10-07: eighteen of them, after a migration completed eighteen contracts at once).
    if item.kind == k::KIND_CONTRACT {
        return contract_alert(root, item);
    }
    let body = match (item.kind.as_str(), title) {
        (k::KIND_REBROADCAST, Some(t)) => {
            crate::msg!("attention.shared-your-post", "shared your post \"{t}\"", t = t).english
        }
        (k::KIND_REBROADCAST, None) => {
            crate::msg!("attention.shared-something-of-yours", "shared something of yours").english
        }
        (k::KIND_COMMENT, Some(t)) => {
            crate::msg!("attention.replied-to-your-post", "replied to your post \"{t}\"", t = t)
                .english
        }
        (k::KIND_COMMENT, None) => {
            crate::msg!("attention.replied-to-one-of-your-posts", "replied to one of your posts")
                .english
        }
        (k::KIND_TAGGED, t) => match (&item.detail, t) {
            (Some(words), Some(t)) => {
                crate::msg!(
                    "attention.labelled-post-words",
                    "labelled \"{t}\" \"{words}\"",
                    t = t,
                    words = words
                )
                .english
            }
            (Some(words), None) => {
                crate::msg!(
                    "attention.labelled-a-post-words",
                    "labelled one of your posts \"{words}\"",
                    words = words
                )
                .english
            }
            (None, Some(t)) => {
                crate::msg!("attention.labelled-post", "labelled your post \"{t}\"", t = t).english
            }
            (None, None) => {
                crate::msg!("attention.labelled-a-post", "labelled one of your posts").english
            }
        },
        (k::KIND_MENTIONED, _) => {
            crate::msg!("attention.mentioned-you-in-a-post", "mentioned you in a post").english
        }
        (k::KIND_ROOM_MENTION, Some(room)) => {
            crate::msg!("attention.mentioned-you-in-room", "mentioned you in {room}", room = room)
                .english
        }
        (k::KIND_ROOM_MENTION, None) => {
            crate::msg!("attention.mentioned-you-in-a-room", "mentioned you in a room").english
        }
        // The band ladder is the public edge's alone. Any kind this match doesn't know says only
        // that something happened - never another kind's news (the miscopy that made a contract
        // read as trust, 2026-10-07, and a share before it, 2026-08-25).
        (kind, _) if kind != k::KIND_PUBLIC_EDGE => {
            crate::msg!("attention.has-news-for-you", "has news for you").english
        }
        _ => {
            let follows = item.interest.is_some();
            let vouches = item.trust.as_deref() == Some("max");
            match (follows, vouches, item.trust.is_some()) {
                (true, true, _) => {
                    crate::msg!("attention.follows-and-vouches", "follows and trusts you").english
                }
                (true, false, true) => {
                    crate::msg!(
                        "attention.follows-and-trusts",
                        "follows you publicly, and publishes their trust in you"
                    )
                    .english
                }
                (true, false, false) => {
                    crate::msg!("attention.follows-you", "follows you, publicly").english
                }
                (false, true, _) => {
                    crate::msg!("attention.vouches-for-you", "trusts you, publicly").english
                }
                _ => crate::msg!("attention.trusts-you", "publishes their trust in you").english,
            }
        }
    };
    let route = if item.kind == crate::notifications::KIND_ROOM_MENTION {
        match &item.detail {
            Some(author) => room_route(author, &item.doc_id),
            None => BELL_ROUTE.to_string(),
        }
    } else {
        BELL_ROUTE.to_string()
    };
    Alert { root: root.to_string(), title: who, body, route, picture: None, picture_png: None }
}

/// A completed contract as an alert, in the bell's words (js/apps/notifications.js
/// `contractWords`): its name - the registry's, else what the row carries - and its reward.
fn contract_alert(root: &str, item: &crate::identity::routes::NotificationItem) -> Alert {
    let said: serde_json::Value =
        item.detail.as_deref().and_then(|d| serde_json::from_str(d).ok()).unwrap_or_default();
    let name = crate::bank::CONTRACTS
        .iter()
        .find(|c| c.id == item.doc_id)
        .map(|c| c.name.to_string())
        .or_else(|| said.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .unwrap_or_else(|| item.doc_id.clone());
    let money =
        crate::bank::horsebucks(said.get("pennies").and_then(|p| p.as_str()).unwrap_or("0"));
    Alert {
        root: root.to_string(),
        title: crate::msg!("attention.hrsebank", "hrseBank™").english,
        body: crate::msg!(
            "attention.you-completed-the-contract",
            "You completed the {name} contract! Have H$ {money}!",
            name = name,
            money = money
        )
        .english,
        route: BELL_ROUTE.to_string(),
        picture: None,
        picture_png: None,
    }
}

/// A room line as a notification says it: its words plain, each embed named for what it is -
/// a line that is only a picture reads "sent a picture" - and its first still picture, as
/// the twin path it was baked to (chat.rs `bake_words`: always on the speaker's own root).
fn line_words(words: &str, speaker: &str) -> (String, Option<String>) {
    let picture = crate::record::bake::public_media_refs(words, speaker)
        .into_iter()
        .map(|(target, _)| target)
        .find(|t| t.ends_with(".avif"));
    let embed_word = |target: &str| {
        if target.ends_with(".avif") || target.ends_with(".apng") {
            crate::msg!("attention.a-picture", "(picture)").english
        } else if target.ends_with(".webm") {
            crate::msg!("attention.a-video", "(video)").english
        } else if target.ends_with(".opus") {
            crate::msg!("attention.a-sound", "(sound)").english
        } else {
            crate::msg!("attention.an-attachment", "(attachment)").english
        }
    };
    let body = match crate::record::bake::plain_words(words, &embed_word) {
        Some(plain) if plain == crate::msg!("attention.a-picture", "(picture)").english => {
            crate::msg!("attention.sent-a-picture", "sent a picture").english
        }
        Some(plain) if !plain.is_empty() => plain,
        Some(_) => crate::msg!("attention.a-new-message", "a new message").english,
        None => words.to_string(),
    };
    (body, picture)
}

/// Ready an alert's picture before it is told: wait (briefly) for its bytes to be here - so a
/// browser fetching it (sw.js) finds it - and, for an embedder, render it as the PNG it hands
/// its operating system. A picture that never comes leaves the alert without one, a little late.
async fn with_picture(state: &AppState, root: &str, alert: &mut Alert) {
    let Some(picture) = alert.picture.clone() else { return };
    for attempt in 0..PICTURE_TRIES {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let Some(avif) = picture_bytes(state, root, &picture).await else { continue };
        if state.attention.embedded() {
            let png = tokio::task::spawn_blocking(move || {
                crate::media::image::avif_to_png(&avif, PICTURE_BOUND)
            })
            .await;
            match png {
                Ok(Ok(png)) => alert.picture_png = Some(Arc::new(png)),
                Ok(Err(e)) => {
                    tracing::debug!(error = %e, "a notification's picture would not decode")
                }
                Err(e) => tracing::debug!(error = %e, "a notification's picture render stopped"),
            }
        }
        return;
    }
    alert.picture = None;
}

/// How many times a picture is looked for, half a second apart.
const PICTURE_TRIES: usize = 10;

/// An alert's picture bytes, read the way the persona's own browser reads them - through the
/// public door, as the account that hosts `root` - so a sealed room's picture opens for its
/// member exactly as it does on screen, and for nobody else. `None` while it will not serve.
async fn picture_bytes(state: &AppState, root: &str, picture: &str) -> Option<axum::body::Bytes> {
    let (author, twin) = crate::record::bake::twin_address(picture)?;
    let (seg, doc_hex) = (hex::encode(author), hex::encode(twin));
    let (seg, doc_hex) = (seg.as_str(), doc_hex.as_str());
    let (_, account) = crate::identity::hosted_roots_with_accounts(&state.node_db)
        .await
        .ok()?
        .into_iter()
        .find(|(r, _)| r == root)?;
    let session = Some(crate::auth::Session {
        key: None,
        by_agent: false,
        account: crate::auth::Account { id: account, username: String::new() },
    });
    let response =
        crate::idface::public_doc_bytes(state, &session, seg, doc_hex, false, None, None)
            .await
            .ok()?;
    if !response.status().is_success() {
        return None;
    }
    axum::body::to_bytes(response.into_body(), MAX_PICTURE_BYTES).await.ok()
}

/// The most of a picture's bytes a notification reads - past every crushed still.
const MAX_PICTURE_BYTES: usize = 16 * 1024 * 1024;

/// A room's name as its post titles it, or "a room" for a sealed or unheld one.
/// A room's name for a notification: `# <title>` (Curtis, 2026-09-28 - a room is marked as one
/// wherever its title stands), or the bare title of a private chat for two, which names a person.
async fn room_name(state: &AppState, author: &str, doc: &str) -> String {
    let title = match crate::identity::routes::held_public_header(state, author, doc).await {
        Ok(Some(h)) if !h.title.trim().is_empty() => h.title,
        _ => return crate::msg!("attention.a-room", "a room").english,
    };
    let im = match hex::decode(doc).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok()) {
        Some(doc) => crate::chat::is_im(state, author, &doc).await,
        None => false,
    };
    if im {
        title
    } else {
        format!("# {title}")
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

    /// The desktop app hears the window's account and nobody else (2026-09-28): another account
    /// on the same computer stays quiet, and a change of who is signed in drops the last one's
    /// personas at once rather than at the next tick.
    #[test]
    fn the_app_hears_only_the_window_account() {
        let a = Attention::new(false);
        a.watch_window();
        assert!(!a.any_wanted(), "nobody signed in: nobody heard");
        a.set_window_account(Some("acct-1".into()));
        a.set_window_roots(HashSet::from(["mine".to_string()]));
        assert!(a.wanted("mine"));
        assert!(!a.wanted("theirs"), "another account's persona on this node");
        a.set_window_account(Some("acct-2".into()));
        assert!(!a.wanted("mine"), "signed in as someone else");
        a.set_window_account(None);
        assert!(!a.any_wanted());
    }

    fn alert(route: &str, body: &str) -> Alert {
        Alert {
            root: "r".into(),
            title: "t".into(),
            body: body.into(),
            route: route.into(),
            picture: None,
            picture_png: None,
        }
    }

    #[test]
    fn a_few_pass_through_and_a_burst_collapses_per_room() {
        let few = vec![alert(BELL_ROUTE, "a"), alert("/ringtome/user/x/room/y", "b")];
        assert_eq!(collapse("r", few).len(), 2, "under the burst, every alert stands");

        let many = vec![
            alert(BELL_ROUTE, "one"),
            alert(BELL_ROUTE, "two"),
            alert("/ringtome/user/x/room/y", "hi"),
            alert("/ringtome/user/x/room/y", "hello"),
            alert("/ringtome/user/z/room/w", "lone"),
        ];
        let out = collapse("r", many);
        assert_eq!(out.len(), 3, "one per room, one for the bell");
        assert!(out
            .iter()
            .any(|a| a.route == BELL_ROUTE && a.body.contains("2 new notifications")));
        assert!(out.iter().any(|a| a.route == "/ringtome/user/x/room/y"
            && a.body.contains("2 new messages")
            && a.body.contains("hello")));
        assert!(
            out.iter().any(|a| a.route == "/ringtome/user/z/room/w" && a.body == "lone"),
            "a lone line stays itself"
        );
    }

    /// A completed contract alerts as the bank's news, in the bell's words - never as the
    /// reader's trust in themselves (2026-10-07: a migration's eighteen contracts read
    /// "publishes their trust in you", from the reader, to the reader).
    #[test]
    fn a_contract_alerts_as_the_banks_news() {
        let me = "ab".repeat(32);
        let item = crate::identity::routes::NotificationItem {
            author: me.clone(),
            kind: crate::notifications::KIND_CONTRACT.to_string(),
            trust: None,
            interest: None,
            detail: Some(r#"{"name":"Draw a horse","pennies":"500000"}"#.to_string()),
            doc_title: None,
            doc_published_ms: None,
            updated_ms: 0,
            seen: false,
            stranger: false,
            doc_id: "draw-a-horse".to_string(),
            author_name: Some("Cube Drone".to_string()),
            author_avatar: None,
            claimed_name: None,
        };
        let alert = contract_alert(&me, &item);
        assert_eq!(alert.title, "hrseBank™");
        assert!(alert.body.starts_with("You completed the "), "{}", alert.body);
        assert!(alert.body.ends_with("contract! Have H$ 5,000.00!"), "{}", alert.body);
        assert!(!alert.body.contains("trust"), "{}", alert.body);
    }
}
