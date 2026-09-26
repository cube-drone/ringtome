//! The node as a child process: start it, ask it whether it is healthy, stop it.
//!
//! The child inherits the supervisor's environment (the operator's node settings) with the data
//! and backup directories set explicitly to the absolute paths the supervisor resolved, and its
//! output goes where the supervisor's does - the journal, under systemd.
//!
//! Stopping is SIGTERM, then SIGKILL after the grace period. The node keeps its databases in
//! SQLite's write-ahead log, which survives an abrupt exit by design, so the grace period is a
//! courtesy, not what consistency rests on.

use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::process::{Child, Command};

use crate::config::Config;

/// How long one `/health` request may take. The node answers from one `SELECT 1`; a node that
/// cannot do that in this long is not healthy, whatever it would eventually say.
const HEALTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const HEALTH_POLL: Duration = Duration::from_millis(500);

pub struct Node {
    child: Child,
    pub version: String,
    started: Instant,
    pid_file: std::path::PathBuf,
}

/// Start `binary` (the node at `version`).
///
/// On Linux the child is asked to receive SIGTERM when the supervisor dies (`PR_SET_PDEATHSIG`),
/// so a supervisor killed outright cannot leave an orphaned node holding the port and the data
/// directory. The signal is tied to the THREAD that forked, not the process - which is why the
/// supervisor runs on a current-thread runtime (`main.rs`) and spawns from its main future: that
/// thread lives exactly as long as the supervisor does.
pub fn spawn(config: &Config, binary: &Path, version: &str) -> Result<Node> {
    let mut command = Command::new(binary);
    command
        .env("RINGTOME_DATA_DIRECTORY", &config.data_directory)
        .env("RINGTOME_BACKUP_DIRECTORY", &config.backup_directory)
        .stdin(Stdio::null())
        .kill_on_drop(false);
    #[cfg(target_os = "linux")]
    // SAFETY: prctl is async-signal-safe and touches only the calling (child) process.
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .spawn()
        .with_context(|| format!("starting {}", binary.display()))?;
    let pid_file = config.pid_file();
    if let Some(pid) = child.id() {
        if let Err(e) = std::fs::write(&pid_file, format!("{pid}\n")) {
            tracing::warn!(error = %e, "could not write {}", pid_file.display());
        }
    }
    tracing::info!(version, pid = child.id(), "node started");
    Ok(Node {
        child,
        version: version.to_string(),
        started: Instant::now(),
        pid_file,
    })
}

/// Does the node at `node_url` answer `/health` with 200 right now?
pub async fn is_healthy(client: &reqwest::Client, node_url: &str) -> bool {
    matches!(
        client.get(format!("{node_url}/health")).timeout(HEALTH_REQUEST_TIMEOUT).send().await,
        Ok(r) if r.status().is_success()
    )
}

impl Node {
    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    /// Wait for the process to exit, however long that takes.
    pub async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        self.child.wait().await
    }

    /// Wait until the node answers `/health` (within `timeout`), then until it has stayed up and
    /// healthy for `probation`. Fails at once if the process exits: a node that died will not
    /// become healthy by waiting.
    pub async fn wait_healthy(
        &mut self,
        client: &reqwest::Client,
        node_url: &str,
        timeout: Duration,
        probation: Duration,
    ) -> Result<()> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().context("checking on the node")? {
                bail!("it exited ({status}) before it answered /health");
            }
            if is_healthy(client, node_url).await {
                break;
            }
            if Instant::now() >= deadline {
                bail!("it did not answer /health within {}s", timeout.as_secs());
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }
        let settled = Instant::now() + probation;
        while Instant::now() < settled {
            if let Some(status) = self.child.try_wait().context("checking on the node")? {
                bail!(
                    "it answered /health, then exited ({status}) within {}s",
                    probation.as_secs()
                );
            }
            tokio::time::sleep(HEALTH_POLL).await;
        }
        if !is_healthy(client, node_url).await {
            bail!(
                "it answered /health, then stopped answering within {}s",
                probation.as_secs()
            );
        }
        Ok(())
    }

    /// SIGTERM, a grace period, then SIGKILL; returns once the process is gone.
    pub async fn stop(mut self, grace: Duration) {
        if let Ok(Some(_)) = self.child.try_wait() {
            self.forget_pid();
            return;
        }
        terminate(&self.child);
        match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(_) => tracing::info!(version = self.version, "node stopped"),
            Err(_) => {
                tracing::warn!(
                    version = self.version,
                    "node ignored SIGTERM for {}s; killing it",
                    grace.as_secs()
                );
                let _ = self.child.kill().await;
            }
        }
        self.forget_pid();
    }

    /// The process exited on its own; tidy up after it.
    pub fn forget_pid(&self) {
        let _ = std::fs::remove_file(&self.pid_file);
    }
}

#[cfg(unix)]
fn terminate(child: &Child) {
    if let Some(pid) = child.id() {
        // SAFETY: kill(2) with a pid we own and a valid signal number.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

/// Elsewhere there is no SIGTERM to send; `stop` falls through to the kill after the grace period.
#[cfg(not(unix))]
fn terminate(_child: &Child) {}
