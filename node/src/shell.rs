//! Requests from the node to the desktop shell that embeds it (desktop/src/main.rs).
//!
//! The other direction from attention.rs, and the same shape. The node cannot open a file manager,
//! being a library inside somebody else's process, so it says what it wants and the shell, if there
//! is one, does it. A server node has nobody listening, and says so to its caller: [`Shell::ask`]
//! answers whether anybody heard.
//!
//! In local-test mode every request is also recorded, so the rig can see what a device node asked
//! for without a shell to ask (`/test/shell`).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tokio::sync::broadcast;

/// What the node can ask of the app around it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ShellRequest {
    /// Show this file in the system's file manager (backup.rs: a desktop app's backups are
    /// already on the person's own disk, so "download" means "show me where").
    Reveal { path: PathBuf },
    /// Save these bytes where the person says, suggesting `name` (2026-09-28: a webview downloads
    /// nothing from a `blob:` link - the spare key and a drawing's PNG went nowhere in the desktop
    /// app). The page hands the file to the node ([`save_handler`]) and the shell asks where it
    /// goes. The bytes are never serialized: the test recorder shows the name and the size, and
    /// never a spare key.
    Save {
        name: String,
        #[serde(skip)]
        bytes: bytes::Bytes,
        size: usize,
    },
    /// Open this node in the system's own browser (2026-09-28: on Linux the app's webview is a
    /// poor place to be, and its sign-in says so). Always the node's own address, which the shell
    /// knows - nothing in the request can point it anywhere else.
    OpenInBrowser,
}

#[derive(Clone)]
pub struct Shell {
    sender: broadcast::Sender<ShellRequest>,
    recorded: Option<Arc<Mutex<Vec<ShellRequest>>>>,
}

impl Shell {
    pub fn new(record: bool) -> Self {
        let (sender, _) = broadcast::channel(16);
        Self { sender, recorded: record.then(|| Arc::new(Mutex::new(Vec::new()))) }
    }

    /// For the embedder: every request from here on.
    pub fn subscribe(&self) -> broadcast::Receiver<ShellRequest> {
        self.sender.subscribe()
    }

    /// Ask. True when somebody was there to hear it - a shell, or the test recorder.
    pub fn ask(&self, request: ShellRequest) -> bool {
        let recorded = match &self.recorded {
            Some(log) => {
                if let Ok(mut log) = log.lock() {
                    log.push(request.clone());
                }
                true
            }
            None => false,
        };
        self.sender.send(request).is_ok() || recorded
    }

    /// Everything asked so far (local-test mode; empty otherwise).
    pub fn recorded(&self) -> Vec<ShellRequest> {
        self.recorded
            .as_ref()
            .and_then(|log| log.lock().ok().map(|l| l.clone()))
            .unwrap_or_default()
    }
}

#[derive(serde::Deserialize)]
pub struct SaveQuery {
    pub name: String,
}

/// POST `/api/shell/save?name=` with the file as the body - the desktop app's way to download
/// something the page made itself. Only a device node has a shell to ask; anywhere else the
/// page downloads the ordinary way, so this answers 404 there. The name is only a suggestion to
/// a save dialog, but it is cut to its last path component all the same.
pub async fn save_handler(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _session: crate::auth::Session,
    axum::extract::Query(q): axum::extract::Query<SaveQuery>,
    body: bytes::Bytes,
) -> Result<axum::http::StatusCode, crate::error::AppError> {
    let name = file_name(&q.name);
    let size = body.len();
    if !crate::registration::is_device(&state)
        || !state.shell.ask(ShellRequest::Save { name, bytes: body, size })
    {
        return Err(crate::error::AppError::NotFound(crate::msg!(
            "shell.only-the-desktop-app-saves-files",
            "only the desktop app saves files this way"
        )));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// POST `/api/shell/open-in-browser` - the desktop app's window asks to be opened in the system
/// browser instead. Before anyone has signed in, so it asks no session; it asks the window's own
/// header instead (auth/extractor.rs, `window_offered`), so no other page - not even one in a
/// browser on this computer - can make the app open windows.
pub async fn open_in_browser_handler(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    headers: axum::http::HeaderMap,
) -> Result<axum::http::StatusCode, crate::error::AppError> {
    let from_window = crate::auth::window_offered(&headers, &state);
    if !from_window
        || !crate::registration::is_device(&state)
        || !state.shell.ask(ShellRequest::OpenInBrowser)
    {
        return Err(crate::error::AppError::NotFound(crate::msg!(
            "shell.only-the-desktop-app-opens-a-browser",
            "only the desktop app's own window can ask for that"
        )));
    }
    Ok(axum::http::StatusCode::NO_CONTENT)
}

/// A suggested file name, safe to hand a save dialog: the last path component, no control
/// characters, never empty.
fn file_name(said: &str) -> String {
    let last = said.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = last
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_string();
    if clean.is_empty() {
        "download".to_string()
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_suggested_name_is_one_plain_file_name() {
        assert_eq!(
            file_name("horse-drawing-tycoon-2-spare-key-abc.txt"),
            "horse-drawing-tycoon-2-spare-key-abc.txt"
        );
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("C:\\Windows\\evil.png"), "evil.png");
        assert_eq!(file_name("..hidden\nname"), "hiddenname");
        assert_eq!(file_name(""), "download");
        assert_eq!(file_name("a/"), "download");
    }
}
