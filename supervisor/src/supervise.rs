//! The loop: keep the node running, bring it forward, back it up, and undo an update that failed.
//!
//! One task, one `select!`, so there is never a question of two things touching the node at once:
//! the node exiting, a restart coming due, an update check, a scheduled backup, and a request to
//! stop are each a branch, and each runs to completion before the next is looked at.
//!
//! **An update**, in order (SERVER.md, "The supervisor"):
//!
//! 1. download the new release and verify it (`install::download`) - the old node keeps serving;
//! 2. back up (`backup.rs`: live, falling back to stopped) - no backup, no update;
//! 3. record the update as pending, stop the old node, start the new one;
//! 4. wait for `/health`, then a probation period;
//! 5. healthy: done. Otherwise, **roll back**: stop it, restore the backup (a migrated database
//!    cannot be opened by the older binary - nothing migrates down), start the previous version,
//!    and never try the failed one again.
//!
//! Steps 3-5 are `settle`, and they are also what a restarted supervisor does when it finds an
//! update still pending: it cannot know how far the last one got, so it proves the new version
//! from the start.

use std::time::Duration;

use anyhow::{Context, Result};
use tokio::time::Instant;

use crate::backup;
use crate::config::{BackupStrategy, Config};
use crate::install::{self, Pending, State};
use crate::manifest;
use crate::node::{self, Node};
use crate::stamp;

/// A node that exits is restarted after this, doubling on each quick exit up to the ceiling.
const RESTART_FLOOR: Duration = Duration::from_secs(1);
const RESTART_CEILING: Duration = Duration::from_secs(60);
/// A node that ran this long before exiting had been working: its restart starts from the floor.
const RAN_LONG_ENOUGH: Duration = Duration::from_secs(60);
/// With nothing installed yet, how often to retry the first download.
const FIRST_INSTALL_RETRY: Duration = Duration::from_secs(60);
/// Nightly backups run when the UTC clock reads this hour.
const NIGHTLY_UTC_HOUR: i64 = 4;

struct Supervisor {
    config: Config,
    client: reqwest::Client,
    state: State,
    node: Option<Node>,
    restart_at: Option<Instant>,
    backoff: Duration,
}

pub async fn run(config: Config) -> Result<()> {
    std::fs::create_dir_all(config.versions_directory())
        .with_context(|| format!("creating {}", config.versions_directory().display()))?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .user_agent(concat!("ringtome-supervisor/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("building the HTTP client")?;
    let state = State::load(&config)?;
    tracing::info!(
        supervisor = env!("CARGO_PKG_VERSION"),
        platform = config.platform,
        data = %config.data_directory.display(),
        backups = %config.backup_directory.display(),
        strategy = ?config.backup_strategy,
        auto_update = config.auto_update,
        "supervisor starting"
    );
    let mut sup = Supervisor {
        config,
        client,
        state,
        node: None,
        restart_at: None,
        backoff: RESTART_FLOOR,
    };
    let mut stop = StopSignal::new()?;

    if sup.state.current.is_none() {
        let beside = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|dir| dir.join("ringtome")));
        if let Some(beside) = beside.filter(|b| b.is_file()) {
            match install::adopt(&sup.config, &beside) {
                Ok(installed) => {
                    sup.state.current = Some(installed);
                    sup.state.save(&sup.config)?;
                }
                Err(e) => tracing::warn!("could not adopt {}: {e:#}", beside.display()),
            }
        }
    }
    while sup.state.current.is_none() {
        if !sup.config.auto_update {
            anyhow::bail!(
                "no node is installed in {} and RINGTOME_AUTO_UPDATE is off, so none will be",
                sup.config.versions_directory().display()
            );
        }
        if let Err(e) = sup.install_first().await {
            tracing::warn!(
                "could not install the first node: {e:#}; trying again in {}s",
                FIRST_INSTALL_RETRY.as_secs()
            );
            tokio::select! {
                _ = tokio::time::sleep(FIRST_INSTALL_RETRY) => {}
                _ = stop.recv() => return Ok(()),
            }
        }
    }

    match sup.state.pending.clone() {
        Some(pending) => {
            tracing::warn!(
                to = pending.to.name,
                "an update was in flight when the supervisor last stopped; proving it again"
            );
            sup.settle(pending).await;
        }
        None => sup.start(),
    }

    let mut next_check = Instant::now() + sup.config.update_check;
    let mut next_backup = sup.next_scheduled_backup();
    loop {
        let restart_at = sup.restart_at;
        tokio::select! {
            status = wait_for_exit(&mut sup.node) => sup.exited(status),
            _ = sleep_until(restart_at) => {
                sup.restart_at = None;
                sup.start();
            }
            _ = tokio::time::sleep_until(next_check), if sup.config.auto_update => {
                sup.check_for_update().await;
                next_check = Instant::now() + sup.config.update_check;
            }
            _ = sleep_until(next_backup) => {
                sup.scheduled_backup().await;
                next_backup = sup.next_scheduled_backup();
            }
            _ = stop.recv() => break,
        }
    }
    tracing::info!("stopping");
    sup.stop_node().await;
    Ok(())
}

/// The node's exit, or never while there is no node.
async fn wait_for_exit(node: &mut Option<Node>) -> std::io::Result<std::process::ExitStatus> {
    match node {
        Some(node) => node.wait().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

impl Supervisor {
    // --- running the node ------------------------------------------------------------------

    /// Start the current version. A start that fails is retried like an exit.
    fn start(&mut self) {
        let Some(current) = self.state.current.clone() else {
            return;
        };
        match node::spawn(
            &self.config,
            &install::binary_path(&self.config, &current.version),
            &current.name,
        ) {
            Ok(node) => self.node = Some(node),
            Err(e) => {
                tracing::error!("could not start the node: {e:#}");
                self.schedule_restart();
            }
        }
    }

    fn exited(&mut self, status: std::io::Result<std::process::ExitStatus>) {
        let Some(node) = self.node.take() else { return };
        node.forget_pid();
        if node.uptime() >= RAN_LONG_ENOUGH {
            self.backoff = RESTART_FLOOR;
        }
        match status {
            Ok(status) => tracing::warn!(version = node.version, "node exited ({status})"),
            Err(e) => tracing::warn!(version = node.version, "lost track of the node: {e}"),
        }
        self.schedule_restart();
    }

    fn schedule_restart(&mut self) {
        tracing::info!("restarting the node in {}s", self.backoff.as_secs());
        self.restart_at = Some(Instant::now() + self.backoff);
        self.backoff = (self.backoff * 2).min(RESTART_CEILING);
    }

    async fn stop_node(&mut self) {
        self.restart_at = None;
        if let Some(node) = self.node.take() {
            node.stop(self.config.stop_grace).await;
        }
    }

    fn save_state(&self) {
        if let Err(e) = self.state.save(&self.config) {
            tracing::error!("could not save the supervisor's state: {e:#}");
        }
    }

    // --- installing and updating -----------------------------------------------------------

    async fn install_first(&mut self) -> Result<()> {
        let manifest = install::fetch_manifest(&self.client, &self.config).await?;
        let installed = install::download(&self.client, &self.config, &manifest).await?;
        self.state.current = Some(installed);
        self.state.save(&self.config)
    }

    async fn check_for_update(&mut self) {
        let Some(current) = self.state.current.clone() else {
            return;
        };
        let manifest = match install::fetch_manifest(&self.client, &self.config).await {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("could not check for an update: {e:#}");
                return;
            }
        };
        if !manifest::is_newer(&manifest.version, &current.version) {
            return;
        }
        if self.state.skipped.contains(&manifest.version) {
            tracing::debug!(
                version = manifest.version,
                "skipping a version that already failed here"
            );
            return;
        }
        tracing::info!(
            running = current.name,
            available = manifest.name,
            "an update is out"
        );
        let to = match install::download(&self.client, &self.config, &manifest).await {
            Ok(to) => to,
            Err(e) => {
                tracing::error!("not updating: {e:#}; will look again at the next check");
                return;
            }
        };
        let backup = if self.config.backup_strategy == BackupStrategy::None {
            tracing::warn!(
                "RINGTOME_BACKUP_STRATEGY=none: updating without a backup. If {} fails, the rollback can restore the \
                 binary but not the data, and the older binary will not open data a newer one migrated",
                to.name
            );
            self.stop_node().await;
            None
        } else {
            match self.backup_before_update().await {
                Ok(path) => Some(path),
                Err(e) => {
                    tracing::error!("not updating without a backup: {e:#}");
                    if self.node.is_none() {
                        self.start();
                    }
                    return;
                }
            }
        };
        let pending = Pending {
            from: Some(current),
            to,
            backup,
        };
        self.state.pending = Some(pending.clone());
        if let Err(e) = self.state.save(&self.config) {
            // Without the pending record, a crash mid-update would leave nobody knowing to roll
            // back - so no record, no update.
            tracing::error!("not updating: could not record the update: {e:#}");
            self.state.pending = None;
            if self.node.is_none() {
                self.start();
            }
            return;
        }
        self.settle(pending).await;
    }

    /// Live if the node will answer, stopped otherwise; the node is stopped either way on return.
    async fn backup_before_update(&mut self) -> Result<std::path::PathBuf> {
        if self.node.is_some() && node::is_healthy(&self.client, &self.config.node_url).await {
            match backup::live(&self.client, &self.config).await {
                Ok(path) => {
                    tracing::info!("backed up to {} while the node ran", path.display());
                    self.stop_node().await;
                    return Ok(path);
                }
                Err(e) => tracing::warn!("the node could not back itself up ({e:#}); stopping it to back up its data directly"),
            }
        }
        self.stop_node().await;
        let path = backup::stopped(&self.config).await?;
        tracing::info!("backed up to {} with the node stopped", path.display());
        Ok(path)
    }

    /// Start `pending.to` and hold it to the health bar; roll back if it falls short.
    async fn settle(&mut self, pending: Pending) {
        self.stop_node().await;
        self.state.current = Some(pending.to.clone());
        self.state.previous = pending.from.clone();
        self.save_state();
        let binary = install::binary_path(&self.config, &pending.to.version);
        let outcome = match node::spawn(&self.config, &binary, &pending.to.name) {
            Ok(mut node) => {
                let outcome = node
                    .wait_healthy(
                        &self.client,
                        &self.config.node_url,
                        self.config.health_timeout,
                        self.config.probation,
                    )
                    .await;
                match outcome {
                    Ok(()) => {
                        self.node = Some(node);
                        Ok(())
                    }
                    Err(e) => {
                        node.stop(self.config.stop_grace).await;
                        Err(e)
                    }
                }
            }
            Err(e) => Err(e),
        };
        match outcome {
            Ok(()) => {
                tracing::info!(version = pending.to.name, "updated");
                self.state.pending = None;
                self.backoff = RESTART_FLOOR;
                self.save_state();
                let mut keep = vec![pending.to.version.as_str()];
                if let Some(from) = &pending.from {
                    keep.push(from.version.as_str());
                }
                install::prune_versions(&self.config, &keep);
                if self.config.backup_strategy != BackupStrategy::None {
                    backup::prune(&self.config);
                }
            }
            Err(e) => {
                tracing::error!(
                    version = pending.to.name,
                    "the update failed: {e:#}; rolling back"
                );
                self.roll_back(pending).await;
            }
        }
    }

    async fn roll_back(&mut self, pending: Pending) {
        if !self.state.skipped.contains(&pending.to.version) {
            self.state.skipped.push(pending.to.version.clone());
        }
        let Some(from) = pending.from.clone() else {
            // Only a first install has no `from`, and a first install is never pending.
            tracing::error!("nothing to roll back to; staying on {}", pending.to.name);
            self.state.pending = None;
            self.save_state();
            self.schedule_restart();
            return;
        };
        let aside = match &pending.backup {
            Some(archive) => match backup::restore(&self.config, archive).await {
                Ok(aside) => {
                    tracing::info!(
                        "restored {}; the failed version's data is at {}",
                        archive.display(),
                        aside.display()
                    );
                    Some(aside)
                }
                Err(e) => {
                    tracing::error!(
                        "could not restore {}: {e:#}; starting {} on the data as it is",
                        archive.display(),
                        from.name
                    );
                    None
                }
            },
            None => None,
        };
        self.state.current = Some(from.clone());
        self.state.previous = None;
        self.state.pending = None;
        self.save_state();
        install::prune_versions(&self.config, &[from.version.as_str()]);

        match node::spawn(
            &self.config,
            &install::binary_path(&self.config, &from.version),
            &from.name,
        ) {
            Ok(mut node) => {
                match node
                    .wait_healthy(
                        &self.client,
                        &self.config.node_url,
                        self.config.health_timeout,
                        Duration::ZERO,
                    )
                    .await
                {
                    Ok(()) => {
                        if let Some(aside) = aside {
                            if let Err(e) = std::fs::remove_dir_all(&aside) {
                                tracing::warn!(error = %e, "could not remove {}", aside.display());
                            }
                        }
                        tracing::info!(
                            version = from.name,
                            skipped = pending.to.name,
                            "rolled back"
                        );
                    }
                    Err(e) => {
                        let kept = aside.map(|a| {
                            format!("; the failed version's data is kept at {}", a.display())
                        });
                        tracing::error!(
                            "the rollback to {} did not come up healthy either: {e:#}{}",
                            from.name,
                            kept.unwrap_or_default()
                        );
                    }
                }
                self.node = Some(node);
            }
            Err(e) => {
                tracing::error!("could not start {} after the rollback: {e:#}", from.name);
                self.schedule_restart();
            }
        }
    }

    // --- scheduled backups -----------------------------------------------------------------

    fn next_scheduled_backup(&self) -> Option<Instant> {
        let wait = match self.config.backup_strategy {
            BackupStrategy::Hourly => Duration::from_secs(3600),
            BackupStrategy::Nightly => Duration::from_secs(stamp::secs_until_utc_hour(
                stamp::now_secs(),
                NIGHTLY_UTC_HOUR,
            ) as u64),
            BackupStrategy::None | BackupStrategy::OnUpdate => return None,
        };
        Some(Instant::now() + wait)
    }

    /// A scheduled backup never stops the node: a node that will not back itself up is skipped
    /// this time and logged, and the next one tries again.
    async fn scheduled_backup(&mut self) {
        if self.node.is_none() {
            tracing::warn!("scheduled backup skipped: the node is not running");
            return;
        }
        match backup::live(&self.client, &self.config).await {
            Ok(path) => {
                tracing::info!("scheduled backup: {}", path.display());
                backup::prune(&self.config);
            }
            Err(e) => tracing::error!("scheduled backup failed: {e:#}"),
        }
    }
}

/// SIGTERM (systemd, docker stop) or SIGINT (a terminal): either means stop the node, then exit.
struct StopSignal {
    #[cfg(unix)]
    terminate: tokio::signal::unix::Signal,
}

impl StopSignal {
    fn new() -> Result<Self> {
        Ok(Self {
            #[cfg(unix)]
            terminate: tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .context("listening for SIGTERM")?,
        })
    }

    async fn recv(&mut self) {
        #[cfg(unix)]
        tokio::select! {
            _ = self.terminate.recv() => {}
            _ = tokio::signal::ctrl_c() => {}
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    }
}
