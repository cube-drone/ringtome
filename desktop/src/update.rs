//! Auto-update (DESKTOP.md, Stage 6): the app looks for a newer release, fetches it in the
//! background, and installs it when the user quits.
//!
//! **Update-on-quit, not update-now.** An update is the whole app, tens of megabytes, and
//! installing it restarts the node - which is somebody's presence on the network, and after
//! Stage 5 an always-on one. So the default is to install the next time the app is closing
//! anyway, and the user is offered "restart now" exactly once per version for when they'd
//! rather have it sooner. Both roads verify the download the same way: the updater plugin
//! checks the archive's minisign signature against the public key baked into this binary
//! (`tauri.conf.json`, `plugins.updater.pubkey`) before it will hand the bytes over, and
//! Apple's and Microsoft's signatures on the new bundle are the system's business at the next
//! launch (SIGNING.md).
//!
//! **Only a packaged build updates.** A `cargo run` has no bundle to replace and a version
//! number that means nothing, so a dev build never checks - the same split as the
//! prod-versus-dev node in `main.rs`.
//!
//! Where an update comes from: `latest.json` on the newest GitHub Release, which the release
//! workflow writes (`includeUpdaterJson`). The plugin compares its version to this build's
//! and downloads the platform's artifact - the `.app.tar.gz`, the NSIS installer, the
//! AppImage. A `.deb` install has nothing the updater can replace and simply never sees one.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

/// The first look, after launch: late enough that the node is up and the window painted, since
/// nothing about an update is urgent.
const FIRST_CHECK: Duration = Duration::from_secs(30);
/// Between looks. Ten minutes while the product is changing daily (Curtis, 2026-09-24): a
/// check is one small GET against the release CDN, and a download happens only when the
/// version moved, so the cadence costs nothing and buys every install the day's releases
/// within minutes. Raise it when releases are weeks apart and nobody is waiting on one.
const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);

/// A verified, downloaded update waiting for the app to quit.
struct Pending {
    version: String,
    bytes: Vec<u8>,
    update: tauri_plugin_updater::Update,
}

/// The one pending update, held by Tauri's managed state so the exit hook can find it.
#[derive(Default)]
pub struct Waiting(Mutex<Option<Pending>>);

/// Start the loop. Called once from `main`, after the plugins are registered.
pub fn start(app: AppHandle) {
    if cfg!(debug_assertions) {
        tracing::info!("dev build: the updater is off");
        return;
    }
    app.manage(Waiting::default());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(e) = check_once(&app).await {
                tracing::warn!(error = %e, "update check failed");
            }
            tokio::time::sleep(CHECK_EVERY).await;
        }
    });
}

/// One look: is there a newer release, and if so fetch it, park it, and ask.
async fn check_once(app: &AppHandle) -> anyhow::Result<()> {
    // Nothing to ask while one is already waiting: a second download would only re-fetch the
    // same bytes (or a newer version, which the next quit-and-relaunch reaches anyway).
    if app.state::<Waiting>().0.lock().unwrap().is_some() {
        return Ok(());
    }
    let Some(update) = app.updater()?.check().await? else {
        tracing::debug!("up to date");
        return Ok(());
    };
    let version = update.version.clone();
    tracing::info!(%version, current = %update.current_version, "an update is available; downloading");
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await?;
    tracing::info!(%version, bytes = bytes.len(), "update downloaded and verified; it installs when the app quits");
    *app.state::<Waiting>().0.lock().unwrap() = Some(Pending {
        version: version.clone(),
        bytes,
        update,
    });

    // Once, and blocking on a worker thread rather than the runtime: a dialog waits on a
    // person, and the runtime has a node to run.
    let ask = app.clone();
    let now = tauri::async_runtime::spawn_blocking(move || {
        ask.dialog()
            .message(format!(
                "Ringtome {version} is downloaded. It will install the next time you quit.\n\n\
                 Restart now to update immediately? Your node will be offline for a few seconds."
            ))
            .title("Update ready")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Restart now".into(),
                "When I quit".into(),
            ))
            .blocking_show()
    })
    .await?;
    if now {
        install_pending(app);
        app.restart();
    }
    Ok(())
}

/// Install whatever is waiting. Called on the way out (`main`'s exit hook) and by "restart
/// now". On Windows the installer runs and the process is ended by the plugin; elsewhere the
/// bundle is replaced under the running app, which is about to stop using it.
pub fn install_pending(app: &AppHandle) {
    let Some(waiting) = app.try_state::<Waiting>() else {
        return; // a dev build never managed the state
    };
    let Some(pending) = waiting.0.lock().unwrap().take() else {
        return;
    };
    tracing::info!(version = %pending.version, "installing the update");
    if let Err(e) = pending.update.install(&pending.bytes) {
        tracing::error!(version = %pending.version, error = %e, "the update did not install; the next check will fetch it again");
    }
}
