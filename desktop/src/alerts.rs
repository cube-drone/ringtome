//! Desktop notifications: every time a badge in the app would light, the operating system says so
//! (Curtis, 2026-09-25) - unless the window is already in front of the person, where the badge
//! itself is the notification - and clicking one lands in the room or the bell it is about.
//!
//! The deciding is all the node's (`ringtome_node::attention`): it watches the same rows the two
//! dock badges count, and hands over each unseen, not-yet-announced one already worded, with the
//! UI route it belongs to. This file only chooses whether anyone needs telling, tells them, and
//! follows the click.
//!
//! **`notify-rust` directly, not the Tauri notification plugin.** The plugin's desktop `show()`
//! discards the handle `notify-rust` returns, and with it the click - which `notify-rust` reports
//! on every platform (the XDG "default" action, macOS's contents-clicked, the Windows toast's
//! activation). Its permission calls are fixed `Granted` on desktop, so nothing else was bought:
//! the platform owns permission, and macOS asks on a bundled app's first notification. The
//! per-platform setup below is the plugin's own, carried over (tauri-plugin-notification 2.4,
//! `desktop.rs`).
//!
//! **Waiting for the click holds a thread.** On macOS the default backend sends the notification
//! inside `wait_for_action` and blocks until the person acts or it is dismissed; elsewhere the
//! wait is a blocking receive. So each notification is waited on from the blocking pool, and past
//! [`MAX_WAITING`] outstanding ones a new notification is shown without a click to follow, rather
//! than let a flood of them hold the pool.

use std::sync::atomic::{AtomicUsize, Ordering};

use tauri::{AppHandle, Manager};

/// How many notifications may be waiting for a click at once.
const MAX_WAITING: usize = 32;
static WAITING: AtomicUsize = AtomicUsize::new(0);

/// Listen for the node's alerts for the life of the app.
pub fn start(app: AppHandle, mut alerts: tokio::sync::broadcast::Receiver<ringtome_node::attention::Alert>) {
    // macOS attributes a notification to the bundle it names; a dev run has no bundle of its
    // own, so it borrows Terminal's, as the plugin did.
    #[cfg(target_os = "macos")]
    {
        let identifier = if tauri::is_dev() { "com.apple.Terminal".to_string() } else { app.config().identifier.clone() };
        let _ = notify_rust::set_application(&identifier);
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let alert = match alerts.recv().await {
                Ok(alert) => alert,
                // Fell behind: the oldest news is the least worth showing. Carry on.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(missed)) => {
                    tracing::debug!(missed, "alerts lagged");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            };
            if in_front(&app) {
                continue; // the badge is right there
            }
            show(&app, alert);
        }
    });
}

/// Show one alert, and follow its click to its route.
fn show(app: &AppHandle, alert: ringtome_node::attention::Alert) {
    let mut notification = notify_rust::Notification::new();
    notification.summary(&alert.title).body(&alert.body).auto_icon();
    // Windows names a toast's sender by the app's AppUserModelID - only when running the
    // installed app; a build out of target/ has none registered, and the toast falls back.
    #[cfg(windows)]
    if !running_from_target() {
        notification.app_id(&app.config().identifier);
    }
    let follow = WAITING.fetch_add(1, Ordering::SeqCst) < MAX_WAITING;
    if !follow {
        WAITING.fetch_sub(1, Ordering::SeqCst);
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        match notification.show() {
            Ok(handle) if follow => {
                handle.wait_for_action(|action| {
                    if action == "default" {
                        open_at(&app, &alert.route);
                    }
                });
                WAITING.fetch_sub(1, Ordering::SeqCst);
            }
            Ok(_) => {}
            Err(e) => {
                if follow {
                    WAITING.fetch_sub(1, Ordering::SeqCst);
                }
                tracing::warn!(error = %e, "could not show a notification");
            }
        }
    });
}

/// The click: the window forward, and the UI at the alert's route - the room, or the bell. The
/// route goes onto the page's history and a `popstate` tells its router (preact-iso) to follow,
/// so the app moves without a reload. Only an app path is ever followed.
fn open_at(app: &AppHandle, route: &str) {
    crate::tray::show_window(app);
    if !route.starts_with("/home") {
        return;
    }
    let Some(window) = app.get_webview_window("main") else { return };
    let route = serde_json::to_string(route).expect("a string is JSON");
    let script = format!("history.pushState(null, '', {route}); dispatchEvent(new PopStateEvent('popstate'));");
    if let Err(e) = window.eval(&script) {
        tracing::warn!(error = %e, "could not follow a notification's route");
    }
}

/// Is the window visible AND focused - is somebody looking at the badges right now?
fn in_front(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)
    })
}

#[cfg(windows)]
fn running_from_target() -> bool {
    let sep = std::path::MAIN_SEPARATOR;
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.display().to_string()))
        .is_some_and(|dir| dir.ends_with(&format!("{sep}target{sep}debug")) || dir.ends_with(&format!("{sep}target{sep}release")))
}
