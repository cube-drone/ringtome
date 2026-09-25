//! Ringtome connector node - the library.
//!
//! The composition root: load config, open the databases and keystore, bind the iroh endpoint,
//! pick the discovery directory, mount the HTTP routers, and start the background loops. The
//! systems live in their own modules; this file's job is wiring them together.
//!
//! It lives in a LIBRARY rather than in the binary (DESKTOP.md, Stage 1) because a node that
//! cannot be linked can only be run: the desktop shell embeds it in its own process, mobile
//! and any Godot client want the same, and `tests/*.rs` can `use` a library where they could
//! never reach into a binary. Two thin entry points over one boot sequence - `src/main.rs` for
//! the operator's `ringtome`, the shell for the app - and exactly one place that assembles the
//! node, because a shell that reimplemented the assembly would drift from what `just ci` tests.

use std::net::SocketAddr;

use axum::{extract::State, routing::get, Json, Router};
use tower_http::trace::TraceLayer;
use tracing::info_span;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

// The module tree is public because this crate is the workspace's own, and every item in it
// was written as a binary's innards, where `pub` meant nothing. What an embedder actually
// calls is four names - `run`, `Config`, `init_tracing`, `inspect` - and a reader asking
// "what may I call from outside" should read those rather than the tree.
pub mod auth;
pub mod clock;
pub mod config;
pub mod db;
pub mod edgegraph;
pub mod error;
pub mod fanout;
pub mod fragments;
pub mod postkeys;
pub mod scheduled;
pub mod books;
pub mod chat;
pub mod files;
pub mod fold;
pub mod identity;
pub mod inbox;
pub mod ingest;
pub mod inspect;
pub mod keystore;
pub mod loops;
pub mod media;
pub mod message;
pub mod migrations;
pub mod net;
pub mod nodeface;
pub mod nodeshelf;
pub mod slugs;
pub mod notifications;
pub mod outbox;
pub mod search;
pub mod selectivity;
pub mod profiles;
pub mod pubkey;
pub mod publish;
pub mod rate_limit;
pub mod rebroadcast;
pub mod annotations;
pub mod attention;
pub mod backup;
pub mod webpush;
pub mod replies;
pub mod reaper;
pub mod record;
pub mod request_context;
pub mod seal;
pub mod semver;
pub mod eviction;
pub mod speculative;
pub mod idface;
pub mod speakable;
pub mod test_endpoints;
pub mod ui;

use config::{Config, PublicConfig};
use error::AppError;

/// Shared, cheaply-cloneable application state. Services (identity, p2p, ...) will hang off this
/// as they are built.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    /// The node-level database (`node.db`): node config, known peers, replication state.
    pub node_db: db::Db,
    /// Opens/migrates/caches the per-identity databases.
    pub user_dbs: db::UserDbManager,
    /// Per-node in-memory rate limiter (disabled in local-test mode).
    pub rate_limiter: rate_limit::RateLimiter,
    /// Envelope encryption for private keys at rest.
    pub keystore: keystore::Keystore,
    /// The node's iroh endpoint: transport identity + p2p connections (cheaply cloneable).
    pub endpoint: iroh::Endpoint,
    /// Discovery: publish/resolve serving + endpoint records (off / local stub / mainline DHT).
    pub directory: net::discovery::Directory,
    /// The file layer: the node's one global blob store (encrypted bodies, later public media).
    pub files: std::sync::Arc<files::FileStore>,
    /// Media ingest: quarantine + enqueue handle for the async transcode pipeline.
    pub ingest: ingest::Ingest,
    /// In-memory eager-push debounce state (which identities changed, when last pushed).
    /// Rebuilt empty each boot: roots re-seed dirty and re-push once, cheaply.
    pub resync: net::resync::ResyncTracker,
    /// The turbolink unfurl engine: outbound OpenGraph fetches, guarded and cached.
    pub unfurl: net::unfurl::Unfurler,
    /// Per-root view-freshness counter for changes chain frontiers can't see - today, body
    /// blobs arriving by backfill (headers travel ahead of bodies; a body landing changes
    /// what resolution and the search index can say without moving any frontier). Mixed into
    /// the live-cache stream cursor so open browsers hear about it. In-memory: a boot resets
    /// it, which just makes returning cursors doubt themselves into a full snapshot - the
    /// design's own answer.
    pub view_epochs: ViewEpochs,
    /// Foreign personas being re-fetched right now, so a member reloading someone's page ten
    /// times dials their node once rather than ten times (idface's stale-while-revalidate).
    /// In-memory and per-process: a boot clears it, which at worst costs one extra exchange.
    pub refreshing: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// The tick sweeps' stat-before-open marks (loops::FreshnessMarks): a backstop sweep
    /// skips every root whose files haven't moved since it last folded them.
    pub sweep_marks: loops::FreshnessMarks,
    /// Which accounts are actively using this node right now (see [`ActivityMarks`]).
    pub activity: ActivityMarks,
    /// The test-only transport gate: which ALPNs this node is refusing, in which direction. Armed
    /// only through `/test/unplug`, which is not mounted outside local-test mode, and refuses to
    /// arm outside it regardless. Empty - refusing nothing - on every real node, forever.
    /// See [`net::p2p::Unplugged`] for the whole argument.
    pub unplugged: net::p2p::Unplugged,
    /// The gate at accept (PROJECT_PLAN's Peeks, ruling 14): connection ceilings and the exchange budgets.
    pub admission: net::admission::Admission,
    /// Personas whose last exchange ended short of the peer's frontier (PROJECT_PLAN's Peeks, ruling 2).
    pub behind: net::admission::Behind,
    /// Personas this node fetched at PEEK depth and has not fetched whole since (PROJECT_PLAN's Peeks
    /// ruling 7): what a dial promotes, and what the wake pass treats as stale. In memory -
    /// after a boot the relationships decide the depth of the next fetch anyway.
    pub peeked: net::admission::Behind,
    /// The rooms' live lane (CHAT.md, ruling 5): iroh-gossip on the node's endpoint, one
    /// topic per room a hosted persona has open.
    pub gossip: iroh_gossip::net::Gossip,
    /// The topics this node is in right now, with their presence: in memory, since a live
    /// space is exactly what a boot loses.
    pub live: chat::Live,
    /// The badges' moments, said out loud for an embedder (attention.rs): the desktop app
    /// subscribes through [`Bound::attention`] and turns each into a notification.
    pub attention: attention::Attention,
    /// The Web Push sender's key and client (webpush.rs).
    pub webpush: webpush::WebPush,
    /// Backup tickets: the one running and the last few finished (backup.rs).
    pub backups: backup::Backups,
}

/// Who has touched this node lately: account id -> last authenticated request, in memory.
/// Stamped by the session extractor, read by the follow-refresh sweep so a node hosting many
/// accounts spends its wake-up syncs on the humans actually present. Boot-reset by design -
/// the first request back repopulates it, and "nobody is active yet" just means the sweep
/// falls back to eagerness order.
#[derive(Clone, Default)]
pub struct ActivityMarks(std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, i64>>>);

impl ActivityMarks {
    pub fn stamp(&self, account_id: &str) {
        self.0
            .lock()
            .expect("activity marks poisoned")
            .insert(account_id.to_string(), crate::clock::now_ms());
    }

    /// Accounts seen within the window, as a set for joining against identities.
    pub fn active_within(&self, window_ms: i64) -> std::collections::HashSet<String> {
        let cutoff = crate::clock::now_ms() - window_ms;
        self.0
            .lock()
            .expect("activity marks poisoned")
            .iter()
            .filter(|(_, at)| **at >= cutoff)
            .map(|(id, _)| id.clone())
            .collect()
    }
}

/// See [`AppState::view_epochs`].
#[derive(Clone, Default)]
pub struct ViewEpochs(std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, u64>>>);

impl ViewEpochs {
    pub fn bump(&self, root: &str) {
        let mut map = self.0.lock().expect("view epochs poisoned");
        *map.entry(root.to_string()).or_insert(0) += 1;
    }

    pub fn get(&self, root: &str) -> u64 {
        self.0
            .lock()
            .expect("view epochs poisoned")
            .get(root)
            .copied()
            .unwrap_or(0)
    }
}

#[derive(serde::Serialize)]
struct Health {
    status: &'static str,
    version: String,
}

/// Liveness check. Verifies the node database is actually reachable, not just that HTTP responds -
/// a node whose database is wedged is not healthy.
async fn health(State(state): State<AppState>) -> Result<Json<Health>, AppError> {
    // fetch, not execute: turso's execute refuses statements that return rows.
    state
        .node_db
        .fetch_one::<(i64,)>("SELECT 1", ())
        .await
        .map_err(AppError::Internal)?;

    Ok(Json(Health {
        status: "ok",
        version: state.config.app_version.clone(),
    }))
}

async fn get_config(State(state): State<AppState>) -> Result<Json<PublicConfig>, AppError> {
    Ok(Json(state.config.public()))
}

#[derive(serde::Serialize)]
struct NodeInfo {
    /// The node's iroh endpoint id (its transport identity - NOT an identity key).
    endpoint_id: String,
    /// Locally bound UDP sockets. With `presets::Minimal` these are the only reachability.
    bound_sockets: Vec<String>,
}

/// The node's p2p coordinates, for assembling add-a-node codes. Session-gated: only this node's
/// own users compose codes.
async fn node_info(_session: auth::Session, State(state): State<AppState>) -> Json<NodeInfo> {
    Json(NodeInfo {
        endpoint_id: state.endpoint.id().to_string(),
        bound_sockets: state
            .endpoint
            .bound_sockets()
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
    })
}

#[derive(serde::Deserialize)]
struct UnfurlQuery {
    url: String,
}

/// Fetch a link's OpenGraph card on the browser's behalf (net::unfurl - CORS forbids the
/// browser doing it). Session-gated: unfurling spends the node's outbound budget and reveals
/// interest in the target, so only this node's own users may ask. `null` is an honest "that
/// page has no card" (or a transient fetch failure) - the turbolink falls to its plain form.
async fn unfurl_handler(
    _session: auth::Session,
    State(state): State<AppState>,
    axum::extract::Query(q): axum::extract::Query<UnfurlQuery>,
) -> Result<Json<Option<net::unfurl::Summary>>, AppError> {
    match state.unfurl.unfurl(&q.url).await {
        Ok(summary) => Ok(Json(summary)),
        Err(net::unfurl::Refusal::BadTarget(m)) => Err(AppError::BadRequest(m)),
        Err(net::unfurl::Refusal::RateLimited) => Err(AppError::TooManyRequests(crate::msg!("lib.the-nodes-unfurl-budget-is", "link previews are paused for now"))),
    }
}

/// A node built, its router assembled and its listener BOUND - everything but the serving.
///
/// The desktop shell needs exactly this shape (DESKTOP.md's architecture): it must know the
/// address before it can point a window at it, and "poll the health endpoint until it answers"
/// is the readiness race that running in-process exists to not have. Binding is also what makes
/// a port collision an error the caller can answer - pick another, write it down, try again -
/// rather than a crash at boot.
pub struct Bound {
    listener: tokio::net::TcpListener,
    service: axum::extract::connect_info::IntoMakeServiceWithConnectInfo<Router, SocketAddr>,
    addr: SocketAddr,
    attention: attention::Attention,
}

impl Bound {
    /// Where this node is listening, as the OS agreed it - which is the real port even when the
    /// caller asked for `0` and let the OS choose.
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Listen for the moments a badge lights (attention.rs) - the desktop app's notifications.
    /// Subscribe before [`serve`] consumes the `Bound`; the receiver outlives it.
    pub fn attention(&self) -> tokio::sync::broadcast::Receiver<attention::Alert> {
        self.attention.watch_everyone();
        self.attention.subscribe()
    }
}

/// Build this node and serve it: the one boot sequence, called by both entry points - the
/// `ringtome` binary an operator runs, and the desktop shell that embeds the node in its own
/// process (DESKTOP.md's architecture). The caller owns `Config` and the tracing subscriber,
/// because those are the two things an embedder legitimately wants to decide for itself.
pub async fn run(config: Config) -> anyhow::Result<()> {
    serve(bind(config).await?).await
}

/// Serve a bound node until it stops. The other half of [`run`], split out for the embedder
/// that had to know the address first.
pub async fn serve(bound: Bound) -> anyhow::Result<()> {
    tracing::info!("listening on http://{}", bound.addr);
    axum::serve(bound.listener, bound.service).await?;
    Ok(())
}

/// Everything [`run`] does except the last line: the whole assembly, and the listener bound.
pub async fn bind(config: Config) -> anyhow::Result<Bound> {
    // The listener comes FIRST - before the banner, before a byte of state - and the order is
    // the design (2026-09-21): the loops are registered with clones of the state as it is
    // built, so a bind that failed after that would leave a half-dead node's background tasks
    // running in the caller's process. The binary hardly noticed, since a failed bind exits;
    // an embedder means to answer a taken port by picking another, and it can only do that if
    // the failure costs nothing and says nothing.
    let listener = tokio::net::TcpListener::bind(format!("{}:{}", config.bind_address, config.port)).await?;
    let addr = listener.local_addr()?;

    tracing::info!(
        version = %config.app_version,
        environment = ?config.environment,
        "starting ringtome node"
    );

    // The delivery price, said out loud at boot. Both halves, because the failure they cause is
    // silent: charge more than other nodes pay and strangers stop reaching you; offer less than
    // other nodes charge and your notices stop landing. Neither raises an error anywhere - the
    // symptom is an inbox that is quietly emptier than it should be - so the numbers belong in
    // the log where an operator can find them without reading the source.
    tracing::info!(
        requested_bits = config.pow_requested_bits,
        willing_bits = config.pow_willing_bits,
        "delivery proof-of-work price (fixed at boot; no runtime adjustment)"
    );
    if config.pow_willing_bits < config.pow_requested_bits {
        tracing::warn!(
            requested_bits = config.pow_requested_bits,
            willing_bits = config.pow_willing_bits,
            "this node charges strangers more than it is willing to pay itself - deliberate \
             asymmetry is legitimate, but a node like this one could not deliver to a node \
             like this one"
        );
    }

    std::fs::create_dir_all(&config.data_directory)?;

    // The keystore comes first: the databases need it for their at-rest encryption keys.
    let keystore = keystore::Keystore::load(&config.data_directory)?;

    let node_db = db::open_node_db(&config.data_directory, &keystore).await?;
    db::record_boot(&node_db, &config.app_version).await?;
    tracing::info!(data_dir = %config.data_directory.display(), "opened node database");

    // Bound on simultaneously-open per-user DB handles. A placeholder default for now; will move to
    // config when it matters (many-user nodes tuning against file-handle limits).
    let user_dbs =
        db::UserDbManager::new(&config.data_directory, keystore.clone(), config.max_open_databases);
    // Every per-user handle carries node.db for chain-heads memo co-writes (Db::memo): the
    // entry writers feed the memo at the moment they hold the tip in hand.
    user_dbs.attach_memo(node_db.clone());

    let local_test = config.local_test;
    let body_limits = identity::BodyLimits {
        upload: config.max_upload_bytes,
        document: config.max_document_bytes,
    };
    // Rate limiting is off in local-test mode so integration tests don't trip it.
    let rate_limiter = rate_limit::RateLimiter::new(!local_test);
    let endpoint = net::p2p::build_endpoint(&keystore, &config.discovery, config.p2p_port).await?;
    let directory = net::discovery::Directory::build(&config.discovery)?;
    // The blob-layer size invariant tracks the document cap (plus a little AEAD/framing headroom),
    // so "nothing over ~10MB moves on the network" is enforced where bytes actually cross between
    // nodes - not just at our own HTTP door.
    let max_blob_bytes = config.max_document_bytes as u64 + 64 * 1024;
    // One gate, two holders: the accept loop and `p2p::dial` read it off AppState, and the blob
    // store carries its own clone because it opens its own connections (net::p2p::Unplugged).
    let unplugged = net::p2p::Unplugged::default();
    // How often the blob reaper's rounds run. Half an hour: blobs are disk-cheap and the
    // reaper's job is drift, not urgency - a takedown's SERVING stops the moment the fragment
    // dies; this only decides how long the unreferenced bytes sit before collection. The
    // harness shortens it to watch a reap inside a test.
    let gc_interval = if config.local_test {
        std::env::var("RINGTOME_TEST_REAP_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(30 * 60))
    } else {
        std::time::Duration::from_secs(30 * 60)
    };
    let files = std::sync::Arc::new(
        files::FileStore::fs(config.data_directory.join("blobs"), gc_interval)
            .await?
            .with_max_blob_bytes(max_blob_bytes)
            .with_unplugged(unplugged.clone()),
    );
    let ingest = ingest::Ingest::new(config.quarantine_directory.clone());
    ingest.ensure_dir()?;
    // Reconcile any jobs left in flight by a previous run before the worker starts claiming.
    ingest::reconcile_on_boot(&node_db).await?;
    let unfurl = net::unfurl::Unfurler::new(config.unfurl_rate_per_min);
    let admission = net::admission::Admission::from_config(&config);
    // A gossip frame is one signed message (16KB at most) or a presence beacon; the cap
    // leaves headroom and refuses the rest at the door.
    let gossip = iroh_gossip::net::Gossip::builder()
        .max_message_size(32 * 1024)
        .spawn(endpoint.clone());
    // Read before `config` moves into the state: the recorder is a local-test fixture, and so is
    // a push endpoint over plain http (the rig's fake push service).
    let record_attention = config.local_test;
    let webpush = webpush::WebPush::load(&keystore, config.local_test).map_err(|e| e.context("loading the Web Push key"))?;
    let state = AppState {
        config,
        node_db,
        user_dbs,
        rate_limiter,
        keystore,
        endpoint: endpoint.clone(),
        directory,
        files,
        ingest,
        resync: net::resync::ResyncTracker::default(),
        unfurl,
        view_epochs: ViewEpochs::default(),
        refreshing: Default::default(),
        sweep_marks: Default::default(),
        activity: Default::default(),
        unplugged,
        admission,
        behind: net::admission::Behind::default(),
        peeked: net::admission::Behind::default(),
        gossip,
        live: chat::Live::default(),
        attention: attention::Attention::new(record_attention),
        webpush,
        backups: backup::Backups::default(),
    };
    net::p2p::spawn_accept_loop(endpoint, state.clone());
    // Arm the blob reaper: until this line, the store's GC aborts every run. From here, each
    // round marks from the node's own reference ledgers (reaper::live_set) and sweeps the rest.
    reaper::arm(&state);

    // Background loops: every recurring process in the node, registered here by name. Modules
    // export one-pass functions; loops.rs owns the ticking, logging, and panic containment.
    let dht_ttl_pace = std::time::Duration::from_secs(15 * 60);
    loops::periodic(
        "republish-endpoint-record",
        dht_ttl_pace,
        state.clone(),
        net::discovery::republish_endpoint_pass,
    );
    loops::periodic(
        "republish-serving-records",
        dht_ttl_pace,
        state.clone(),
        identity::serving::republish_pass,
    );
    // The publication media baker (record::bake): downloads and mints external media that
    // published posts embed. Same 2s heartbeat as the ingest worker it mirrors.
    loops::periodic(
        "media-bake",
        std::time::Duration::from_secs(2),
        state.clone(),
        crate::record::bake::bake_pass,
    );
    // The media ingest worker: drains the transcode queue. A short cadence keeps upload latency
    // low; a pass drains everything pending, so under load it's effectively continuous.
    loops::periodic(
        "ingest-transcode",
        std::time::Duration::from_secs(2),
        state.clone(),
        ingest::worker_pass,
    );
    // Background sync (net::resync): eager push notices fresh local writes and delivers them to
    // peers after a short debounce; anti-entropy periodically exchanges with random peers dirty
    // or not - and its immediate first pass is the boot catch-up. The eager loop's doorbell is
    // rung by every locally-signed write (Db::nudge_sync via the user-DB manager), so the
    // debounce clock starts at the write, not at the next tick.
    loops::periodic_nudged(
        "sync-eager-push",
        net::resync::EAGER_TICK,
        state.user_dbs.write_nudge(),
        state.clone(),
        net::resync::eager_pass,
    );
    // The public-frontier map (net::frontier): what this node holds of each persona's public
    // lane, one fingerprint per (persona, service). EVENT-driven for correctness as well as
    // latency - local writes nudge, and both ends of a sync exchange refresh directly - so
    // the tick is pure disaster recovery: rare, and stat-guarded so an idle persona costs a
    // stat, never an open. (It was 30s and unguarded once, which meant reopening every
    // database on the node twice a minute to learn nothing - the design smell Curtis called,
    // 2026-08-05.)
    loops::periodic_nudged(
        "frontier-map",
        std::time::Duration::from_secs(600),
        state.user_dbs.write_nudge(),
        state.clone(),
        net::frontier::sweep,
    );
    // The subscription memo (net::subscriptions): who each hosted persona follows, and whom
    // they publicly trust. Nudged (a contact dial is a private-chain write) AND refreshed
    // post-ingest (a dial turned on another device arrives by sync, which never nudges) - the
    // second hook was missing while the 60s tick masked it. The tick is recovery now: rare,
    // stat-guarded.
    loops::periodic_nudged(
        "subscription-memo",
        std::time::Duration::from_secs(600),
        state.user_dbs.write_nudge(),
        state.clone(),
        net::subscriptions::sweep,
    );
    // The gravedigger's rounds (net::bodies): retry blobs the body walks noted missing, from
    // the nodes most likely to hold them. Recovery only - the event half is every exchange's
    // walk plus the fan-out re-ride - so the beat is slow, and an empty ledger costs one
    // query. LOCAL_TEST may shorten the beat so probes can watch a full round.
    let body_beat = if local_test {
        std::env::var("RINGTOME_TEST_BODY_SWEEP_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(300))
    } else {
        std::time::Duration::from_secs(300)
    };
    loops::periodic("missing-bodies", body_beat, state.clone(), net::bodies::sweep);
    // The outbox rounds (outbox::sweep): envelopes owed to strangers who were not reachable
    // when their news was minted. Shares the body sweep's beat and its backoff discipline -
    // both are "keep knocking, politely, at machines that are mostly asleep".
    loops::periodic("outbound-notices", body_beat, state.clone(), outbox::sweep);
    // Fragment revalidation (fragments::sweep): ask each origin whether the shared documents we
    // hold are still what they serve. This is what carries a DELETION past the first hop - the
    // author tombstones, the sharer's pin sees it, and a reader only ever learns by asking
    // again. Shares the same beat and the same politeness discipline as the two above.
    loops::periodic("fragment-revalidation", body_beat, state.clone(), fragments::sweep);
    // The peer-set derive sweep (net::sync::derive_peers): every hosted identity's peer list,
    // re-derived from Active crown leaves x live serving records. The event edges (adoption,
    // member-proven dials) keep it fresh; the beat heals dead-introducer partitions and
    // enforces revocation-to-routing. LOCAL_TEST may shorten it so probes can watch a round.
    let derive_beat = if local_test {
        std::env::var("RINGTOME_TEST_PEER_DERIVE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(600))
    } else {
        std::time::Duration::from_secs(600)
    };
    loops::periodic("peer-derive", derive_beat, state.clone(), net::sync::derive_peers);
    // Follower-side anti-entropy (idface::refresh_followed_pass): the wake pass that
    // re-fetches stale followed mirrors AND re-arms this node on their push lists - one
    // exchange does both. Presence-prioritized, eagerness-ordered, capped per beat.
    let follow_beat = if local_test {
        std::env::var("RINGTOME_TEST_FOLLOW_REFRESH_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(60))
    } else {
        std::time::Duration::from_secs(60)
    };
    loops::periodic("follow-refresh", follow_beat, state.clone(), idface::refresh_followed_pass);
    // Speculative acquisition (speculative::acquire_pass): the quiet pull behind the demand
    // rollup - strangers a reader's trust admits, fetched through their introducers on a slow
    // beat at lower priority than real follows (PROJECT_PLAN's Discovery slice 1). Slow on purpose:
    // speculative content is allowed to be hours stale; that is part of what makes it cheap.
    let speculative_beat = if local_test {
        std::env::var("RINGTOME_TEST_SPECULATIVE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(300))
    } else {
        std::time::Duration::from_secs(300)
    };
    loops::periodic("speculative-acquire", speculative_beat, state.clone(), speculative::acquire_pass);
    // The history dig (fanout::fill_pass): every follow edge's feed extended backward, one
    // page per pair per beat, until the year horizon. Local reads feeding local writes - the
    // pace exists to bound shelf opens per beat and node.db growth, not network politeness,
    // because there is no network in it. LOCAL_TEST may shorten it so a test can watch a
    // whole history converge.
    let fill_beat = if local_test {
        std::env::var("RINGTOME_TEST_JOURNAL_FILL_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(60))
    } else {
        std::time::Duration::from_secs(60)
    };
    loops::periodic("journal-fill", fill_beat, state.clone(), fanout::fill_pass);
    // Attention (attention.rs): idle unless somebody listens. Web Push is one listener.
    tokio::spawn(attention::watch(state.clone()));
    tokio::spawn(webpush::deliver(state.clone()));
    // The room-sync beat (CHAT.md, slice 2): every room a hosted persona opened lately,
    // pulled from the creator's node. Slow on purpose - the beat is the honest floor,
    // and live delivery is slice 3's.
    let room_beat = if local_test {
        std::env::var("RINGTOME_TEST_ROOM_SYNC_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(20))
    } else {
        std::time::Duration::from_secs(20)
    };
    loops::periodic("room-sync", room_beat, state.clone(), chat::sync_pass);
    // The room pulse (Curtis, 2026-09-18): a busy room's feed time is its last word's, moved
    // periodically rather than per word.
    let pulse_beat = if local_test {
        std::env::var("RINGTOME_TEST_ROOM_PULSE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(60))
    } else {
        std::time::Duration::from_secs(60)
    };
    loops::periodic("room-pulse", pulse_beat, state.clone(), chat::pulse_pass);
    // The public text index's backlog walk (search.rs): a bounded slice per beat, so the
    // first search over a deep journal is rarely the one that pays for reading it. Its own
    // slow beat, never the journal fill's (2026-09-08): on the rig the fill beat is a
    // second, and an index walk every second beside the fill pass loaded the dig's claim
    // into the red; the test door rings the index directly when a claim wants it.
    loops::periodic("search-index", std::time::Duration::from_secs(60), state.clone(), search::index_pass);
    // Scheduled publishes (PUBLISH.md slice 2): drafts whose preferred date lay in the
    // future mint when their moment comes. A minute is plenty - the date is a day at an
    // hour, never a deadline - and LOCAL_TEST may shorten it.
    let publish_beat = if local_test {
        std::env::var("RINGTOME_TEST_PUBLISH_DUE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(60))
    } else {
        std::time::Duration::from_secs(60)
    };
    loops::periodic("publish-due", publish_beat, state.clone(), scheduled::pass);
    // Book rollouts (PROJECT_PLAN's Books, slice 2): plans the Publish column wrote, carried out here.
    let rollout_beat = if local_test {
        std::env::var("RINGTOME_TEST_BOOK_ROLLOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(20))
    } else {
        std::time::Duration::from_secs(20)
    };
    loops::periodic("book-rollout", rollout_beat, state.clone(), books::pass);
    // WAL maintenance (db::checkpoint_pass): truncate node.db's and every open user db's log
    // on a slow beat - the policy and its reasoning live beside Db::checkpoint.
    loops::periodic(
        "wal-checkpoint",
        std::time::Duration::from_secs(60),
        state.clone(),
        db::checkpoint_pass,
    );
    // Mirror eviction (eviction::evict_pass): the retention edge - a mirrored persona nobody
    // wants (not hosted, no dial, not member-fetched, no fragments, no demand) leaves, files
    // and traces. Slow on purpose: retention is not urgent, and the grace inside the pass is
    // what carries the safety.
    let evict_beat = if state.config.local_test {
        std::env::var("RINGTOME_TEST_EVICT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map(std::time::Duration::from_millis)
            .unwrap_or(std::time::Duration::from_secs(3600))
    } else {
        std::time::Duration::from_secs(3600)
    };
    loops::periodic("mirror-eviction", evict_beat, state.clone(), eviction::evict_pass);
    loops::periodic(
        "sync-anti-entropy",
        std::time::Duration::from_secs(state.config.resync_interval_secs),
        state.clone(),
        net::resync::anti_entropy_pass,
    );

    let mut app = Router::new()
        // The internal UI lives entirely under /home (SPA shell: every /home route returns the
        // same HTML, the client router sorts out which screen). Root bounces there for now, and
        // stays free for the API and a future public face - a temporary redirect so it is never
        // cached as permanent against that day.
        // The public face arrived (PROJECT_PLAN's The node's public face, 2026-09-15): root is the app, which shows a
        // stranger the node's front page and sends a signed-in reader on to /home.
        .route("/", get(ui::homepage))
        .route("/people", get(ui::homepage))
        .route("/home", get(ui::homepage))
        // The /id surface: one URL, two audiences (idface.rs). The wildcard form covers
        // deeper resource paths; the segment parser only reads the first segment for now.
        .route("/id/{seg}", get(idface::idface))
        // Public document bytes: static segments beat the page wildcard below, so these
        // resolve first (matchit's specificity, relied on deliberately).
        .route("/id/{seg}/docs/{doc}/body", get(idface::public_body_route))
        .route(
            "/id/{seg}/docs/{doc}/body/{filename}",
            get(idface::public_body_named_route),
        )
        .route("/id/{seg}/docs/{doc}/thumb", get(idface::public_thumb_route))
        .route("/id/{seg}/{*rest}", get(idface::idface_deep))
        .route("/api/id/{seg}/profile", get(idface::id_profile))
        .route("/api/id/{seg}/posts", get(idface::id_posts))
        .route("/api/id/{seg}/labels", get(idface::id_labels))
        .route("/api/id/{seg}/posts/{doc}", get(idface::id_post))
        .route("/api/id/{seg}/posts/{doc}/replies", get(idface::id_post_replies))
        .route("/api/id/{seg}/posts/{doc}/dossier", get(idface::id_post_dossier))
        .route("/api/directory", get(idface::directory))
        .route("/home/{*wildcard}", get(ui::homepage))
        .route("/in/{*wildcard}", get(ui::homepage))
        // Versioned static assets (CDN cache-safe)
        .route("/static/{version}/app.js", get(ui::app_js))
        .route("/sw.js", get(ui::service_worker))
        .route("/static/{version}/app.css", get(ui::app_css))
        // Marquee font files (embedded in binary, read from disk in dev)
        .route("/fonts/{filename}", get(ui::font))
        // API routes
        .route("/health", get(health))
        .route("/api/config", get(get_config))
        .route("/api/node", get(node_info))
        // The node's public face (PROJECT_PLAN's The node's public face): a stranger's doors, no session.
        .route("/api/node/feed", get(nodeface::node_feed))
        .route("/api/node/feed/labels", get(nodeface::node_feed_labels))
        .route("/api/node/personas", get(nodeface::node_personas))
        .route("/api/node/slugs/{slug}", get(nodeface::slug_resolve))
        .route("/@{slug}", get(nodeface::slug_page))
        .route(
            "/api/identity/{root}/slug",
            get(nodeface::slug_get).put(nodeface::slug_put),
        )
        .route(
            "/api/identity/{root}/listed",
            get(nodeface::listed_get).put(nodeface::listed_put),
        )
        .route("/api/unfurl", get(unfurl_handler))
        .merge(auth::router())
        // Backups (backup.rs): the machine itself or a node administrator; tickets, not waits.
        .route("/api/admin/backup", axum::routing::post(backup::start_handler))
        .route("/api/admin/backup/{ticket}", axum::routing::get(backup::ticket_handler))
        .merge(identity::router(body_limits));

    // DANGEROUS: only mounted in local-test mode. The route does not exist otherwise (404), so
    // there is no path to the SQL executor on a normal node. See test_endpoints.
    if local_test {
        tracing::warn!(
            "RINGTOME_LOCAL_TEST is enabled: mounting raw SQL passthrough at /test/sql. \
             This is an extreme security hole - use only on a local test node."
        );
        app = app
            .route("/test/sql", axum::routing::post(test_endpoints::raw_sql))
            .route("/test/mark", axum::routing::post(test_endpoints::mark))
            .route("/test/beat", axum::routing::post(test_endpoints::beat))
            .route(
                "/test/revalidation",
                axum::routing::post(test_endpoints::revalidation_mode),
            )
            .route(
                "/test/resolve-serving/{leaf}",
                axum::routing::get(test_endpoints::resolve_serving),
            )
            .route(
                "/test/derive",
                axum::routing::post(test_endpoints::derive_pass),
            )
            .route("/test/reap", axum::routing::post(test_endpoints::reap_pass))
            .route(
                "/test/edit-window",
                axum::routing::post(test_endpoints::edit_window),
            )
            .route(
                "/test/blob/{hash}",
                axum::routing::get(test_endpoints::blob_present),
            )
            // The transport gate: simulate a partition on the shared rig without killing a node.
            .route(
                "/test/unplug",
                axum::routing::post(test_endpoints::unplug).get(test_endpoints::unplug_state),
            )
            .route(
                "/test/plug-in",
                axum::routing::post(test_endpoints::plug_in),
            )
            .route(
                "/test/attention",
                axum::routing::get(test_endpoints::attention),
            )
            .route(
                "/test/backup-verify",
                axum::routing::post(test_endpoints::backup_verify),
            );
    }

    let attention = state.attention.clone();
    let app = app
        .with_state(state)
        .layer(
            TraceLayer::new_for_http().make_span_with(|req: &axum::http::Request<_>| {
                info_span!(
                    "req",
                    method = %req.method(),
                    uri = %req.uri(),
                    c_id = tracing::field::Empty,
                    remote_ip = tracing::field::Empty,
                    forwarded_for = tracing::field::Empty,
                )
            }),
        )
        .into_make_service_with_connect_info::<SocketAddr>();

    Ok(Bound { listener, service: app, addr, attention })
}

/// The tracing subscriber, built HERE rather than in the binary (DESKTOP.md's quiet Stage 1
/// hazard): tracing targets follow the module path, so everything this crate logs is
/// `ringtome_node::*`, and a filter assembled in the binary from its own crate name would
/// match nothing at all - no error, just silence.
pub fn init_tracing(config: &Config) {
    init_tracing_with(config, &[])
}

/// ...and the same subscriber for an embedder that logs under its own crate name. The default
/// filter is built from THIS crate's name, so a shell's own lines land under a target nothing
/// in the filter mentions and vanish - which is the Stage 1 hazard again, one floor up, and it
/// cost a smoke test's "the remembered port is taken" warning before it was noticed
/// (2026-09-21). `RUST_LOG`, when set, still wins outright.
pub fn init_tracing_with(config: &Config, also: &[&str]) {
    let mut default = format!("{}=debug,tower_http=debug", env!("CARGO_CRATE_NAME"));
    for target in also {
        default.push_str(&format!(",{target}=debug"));
    }
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| default.into()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
                .with_ansi(config.is_dev()),
        )
        .init();
}
