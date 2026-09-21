//! The desktop node's port, and why it is written down.
//!
//! DESKTOP.md settles the origin question as **option (a)**: a persisted fixed port, page and API
//! same-origin. The reason is not tidiness. Browser storage is partitioned per ORIGIN, and the
//! origin of `http://127.0.0.1:5281` is not the origin of `http://127.0.0.1:5282` - so a port that
//! floats between launches silently drops the mirror, the remembered column widths, the open chat,
//! every per-origin thing the client keeps. The same-origin arrangement is also the one the spike
//! actually validated, and the one where the live-cache WebSocket needs nothing new.
//!
//! So: pick once, write it into the data directory, reuse it forever. A collision picks again and
//! writes the new one down - the mirror resnapshots, which is free by design, and the alternative
//! (refusing to start because something else took the port) is worse for a consumer app.

use std::net::TcpListener;
use std::path::{Path, PathBuf};

/// The file, beside the node's own data. Plain text, one number, so an operator debugging "which
/// port is my app on" can read it with `cat`.
const PORT_FILE: &str = "desktop-port";

fn port_file(data_dir: &Path) -> PathBuf {
    data_dir.join(PORT_FILE)
}

/// The port this desktop node should ask for: the one written down, or a fresh one from the OS.
pub fn remembered_or_fresh(data_dir: &Path) -> anyhow::Result<u16> {
    if let Some(port) = remembered(data_dir) {
        return Ok(port);
    }
    let port = free_port()?;
    remember(data_dir, port)?;
    Ok(port)
}

/// Forget the port and pick another: what the caller does when binding the remembered one failed,
/// which means something else is on it now.
pub fn pick_another(data_dir: &Path) -> anyhow::Result<u16> {
    let port = free_port()?;
    remember(data_dir, port)?;
    Ok(port)
}

fn remembered(data_dir: &Path) -> Option<u16> {
    std::fs::read_to_string(port_file(data_dir))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn remember(data_dir: &Path, port: u16) -> anyhow::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(port_file(data_dir), format!("{port}\n"))?;
    Ok(())
}

/// A port the OS says is free right now: bind zero, read what it gave, let it go. There is a
/// window between letting go and binding again in which somebody else could take it - which is
/// exactly the case [`pick_another`] exists for, so the race costs one retry rather than a boot.
fn free_port() -> anyhow::Result<u16> {
    let probe = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(probe.local_addr()?.port())
}
