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
mod error;
mod files;
mod identity;
mod ingest;
mod inspect;
mod keystore;
mod loops;
mod media;
mod net;
mod pubkey;
mod rate_limit;
mod record;
mod request_context;
mod seal;
mod semver;
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
        Err(net::unfurl::Refusal::RateLimited) => Err(AppError::TooManyRequests(
            "the node's unfurl budget is spent for the moment - links still work plain".into(),
        )),
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

    std::fs::create_dir_all(&config.data_directory)?;

    // The keystore comes first: the databases need it for their at-rest encryption keys.
    let keystore = keystore::Keystore::load(&config.data_directory)?;

    let node_db = db::open_node_db(&config.data_directory, &keystore).await?;
    db::record_boot(&node_db, &config.app_version).await?;
    tracing::info!(data_dir = %config.data_directory.display(), "opened node database");

    // Bound on simultaneously-open per-user DB handles. A placeholder default for now; will move to
    // config when it matters (many-user nodes tuning against file-handle limits).
    let user_dbs = db::UserDbManager::new(&config.data_directory, keystore.clone(), 128);

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
    let files = std::sync::Arc::new(
        files::FileStore::fs(config.data_directory.join("blobs"))
            .await?
            .with_max_blob_bytes(max_blob_bytes),
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
    };
    net::p2p::spawn_accept_loop(endpoint, state.clone());

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
    // lane, one fingerprint per (persona, service). Nudged, because a local write is exactly
    // when it goes stale, and ticked as the backstop for writes that arrive by sync. Off the
    // hot path deliberately - recomputing inside the append would charge every entry for a
    // fact only sweeps read, and Feed writes several entries per post.
    loops::periodic_nudged(
        "frontier-map",
        std::time::Duration::from_secs(30),
        state.user_dbs.write_nudge(),
        state.clone(),
        net::frontier::sweep,
    );
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
        .route("/id/{seg}/docs/{doc}/thumb", get(idface::public_thumb_route))
        .route("/id/{seg}/{*rest}", get(idface::idface_deep))
        .route("/api/id/{seg}/profile", get(idface::id_profile))
        .route("/api/id/{seg}/posts", get(idface::id_posts))
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
            .route(
                "/test/resolve-serving/{leaf}",
                axum::routing::get(test_endpoints::resolve_serving),
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
