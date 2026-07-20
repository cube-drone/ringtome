//! Serves the embedded Preact SPA and its versioned static assets.
//!
//! # Architecture (mirroring api_old)
//!
//! * **Compile-time embedding**: `include_str!` bakes the esbuild output (`js/target/js/bundle.js`
//!   and `js/target/css/bundle.css`) plus the HTML shell (`html/index.html`) into the binary, so
//!   the deployed binary is fully self-contained — no external files to ship.
//!
//! * **Dev-mode hot reload**: When the node is running in `Dev` environment, the JS and CSS
//!   handlers re-read from disk on every request. Run `just watch` and `just csswatch` in `js/`
//!   and esbuild will rebuild on save; refresh the browser to pick it up instantly.
//!
//! * **Versioned URLs + CDN cache-busting**: The HTML template contains `$VERSION$` placeholders
//!   that are replaced at render-time with the app version from `Cargo.toml`. Assets are served at
//!   `/static/{version}/app.js` etc. The handler only serves versions *≤ the running version*, so
//!   a CDN can never accidentally cache a future version's assets under an old URL.

use axum::{
    extract::{Path, State},
    response::{Html, IntoResponse},
};

use crate::{error::AppError, semver, AppState};

// Baked into the binary at compile time.
const HOME_PAGE: &str = include_str!("../html/index.html");
const JS: &str = include_str!("../js/target/js/bundle.js");
const CSS: &str = include_str!("../js/target/css/bundle.css");

// Dev-mode paths, anchored to the crate root at compile time so they resolve correctly
// regardless of the process's working directory (the justfile runs cargo from the workspace
// root, not from node/).
const JS_DEV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/js/target/js/bundle.js");
const CSS_DEV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/js/target/css/bundle.css");

/// Render the SPA shell, replacing `$VERSION$` with the running app version.
pub async fn homepage(State(state): State<AppState>) -> Html<String> {
    let version = &state.config.app_version;
    let environment = if state.config.is_dev() { "dev" } else { "prod" };

    let page = HOME_PAGE
        .replace("$VERSION$", version)
        .replace("$ENVIRONMENT$", environment);

    Html(page)
}

/// Serve the JS bundle. Only versions ≤ current are served (see module doc).
pub async fn app_js(
    Path(version): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    check_version(&version, &state.config.app_version)?;

    if state.config.is_dev() {
        tracing::info!("dev mode: reloading JS from disk");
        let contents = std::fs::read_to_string(JS_DEV_PATH)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to read JS bundle from {}: {}", JS_DEV_PATH, e)))?;
        Ok(([(axum::http::header::CONTENT_TYPE, "application/javascript")], contents))
    } else {
        Ok(([(axum::http::header::CONTENT_TYPE, "application/javascript")], JS.to_string()))
    }
}

/// Serve the CSS bundle. Same versioning rules as JS.
pub async fn app_css(
    Path(version): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    check_version(&version, &state.config.app_version)?;

    if state.config.is_dev() {
        tracing::info!("dev mode: reloading CSS from disk");
        let contents = std::fs::read_to_string(CSS_DEV_PATH)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to read CSS bundle from {}: {}", CSS_DEV_PATH, e)))?;
        Ok(([(axum::http::header::CONTENT_TYPE, "text/css")], contents))
    } else {
        Ok(([(axum::http::header::CONTENT_TYPE, "text/css")], CSS.to_string()))
    }
}

/// Reject requests for versions newer than the running binary. Older-or-equal is fine: a CDN
/// might still be serving a stale HTML shell that references the old version, and that's
/// harmless. A *future* version, though, could let a malicious request poison the cache.
fn check_version(requested: &str, current: &str) -> Result<(), AppError> {
    let req = semver::semver_to_comparable_integer(requested)
        .map_err(|_| AppError::BadRequest(format!("invalid version: {requested}")))?;
    let cur = semver::semver_to_comparable_integer(current)
        .map_err(|e| AppError::Internal(e))?;

    if req > cur {
        return Err(AppError::BadRequest(format!(
            "requested version {requested} is newer than running version {current}"
        )));
    }
    Ok(())
}
