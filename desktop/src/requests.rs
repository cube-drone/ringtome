//! What the node asks of this app (the node's `shell.rs`), done here, where the app is.
//!
//! Today that is one thing: **show a file** - a backup, on the Device app's Backups page. It is
//! already on this disk, so the file manager opens with it selected rather than the webview trying
//! to download it.

use tauri::AppHandle;
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
            }
        }
    });
}
