//! Requests from the node to the desktop shell that embeds it (desktop/src/main.rs).
//!
//! The other direction from attention.rs, and the same shape: the node cannot restart the app or
//! open a file manager - it is a library inside somebody else's process - so it says what it wants
//! and the shell, if there is one, does it. A server node has nobody listening, and says so to its
//! caller: [`Shell::ask`] answers whether anybody heard.
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
    /// Listen on the local network (true) or on this computer only (false), from the next start -
    /// and restart now to get there (registration.rs, multi-user mode). The binding is the shell's
    /// to decide, because it is decided before the node exists.
    ListenOnNetwork { on: bool },
    /// Show this file in the system's file manager (backup.rs: a desktop app's backups are
    /// already on the person's own disk, so "download" means "show me where").
    Reveal { path: PathBuf },
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
        self.recorded.as_ref().and_then(|log| log.lock().ok().map(|l| l.clone())).unwrap_or_default()
    }
}
