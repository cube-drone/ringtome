//! The sync ledger (plans/SYNC_STATUS.md, piece 2): what this node is syncing right now, and what
//! it last did with each of a persona's other computers - in memory, describing this process's
//! work, reset with it, synced nowhere.
//!
//! Two levels. **A persona's own** - an exchange between computers of the same persona: pulled
//! here from one of them (the cloud's arrow down), or served from here to one (the arrow up).
//! **The network** - every other exchange this node runs: other people's chains followed,
//! peeked, served to their followers (the cloud's sun, ruling 2). Counted, never named: a
//! persona's page may say "syncing the network for 3 people" (ruling 5), never whose.
//!
//! Every exchange registers itself where it begins (`Ledger::begin_pull` in `net::sync::sync_with_peer_asking`, `Ledger::try_begin` in
//! `serve_on` once the asker is known) and holds an [`Exchange`] guard; dropping it - an
//! exchange ending any way at all, a panic or the wall clock included - takes it off the books.
//! How many entries a pull has brought so far is the persona's `entries` write count since it
//! began (`db::writes_to`), so nothing inside the exchange has to report progress.
//!
//! The corner cloud's face is computed here, debounced here (`FaceState::step`), so every open
//! tab of a persona agrees on it.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

/// The corner cloud's four faces (piece 3), in order of precedence.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Face {
    /// This persona is pulling something chunky from another of its computers.
    Down,
    /// This persona is serving something chunky to another of its computers.
    Up,
    /// The node is busy syncing for other people.
    Sun,
    /// Nothing chunky.
    Idle,
}

/// Which way an exchange runs, seen from this node.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Way {
    Pull,
    Serve,
}

/// The starting thresholds (piece 3's table; Curtis, 2026-10-07: "Those numbers [look] fine for
/// now"), to be adjusted by watching a real large sync.
pub const CHUNKY_EXCHANGE_MS: i64 = 5_000;
pub const CHUNKY_EXCHANGE_ENTRIES: u64 = 50;
pub const CHUNKY_BODIES: u64 = 10;
pub const CHUNKY_NETWORK_MS: i64 = 10_000;
pub const FACE_HOLD_MS: i64 = 3_000;
pub const FACE_LINGER_MS: i64 = 5_000;

struct Running {
    root: String,
    peer: String,
    /// What the exchange asks for (`net::sync::ledger_scope`): a room's pull is no stand-in for
    /// the persona's whole, nor a peek's for either.
    scope: String,
    way: Way,
    personal: bool,
    started_ms: i64,
    entries_at_start: u64,
}

impl Running {
    fn new(
        root: &str,
        peer: &str,
        scope: &str,
        way: Way,
        personal: bool,
        entries_at_start: u64,
    ) -> Self {
        Running {
            root: root.to_string(),
            peer: peer.to_string(),
            scope: scope.to_string(),
            way,
            personal,
            started_ms: now_ms(),
            entries_at_start,
        }
    }
}

/// What last happened with one of a persona's other computers.
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct PeerRecord {
    /// When an exchange with it last ended having reached it.
    pub reached_ms: Option<i64>,
    /// When an exchange with it was last attempted.
    pub tried_ms: Option<i64>,
    /// How many entries the last exchange brought in.
    pub moved: u64,
    /// The last attempt's failure, in words - none when it reached.
    pub error: Option<String>,
    /// At the start of the last whole exchange: entries it had that this computer didn't, and the
    /// other way round (`gap`).
    pub theirs_ahead: Option<u64>,
    pub ours_ahead: Option<u64>,
}

#[derive(Default)]
struct Books {
    next: u64,
    running: HashMap<u64, Running>,
    /// (persona root, peer endpoint) -> its record. Only a persona's own computers.
    peers: HashMap<(String, String), PeerRecord>,
    /// (persona root, peer endpoint) -> (their entries we lack, ours they lack), at the last
    /// whole exchange's start.
    gaps: HashMap<(String, String), (u64, u64)>,
    faces: HashMap<String, FaceState>,
    /// (persona root, peer endpoint, scope) -> a pull waiting for the one running to end
    /// (`begin_pull`).
    waiting: HashSet<(String, String, String)>,
}

/// The ledger, shared across the node (cloned into every `AppState`).
#[derive(Clone, Default)]
pub struct Ledger {
    books: Arc<Mutex<Books>>,
    /// Rung whenever an exchange ends, for a pull waiting its turn.
    an_exchange_ended: Arc<tokio::sync::Notify>,
}

/// One exchange on the books, for as long as it lives.
pub struct Exchange {
    books: Arc<Mutex<Books>>,
    an_exchange_ended: Arc<tokio::sync::Notify>,
    id: u64,
}

impl Drop for Exchange {
    fn drop(&mut self) {
        if let Ok(mut books) = self.books.lock() {
            books.running.remove(&self.id);
        }
        self.an_exchange_ended.notify_waiters();
    }
}

/// A pull's place in the queue, given up however its wait ends - a cancelled caller included, or
/// the pair would never pull again.
struct Waiting<'a> {
    books: &'a Mutex<Books>,
    key: (String, String, String),
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        if let Ok(mut books) = self.books.lock() {
            books.waiting.remove(&self.key);
        }
    }
}

/// Whether this persona already has an exchange of that scope running with that computer, that
/// way.
fn busy(books: &Books, root: &str, peer: &str, scope: &str, way: Way) -> bool {
    books
        .running
        .values()
        .any(|r| r.root == root && r.peer == peer && r.scope == scope && r.way == way)
}

fn now_ms() -> i64 {
    crate::clock::now_ms()
}

impl Ledger {
    fn books(&self) -> std::sync::MutexGuard<'_, Books> {
        self.books.lock().expect("sync ledger poisoned")
    }

    /// A serve begins - `personal`: between computers of the persona `root`, else the network's -
    /// unless this persona already has one of that `scope` running to that computer (plans/SYNC_STATUS.md, step
    /// 7): on 2026-10-07 a migration's server cut 23 exchanges at the wall clock in one hour, the
    /// other end's loops and dials all asking for the same chains at once. A pull the other way is
    /// no reason to refuse - eager push has both computers dial each other the moment either
    /// writes. Checked and booked under one lock, so two can't both get in.
    pub fn try_begin(
        &self,
        root: &str,
        peer: &str,
        scope: &str,
        way: Way,
        personal: bool,
    ) -> Option<Exchange> {
        let entries_at_start = crate::db::writes_to(root, "entries");
        let mut books = self.books();
        if busy(&books, root, peer, scope, way) {
            return None;
        }
        Some(
            self.book(&mut books, Running::new(root, peer, scope, way, personal, entries_at_start)),
        )
    }

    /// A pull begins, the same way - but behind one already running for this persona and that
    /// computer, not instead of it: the running pull read the other end's heads before whatever
    /// asked for this one was written, so dropping it would leave that write to anti-entropy.
    /// One waits; any more find it waiting and return `None` - it will carry their writes too.
    pub async fn begin_pull(
        &self,
        root: &str,
        peer: &str,
        scope: &str,
        personal: bool,
    ) -> Option<Exchange> {
        let mut queued: Option<Waiting<'_>> = None;
        loop {
            let ended = self.an_exchange_ended.notified();
            tokio::pin!(ended);
            ended.as_mut().enable();
            let entries_at_start = crate::db::writes_to(root, "entries");
            {
                let mut books = self.books();
                if !busy(&books, root, peer, scope, Way::Pull) {
                    let running =
                        Running::new(root, peer, scope, Way::Pull, personal, entries_at_start);
                    let exchange = self.book(&mut books, running);
                    drop(books);
                    drop(queued);
                    return Some(exchange);
                }
                if queued.is_none() {
                    let key = (root.to_string(), peer.to_string(), scope.to_string());
                    if !books.waiting.insert(key.clone()) {
                        return None;
                    }
                    queued = Some(Waiting { books: &self.books, key });
                }
            }
            ended.await;
        }
    }

    fn book(&self, books: &mut Books, running: Running) -> Exchange {
        books.next += 1;
        let id = books.next;
        books.running.insert(id, running);
        Exchange {
            books: self.books.clone(),
            an_exchange_ended: self.an_exchange_ended.clone(),
            id,
        }
    }

    /// A personal exchange ended: reached its peer (moving `moved` entries), or not (`error`).
    pub fn ended(&self, root: &str, peer: &str, moved: u64, error: Option<String>) {
        let now = now_ms();
        let mut books = self.books();
        let record = books.peers.entry((root.to_string(), peer.to_string())).or_default();
        record.tried_ms = Some(now);
        if error.is_none() || moved > 0 {
            record.reached_ms = Some(now);
        }
        record.moved = moved;
        record.error = error;
    }

    /// The corner's face for `root` now, debounced, and what the hover can say about it.
    pub fn face(&self, root: &str, bodies_waiting: u64) -> FaceNow {
        let now = now_ms();
        let mut books = self.books();
        let sample = sample(&books.running, root, bodies_waiting, now);
        let raw = sample.raw();
        let shown = books.faces.entry(root.to_string()).or_default().step(raw, now);
        FaceNow { face: shown, moved: sample.moved, people: sample.network_people }
    }

    /// What a whole exchange's hellos said about how far apart the two computers are. Kept for
    /// every peer; only a persona's own computers' are ever shown (`status`).
    pub fn gap(&self, root: &str, peer: &str, theirs_ahead: u64, ours_ahead: u64) {
        let mut books = self.books();
        let gaps = books.gaps.entry((root.to_string(), peer.to_string())).or_default();
        *gaps = (theirs_ahead, ours_ahead);
    }

    /// The whole of what the ledger knows for `root`: its exchanges running now, each of its other
    /// computers' records, and the network's work in counts.
    pub fn status(&self, root: &str) -> serde_json::Value {
        let now = now_ms();
        let books = self.books();
        let running: Vec<serde_json::Value> = books
            .running
            .values()
            .filter(|r| r.personal && r.root == root)
            .map(|r| {
                serde_json::json!({
                    "peer": r.peer,
                    "way": r.way,
                    "since_ms": r.started_ms,
                    "moved": crate::db::writes_to(&r.root, "entries").saturating_sub(r.entries_at_start),
                })
            })
            .collect();
        let peers: serde_json::Map<String, serde_json::Value> = books
            .peers
            .iter()
            .filter(|((r, _), _)| r == root)
            .map(|((r, peer), record)| {
                let mut record = record.clone();
                if let Some((theirs, ours)) = books.gaps.get(&(r.clone(), peer.clone())) {
                    record.theirs_ahead = Some(*theirs);
                    record.ours_ahead = Some(*ours);
                }
                (peer.clone(), serde_json::json!(record))
            })
            .collect();
        let network: Vec<&Running> = books.running.values().filter(|r| !r.personal).collect();
        let people: HashSet<&str> = network.iter().map(|r| r.root.as_str()).collect();
        serde_json::json!({
            "running": running,
            "computers": peers,
            "network": {
                "exchanges": network.len(),
                "pulling": network.iter().filter(|r| r.way == Way::Pull).count(),
                "serving": network.iter().filter(|r| r.way == Way::Serve).count(),
                "people": people.len(),
                "longest_ms": network.iter().map(|r| now - r.started_ms).max().unwrap_or(0),
            },
        })
    }
}

/// The face and the words the hover can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
pub struct FaceNow {
    pub face: Face,
    /// Entries the persona's pulls have brought in so far.
    pub moved: u64,
    /// How many people the node's network work is for.
    pub people: usize,
}

/// What's running, reduced to what the face is decided on.
#[derive(Debug, Default, PartialEq)]
struct Sample {
    pulling: bool,
    serving: bool,
    network: bool,
    moved: u64,
    network_people: usize,
}

fn sample(running: &HashMap<u64, Running>, root: &str, bodies_waiting: u64, now: i64) -> Sample {
    let mut s = Sample::default();
    let mut people: HashSet<&str> = HashSet::new();
    for r in running.values() {
        let age = now - r.started_ms;
        if r.personal && r.root == root {
            let moved = crate::db::writes_to(&r.root, "entries").saturating_sub(r.entries_at_start);
            s.moved += moved;
            match r.way {
                Way::Pull => {
                    s.pulling |= age >= CHUNKY_EXCHANGE_MS || moved >= CHUNKY_EXCHANGE_ENTRIES
                }
                Way::Serve => s.serving |= age >= CHUNKY_EXCHANGE_MS,
            }
        } else if !r.personal {
            people.insert(r.root.as_str());
            s.network |= age >= CHUNKY_NETWORK_MS;
        }
    }
    s.pulling |= bodies_waiting >= CHUNKY_BODIES;
    s.network_people = people.len();
    s
}

impl Sample {
    /// The face this moment asks for, before debouncing: the precedence of piece 3's table.
    fn raw(&self) -> Face {
        if self.pulling {
            Face::Down
        } else if self.serving {
            Face::Up
        } else if self.network {
            Face::Sun
        } else {
            Face::Idle
        }
    }
}

/// The corner's debounce (ruling 3): a face shows only once the state asking for it has held
/// `FACE_HOLD_MS`, and a busy face lingers `FACE_LINGER_MS` past the end - so it never blinks.
#[derive(Debug, Clone, Copy)]
pub struct FaceState {
    shown: Face,
    candidate: Face,
    candidate_since: i64,
    busy_until: i64,
}

impl Default for FaceState {
    fn default() -> Self {
        FaceState { shown: Face::Idle, candidate: Face::Idle, candidate_since: 0, busy_until: 0 }
    }
}

impl FaceState {
    /// One look at `raw` (what the moment asks for) at `now`; answers the face to show.
    pub fn step(&mut self, raw: Face, now: i64) -> Face {
        if raw != Face::Idle {
            self.busy_until = now + FACE_LINGER_MS;
        }
        if raw != self.candidate {
            self.candidate = raw;
            self.candidate_since = now;
        }
        let held = now - self.candidate_since >= FACE_HOLD_MS;
        if raw == Face::Idle {
            // Back to the plain cloud only once the linger has passed.
            if now >= self.busy_until {
                self.shown = Face::Idle;
            }
        } else if held {
            self.shown = raw;
        }
        self.shown
    }
}

/// How far apart two frontier lists are: (entries `theirs` holds that `ours` doesn't, the other way
/// round), chain by chain - a chain one side lacks counts whole, a chain both hold counts the
/// difference of their heads. Floors are ignored: what was pruned on purpose isn't missing.
pub fn gap(
    theirs: &[ringtome_proto::sync::Frontier],
    ours: &[ringtome_proto::sync::Frontier],
) -> (u64, u64) {
    type Key = ([u8; 32], u32, Option<[u8; 16]>);
    let index = |list: &[ringtome_proto::sync::Frontier]| -> HashMap<Key, (u64, u64)> {
        list.iter().map(|f| ((f.author, f.service, f.instance), (f.floor, f.head))).collect()
    };
    let (theirs, ours) = (index(theirs), index(ours));
    let ahead = |a: &HashMap<Key, (u64, u64)>, b: &HashMap<Key, (u64, u64)>| -> u64 {
        a.iter()
            .map(|(k, (floor, head))| match b.get(k) {
                Some((_, other)) => head.saturating_sub(*other),
                None => head.saturating_sub(*floor) + 1,
            })
            .sum()
    };
    (ahead(&theirs, &ours), ahead(&ours, &theirs))
}

/// The sync code (plans/SYNC_STATUS.md, piece 5): six characters made from every chain a computer
/// holds of a persona and how far each reaches - two computers holding the same chains show the
/// same code, whatever order they read them in. Heads and their hashes only: a floor is what was
/// pruned on purpose, and the inbox and chat chains (pruned per computer, `service_allows_suffix`)
/// are left out, so a difference in the code is a difference in what they should agree on.
pub fn sync_code(frontiers: &[ringtome_proto::sync::Frontier]) -> String {
    let mut chains: Vec<_> = frontiers
        .iter()
        .filter(|f| !crate::net::sync::service_allows_suffix(f.service))
        .map(|f| (f.author, f.service, f.instance, f.head, f.head_hash))
        .collect();
    chains.sort_unstable();
    let mut hasher = blake3::Hasher::new();
    for (author, service, instance, head, hash) in &chains {
        hasher.update(author);
        hasher.update(&service.to_be_bytes());
        hasher.update(&instance.unwrap_or_default());
        hasher.update(&head.to_be_bytes());
        hasher.update(hash);
    }
    // Six letters a person can read aloud: no 0/O or 1/I/L to confuse.
    const ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    hasher.finalize().as_bytes()[..6]
        .iter()
        .map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_face_shows_only_once_held_and_lingers_past_the_end() {
        let mut f = FaceState::default();
        assert_eq!(f.step(Face::Down, 0), Face::Idle, "just begun");
        assert_eq!(f.step(Face::Down, 2_999), Face::Idle, "not yet held");
        assert_eq!(f.step(Face::Down, 3_000), Face::Down, "held three seconds");
        assert_eq!(f.step(Face::Idle, 4_000), Face::Down, "lingering");
        assert_eq!(f.step(Face::Idle, 7_999), Face::Down, "still lingering");
        assert_eq!(f.step(Face::Idle, 8_000), Face::Idle, "five seconds past the last busy look");
    }

    #[test]
    fn a_blip_never_shows() {
        let mut f = FaceState::default();
        for t in (0..2_000).step_by(500) {
            assert_eq!(f.step(Face::Sun, t), Face::Idle);
        }
        assert_eq!(f.step(Face::Idle, 2_500), Face::Idle);
        assert_eq!(f.step(Face::Idle, 20_000), Face::Idle, "the blip came and went unseen");
    }

    #[test]
    fn a_change_of_busy_face_waits_its_own_hold() {
        let mut f = FaceState::default();
        f.step(Face::Up, 0);
        assert_eq!(f.step(Face::Up, 3_000), Face::Up);
        assert_eq!(f.step(Face::Down, 4_000), Face::Up, "the new face hasn't held yet");
        assert_eq!(f.step(Face::Down, 7_000), Face::Down);
    }

    #[test]
    fn precedence_is_down_up_sun_idle() {
        let all = Sample { pulling: true, serving: true, network: true, ..Default::default() };
        assert_eq!(all.raw(), Face::Down);
        assert_eq!(Sample { serving: true, network: true, ..Default::default() }.raw(), Face::Up);
        assert_eq!(Sample { network: true, ..Default::default() }.raw(), Face::Sun);
        assert_eq!(Sample::default().raw(), Face::Idle);
    }

    #[test]
    fn chunky_is_long_or_large_and_bodies_count() {
        let mut running = HashMap::new();
        let root = "ledger-test-root";
        running.insert(
            1,
            Running {
                root: root.into(),
                peer: "p".into(),
                scope: "all".into(),
                way: Way::Pull,
                personal: true,
                started_ms: 0,
                entries_at_start: 0,
            },
        );
        assert!(!sample(&running, root, 0, 4_999).pulling, "short, and nothing moved");
        assert!(sample(&running, root, 0, 5_000).pulling, "long");
        assert!(sample(&running, "another-root", 10, 0).pulling, "bodies waiting count alone");
        running.insert(
            2,
            Running {
                root: "someone-else".into(),
                peer: "q".into(),
                scope: "all".into(),
                way: Way::Serve,
                personal: false,
                started_ms: 0,
                entries_at_start: 0,
            },
        );
        let s = sample(&running, root, 0, 10_000);
        assert!(s.network);
        assert_eq!(s.network_people, 1, "counted, never named");
    }

    #[test]
    fn the_gap_counts_both_ways_a_missing_chain_whole() {
        let chain = |author: u8, floor: u64, head: u64| ringtome_proto::sync::Frontier {
            author: [author; 32],
            service: 1,
            instance: None,
            floor,
            head,
            head_hash: [0; 32],
        };
        let theirs = vec![chain(1, 0, 9), chain(2, 0, 4)];
        let ours = vec![chain(1, 0, 6), chain(3, 10, 12)];
        // Theirs: chain 1 is 3 ahead, chain 2 (5 entries) we lack whole. Ours: chain 3 (3 entries).
        assert_eq!(gap(&theirs, &ours), (8, 3));
        assert_eq!(gap(&ours, &ours), (0, 0));
    }

    #[test]
    fn the_sync_code_is_the_same_for_the_same_chains_in_any_order() {
        let chain = |author: u8, service: u32, head: u64| ringtome_proto::sync::Frontier {
            author: [author; 32],
            service,
            instance: None,
            floor: 0,
            head,
            head_hash: [head as u8; 32],
        };
        let a = vec![chain(1, 1, 5), chain(2, 4, 9)];
        let b = vec![chain(2, 4, 9), chain(1, 1, 5)];
        assert_eq!(sync_code(&a), sync_code(&b), "order doesn't matter");
        assert_eq!(sync_code(&a).len(), 6);
        assert_ne!(sync_code(&a), sync_code(&[chain(1, 1, 6), chain(2, 4, 9)]), "a head moved");
        let floored =
            vec![ringtome_proto::sync::Frontier { floor: 3, ..chain(1, 1, 5) }, chain(2, 4, 9)];
        assert_eq!(sync_code(&a), sync_code(&floored), "a pruned floor isn't a difference");
        let inbox = ringtome_proto::registry::service::INBOX_TRUSTED;
        let mut with_inbox = a.clone();
        with_inbox.push(chain(3, inbox, 40));
        assert_eq!(sync_code(&a), sync_code(&with_inbox), "per-computer chains are left out");
    }

    #[test]
    fn one_serve_per_persona_and_computer() {
        let ledger = Ledger::default();
        let first = ledger.try_begin("r1", "p1", "all", Way::Serve, true);
        assert!(first.is_some());
        assert!(ledger.try_begin("r1", "p1", "all", Way::Serve, true).is_none(), "a second serve");
        assert!(ledger.try_begin("r1", "p1", "all", Way::Pull, true).is_some(), "the other way");
        assert!(
            ledger.try_begin("r1", "p2", "all", Way::Serve, true).is_some(),
            "another computer"
        );
        assert!(ledger.try_begin("r2", "p1", "all", Way::Serve, true).is_some(), "another persona");
        assert!(ledger.try_begin("r1", "p1", "room", Way::Serve, true).is_some(), "another scope");
        drop(first);
        assert!(
            ledger.try_begin("r1", "p1", "all", Way::Serve, true).is_some(),
            "free once it ends"
        );
    }

    #[tokio::test]
    async fn a_second_pull_waits_its_turn_and_a_third_rides_it() {
        let ledger = Ledger::default();
        let first = ledger.begin_pull("r1", "p1", "all", true).await.expect("free");
        let behind = {
            let ledger = ledger.clone();
            tokio::spawn(async move { ledger.begin_pull("r1", "p1", "all", true).await.is_some() })
        };
        while !ledger.books().waiting.contains(&("r1".into(), "p1".into(), "all".into())) {
            tokio::task::yield_now().await;
        }
        assert!(
            ledger.begin_pull("r1", "p1", "all", true).await.is_none(),
            "the third rides the second"
        );
        assert!(ledger.begin_pull("r1", "p2", "all", true).await.is_some(), "another computer");
        assert!(ledger.begin_pull("r1", "p1", "room", true).await.is_some(), "another scope");
        drop(first);
        assert!(behind.await.unwrap(), "the second runs once the first ends");
        assert!(ledger.books().waiting.is_empty());
    }

    #[tokio::test]
    async fn a_cancelled_wait_gives_up_its_place() {
        let ledger = Ledger::default();
        let first = ledger.begin_pull("r1", "p1", "all", true).await.expect("free");
        let gave_up = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            ledger.begin_pull("r1", "p1", "all", true),
        )
        .await;
        assert!(gave_up.is_err(), "still waiting when cancelled");
        assert!(ledger.books().waiting.is_empty(), "and its place is free");
        drop(first);
        assert!(ledger.begin_pull("r1", "p1", "all", true).await.is_some());
    }
}
