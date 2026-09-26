//! ringtome-supervisor: the stable parent of a server node (SERVER.md, "The supervisor").
//!
//! A server node changes every release; the thing that keeps it running should not. This binary
//! starts the `ringtome` node as its child, restarts it when it exits, installs signed releases
//! when they appear, backs the node up, and rolls an update back - binary AND data - when the new
//! version will not come up healthy. It is supervised in turn by systemd (or anything like it):
//! the supervisor does not reinvent an init system, it only knows what an init system cannot -
//! what a Ringtome release is, and that a migrated database cannot be migrated back.
//!
//! Composition root: read the settings, start logging, hand over to `supervise`.

mod backup;
mod config;
mod install;
mod manifest;
mod node;
mod stamp;
mod supervise;

use tracing_subscriber::EnvFilter;

// Current-thread on purpose, not for speed: the node is spawned from this runtime's one thread,
// and on Linux the child's parent-death signal is tied to the thread that forked it (node.rs).
#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("RINGTOME_SUPERVISOR_LOG")
                .unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let config = config::Config::from_env()?;
    supervise::run(config).await
}
