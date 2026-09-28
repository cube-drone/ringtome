//! What the node asks of this app (the node's `shell.rs`), done here, where the app is.
//!
//! Two things:
//!
//! - **show a file** - a backup, on the Device app's Backups page. It is already on this disk, so
//!   the file manager opens with it selected rather than the webview trying to download it.
//! - **save a file** the page made - the spare key, a drawing's PNG (2026-09-28). A webview
//!   downloads nothing from a `blob:` link, so the page hands the bytes to the node and this asks
//!   where they go, with the system's own save dialog.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use ringtome_node::shell::ShellRequest;

/// Act on the node's requests for the life of the app.
pub fn start(app: AppHandle, mut requests: tokio::sync::broadcast::Receiver<ShellRequest>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let request = match requests.recv().await {
                Ok(request) => request,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            };
            match request {
                ShellRequest::Reveal { path } => {
                    if let Err(e) = app.opener().reveal_item_in_dir(&path) {
                        tracing::warn!(error = %e, path = %path.display(), "could not show the file");
                    }
                }
                ShellRequest::Save { name, bytes, .. } => save(&app, name, bytes),
            }
        }
    });
}

/// Ask where, then write. A cancel writes nothing; a failed write says so, since the person is
/// looking for the file and would otherwise not know it isn't there.
fn save(app: &AppHandle, name: String, bytes: impl AsRef<[u8]> + Send + 'static) {
    let dialogs = app.clone();
    app.dialog().file().set_file_name(&name).save_file(move |picked| {
        let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return };
        if let Err(e) = std::fs::write(&path, &bytes) {
            tracing::warn!(error = %e, path = %path.display(), "could not save the file");
            dialogs
                .dialog()
                .message(format!("Horse Drawing Tycoon 2 could not save {}: {e}", path.display()))
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
}
