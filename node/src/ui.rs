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
/// The tab icon and the home-screen icon, from `branding/hdt_logo.png` (branding/README.md says how
/// they were made). Served from the root, where browsers and iOS look for them unasked.
const FAVICON: &[u8] = include_bytes!("../html/favicon.ico");
const APPLE_TOUCH_ICON: &[u8] = include_bytes!("../html/apple-touch-icon.png");

/// The Web Push service worker (js/sw.js): its own script, never bundled.
const SERVICE_WORKER: &str = include_str!("../js/sw.js");
const SERVICE_WORKER_DEV_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/js/sw.js");
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
    Html(app_page(&state, "<title>Horse Drawing Tycoon 2</title>"))
}

/// The app's page with a head of the caller's choosing (PROJECT_PLAN's The node's public face, ruling 8): the title
/// and the OpenGraph meta a crawler or a link unfurler reads, with the app taking the body -
/// one rendering path for signed-in readers and strangers alike.
pub fn app_page(state: &AppState, head: &str) -> String {
    let version = &state.config.app_version;
    let environment = if state.config.is_dev() { "dev" } else { "prod" };
    // A dev node names the branch it was run from, which the version label shows in place of a
    // release name (js/version.js; Curtis, 2026-09-25: "0.1.7-cloth-vowel" is right for a release,
    // "main" or "feature-dinglebingle" for a local build). Read per page, so switching branches
    // shows up on the next reload without a rebuild; a prod node - every packaged app - says
    // nothing, and shows its release.
    let branch = if state.config.is_dev() {
        dev_branch()
            .map(|b| format!("\n    <meta name=\"app-branch\" content=\"{}\">", escape_attr(&b)))
            .unwrap_or_default()
    } else {
        String::new()
    };
    HOME_PAGE
        .replace("$HEAD$", head)
        .replace("$VERSION$", version)
        .replace("$BRANCH$", &branch)
        .replace("$ENVIRONMENT$", environment)
}

/// The checkout this dev node was built from - the repository above the node crate.
const REPO_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");

/// The branch the checkout is on: `.git/HEAD`, read directly (no `git` process per page). A
/// worktree's `.git` is a FILE naming its real git directory, which is followed; a detached HEAD
/// names its commit, shortened. None when there is no checkout to read.
fn dev_branch() -> Option<String> {
    let dot_git = std::path::Path::new(REPO_DIR).join(".git");
    let git_dir = if dot_git.is_file() {
        let pointer = std::fs::read_to_string(&dot_git).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim().to_string();
        let target = std::path::PathBuf::from(target);
        if target.is_absolute() { target } else { std::path::Path::new(REPO_DIR).join(target) }
    } else {
        dot_git
    };
    branch_from_head(&std::fs::read_to_string(git_dir.join("HEAD")).ok()?)
}

/// `HEAD`'s contents to a name: `ref: refs/heads/<branch>` is the branch, a bare hash is a
/// detached checkout and shows its first seven characters.
fn branch_from_head(head: &str) -> Option<String> {
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref:") {
        let r = r.trim();
        return Some(r.strip_prefix("refs/heads/").unwrap_or(r).to_string()).filter(|b| !b.is_empty());
    }
    (head.len() >= 7 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head[..7].to_string())
}

/// Enough escaping for an attribute value: a branch name is the developer's own, but `&`, `<`
/// and quotes are all legal in one.
fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;").replace('>', "&gt;")
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

/// Serve the service worker at `/sw.js` - the origin's root, which is what lets its scope cover
/// the whole app - unversioned and `no-cache`: the browser compares it byte for byte on every
/// navigation and installs a changed one, so a stale cached copy would pin old behaviour.
pub async fn service_worker(State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let contents = if state.config.is_dev() {
        std::fs::read_to_string(SERVICE_WORKER_DEV_PATH)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("failed to read the service worker from {}: {}", SERVICE_WORKER_DEV_PATH, e)))?
    } else {
        SERVICE_WORKER.to_string()
    };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, "application/javascript"),
            (axum::http::header::CACHE_CONTROL, "no-cache"),
        ],
        contents,
    ))
}

/// `/favicon.ico` and `/apple-touch-icon.png`: embedded, unversioned, and cached for a day - an icon
/// changes about once a logo, and a day-stale tab icon costs nobody anything.
pub async fn favicon() -> impl IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/x-icon"), (axum::http::header::CACHE_CONTROL, "public, max-age=86400")], FAVICON)
}

pub async fn apple_touch_icon() -> impl IntoResponse {
    ([(axum::http::header::CONTENT_TYPE, "image/png"), (axum::http::header::CACHE_CONTROL, "public, max-age=86400")], APPLE_TOUCH_ICON)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_names_the_branch_or_the_commit() {
        assert_eq!(branch_from_head("ref: refs/heads/main\n").as_deref(), Some("main"));
        assert_eq!(
            branch_from_head("ref: refs/heads/feature/dinglebingle").as_deref(),
            Some("feature/dinglebingle"),
            "a slashed branch keeps its slashes"
        );
        assert_eq!(
            branch_from_head("03310cd4f2a1b9e8c7d6e5f4a3b2c1d0e9f8a7b6\n").as_deref(),
            Some("03310cd"),
            "a detached checkout shows its commit"
        );
        assert_eq!(branch_from_head("ref: "), None);
        assert_eq!(branch_from_head("not a head"), None);
    }

    #[test]
    fn a_branch_name_cannot_break_out_of_its_attribute() {
        assert_eq!(escape_attr(r#"a"b<c>&d"#), "a&quot;b&lt;c&gt;&amp;d");
    }
}
