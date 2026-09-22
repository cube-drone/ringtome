//! Ringtome for the desktop: one window, one process, the node inside it.
//!
//! DESKTOP.md's architecture in three steps, and this file is all three: build the node, serve it
//! on a loopback listener on the runtime the shell is already using, open the window at its URL.
//! There is no child process here - no sidecar to orphan, no readiness poll, no second executable
//! to ship or to notarize - because the node is a library (Stage 1) and this links it.
//!
//! What this file must never become is a second composition root. It decides three things that
//! belong to an embedder - where the data lives, which port to ask for, and that the window exists
//! - and then calls `ringtome_node::bind`. Everything else about what a node IS stays in the
//! library, where `just ci` tests it.
//!
//! Stage 2 is dev-only: no signing, no updater, no installer, no tray, no autostart. The
//! environment is left to `RINGTOME_ENVIRONMENT`, which means a plain `just desktop` runs the node
//! in dev mode and serves the UI from disk - edit `node/js`, hit reload, see it - and Stage 4 will
//! be where a packaged build says `prod` and eats the bundle baked into the binary.

mod port;

use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = data_directory(app.handle())?;
            // The key for this launch (DESKTOP.md, Stage 3), minted here and never written
            // down: the node takes it as proof of being this window, and the window is handed
            // it by an initialization script - which runs before any page script, so the
            // client finds it already there. NOT the query string: a URL lands in history, in
            // a log, in a screenshot, and this is the whole house.
            let token = ringtome_node::auth::mint_launch_token();
            let url = start_node(&data_dir, token.clone())?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("Ringtome")
                .inner_size(1280.0, 860.0)
                .initialization_script(&format!(
                    "window.__ringtome_launch_token = {};",
                    serde_json::to_string(&token).expect("a hex string is JSON")
                ))
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("running the Ringtome desktop shell");
}

/// Where this app keeps its node: the platform's own application-data directory, named by the
/// bundle identifier - `~/Library/Application Support/net.lassam.ringtome` and its friends.
///
/// Deliberately NOT the node's own `./data` default, which is relative to the working directory:
/// an app launched from the dock has no working directory worth the name, and an operator running
/// the `ringtome` binary must never find that a desktop build moved their data. `RINGTOME_DATA_DIRECTORY`
/// still wins when it is set, because that is how a developer points this at a scratch node.
fn data_directory(app: &tauri::AppHandle) -> anyhow::Result<PathBuf> {
    if let Ok(said) = std::env::var("RINGTOME_DATA_DIRECTORY") {
        return Ok(PathBuf::from(said));
    }
    Ok(app.path().app_data_dir()?)
}

/// Build the node, bind it, and hand back the URL the window should open - having started the
/// server on Tauri's own runtime, which is the tokio runtime this app already has.
///
/// The port is the remembered one (see [`port`]); if something else took it since last launch the
/// bind fails, and the answer to that is another port written down rather than a shell that will
/// not start.
fn start_node(data_dir: &PathBuf, token: String) -> anyhow::Result<String> {
    let mut config = ringtome_node::config::Config::from_env();
    config.data_directory = data_dir.clone();
    // A PACKAGED app is a prod node (DESKTOP.md, Stage 4), and a `cargo run` is a dev one - which
    // is not a preference but a fact about where the UI comes from: a dev node serves the bundle
    // from `node/js/target` by absolute path, which exists on the machine that compiled it and
    // nowhere else. The build profile is the honest signal, and `RINGTOME_ENVIRONMENT` still wins
    // for anyone who wants to argue with it.
    if std::env::var("RINGTOME_ENVIRONMENT").is_err() && !cfg!(debug_assertions) {
        config.environment = ringtome_node::config::Environment::Prod;
    }
    // One human, one account, and the token is how they say so - which is what removes the
    // login screen. Set here rather than read from the environment, because these two are
    // facts about being an app rather than an operator's choice.
    config.tenancy = ringtome_node::config::Tenancy::Single;
    config.launch_token = Some(token);
    // Loopback, always: the desktop node is this machine's, and the one place the password floor
    // relaxes is a node that faces nobody (config.rs::password_min_len).
    config.bind_address = "127.0.0.1".to_string();
    config.port = port::remembered_or_fresh(data_dir)?;
    // The shell's own target, said out loud: the library builds its default filter from its own
    // crate name, so without this the lines below are logged to nobody.
    ringtome_node::init_tracing_with(&config, &["ringtome_desktop"]);

    // One retry, and it costs one assembly rather than two: the library binds its listener
    // before it builds anything, so a taken port fails early and leaves nothing running.
    let bound = match bind_blocking(config.clone()) {
        Ok(bound) => bound,
        Err(first) => {
            tracing::warn!(port = config.port, error = %first, "the remembered port is taken; picking another");
            config.port = port::pick_another(data_dir)?;
            bind_blocking(config.clone())?
        }
    };
    let url = format!("http://{}/", bound.addr());
    tracing::info!(%url, data_dir = %data_dir.display(), "ringtome desktop: node up");
    tauri::async_runtime::spawn(async move {
        if let Err(e) = ringtome_node::serve(bound).await {
            tracing::error!(error = ?e, "the node stopped serving");
        }
    });
    Ok(url)
}

/// The boot, awaited before the window exists - which is the whole readiness story: by the time
/// there is a URL to open, the listener is bound and the router is assembled.
fn bind_blocking(config: ringtome_node::config::Config) -> anyhow::Result<ringtome_node::Bound> {
    tauri::async_runtime::block_on(ringtome_node::bind(config))
}
