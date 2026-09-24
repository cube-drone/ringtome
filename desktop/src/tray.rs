//! The always-on half (DESKTOP.md, Stage 5): a tray icon, a window that hides rather than
//! closes, and a launch at login - so the node keeps running when nobody is looking at it,
//! which is what makes it somebody's presence on the network rather than a program they
//! happen to have open.
//!
//! **Close hides; Quit quits.** The window's close button hides it and the node runs on; the
//! tray's Quit is the one act that stops the node (and installs a pending update on the way
//! out, `update::install_pending`). On macOS the dock icon goes with the window, so a hidden
//! Ringtome reads as a background presence rather than a stuck app.
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

/// Was this launch asked to stay out of sight (a login item, or a hand-typed `--hidden`)?
pub fn launched_hidden() -> bool {
    std::env::args().any(|a| a == HIDDEN_ARG)
}

/// Build the tray and its menu. Called once from `main`'s setup.
pub fn build(app: &AppHandle, data_dir: &Path, url: &str) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Ringtome", true, None::<&str>)?;
    let status = MenuItem::with_id(
        app,
        "status",
        format!("Ringtome {} · node at {url}", env!("CARGO_PKG_VERSION")),
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
    let quit = MenuItem::with_id(app, "quit", "Quit Ringtome", true, None::<&str>)?;
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
        .tooltip("Ringtome")
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

    offer_autostart(app, data_dir);
    Ok(())
}

/// Turn start-at-login on, once, on a packaged build's first launch.
fn offer_autostart(app: &AppHandle, data_dir: &Path) {
    if cfg!(debug_assertions) {
        return;
    }
    let marker = data_dir.join(AUTOSTART_MARKER);
    if marker.exists() {
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
