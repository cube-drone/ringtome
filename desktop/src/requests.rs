//! What the node asks of this app (the node's `shell.rs`), done here, where the app is.
//!
//! - **Listen on the network, or stop**: multi-user mode being switched (the node's
//!   `registration.rs`). The choice is written down beside the port ([`network`]) and the app
//!   restarts, because where a node listens is settled before it exists (`start_node`).
//! - **Show a file**: a backup, on the Backups page - already on this disk, so the file manager
//!   opens with it selected rather than the webview trying to download it.

use std::path::{Path, PathBuf};

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use ringtome_node::shell::ShellRequest;

/// Act on the node's requests for the life of the app.
pub fn start(app: AppHandle, data_dir: PathBuf, mut requests: tokio::sync::broadcast::Receiver<ShellRequest>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let request = match requests.recv().await {
                Ok(request) => request,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            };
            match request {
                ShellRequest::ListenOnNetwork { on } => {
                    if let Err(e) = network::remember(&data_dir, on) {
                        tracing::error!(error = %e, "could not write down the network choice; not restarting");
                        continue;
                    }
                    tracing::info!(on, "listening on the network changes; restarting");
                    app.restart();
                }
                ShellRequest::Reveal { path } => {
                    if let Err(e) = app.opener().reveal_item_in_dir(&path) {
                        tracing::warn!(error = %e, path = %path.display(), "could not show the file");
                    }
                }
            }
        }
    });
}

/// Whether this app listens beyond this computer: multi-user mode's half that the shell owns.
///
/// A file beside the port file (port.rs), for the same reasons - it is decided before the node
/// exists, so it cannot live in the node's database, and an operator asking "why can my phone reach
/// this" can `cat` it. Absent, or anything but `on`, means this computer only: the app's default
/// is to face nobody.
pub mod network {
    use super::*;

    const NETWORK_FILE: &str = "desktop-network";

    pub fn listening(data_dir: &Path) -> bool {
        std::fs::read_to_string(data_dir.join(NETWORK_FILE)).map(|s| s.trim() == "on").unwrap_or(false)
    }

    pub fn remember(data_dir: &Path, on: bool) -> std::io::Result<()> {
        std::fs::write(data_dir.join(NETWORK_FILE), if on { "on\n" } else { "off\n" })
    }
}
