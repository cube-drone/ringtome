//! Serves the embedded Preact SPA and its versioned static assets.
//!
//! # Architecture (mirroring api_old)
//!
//! * **Compile-time embedding**: `include_str!` bakes the esbuild output (`js/target/js/bundle.js`
//!   and `js/target/css/bundle.css`) plus the HTML shell (`html/index.html`) into the binary.
//!   `include_bytes!` bakes the Marquee font woff2 files in too. The deployed binary is fully
//!   self-contained — no external files to ship.
//!
//! * **Dev-mode hot reload**: When the node is running in `Dev` environment, the JS, CSS, and
//!   font handlers re-read from disk on every request. Run `just ui-watch` and `just ui-csswatch`
//!   in the node directory and esbuild will rebuild on save; refresh the browser to pick it up.
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

// --- HTML / JS / CSS: baked into the binary at compile time ---

const HOME_PAGE: &str = include_str!("../html/index.html");
const JS: &str = include_str!("../js/target/js/bundle.js");
const CSS: &str = include_str!("../js/target/css/bundle.css");

// Dev-mode paths, anchored to the crate root at compile time so they resolve correctly
// regardless of the process's working directory (the justfile runs cargo from the workspace
// root, not from node/).
const JS_DEV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/js/target/js/bundle.js");
const CSS_DEV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/js/target/css/bundle.css");

// --- Marquee fonts: all 31 woff2 faces, baked into the binary ---
//
// In prod the binary is self-contained; in dev we read from the npm package on disk so that
// adding a font during development doesn't require a Rust recompile.

const FONTS_DEV_DIR: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/js/node_modules/@cube-drone/marquee-fonts/fonts"
);

/// (filename, embedded bytes) — the lookup table for prod-mode font serving.
const EMBEDDED_FONTS: &[(&str, &[u8])] = &[
    ("radio-canada.woff2",          include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/radio-canada.woff2")),
    ("atkinson-hyperlegible.woff2", include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/atkinson-hyperlegible.woff2")),
    ("lexend.woff2",                include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/lexend.woff2")),
    ("zilla-slab.woff2",            include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/zilla-slab.woff2")),
    ("playfair-display.woff2",      include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/playfair-display.woff2")),
    ("cormorant.woff2",             include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/cormorant.woff2")),
    ("im-fell-english.woff2",       include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/im-fell-english.woff2")),
    ("uncial-antiqua.woff2",        include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/uncial-antiqua.woff2")),
    ("unifraktur.woff2",            include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/unifraktur.woff2")),
    ("jetbrains-mono.woff2",        include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/jetbrains-mono.woff2")),
    ("vt323.woff2",                 include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/vt323.woff2")),
    ("press-start.woff2",           include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/press-start.woff2")),
    ("silkscreen.woff2",            include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/silkscreen.woff2")),
    ("major-mono.woff2",            include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/major-mono.woff2")),
    ("orbitron.woff2",              include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/orbitron.woff2")),
    ("bungee.woff2",                include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/bungee.woff2")),
    ("monoton.woff2",               include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/monoton.woff2")),
    ("creepster.woff2",             include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/creepster.woff2")),
    ("special-elite.woff2",         include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/special-elite.woff2")),
    ("fredericka.woff2",            include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/fredericka.woff2")),
    ("lobster.woff2",               include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/lobster.woff2")),
    ("pacifico.woff2",              include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/pacifico.woff2")),
    ("caveat.woff2",                include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/caveat.woff2")),
    ("comic-neue.woff2",            include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/comic-neue.woff2")),
    ("audiowide.woff2",             include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/audiowide.woff2")),
    ("kablammo.woff2",              include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/kablammo.woff2")),
    ("henny-penny.woff2",           include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/henny-penny.woff2")),
    ("oi.woff2",                    include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/oi.woff2")),
    ("rye.woff2",                   include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/rye.woff2")),
    ("bitcount.woff2",              include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/bitcount.woff2")),
    ("quicksand.woff2",             include_bytes!("../js/node_modules/@cube-drone/marquee-fonts/fonts/quicksand.woff2")),
];

// ---- handlers ----

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

/// Serve a Marquee font file. In prod, served from the binary's embedded data; in dev, read
/// from the npm package on disk.
pub async fn font(
    Path(filename): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, AppError> {
    // Only serve .woff2 files — reject anything else before touching the filesystem.
    if !filename.ends_with(".woff2") {
        return Err(AppError::NotFound(crate::msg!("ui.not-a-font-file-filename", "not a font file: {filename}", filename = filename)));
    }

    if state.config.is_dev() {
        let path = format!("{}/{}", FONTS_DEV_DIR, filename);
        let bytes = std::fs::read(&path)
            .map_err(|e| AppError::NotFound(crate::msg!("ui.font-not-found-at", "font not found at {path}: {error}", path = path, error = e)))?;
        Ok(([(axum::http::header::CONTENT_TYPE, "font/woff2")], bytes))
    } else {
        let bytes = EMBEDDED_FONTS
            .iter()
            .find(|(name, _)| *name == filename.as_str())
            .map(|(_, data)| *data)
            .ok_or_else(|| AppError::NotFound(crate::msg!("ui.unknown-font-filename", "unknown font: {filename}", filename = filename)))?;
        Ok(([(axum::http::header::CONTENT_TYPE, "font/woff2")], bytes.to_vec()))
    }
}

/// Reject requests for versions newer than the running binary. Older-or-equal is fine: a CDN
/// might still be serving a stale HTML shell that references the old version, and that's
/// harmless. A *future* version, though, could let a malicious request poison the cache.
fn check_version(requested: &str, current: &str) -> Result<(), AppError> {
    let req = semver::semver_to_comparable_integer(requested)
        .map_err(|_| AppError::BadRequest(crate::msg!("ui.invalid-version-requested", "invalid version: {requested}", requested = requested)))?;
    let cur = semver::semver_to_comparable_integer(current)
        .map_err(AppError::Internal)?;

    if req > cur {
        return Err(AppError::BadRequest(crate::msg!("ui.requested-version-requested-is-newer", "requested version {requested} is newer than running version {current}", requested = requested, current = current)));
    }
    Ok(())
}
