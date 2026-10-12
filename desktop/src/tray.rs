//! The always-on half (DESKTOP.md, Stage 5): a tray icon, a window that hides rather than
//! closes, and a launch at login - so the node keeps running when nobody is looking at it,
//! which is what makes it somebody's presence on the network rather than a program they
//! happen to have open.
//!
//! **Close hides; Quit quits.** The window's close button hides it and the node runs on; the
//! tray's Quit is the one act that stops the node (and installs a pending update on the way
//! out, `update::install_pending`). On macOS the dock icon goes with the window, so a hidden
//! Horse Drawing Tycoon 2 reads as a background presence rather than a stuck app. On a machine with no
//! tray to come back through ([`TrayPresent`]) close quits instead - hidden with no way
//! back would be a node nobody can reach.
//!
//! **Start at login, on by default** (Curtis, 2026-09-24: affordances to tune this can come
//! later). Enabled once, on the first packaged launch, through the platform's own mechanism
//! (a Launch Agent, a Run key, an XDG autostart entry), and never re-enabled behind a user's
//! back: the tray's toggle is theirs from then on. A launch at login starts hidden. A dev
//! build never registers itself: its binary lives in a target directory.
//!
//! **One instance.** A second launch - the dock icon, the Start menu, a login item racing a
//! manual start - focuses the running window instead of building a second node against the
//! same data directory, which would lose the port and the database lock in that order.

use std::path::Path;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

/// The launch-at-login argument: a launch that carries it opens no window.
pub const HIDDEN_ARG: &str = "--hidden";
/// The marker beside the node's data that says start-at-login has been set up once. Its
/// presence is what keeps a user's later "no" from being overridden at every launch.
const AUTOSTART_MARKER: &str = "autostart-offered";

/// Whether this launch got a tray. On Linux the tray is a runtime library
/// (libayatana-appindicator, loaded by `dlopen`) that a machine may simply not have, and a
/// panel that may not render it; without one, a hidden window could never be reopened or quit
/// from, so close must quit instead (`main`'s window-event handler asks this).
pub struct TrayPresent(pub bool);

/// Was this launch asked to stay out of sight (a login item, or a hand-typed `--hidden`)?
pub fn launched_hidden() -> bool {
    std::env::args().any(|a| a == HIDDEN_ARG)
}

/// Build the tray and its menu, or record that this machine cannot show one. Called once from
/// `main`'s setup, and never fails it: an app that refuses to start because a panel library is
/// missing has confused the ornament with the point.
pub fn build(app: &AppHandle, data_dir: &Path, url: &str) {
    match try_build(app, url) {
        Ok(()) => app.manage(TrayPresent(true)),
        Err(e) => {
            tracing::warn!(error = %e, "no tray on this machine: closing the window will quit Horse Drawing Tycoon 2");
            app.manage(TrayPresent(false))
        }
    };
    offer_autostart(app, data_dir);
}

/// Does this launch have a tray to come back through?
pub fn present(app: &AppHandle) -> bool {
    app.try_state::<TrayPresent>().is_some_and(|t| t.0)
}

fn try_build(app: &AppHandle, url: &str) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Horse Drawing Tycoon 2", true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "status",
        format!("Horse Drawing Tycoon 2 {} · node at {url}", env!("CARGO_PKG_VERSION")),
        false,
        None::<&str>,
    )?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Horse Drawing Tycoon 2", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &status,
            &PredefinedMenuItem::separator(app)?,
            &autostart,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("the app icon".into()))?;
    TrayIconBuilder::with_id("ringtome")
        .icon(icon)
        .tooltip("Horse Drawing Tycoon 2")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "autostart" => {
                let launch = app.autolaunch();
                let now_on = launch.is_enabled().unwrap_or(false);
                let result = if now_on { launch.disable() } else { launch.enable() };
                match result {
                    Ok(()) => tracing::info!(enabled = !now_on, "start at login changed from the tray"),
                    Err(e) => tracing::warn!(error = %e, "could not change start at login"),
                }
                let _ = autostart.set_checked(launch.is_enabled().unwrap_or(false));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Turn start-at-login on, once, on a packaged build's first launch.
fn offer_autostart(app: &AppHandle, data_dir: &Path) {
    if cfg!(debug_assertions) {
        return;
    }
    let marker = data_dir.join(AUTOSTART_MARKER);
    if marker.exists() {
        // Offered before: the person's answer stands - but if it is "on", write it again, so
        // the login item names THIS executable. It records a path, and a renamed executable
        // (Ringtome to Horse Drawing Tycoon 2, 2026-09-25) or a moved app leaves the old entry
        // pointing at nothing; re-enabling on every launch makes that heal itself.
        let launch = app.autolaunch();
        if launch.is_enabled().unwrap_or(false) {
            if let Err(e) = launch.enable() {
                tracing::warn!(error = %e, "could not refresh start at login");
            }
        }
        return;
    }
    match app.autolaunch().enable() {
        Ok(()) => tracing::info!("start at login: on (first launch)"),
        Err(e) => tracing::warn!(error = %e, "could not enable start at login"),
    }
    if let Err(e) = std::fs::write(&marker, b"offered once; the tray owns it from here\n") {
        tracing::warn!(error = %e, "could not write the autostart marker");
    }
}

/// Bring the window back: shown, focused, and on macOS back in the dock.
pub fn show_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    crate::update::window_shown(app);
}

/// Put the window away: hidden, and on macOS out of the dock. The node runs on.
pub fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    crate::update::window_hidden(app);
}
