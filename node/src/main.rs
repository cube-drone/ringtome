//! Ringtome connector node - entry point.
//!
//! The composition root: load config, open the databases and keystore, bind the iroh endpoint,
//! pick the discovery directory, mount the HTTP routers, and start the background loops. The
//! systems live in their own modules; this file's job is wiring them together.

use std::net::SocketAddr;

use axum::{extract::State, routing::get, Json, Router};
use tower_http::trace::TraceLayer;
use tracing::info_span;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod clock;
mod config;
mod db;
mod edgegraph;
mod error;
mod fanout;
mod fragments;
mod postkeys;
mod files;
mod fold;
mod identity;
mod inbox;
mod ingest;
mod inspect;
mod keystore;
mod loops;
mod media;
mod message;
mod net;
mod notifications;
mod outbox;
mod profiles;
mod pubkey;
mod publish;
mod rate_limit;
mod rebroadcast;
mod annotations;
mod replies;
mod reaper;
mod record;
mod request_context;
mod seal;
mod semver;
mod eviction;
mod speculative;
mod idface;
mod identicon;
mod speakable;
mod test_endpoints;
mod ui;

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
        Err(net::unfurl::Refusal::RateLimited) => Err(AppError::TooManyRequests(crate::msg!("main.the-nodes-unfurl-budget-is", "the node's unfurl budget is spent for the moment - links still work plain"))),
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Subcommands run and exit before any server machinery boots.
    let mut args = std::env::args().skip(1);
    if let Some(cmd) = args.next() {
        match cmd.as_str() {
            "inspect" => {
                let target = args
                    .next()
                    .ok_or_else(|| anyhow::anyhow!("usage: ringtome inspect <hex-or-file>"))?;
                return inspect::run(&target);
            }
            other => anyhow::bail!("unknown command {other:?} (try: ringtome inspect <entry>)"),
        }
    }

    let config = Config::from_env();
    init_tracing(&config);

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

    let bind = format!("{}:{}", config.bind_address, config.port);
    let local_test = config.local_test;
    let body_limits = identity::BodyLimits {
        upload: config.max_upload_bytes,
        document: config.max_document_bytes,
    };
    // Rate limiting is off in local-test mode so integration tests don't trip it.
    let rate_limiter = rate_limit::RateLimiter::new(!local_test);
    let endpoint = net::p2p::build_endpoint(&keystore, &config.discovery).await?;
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
        .route(
            "/",
            get(|| async { axum::response::Redirect::temporary("/home") }),
        )
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
        .route("/api/id/{seg}/posts/{doc}", get(idface::id_post))
        .route("/api/id/{seg}/posts/{doc}/replies", get(idface::id_post_replies))
        .route("/api/id/{seg}/posts/{doc}/dossier", get(idface::id_post_dossier))
        .route("/api/directory", get(idface::directory))
        .route("/home/{*wildcard}", get(ui::homepage))
        // Versioned static assets (CDN cache-safe)
        .route("/static/{version}/app.js", get(ui::app_js))
        .route("/static/{version}/app.css", get(ui::app_css))
        // Marquee font files (embedded in binary, read from disk in dev)
        .route("/fonts/{filename}", get(ui::font))
        // API routes
        .route("/health", get(health))
        .route("/api/config", get(get_config))
        .route("/api/node", get(node_info))
        .route("/api/unfurl", get(unfurl_handler))
        .merge(auth::router())
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
            );
    }

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

    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!("listening on http://{}", bind);
    axum::serve(listener, app).await?;

    Ok(())
}

fn init_tracing(config: &Config) {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                format!("{}=debug,tower_http=debug", env!("CARGO_CRATE_NAME")).into()
            }),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
                .with_ansi(config.is_dev()),
        )
        .init();
}
