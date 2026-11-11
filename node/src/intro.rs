//! Node introductions (plans/NODE_PAGE.md; Curtis, 2026-11-05): a node says who it is when
//! another asks - "Here's who I host, here's some basic information about me and the software
//! I'm running" - and the node page shows what a node said, beside what this node has seen of it.
//!
//! **The answer** is the name and version its sync Hello carries, the about facts
//! (`machines::about_us`), its public web address, what its operator says of it, and the people
//! it lists on its own front page (`nodeshelf::listed_roots`) - nobody else: no quiet follows, no
//! copies kept for the crowd. A device lists nobody unless its owner says so: a laptop that
//! listed its person would tie them to its network address. Whether it takes reports is left
//! out (plans/MODERATION.md: nothing advertises who takes reports).
//!
//! **Asking** is the node page's button, and a background pass on a server (Curtis, 2026-11-05:
//! "Background collection seems like a good idea"): every machine this node has exchanged
//! something with lately is asked when first seen and about once a day after, a few at a time,
//! never one blocked here or not answering now; one that doesn't introduce itself is asked
//! weekly. A device leaves it to the button: a pass costs a phone its battery. iroh authenticates
//! the endpoint, so an answer is that node's own word; the address is the one part that can be
//! checked, by fetching `<address>/api/node/id` and comparing - again only when it changes.
//! Everything else is labelled as what the node says.
//!
//! Owns the `machine_intros`, `machine_intro_listed` and `node_introduction` SQL
//! (tests/conventions.rs).

use std::collections::BTreeMap;

use anyhow::{Context as _, Result};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use ringtome_proto::fragment::{
    Intro, MAX_INTRO_ADDRESS, MAX_INTRO_DESCRIPTION, MAX_INTRO_LISTED, MAX_INTRO_RULES,
};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::AppState;

/// An ask this soon after the last is answered from what the last one said.
const ASK_AGAIN_AFTER_MS: i64 = 5_000;
/// The background pass: how often it runs, how many it asks a pass, and how many at once.
pub const PASS_EVERY: std::time::Duration = std::time::Duration::from_secs(5 * 60);
const PER_PASS: usize = 16;
/// Asked again after a day; a node that didn't introduce itself, after a week.
const REFRESH_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
const NO_ANSWER_AGAIN_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// Only machines this node has exchanged something with this lately.
const HEARD_WITHIN_MS: i64 = 21 * 24 * 60 * 60 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/node/id", get(id_handler))
        .route("/api/admin/introduction", get(said_handler).put(set_said_handler))
        .route("/api/identity/{root}/nodes/{endpoint}", get(view_handler))
        .route("/api/identity/{root}/nodes/{endpoint}/introduce", post(introduce_handler))
        .route("/api/identity/{root}/where/{them}", get(where_handler))
}

// ---------------------------------------------------------------------------------------------
// What this node says of itself

/// What the operator says of this node (the server settings).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Said {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub rules: String,
    /// On a device: list its people anyway.
    #[serde(default)]
    pub device_lists: bool,
}

pub async fn said(state: &AppState) -> Said {
    let row: Option<(String, String, i64)> = state
        .node_db
        .fetch_optional(
            "SELECT description, rules, device_lists FROM node_introduction WHERE id = 1",
            (),
        )
        .await
        .ok()
        .flatten();
    row.map(|(description, rules, lists)| Said { description, rules, device_lists: lists != 0 })
        .unwrap_or_default()
}

/// The test rig's stand-in for a public address (`/test/intro-address`): a rig node has none.
static TEST_ADDRESS: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

pub fn set_test_address(address: Option<String>) {
    if let Ok(mut a) = TEST_ADDRESS.write() {
        *a = address;
    }
}

fn address(state: &AppState) -> String {
    if state.config.local_test {
        if let Some(a) = TEST_ADDRESS.read().ok().and_then(|a| a.clone()) {
            return a;
        }
    }
    crate::webpath::public_url(state)
}

/// Whether this node lists its people when asked: a server does, a device only if its owner
/// said so.
fn lists_people(device: &str, said: &Said) -> bool {
    device == "server" || said.device_lists
}

/// At most `cap` bytes of `text`, cut at a character.
fn clip(text: &str, cap: usize) -> String {
    let mut end = text.len().min(cap);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

/// This node's introduction: what the fragment door answers `WantIntro` with.
pub async fn answer(state: &AppState) -> (Intro, Vec<[u8; 32]>) {
    let about = crate::machines::about_us(state).await;
    let said = said(state).await;
    let listed = if lists_people(&about.device, &said) {
        crate::nodeshelf::listed_roots(&state.node_db)
            .await
            .unwrap_or_default()
            .iter()
            .filter_map(|r| hex::decode(r).ok()?.try_into().ok())
            .take(MAX_INTRO_LISTED)
            .collect()
    } else {
        Vec::new()
    };
    let intro = Intro {
        name: clip(
            &crate::machines::node_name(&state.config.node_name),
            ringtome_proto::sync::MAX_NAME_LEN,
        ),
        version: clip(&state.config.app_version, ringtome_proto::sync::MAX_VERSION_LEN),
        about,
        address: clip(&address(state), MAX_INTRO_ADDRESS),
        description: clip(&said.description, MAX_INTRO_DESCRIPTION),
        rules: clip(&said.rules, MAX_INTRO_RULES),
    };
    (intro, listed)
}

// ---------------------------------------------------------------------------------------------
// Asking another

/// Why an ask got no introduction, as the page says it.
fn why(e: &anyhow::Error) -> &'static str {
    let text = format!("{e:#}");
    if text.contains("dialing") || text.contains("bad endpoint id") {
        "unreachable"
    } else {
        "no-answer"
    }
}

/// The endpoint as the ledger spells it, from whatever spelling the page used.
fn ledger_id(endpoint: &str) -> Option<iroh::PublicKey> {
    endpoint.trim().parse::<iroh::PublicKey>().ok().or_else(|| {
        let bytes: [u8; 32] = hex::decode(endpoint.trim()).ok()?.try_into().ok()?;
        iroh::PublicKey::from_bytes(&bytes).ok()
    })
}

/// Ask `endpoint` who it is, and keep what it says. `Err` carries the word for why not:
/// `blocked`, `unreachable` or `no-answer`.
pub async fn ask(state: &AppState, endpoint: &iroh::PublicKey) -> Result<(), &'static str> {
    let id = endpoint.to_string();
    let now = crate::clock::now_ms();
    if crate::moderation::refuses_node(endpoint.as_bytes()) {
        let _ = record_failure(state, &id, now, "blocked").await;
        return Err("blocked");
    }
    match crate::net::fragment::fetch_intro(state, &id).await {
        Ok((intro, listed)) => {
            crate::machines::announced(&id, &intro.name, &intro.version, &intro.about);
            // A checked address that hasn't changed stays checked: fetching an address another
            // node chose buys nothing the second time.
            let before: Option<(Option<String>, i64)> = state
                .node_db
                .fetch_optional(
                    "SELECT address, address_checked FROM machine_intros WHERE endpoint_id = ?1",
                    (id.as_str(),),
                )
                .await
                .ok()
                .flatten();
            let unchanged =
                before.is_some_and(|(a, c)| c != 0 && a.as_deref() == Some(intro.address.as_str()));
            let checked = unchanged || check_address(state, endpoint, &intro.address).await;
            record(state, &id, now, &intro, checked, &listed).await.map_err(|e| {
                tracing::warn!(error = ?e, "could not keep an introduction");
                "no-answer"
            })
        }
        Err(e) => {
            tracing::debug!(endpoint = %id, error = ?e, "no introduction");
            let word = why(&e);
            let _ = record_failure(state, &id, now, word).await;
            Err(word)
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The background pass

/// Whether a node is due another ask, from its last: `(asked_ms, error)`.
fn due(last: Option<&(i64, Option<String>)>, now: i64) -> bool {
    match last {
        None => true,
        Some((asked, Some(e))) if e == "no-answer" => now - asked >= NO_ANSWER_AGAIN_MS,
        Some((asked, _)) => now - asked >= REFRESH_AFTER_MS,
    }
}

/// One pass: the machines this node has exchanged something with lately, that are due, least
/// lately asked first, a few at a time.
pub async fn pass(state: AppState) -> Result<()> {
    sweep(&state, PER_PASS).await
}

/// The same pass without the cap (the test rig's beat).
pub async fn pass_now(state: AppState) -> Result<()> {
    sweep(&state, usize::MAX).await
}

async fn sweep(state: &AppState, cap: usize) -> Result<()> {
    if crate::machines::device_kind(&state.config) != "server" {
        return Ok(());
    }
    let now = crate::clock::now_ms();
    let ours = state.endpoint.id().to_string();
    let rows: Vec<(String, i64, Option<String>)> = state
        .node_db
        .fetch_all("SELECT endpoint_id, asked_ms, error FROM machine_intros", ())
        .await
        .context("reading the introductions asked")?;
    let last: std::collections::HashMap<String, (i64, Option<String>)> =
        rows.into_iter().map(|(e, at, err)| (e, (at, err))).collect();
    let mut wanted: Vec<(i64, iroh::PublicKey)> = crate::machines::all()
        .into_iter()
        .filter(|m| m.endpoint != ours)
        .filter(|m| {
            m.last_ok_ms.max(m.last_inbound_ms).is_some_and(|at| now - at < HEARD_WITHIN_MS)
        })
        .filter(|m| crate::net::p2p::dark_left(&m.endpoint).is_none())
        .filter(|m| due(last.get(&m.endpoint), now))
        .filter_map(|m| {
            let key = ledger_id(&m.endpoint)?;
            (!crate::moderation::refuses_node(key.as_bytes()))
                .then(|| (last.get(&m.endpoint).map_or(0, |(at, _)| *at), key))
        })
        .collect();
    wanted.sort_by_key(|(at, _)| *at);
    wanted.truncate(cap);
    let keys: Vec<iroh::PublicKey> = wanted.into_iter().map(|(_, k)| k).collect();
    crate::net::race::each(keys, crate::net::race::AT_ONCE, |key| {
        let (state, key) = (state.clone(), *key);
        async move {
            let _ = ask(&state, &key).await;
        }
    })
    .await;
    Ok(())
}

/// Whether `address` is where `endpoint` really answers: its `/api/node/id` names it.
async fn check_address(state: &AppState, endpoint: &iroh::PublicKey, address: &str) -> bool {
    let base = address.trim().trim_end_matches('/');
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return false;
    }
    let fetched = crate::net::unfurl::guarded_get(
        &format!("{base}/api/node/id"),
        reqwest::header::HeaderMap::new(),
        4096,
        std::time::Duration::from_secs(8),
        state.config.local_test || state.config.is_dev(),
    )
    .await;
    let Ok(fetched) = fetched else { return false };
    if !fetched.status.is_success() {
        return false;
    }
    serde_json::from_slice::<serde_json::Value>(&fetched.body)
        .ok()
        .and_then(|v| v["endpoint_id"].as_str().and_then(ledger_id))
        .is_some_and(|said| said == *endpoint)
}

async fn record(
    state: &AppState,
    id: &str,
    now: i64,
    intro: &Intro,
    checked: bool,
    listed: &[[u8; 32]],
) -> Result<()> {
    let params: Vec<turso::Value> = vec![
        id.into(),
        now.into(),
        intro.name.clone().into(),
        intro.version.clone().into(),
        intro.about.client.clone().into(),
        intro.about.device.clone().into(),
        i64::try_from(intro.about.users).unwrap_or(i64::MAX).into(),
        i64::try_from(intro.about.personas).unwrap_or(i64::MAX).into(),
        intro.address.clone().into(),
        i64::from(checked).into(),
        intro.description.clone().into(),
        intro.rules.clone().into(),
    ];
    state
        .node_db
        .execute(
            "INSERT INTO machine_intros (endpoint_id, asked_ms, answered_ms, error, name, version,
                 client, device, users, personas, address, address_checked, description, rules)
             VALUES (?1, ?2, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT (endpoint_id) DO UPDATE SET asked_ms = excluded.asked_ms,
                 answered_ms = excluded.answered_ms, error = NULL, name = excluded.name,
                 version = excluded.version, client = excluded.client, device = excluded.device,
                 users = excluded.users, personas = excluded.personas, address = excluded.address,
                 address_checked = excluded.address_checked,
                 description = excluded.description, rules = excluded.rules",
            params,
        )
        .await
        .context("keeping an introduction")?;
    state
        .node_db
        .execute("DELETE FROM machine_intro_listed WHERE endpoint_id = ?1", (id,))
        .await
        .context("clearing a node's listed people")?;
    for root in listed {
        state
            .node_db
            .execute(
                "INSERT OR IGNORE INTO machine_intro_listed (endpoint_id, root) VALUES (?1, ?2)",
                (id, hex::encode(root)),
            )
            .await
            .context("keeping a node's listed people")?;
    }
    Ok(())
}

/// The ask failed: say so, and keep what it said last time.
async fn record_failure(state: &AppState, id: &str, now: i64, word: &str) -> Result<()> {
    state
        .node_db
        .execute(
            "INSERT INTO machine_intros (endpoint_id, asked_ms, error) VALUES (?1, ?2, ?3)
             ON CONFLICT (endpoint_id) DO UPDATE SET asked_ms = excluded.asked_ms,
                 error = excluded.error",
            (id, now, word),
        )
        .await
        .context("noting an unanswered introduction")?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The node page

#[derive(Serialize)]
struct Introduced {
    asked_ms: i64,
    answered_ms: Option<i64>,
    error: Option<String>,
    name: Option<String>,
    version: Option<String>,
    client: Option<String>,
    device: Option<String>,
    users: Option<i64>,
    personas: Option<i64>,
    address: Option<String>,
    address_checked: bool,
    description: Option<String>,
    rules: Option<String>,
}

type IntroRow = (
    i64,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    i64,
    Option<String>,
    Option<String>,
);

async fn introduced(state: &AppState, id: &str) -> Result<Option<(Introduced, Vec<String>)>> {
    let row: Option<IntroRow> = state
        .node_db
        .fetch_optional(
            "SELECT asked_ms, answered_ms, error, name, version, client, device, users, personas,
                 address, address_checked, description, rules
             FROM machine_intros WHERE endpoint_id = ?1",
            (id,),
        )
        .await
        .context("reading an introduction")?;
    let Some((
        asked_ms,
        answered_ms,
        error,
        name,
        version,
        client,
        device,
        users,
        personas,
        address,
        checked,
        description,
        rules,
    )) = row
    else {
        return Ok(None);
    };
    let listed: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT root FROM machine_intro_listed WHERE endpoint_id = ?1 ORDER BY root",
            (id,),
        )
        .await
        .context("reading a node's listed people")?;
    Ok(Some((
        Introduced {
            asked_ms,
            answered_ms,
            error,
            name,
            version,
            client,
            device,
            users,
            personas,
            address,
            address_checked: checked != 0,
            description,
            rules,
        },
        listed.into_iter().map(|(r,)| r).collect(),
    )))
}

/// One person a node hosts, as far as anyone can tell: `says` it lists them, this node has
/// `seen` it serve them.
#[derive(Serialize)]
struct Hosted {
    root: String,
    says: bool,
    seen: bool,
}

fn hosted(listed: &[String], seen: &[String]) -> Vec<Hosted> {
    let mut by: BTreeMap<&str, (bool, bool)> = BTreeMap::new();
    for r in listed {
        by.entry(r.as_str()).or_default().0 = true;
    }
    for r in seen {
        by.entry(r.as_str()).or_default().1 = true;
    }
    let mut out: Vec<Hosted> = by
        .into_iter()
        .map(|(root, (says, seen))| Hosted { root: root.to_string(), says, seen })
        .collect();
    // Confirmed first, then the node's word alone, then what this node saw it serve unasked.
    out.sort_by_key(|h| (!(h.says && h.seen), !h.says));
    out
}

/// What the node page shows of `endpoint`, for the persona `root`.
async fn view(
    state: &AppState,
    root: &str,
    endpoint: &iroh::PublicKey,
) -> Result<serde_json::Value, AppError> {
    let id = endpoint.to_string();
    let ours = *endpoint == state.endpoint.id();
    let seen =
        crate::net::sync::roots_served_by(&state.node_db, &id).await.map_err(AppError::Internal)?;
    let (intro, listed) = if ours {
        // This node's own page: what it would say, as it would say it.
        let (intro, listed) = answer(state).await;
        let now = crate::clock::now_ms();
        let shown = Introduced {
            asked_ms: now,
            answered_ms: Some(now),
            error: None,
            name: Some(intro.name),
            version: Some(intro.version),
            client: Some(intro.about.client),
            device: Some(intro.about.device),
            users: i64::try_from(intro.about.users).ok(),
            personas: i64::try_from(intro.about.personas).ok(),
            address: Some(intro.address).filter(|a| !a.is_empty()),
            address_checked: true,
            description: Some(intro.description),
            rules: Some(intro.rules),
        };
        (Some(shown), listed.iter().map(hex::encode).collect())
    } else {
        match introduced(state, &id).await.map_err(AppError::Internal)? {
            Some((i, l)) => (Some(i), l),
            None => (None, Vec::new()),
        }
    };
    Ok(serde_json::json!({
        "endpoint": id,
        "ours": ours,
        "blocked_here": crate::moderation::refuses_node(endpoint.as_bytes()),
        "machine": crate::machines::machine_view(state, root, &id).await?,
        "words": crate::machines::words_of(&id),
        "intro": intro,
        "hosts": hosted(&listed, &seen),
    }))
}

fn endpoint_of(raw: &str) -> Result<iroh::PublicKey, AppError> {
    ledger_id(raw).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("intro.not-a-node", "that isn't a server's id"))
    })
}

/// GET `/api/identity/{root}/nodes/{endpoint}` - the node page.
async fn view_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, endpoint)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let endpoint = endpoint_of(&endpoint)?;
    Ok(Json(view(&state, &root, &endpoint).await?))
}

/// POST `/api/identity/{root}/nodes/{endpoint}/introduce` - ask it again, then the page.
async fn introduce_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, endpoint)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let endpoint = endpoint_of(&endpoint)?;
    let mut asked = serde_json::json!({ "ok": true });
    if endpoint != state.endpoint.id() {
        let id = endpoint.to_string();
        let last: Option<(i64,)> = state
            .node_db
            .fetch_optional(
                "SELECT asked_ms FROM machine_intros WHERE endpoint_id = ?1",
                (id.as_str(),),
            )
            .await
            .map_err(AppError::Internal)?;
        // The rig asks again at once: its claims change what a node says between asks.
        let fresh = !state.config.local_test
            && last.is_some_and(|(at,)| crate::clock::now_ms() - at < ASK_AGAIN_AFTER_MS);
        if !fresh {
            if let Err(word) = ask(&state, &endpoint).await {
                asked = serde_json::json!({ "ok": false, "error": word });
            }
        }
    }
    let mut page = view(&state, &root, &endpoint).await?;
    page["asked"] = asked;
    Ok(Json(page))
}

// ---------------------------------------------------------------------------------------------
// Where a person has been seen

/// One machine a person's own serving records name, as the person page shows it.
#[derive(Serialize)]
struct Seen {
    endpoint: String,
    name: String,
    /// When this node last synced with it about them: never "when they were active there".
    synced_ms: Option<i64>,
}

/// What kind of machine an endpoint is, as far as this node knows: what it said in an
/// introduction, else in its Hello. `None` for one never met.
async fn kind_of(state: &AppState, endpoint: &str) -> Option<String> {
    if endpoint == state.endpoint.id().to_string() {
        return Some(crate::machines::device_kind(&state.config).to_string());
    }
    let said: Option<(Option<String>,)> = state
        .node_db
        .fetch_optional("SELECT device FROM machine_intros WHERE endpoint_id = ?1", (endpoint,))
        .await
        .ok()
        .flatten();
    said.and_then(|(d,)| d)
        .filter(|d| !d.is_empty())
        .or_else(|| crate::machines::machine(endpoint).and_then(|m| m.device))
}

/// What a machine is called: what it said its name was, else its speakable words.
async fn name_of(state: &AppState, endpoint: &str) -> String {
    if endpoint == state.endpoint.id().to_string() {
        return crate::machines::node_name(&state.config.node_name);
    }
    let said: Option<(Option<String>,)> = state
        .node_db
        .fetch_optional("SELECT name FROM machine_intros WHERE endpoint_id = ?1", (endpoint,))
        .await
        .ok()
        .flatten();
    said.and_then(|(n,)| n)
        .filter(|n| !n.is_empty())
        .or_else(|| crate::machines::machine(endpoint).and_then(|m| m.name))
        .or_else(|| crate::machines::words_of(endpoint))
        .unwrap_or_else(|| endpoint.chars().take(12).collect())
}

/// The most of a person's computers a page resolves live, and how long it waits on the directory.
const RESOLVE_AT_MOST: usize = 8;
const RESOLVE_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// The machines `root`'s own serving records name, resolved now from the directory and kept
/// nowhere: for a person this node only looked up, whose peers no sweep derives. Writing them
/// down would make this node start syncing whoever it looks at. Empty when it holds no key tree
/// of theirs.
async fn resolved_now(state: &AppState, root: &str) -> Vec<String> {
    let Ok(Some(db)) = state.user_dbs.get(root).await else {
        return Vec::new();
    };
    let Ok(tree) = crate::record::imaol::load_key_tree(&db, root).await else {
        return Vec::new();
    };
    let leaves: Vec<[u8; 32]> = tree
        .members()
        .filter(|(_, status)| *status == ringtome_proto::crown::KeyStatus::Active)
        .map(|(leaf, _)| *leaf)
        .take(RESOLVE_AT_MOST)
        .collect();
    let found = crate::net::race::each(leaves, crate::net::race::AT_ONCE, |leaf| {
        let (state, leaf, root) = (state.clone(), *leaf, root.to_string());
        async move {
            let record = tokio::time::timeout(RESOLVE_WAIT, state.directory.resolve_serving(&leaf))
                .await
                .ok()?
                .ok()??;
            let rec = record.record();
            // A leaf serving some other root is no machine of this person's.
            if hex::encode(rec.root) != root {
                return None;
            }
            iroh::PublicKey::from_bytes(&rec.endpoint_id).ok().map(|k| k.to_string())
        }
    })
    .await;
    let mut out: Vec<String> = found.into_iter().filter_map(|(_, e)| e).collect();
    out.sort();
    out.dedup();
    out
}

/// GET `/api/identity/{root}/where/{them}` - the servers `them` lives on, as their own serving
/// records name them (Curtis, 2026-11-05), most lately synced first. This server leads when it
/// hosts them; a person no sweep follows is resolved live. Their own computers - a
/// laptop, a phone, or a machine this node never met - are only counted, unless `them` is the
/// viewer's own: the records are public, but a person's laptop a click from their page is a
/// person-to-home-connection link nobody needs handed to them.
async fn where_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, them)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let own =
        crate::identity::require_owned(&state.node_db, &session.account.id, &them).await.is_ok();
    let mut rows =
        crate::net::sync::peer_leaves(&state.node_db, &them).await.map_err(AppError::Internal)?;
    if rows.is_empty() {
        rows = resolved_now(&state, &them).await.into_iter().map(|e| (e, None, None)).collect();
    }
    rows.sort_by_key(|(_, _, synced)| std::cmp::Reverse(*synced));
    // Peer rows leave this node out - it isn't its own peer - but a person it hosts lives here.
    let ours = state.endpoint.id().to_string();
    rows.retain(|(e, _, _)| *e != ours);
    if crate::identity::is_hosted(&state.node_db, &them).await? {
        rows.insert(0, (ours, None, Some(crate::clock::now_ms())));
    }
    let mut servers = Vec::new();
    let mut computers = Vec::new();
    for (endpoint, _, synced_ms) in rows {
        let server = kind_of(&state, &endpoint).await.as_deref() == Some("server");
        if !server && !own {
            computers.push(None);
            continue;
        }
        let seen = Seen { name: name_of(&state, &endpoint).await, endpoint, synced_ms };
        if server {
            servers.push(seen);
        } else {
            computers.push(Some(seen));
        }
    }
    let count = computers.len();
    let named: Vec<Seen> = computers.into_iter().flatten().collect();
    Ok(Json(serde_json::json!({
        "servers": servers,
        "computers": named,
        "computers_count": count,
    })))
}

/// GET `/api/node/id` - this node's endpoint id, for anyone: how an asker checks that an address
/// a node gave is really that node's. The id is no secret - every Hello carries it.
async fn id_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "endpoint_id": state.endpoint.id().to_string() }))
}

/// GET `/api/admin/introduction` - what this node says of itself.
async fn said_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
) -> Json<Said> {
    Json(said(&state).await)
}

/// PUT `/api/admin/introduction` - the operator's description, rules link, and whether a device
/// lists its people.
async fn set_said_handler(
    State(state): State<AppState>,
    admin: crate::auth::NodeAdminSession,
    Json(req): Json<Said>,
) -> Result<Json<Said>, AppError> {
    let description = req.description.trim();
    let rules = req.rules.trim();
    if description.len() > MAX_INTRO_DESCRIPTION || rules.len() > MAX_INTRO_RULES {
        return Err(AppError::BadRequest(crate::msg!(
            "intro.too-long",
            "that's too long - {description} bytes for the description, {rules} for the rules link",
            description = MAX_INTRO_DESCRIPTION.to_string(),
            rules = MAX_INTRO_RULES.to_string()
        )));
    }
    state
        .node_db
        .execute(
            "INSERT INTO node_introduction (id, description, rules, device_lists, updated_ms)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT (id) DO UPDATE SET description = excluded.description,
                 rules = excluded.rules, device_lists = excluded.device_lists,
                 updated_ms = excluded.updated_ms",
            (description, rules, i64::from(req.device_lists), crate::clock::now_ms()),
        )
        .await
        .context("writing this node's introduction")
        .map_err(AppError::Internal)?;
    Ok(said_handler(State(state), admin).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_lists_nobody_unless_its_owner_says() {
        let quiet = Said::default();
        assert!(lists_people("server", &quiet));
        assert!(!lists_people("mac", &quiet));
        assert!(!lists_people("android", &quiet));
        assert!(lists_people("mac", &Said { device_lists: true, ..Said::default() }));
    }

    #[test]
    fn the_people_a_node_hosts_come_confirmed_first() {
        let listed = vec!["a".to_string(), "b".to_string()];
        let seen = vec!["b".to_string(), "c".to_string()];
        let order: Vec<(String, bool, bool)> =
            hosted(&listed, &seen).into_iter().map(|h| (h.root, h.says, h.seen)).collect();
        assert_eq!(
            order,
            vec![
                ("b".to_string(), true, true),
                ("a".to_string(), true, false),
                ("c".to_string(), false, true),
            ]
        );
    }

    #[test]
    fn a_node_is_asked_when_first_seen_daily_after_and_weekly_when_it_never_says() {
        let day = 24 * 60 * 60 * 1000;
        let now = 100 * day;
        assert!(due(None, now), "never asked");
        assert!(!due(Some(&(now - day / 2, None)), now), "asked this morning");
        assert!(due(Some(&(now - day, None)), now), "asked yesterday");
        assert!(due(Some(&(now - day, Some("unreachable".into()))), now));
        let quiet = Some("no-answer".to_string());
        assert!(!due(Some(&(now - 3 * day, quiet.clone())), now), "an older node, this week");
        assert!(due(Some(&(now - 7 * day, quiet)), now), "and again a week on");
    }

    #[test]
    fn clips_at_a_character() {
        assert_eq!(clip("horsé", 5), "hors");
        assert_eq!(clip("horse", 9), "horse");
    }
}
