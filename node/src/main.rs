//! Ringtome connector node - entry point.
//!
//! The composition root: load config, open the databases and keystore, bind the iroh endpoint,
//! pick the discovery directory, mount the HTTP routers, and start the background loops. The
//! systems live in their own modules; this file's job is wiring them together.

use std::net::SocketAddr;

use axum::{extract::State, routing::get, Json, Router};
use sqlx::SqlitePool;
use tower_http::trace::TraceLayer;
use tracing::info_span;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod clock;
mod config;
mod db;
mod discovery;
mod error;
mod files;
mod identity;
mod imaol;
mod inspect;
mod keystore;
mod loops;
mod notes;
mod p2p;
mod private;
mod pubkey;
mod rate_limit;
mod request_context;
mod seal;
mod store;
mod sync;
mod test_endpoints;

use config::{Config, PublicConfig};
use error::AppError;

/// Shared, cheaply-cloneable application state. Services (identity, p2p, ...) will hang off this
/// as they are built.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    /// The node-level database (`node.db`): node config, known peers, replication state.
    pub node_db: SqlitePool,
    /// Opens/migrates/caches the per-identity databases.
    pub user_dbs: db::UserDbManager,
    /// Per-node in-memory rate limiter (disabled in local-test mode).
    pub rate_limiter: rate_limit::RateLimiter,
    /// Envelope encryption for private keys at rest.
    pub keystore: keystore::Keystore,
    /// The node's iroh endpoint: transport identity + p2p connections (cheaply cloneable).
    pub endpoint: iroh::Endpoint,
    /// Discovery: publish/resolve serving + endpoint records (off / local stub / mainline DHT).
    pub directory: discovery::Directory,
    /// The file layer: the node's one global blob store (encrypted bodies, later public media).
    pub files: std::sync::Arc<files::FileStore>,
}

#[derive(serde::Serialize)]
struct Health {
    status: &'static str,
    version: String,
}

/// Liveness check. Verifies the node database is actually reachable, not just that HTTP responds -
/// a node whose database is wedged is not healthy.
async fn health(State(state): State<AppState>) -> Result<Json<Health>, AppError> {
    sqlx::query("SELECT 1")
        .execute(&state.node_db)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;

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

    let node_db = db::open_node_db(&config.data_directory).await?;
    db::record_boot(&node_db, &config.app_version).await?;
    tracing::info!(data_dir = %config.data_directory.display(), "opened node database");

    // Bound on simultaneously-open per-user DB handles. A placeholder default for now; will move to
    // config when it matters (many-user nodes tuning against file-handle limits).
    let user_dbs = db::UserDbManager::new(&config.data_directory, 128);

    let bind = format!("{}:{}", config.bind_address, config.port);
    let local_test = config.local_test;
    // Rate limiting is off in local-test mode so integration tests don't trip it.
    let rate_limiter = rate_limit::RateLimiter::new(!local_test);
    let keystore = keystore::Keystore::load(&config.data_directory)?;
    let endpoint = p2p::build_endpoint(&keystore, &config.discovery).await?;
    let directory = discovery::Directory::build(&config.discovery)?;
    let files = std::sync::Arc::new(files::FileStore::fs(config.data_directory.join("blobs")).await?);
    let state = AppState {
        config,
        node_db,
        user_dbs,
        rate_limiter,
        keystore,
        endpoint: endpoint.clone(),
        directory,
        files,
    };
    p2p::spawn_accept_loop(endpoint, state.clone());

    // Background loops: every recurring process in the node, registered here by name. Modules
    // export one-pass functions; loops.rs owns the ticking, logging, and panic containment.
    let dht_ttl_pace = std::time::Duration::from_secs(15 * 60);
    loops::periodic(
        "republish-endpoint-record",
        dht_ttl_pace,
        state.clone(),
        discovery::republish_endpoint_pass,
    );
    loops::periodic(
        "republish-serving-records",
        dht_ttl_pace,
        state.clone(),
        identity::serving::republish_pass,
    );

    let mut app = Router::new()
        .route("/health", get(health))
        .route("/api/config", get(get_config))
        .route("/api/node", get(node_info))
        .merge(auth::router())
        .merge(identity::router());

    // DANGEROUS: only mounted in local-test mode. The route does not exist otherwise (404), so
    // there is no path to the SQL executor on a normal node. See test_endpoints.
    if local_test {
        tracing::warn!(
            "RINGTOME_LOCAL_TEST is enabled: mounting raw SQL passthrough at /test/sql. \
             This is an extreme security hole - use only on a local test node."
        );
        app = app.route("/test/sql", axum::routing::post(test_endpoints::raw_sql));
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
