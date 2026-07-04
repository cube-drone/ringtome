//! Ringtome connector node - entry point.
//!
//! M0 skeleton: an Axum HTTP server that boots, logs, serves a health check and its public
//! config, and binds to the configured address. Everything below the HTTP layer (identity, the
//! IM-AOL, iroh p2p) arrives in later milestones.

use std::net::SocketAddr;

use axum::{extract::State, routing::get, Json, Router};
use tower_http::trace::TraceLayer;
use tracing::info_span;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod config;
mod error;
mod request_context;

use config::{Config, PublicConfig};
use error::AppError;

/// Shared, cheaply-cloneable application state. Services (identity, db, p2p, ...) will hang off
/// this as they are built.
#[derive(Clone)]
pub struct AppState {
    pub config: Config,
}

#[derive(serde::Serialize)]
struct Health {
    status: &'static str,
    version: String,
}

async fn health(State(state): State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: state.config.app_version.clone(),
    })
}

async fn get_config(State(state): State<AppState>) -> Result<Json<PublicConfig>, AppError> {
    Ok(Json(state.config.public()))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config::from_env();
    init_tracing(&config);

    tracing::info!(
        version = %config.app_version,
        environment = ?config.environment,
        tenancy = ?config.tenancy,
        "starting ringtome node"
    );

    std::fs::create_dir_all(&config.data_directory)?;

    let bind = format!("{}:{}", config.bind_address, config.port);
    let state = AppState { config };

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/config", get(get_config))
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
