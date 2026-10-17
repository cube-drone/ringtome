//! The machine table (plans/NETWORK.md, 2026-10-17): every machine this node has connected with,
//! either way, under the name it announces, and how reliably it answers - one memory shared by
//! every kind of sync, kept across restarts.
//!
//! **Written off the connect path.** Every outbound connect goes through `p2p::dial` and every
//! inbound one through the accept loop, and both tell the book here, in memory - as the dark book
//! beside it is told. A periodic flush writes the rows that moved to `node.db`; boot loads them
//! back, and a machine whose last word was a failure comes back dark for the shortest window, so
//! a restart no longer forgets which machines don't answer.
//!
//! **About machines, never about people.** A row says what any peer learns by dialing: an endpoint,
//! a name, whether it answers. Which persona or group an exchange was for is never recorded here;
//! the Network page joins each person's own links at read time (`links`), from the tables that
//! already hold them, and only for that person.

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex, RwLock};

use anyhow::{Context, Result};
use serde::Serialize;

use crate::clock::now_ms;
use crate::db::Db;

/// Each outcome first scales both counts by this, so they are a recent history: after about
/// twenty connects, what happened before weighs a third as much.
const DECAY: f64 = 0.95;
/// How much one connect's time moves the running average.
const CONNECT_WEIGHT: f64 = 0.2;
/// A machine silent this long, either way, leaves the table.
const FORGET_AFTER_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// The longest error kept, in bytes.
const MAX_ERROR: usize = 300;

/// One machine, as this node knows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Machine {
    pub endpoint: String,
    pub name: Option<String>,
    pub version: Option<String>,
    pub first_seen_ms: i64,
    pub last_ok_ms: Option<i64>,
    pub last_fail_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_inbound_ms: Option<i64>,
    pub oks: f64,
    pub fails: f64,
    pub connect_ms: Option<f64>,
    /// Which protocols touched it, and when last.
    pub lanes: BTreeMap<String, i64>,
}

impl Machine {
    fn new(endpoint: &str, now: i64) -> Self {
        Self { endpoint: endpoint.to_string(), first_seen_ms: now, ..Default::default() }
    }

    /// The smoothed share of outbound connects that worked: one half for a machine never
    /// dialed - unknown, neither trusted nor written off.
    pub fn reliability(&self) -> f64 {
        reliability(self.oks, self.fails)
    }

    /// When this node last tried it, whichever way the try went.
    pub fn last_tried_ms(&self) -> Option<i64> {
        self.last_ok_ms.max(self.last_fail_ms)
    }

    /// When anything last happened with it, either way.
    fn last_heard_ms(&self) -> i64 {
        [self.last_ok_ms, self.last_fail_ms, self.last_inbound_ms]
            .into_iter()
            .flatten()
            .max()
            .unwrap_or(self.first_seen_ms)
    }

    /// The last word was a failure: it comes back from a restart dark.
    fn last_failed(&self) -> bool {
        match (self.last_fail_ms, self.last_ok_ms.max(self.last_inbound_ms)) {
            (Some(fail), Some(ok)) => fail > ok,
            (Some(_), None) => true,
            _ => false,
        }
    }
}

/// `(oks + 1) / (oks + fails + 2)`: a success rate that starts at a half and needs a few outcomes
/// to move far from it.
pub fn reliability(oks: f64, fails: f64) -> f64 {
    (oks + 1.0) / (oks + fails + 2.0)
}

/// The machines, and which of them moved since the last flush.
#[derive(Default)]
pub struct Book {
    machines: HashMap<String, Machine>,
    dirty: std::collections::HashSet<String>,
}

impl Book {
    fn entry(&mut self, endpoint: &str, now: i64) -> &mut Machine {
        self.dirty.insert(endpoint.to_string());
        self.machines.entry(endpoint.to_string()).or_insert_with(|| Machine::new(endpoint, now))
    }

    /// An outbound connect that worked, in `took_ms`.
    pub fn connected(&mut self, endpoint: &str, alpn: &str, took_ms: f64, now: i64) {
        let m = self.entry(endpoint, now);
        m.oks = m.oks * DECAY + 1.0;
        m.fails *= DECAY;
        m.last_ok_ms = Some(now);
        m.connect_ms = Some(match m.connect_ms {
            Some(avg) => avg + (took_ms - avg) * CONNECT_WEIGHT,
            None => took_ms,
        });
        m.lanes.insert(alpn.to_string(), now);
    }

    /// An outbound connect that didn't.
    pub fn failed(&mut self, endpoint: &str, alpn: &str, error: &str, now: i64) {
        let m = self.entry(endpoint, now);
        m.fails = m.fails * DECAY + 1.0;
        m.oks *= DECAY;
        m.last_fail_ms = Some(now);
        let mut end = error.len().min(MAX_ERROR);
        while !error.is_char_boundary(end) {
            end -= 1;
        }
        m.last_error = Some(error[..end].to_string());
        // Tried, so the lane counts as touched: the page says which road found it dark.
        m.lanes.entry(alpn.to_string()).or_insert(now);
    }

    /// It dialed this node.
    pub fn dialed_in(&mut self, endpoint: &str, alpn: &str, now: i64) {
        let m = self.entry(endpoint, now);
        m.last_inbound_ms = Some(now);
        m.lanes.insert(alpn.to_string(), now);
    }

    /// What it said of itself in a Hello. An empty slot (an older build) leaves what it said
    /// before.
    pub fn announced(&mut self, endpoint: &str, name: &str, version: &str, now: i64) {
        let known = self.machines.get(endpoint);
        let same = known.is_some_and(|m| {
            (name.is_empty() || m.name.as_deref() == Some(name))
                && (version.is_empty() || m.version.as_deref() == Some(version))
        });
        if same {
            return;
        }
        let m = self.entry(endpoint, now);
        if !name.is_empty() {
            m.name = Some(name.to_string());
        }
        if !version.is_empty() {
            m.version = Some(version.to_string());
        }
    }

    pub fn get(&self, endpoint: &str) -> Option<&Machine> {
        self.machines.get(endpoint)
    }

    /// Every machine, the most recently heard first.
    pub fn all(&self) -> Vec<Machine> {
        let mut out: Vec<Machine> = self.machines.values().cloned().collect();
        out.sort_by_key(|m| std::cmp::Reverse(m.last_heard_ms()));
        out
    }

    /// The rows that moved since the last call, taken.
    fn take_dirty(&mut self) -> Vec<Machine> {
        let dirty = std::mem::take(&mut self.dirty);
        dirty.iter().filter_map(|e| self.machines.get(e).cloned()).collect()
    }

    /// Put rows back as dirty when their write failed, so the next flush tries again.
    fn redirty(&mut self, endpoints: impl IntoIterator<Item = String>) {
        self.dirty.extend(endpoints);
    }

    /// Machines silent past the cutoff leave the book.
    fn forget_before(&mut self, cutoff: i64) {
        self.machines.retain(|_, m| m.last_heard_ms() >= cutoff);
    }
}

/// The node's one book.
static BOOK: LazyLock<Mutex<Book>> = LazyLock::new(Default::default);

fn with_book<T>(f: impl FnOnce(&mut Book) -> T) -> Option<T> {
    BOOK.lock().ok().map(|mut b| f(&mut b))
}

/// `p2p::dial`: a connect worked.
pub fn connected(endpoint: &str, alpn: &str, took_ms: f64) {
    with_book(|b| b.connected(endpoint, alpn, took_ms, now_ms()));
}

/// `p2p::dial`: a connect didn't.
pub fn failed(endpoint: &str, alpn: &str, error: &str) {
    with_book(|b| b.failed(endpoint, alpn, error, now_ms()));
}

/// The accept loop: a machine dialed in.
pub fn dialed_in(endpoint: &str, alpn: &str) {
    with_book(|b| b.dialed_in(endpoint, alpn, now_ms()));
}

/// The sync lane: a Hello named its sender.
pub fn announced(endpoint: &str, name: &str, version: &str) {
    with_book(|b| b.announced(endpoint, name, version, now_ms()));
}

/// One machine, as the book holds it.
pub fn machine(endpoint: &str) -> Option<Machine> {
    with_book(|b| b.get(endpoint).cloned()).flatten()
}

/// Every machine, the most recently heard first.
pub fn all() -> Vec<Machine> {
    with_book(|b| b.all()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------
// The table

type Row = (
    String,
    Option<String>,
    Option<String>,
    i64,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<i64>,
    i64,
    i64,
    Option<i64>,
);

/// The counts are kept in thousandths: the table binds integers.
const MILLI: f64 = 1000.0;

/// Read the table into `book`: every machine, and the protocols that touched it. Answers the
/// machines whose last word was a failure, for the dark book.
async fn load_into(db: &Db, book: &mut Book) -> Result<Vec<String>> {
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT endpoint_id, name, version, first_seen_ms, last_ok_ms, last_fail_ms, last_error,
                    last_inbound_ms, oks, fails, connect_ms
             FROM machines",
            (),
        )
        .await
        .context("reading the machine table")?;
    let lanes: Vec<(String, String, i64)> = db
        .fetch_all("SELECT endpoint_id, alpn, last_ms FROM machine_lanes", ())
        .await
        .context("reading the machines' protocols")?;
    let mut dark = Vec::new();
    for (endpoint, name, version, first, ok, fail, error, inbound, oks, fails, connect) in rows {
        let m = Machine {
            endpoint: endpoint.clone(),
            name,
            version,
            first_seen_ms: first,
            last_ok_ms: ok,
            last_fail_ms: fail,
            last_error: error,
            last_inbound_ms: inbound,
            oks: oks as f64 / MILLI,
            fails: fails as f64 / MILLI,
            connect_ms: connect.map(|c| c as f64),
            lanes: BTreeMap::new(),
        };
        if m.last_failed() {
            dark.push(endpoint.clone());
        }
        book.machines.insert(endpoint, m);
    }
    for (endpoint, alpn, at) in lanes {
        if let Some(m) = book.machines.get_mut(&endpoint) {
            m.lanes.insert(alpn, at);
        }
    }
    Ok(dark)
}

/// Write the rows that moved, and forget the machines silent too long - in the book and the
/// table both.
async fn flush_from(db: &Db, book: &Mutex<Book>, now: i64) -> Result<()> {
    let rows = book.lock().map(|mut b| b.take_dirty()).unwrap_or_default();
    let mut failed: Vec<String> = Vec::new();
    for m in &rows {
        if let Err(e) = write_row(db, m).await {
            tracing::debug!(endpoint = %m.endpoint, error = ?e, "a machine row didn't write");
            failed.push(m.endpoint.clone());
        }
    }
    let cutoff = now - FORGET_AFTER_MS;
    if let Ok(mut b) = book.lock() {
        b.redirty(failed);
        b.forget_before(cutoff);
    }
    db.execute(
        "DELETE FROM machines WHERE MAX(first_seen_ms, COALESCE(last_ok_ms, 0),
             COALESCE(last_fail_ms, 0), COALESCE(last_inbound_ms, 0)) < ?1",
        (cutoff,),
    )
    .await
    .context("forgetting silent machines")?;
    db.execute(
        "DELETE FROM machine_lanes WHERE endpoint_id NOT IN (SELECT endpoint_id FROM machines)",
        (),
    )
    .await
    .context("forgetting silent machines' protocols")?;
    Ok(())
}

async fn write_row(db: &Db, m: &Machine) -> Result<()> {
    db.execute(
        "INSERT INTO machines (endpoint_id, name, version, first_seen_ms, last_ok_ms, last_fail_ms,
                               last_error, last_inbound_ms, oks, fails, connect_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT (endpoint_id) DO UPDATE SET
             name = excluded.name, version = excluded.version,
             first_seen_ms = MIN(machines.first_seen_ms, excluded.first_seen_ms),
             last_ok_ms = excluded.last_ok_ms, last_fail_ms = excluded.last_fail_ms,
             last_error = excluded.last_error, last_inbound_ms = excluded.last_inbound_ms,
             oks = excluded.oks, fails = excluded.fails, connect_ms = excluded.connect_ms",
        (
            m.endpoint.as_str(),
            m.name.as_deref(),
            m.version.as_deref(),
            m.first_seen_ms,
            m.last_ok_ms,
            m.last_fail_ms,
            m.last_error.as_deref(),
            m.last_inbound_ms,
            (m.oks * MILLI).round() as i64,
            (m.fails * MILLI).round() as i64,
            m.connect_ms.map(|c| c.round() as i64),
        ),
    )
    .await
    .context("writing a machine")?;
    for (alpn, at) in &m.lanes {
        db.execute(
            "INSERT INTO machine_lanes (endpoint_id, alpn, last_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (endpoint_id, alpn) DO UPDATE SET last_ms = MAX(last_ms, excluded.last_ms)",
            (m.endpoint.as_str(), alpn.as_str(), *at),
        )
        .await
        .context("writing a machine's protocol")?;
    }
    Ok(())
}

/// Boot: the table into the book, the node's chosen name, and the machines that last failed
/// marked dark.
pub async fn load(db: &Db) -> Result<()> {
    let mut fresh = Book::default();
    let dark = load_into(db, &mut fresh).await?;
    if let Ok(mut b) = BOOK.lock() {
        // Anything the book learned while boot was loading wins over the table.
        for (endpoint, m) in fresh.machines {
            b.machines.entry(endpoint).or_insert(m);
        }
    }
    crate::net::p2p::dark_at_boot(&dark);
    let chosen: Option<(String,)> = db
        .fetch_optional("SELECT name FROM node_name WHERE id = 1", ())
        .await
        .context("reading the node's name")?;
    if let Ok(mut c) = CHOSEN.write() {
        *c = chosen.map(|(n,)| n);
    }
    Ok(())
}

/// The flush beat (lib.rs).
pub async fn flush(state: crate::AppState) -> Result<()> {
    flush_from(&state.node_db, &BOOK, now_ms()).await
}

// ---------------------------------------------------------------------------------------------
// The node's own name (rulings 1 and 2)

/// The name the operator chose on the Network page, when they have.
static CHOSEN: LazyLock<RwLock<Option<String>>> = LazyLock::new(Default::default);

/// This node's name: the operator's choice, else `RINGTOME_NODE_NAME`, else the hostname
/// (`config.node_name`). What every Hello announces.
pub fn node_name(config_name: &str) -> String {
    CHOSEN.read().ok().and_then(|c| c.clone()).unwrap_or_else(|| config_name.to_string())
}

/// Whether the operator chose the name, rather than the environment or the hostname.
pub fn name_is_chosen() -> bool {
    CHOSEN.read().ok().is_some_and(|c| c.is_some())
}

/// Rename the node, or (`None`) go back to the environment's name or the hostname. Clamped to the
/// Hello's cap at a character boundary.
pub async fn set_node_name(db: &Db, name: Option<&str>) -> Result<Option<String>> {
    let name = name.map(str::trim).filter(|n| !n.is_empty()).map(|n| {
        let mut end = n.len().min(ringtome_proto::sync::MAX_NAME_LEN);
        while !n.is_char_boundary(end) {
            end -= 1;
        }
        n[..end].to_string()
    });
    match &name {
        Some(n) => {
            db.execute(
                "INSERT INTO node_name (id, name, updated_ms) VALUES (1, ?1, ?2)
                 ON CONFLICT (id) DO UPDATE SET name = excluded.name, updated_ms = excluded.updated_ms",
                (n.as_str(), now_ms()),
            )
            .await
            .context("naming the node")?;
        }
        None => {
            db.execute("DELETE FROM node_name", ()).await.context("unnaming the node")?;
        }
    }
    if let Ok(mut c) = CHOSEN.write() {
        *c = name.clone();
    }
    Ok(name)
}

// ---------------------------------------------------------------------------------------------
// The Network page (plans/NETWORK.md)

/// One of the viewer's own ties to a machine (ruling 3): their own computer, a machine serving
/// someone they follow, one holding them in the crowd, or one their group was heard at.
#[derive(Clone, Debug, Serialize, PartialEq, Eq, PartialOrd, Ord)]
struct Link {
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
}

/// Every machine `root`'s own ties run to, from the tables that already hold them - read for
/// this viewer alone, never stored beside the machines.
async fn links(
    state: &crate::AppState,
    root: &str,
) -> Result<HashMap<String, Vec<Link>>, crate::error::AppError> {
    use crate::error::AppError;
    let db = &state.node_db;
    let mut out: HashMap<String, Vec<Link>> = HashMap::new();
    let mut add = |ep: String, link: Link| {
        let list = out.entry(ep).or_default();
        if !list.contains(&link) {
            list.push(link);
        }
    };
    for ep in crate::net::sync::peers_for(db, root).await.map_err(AppError::Internal)? {
        add(ep, Link { kind: "own", root: None, group: None, name: None });
    }
    let followed =
        crate::net::subscriptions::followed_by(db, root).await.map_err(AppError::Internal)?;
    let names = crate::profiles::bylines(db, &followed).await.map_err(AppError::Internal)?;
    for who in &followed {
        let name = names.get(who).and_then(|b| b.name.clone());
        for ep in crate::net::sync::peers_for(db, who).await.map_err(AppError::Internal)? {
            add(
                ep,
                Link { kind: "serves", root: Some(who.clone()), group: None, name: name.clone() },
            );
        }
        for ep in crate::crowd::holders(db, who, 8).await.map_err(AppError::Internal)? {
            add(
                ep,
                Link { kind: "holds", root: Some(who.clone()), group: None, name: name.clone() },
            );
        }
    }
    for (group, name, ep) in crate::roster::machines_of_groups(state, root).await {
        add(ep, Link { kind: "group", root: None, group: Some(group), name: Some(name) });
    }
    for list in out.values_mut() {
        list.sort();
    }
    Ok(out)
}

/// A machine's speakable words, from its endpoint key: how the page names one that has never
/// said its name.
fn words_of(endpoint: &str) -> Option<String> {
    let key = endpoint.parse::<iroh::PublicKey>().ok()?;
    let full = crate::speakable::speakable(key.as_bytes());
    // The two words and the key's first four characters: enough to tell machines apart.
    let mut parts = full.splitn(3, '-');
    let (a, b, key) = (parts.next()?, parts.next()?, parts.next()?);
    Some(format!("{a}-{b}-{}", key.chars().take(4).collect::<String>()))
}

/// GET `/api/identity/{root}/machines` - the Network page: this machine, every machine this node
/// knows, and the viewer's own links to each (rulings 3 and 5). Any session holding the persona.
pub async fn machines_handler(
    session: crate::auth::Session,
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let mine = links(&state, &root).await?;
    let ours = state.endpoint.id().to_string();
    let now = now_ms();
    let rows: Vec<serde_json::Value> = all()
        .into_iter()
        .filter(|m| m.endpoint != ours)
        .map(|m| {
            let dark_until = crate::net::p2p::dark_left(&m.endpoint)
                .map(|left| now + i64::try_from(left.as_millis()).unwrap_or(i64::MAX / 2));
            serde_json::json!({
                "endpoint": m.endpoint,
                "words": words_of(&m.endpoint),
                "name": m.name,
                "version": m.version,
                "first_seen_ms": m.first_seen_ms,
                "last_ok_ms": m.last_ok_ms,
                "last_fail_ms": m.last_fail_ms,
                "last_error": m.last_error,
                "last_inbound_ms": m.last_inbound_ms,
                "reliability": m.reliability(),
                "tries": m.oks + m.fails,
                "connect_ms": m.connect_ms.map(|c| c.round() as i64),
                "lanes": m.lanes,
                "dark_until_ms": dark_until,
                "links": mine.get(&m.endpoint).cloned().unwrap_or_default(),
            })
        })
        .collect();
    Ok(axum::Json(serde_json::json!({
        "this": {
            "endpoint": ours,
            "words": words_of(&ours),
            "name": node_name(&state.config.node_name),
            "chosen": name_is_chosen(),
            "version": state.config.app_version,
        },
        "machines": rows,
    })))
}

#[derive(serde::Deserialize)]
pub struct NameRequest {
    /// The new name; empty or absent goes back to the environment's name or the hostname.
    #[serde(default)]
    name: Option<String>,
}

/// PUT `/api/admin/machine-name {name}` - the operator renames this machine (ruling 2). The next
/// Hello says it.
pub async fn set_name_handler(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _admin: crate::auth::NodeAdminSession,
    axum::Json(req): axum::Json<NameRequest>,
) -> Result<axum::Json<serde_json::Value>, crate::error::AppError> {
    set_node_name(&state.node_db, req.name.as_deref())
        .await
        .map_err(crate::error::AppError::Internal)?;
    Ok(axum::Json(serde_json::json!({
        "name": node_name(&state.config.node_name),
        "chosen": name_is_chosen(),
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A machine that answers climbs past a half and one that doesn't falls below it; a run of
    /// answers after failures wins it back, because the counts decay.
    #[test]
    fn reliability_starts_at_a_half_and_follows_recent_history() {
        let mut book = Book::default();
        assert_eq!(reliability(0.0, 0.0), 0.5, "never dialed: unknown");
        for i in 0..5 {
            book.failed("dark", "sync", "timed out", i);
        }
        let dark = book.get("dark").unwrap().reliability();
        assert!(dark < 0.2, "five failures: {dark}");
        for i in 5..40 {
            book.connected("dark", "sync", 50.0, i);
        }
        let back = book.get("dark").unwrap().reliability();
        assert!(back > 0.9, "the failures faded: {back}");
        assert_eq!(book.get("dark").unwrap().last_tried_ms(), Some(39));
    }

    /// The connect time is a running average, and an error is kept short.
    #[test]
    fn connect_times_average_and_errors_are_capped() {
        let mut book = Book::default();
        book.connected("m", "sync", 100.0, 1);
        book.connected("m", "fragment", 200.0, 2);
        let m = book.get("m").unwrap();
        assert_eq!(m.connect_ms, Some(120.0));
        assert_eq!(m.lanes.keys().cloned().collect::<Vec<_>>(), vec!["fragment", "sync"]);
        book.failed("m", "sync", &"é".repeat(400), 3);
        let e = book.get("m").unwrap().last_error.clone().unwrap();
        assert!(e.len() <= MAX_ERROR && e.chars().all(|c| c == 'é'));
    }

    /// A Hello's name and version stick, and an older build's empty slots leave them be.
    #[test]
    fn a_name_sticks_until_the_machine_says_another() {
        let mut book = Book::default();
        book.announced("m", "curtis's mac mini", "0.4.6", 1);
        book.announced("m", "", "", 2);
        assert_eq!(book.get("m").unwrap().name.as_deref(), Some("curtis's mac mini"));
        book.announced("m", "the attic", "", 3);
        let m = book.get("m").unwrap();
        assert_eq!(m.name.as_deref(), Some("the attic"));
        assert_eq!(m.version.as_deref(), Some("0.4.6"));
    }

    /// The flush writes what moved, boot reads it back whole, a machine whose last word was a
    /// failure comes back dark, and one silent past the cutoff is forgotten.
    #[tokio::test]
    async fn the_table_survives_a_restart() {
        let db = crate::db::test_node_db().await;
        let book = Mutex::new(Book::default());
        let now = 10 * FORGET_AFTER_MS;
        {
            let mut b = book.lock().unwrap();
            b.connected("up", "sync", 40.0, now);
            b.announced("up", "the server", "0.4.6", now);
            b.dialed_in("up", "gossip", now);
            b.connected("down", "sync", 40.0, now - 10);
            b.failed("down", "fragment", "timed out", now);
            b.connected("gone", "sync", 40.0, now - FORGET_AFTER_MS - 1);
        }
        flush_from(&db, &book, now).await.unwrap();
        assert!(book.lock().unwrap().get("gone").is_none(), "silent too long");

        let mut fresh = Book::default();
        let dark = load_into(&db, &mut fresh).await.unwrap();
        assert_eq!(dark, vec!["down".to_string()]);
        let up = fresh.get("up").unwrap();
        assert_eq!(up.name.as_deref(), Some("the server"));
        assert_eq!(up.last_inbound_ms, Some(now));
        assert_eq!(up.lanes.keys().cloned().collect::<Vec<_>>(), vec!["gossip", "sync"]);
        let kept = book.lock().unwrap().get("up").cloned().unwrap();
        assert!((up.oks - kept.oks).abs() < 0.001 && up.fails == kept.fails, "the counts kept");
        assert_eq!(up.connect_ms, Some(40.0));
        assert!(fresh.get("gone").is_none());

        // Nothing moved: the next flush writes nothing, and the rows stay.
        flush_from(&db, &book, now).await.unwrap();
        let mut again = Book::default();
        load_into(&db, &mut again).await.unwrap();
        assert_eq!(again.all().len(), 2);
    }
}
