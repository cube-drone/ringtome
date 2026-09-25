//! Desktop notifications: every time a badge in the app would light, the operating system says so
//! (Curtis, 2026-09-25) - unless the window is already in front of the person, where the badge
//! itself is the notification.
//!
//! The deciding is all the node's (`ringtome_node::attention`): it watches the same rows the two
//! dock badges count, and hands over each unseen, not-yet-announced one already worded. This file
//! only chooses whether anyone needs telling, and tells them.
//!
//! **Clicking a notification** brings the window forward where the platform routes the click to
//! the app (macOS activates the app, which Tauri reports as `Reopen` - see `main`). The alert's
//! `route` - the bell, or the room - is carried but not yet followed: the notification plugin
//! reports no click on desktop, so deep-linking waits for a way to hear one.

use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

/// Listen for the node's alerts for the life of the app.
pub fn start(app: AppHandle, mut alerts: tokio::sync::broadcast::Receiver<ringtome_node::attention::Alert>) {
    ask_once(&app);
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
            if let Err(e) = app.notification().builder().title(&alert.title).body(&alert.body).show() {
                tracing::warn!(error = %e, "could not show a notification");
            }
        }
    });
}

/// Is the window visible AND focused - is somebody looking at the badges right now?
fn in_front(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|w| {
        w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)
    })
}

/// The platform's permission, asked once: macOS shows its own prompt the first time, and the
/// answer is the person's from then on (System Settings, not us, is where they change it).
fn ask_once(app: &AppHandle) {
    let notifications = app.notification();
    match notifications.permission_state() {
        Ok(PermissionState::Granted) => {}
        Ok(PermissionState::Denied) => tracing::info!("notifications are turned off for this app"),
        _ => {
            if let Err(e) = notifications.request_permission() {
                tracing::warn!(error = %e, "could not ask for notification permission");
            }
        }
    }
}
