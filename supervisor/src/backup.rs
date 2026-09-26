//! Backups: taking them, restoring one, and keeping only as many as the operator asked for.
//!
//! Two ways to take one, and one archive format (the node's - `node/src/backup.rs`):
//!
//! - **live**: ask the running node through `POST /api/admin/backup` and wait on the ticket. The
//!   node copies each database under its own lock, so it never stops serving. The supervisor
//!   reaches it on loopback, which is the door that endpoint keeps open to the machine itself.
//! - **stopped**: the node is not running (or would not answer), so the data directory is quiet
//!   and a plain archive of it is consistent by construction.
//!
//! Before an update the supervisor tries live, then stops the node either way; a failed live
//! backup falls back to stopped rather than skipping the backup - it is the rollback's data half,
//! and an update without one is not attempted (except under RINGTOME_BACKUP_STRATEGY=none).
//!
//! Restoring never deletes: the data directory's contents move into `.rollback-<stamp>` inside it
//! first (inside, so the move is a rename even when the data directory is a mount point), and the
//! supervisor removes that only once the restored node has come up healthy.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

use crate::config::Config;
use crate::stamp;

const TICKET_POLL: Duration = Duration::from_secs(1);
/// A backup of a blob-heavy node is bounded by disk speed; this bounds a node that has hung.
const LIVE_BACKUP_TIMEOUT: Duration = Duration::from_secs(4 * 3600);

#[derive(Deserialize)]
struct Ticket {
    id: String,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    log: Vec<String>,
}

/// Ask the running node for a backup and wait for the archive. Returns its path.
pub async fn live(client: &reqwest::Client, config: &Config) -> Result<PathBuf> {
    let started = client
        .post(format!("{}/api/admin/backup", config.node_url))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .context("asking the node for a backup")?;
    if !started.status().is_success() {
        bail!(
            "the node refused a backup: {} {}",
            started.status(),
            started.text().await.unwrap_or_default()
        );
    }
    let ticket: Ticket =
        serde_json::from_slice(&started.bytes().await.context("reading the backup ticket")?)
            .context("reading the backup ticket")?;
    let deadline = Instant::now() + LIVE_BACKUP_TIMEOUT;
    loop {
        tokio::time::sleep(TICKET_POLL).await;
        let response = client
            .get(format!(
                "{}/api/admin/backup/{}",
                config.node_url, ticket.id
            ))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .context("checking on the backup")?;
        let status = response.status();
        let body: Ticket = serde_json::from_slice(
            &response
                .bytes()
                .await
                .context("reading the backup ticket")?,
        )
        .context("reading the backup ticket")?;
        match status.as_u16() {
            200 => {
                let path = body.path.context("a finished backup with no path")?;
                return Ok(PathBuf::from(path));
            }
            202 if Instant::now() < deadline => continue,
            202 => bail!(
                "the backup was still running after {}s",
                LIVE_BACKUP_TIMEOUT.as_secs()
            ),
            _ => bail!("the backup failed: {}", body.log.join(" | ")),
        }
    }
}

/// Archive the (quiet) data directory, the way the node's own backup lays it out.
pub async fn stopped(config: &Config) -> Result<PathBuf> {
    let data = config.data_directory.clone();
    let out = config.backup_directory.clone();
    tokio::task::spawn_blocking(move || pack(&data, &out))
        .await
        .context("the backup task died")?
}

fn pack(data: &Path, out_dir: &Path) -> Result<PathBuf> {
    std::fs::create_dir_all(out_dir).with_context(|| format!("creating {}", out_dir.display()))?;
    let out = out_dir.join(format!(
        "backup_{}.tar.gz",
        stamp::utc_stamp(stamp::now_secs())
    ));
    let partial = out.with_extension("gz.partial");
    let file = std::fs::File::create(&partial)
        .with_context(|| format!("creating {}", partial.display()))?;
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(
        file,
        flate2::Compression::default(),
    ));
    tar.follow_symlinks(false);
    if data.exists() {
        tar.append_dir_all(".", data)
            .with_context(|| format!("archiving {}", data.display()))?;
    }
    let gz = tar.into_inner().context("finishing the archive")?;
    gz.finish()
        .context("finishing the compression")?
        .sync_all()
        .context("flushing the archive")?;
    std::fs::rename(&partial, &out).with_context(|| format!("naming {}", out.display()))?;
    Ok(out)
}

/// Replace the data directory's contents with `archive`'s. Returns where the old contents went.
pub async fn restore(config: &Config, archive: &Path) -> Result<PathBuf> {
    let data = config.data_directory.clone();
    let archive = archive.to_path_buf();
    tokio::task::spawn_blocking(move || unpack_over(&data, &archive))
        .await
        .context("the restore task died")?
}

fn unpack_over(data: &Path, archive: &Path) -> Result<PathBuf> {
    let file =
        std::fs::File::open(archive).with_context(|| format!("opening {}", archive.display()))?;
    std::fs::create_dir_all(data).with_context(|| format!("creating {}", data.display()))?;
    let aside = data.join(format!(".rollback-{}", stamp::utc_stamp(stamp::now_secs())));
    std::fs::create_dir(&aside).with_context(|| format!("creating {}", aside.display()))?;
    for entry in std::fs::read_dir(data).with_context(|| format!("reading {}", data.display()))? {
        let entry = entry?;
        if entry.path() == aside {
            continue;
        }
        std::fs::rename(entry.path(), aside.join(entry.file_name()))
            .with_context(|| format!("moving {} aside", entry.path().display()))?;
    }
    // `unpack` refuses entries that would land outside `data` (absolute paths, `..`).
    tar::Archive::new(flate2::read::GzDecoder::new(file))
        .unpack(data)
        .with_context(|| format!("unpacking {} into {}", archive.display(), data.display()))?;
    Ok(aside)
}

/// Keep the newest `backup_retention` archives in the backup directory, whoever made them. The
/// names are UTC stamps, so name order is time order.
pub fn prune(config: &Config) {
    let Ok(entries) = std::fs::read_dir(&config.backup_directory) else {
        return;
    };
    let mut archives: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("backup_") && n.ends_with(".tar.gz"))
                .unwrap_or(false)
        })
        .collect();
    archives.sort();
    let excess = archives.len().saturating_sub(config.backup_retention);
    for old in archives.into_iter().take(excess) {
        match std::fs::remove_file(&old) {
            Ok(()) => tracing::info!("removed old backup {}", old.display()),
            Err(e) => tracing::warn!(error = %e, "could not remove old backup {}", old.display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stopped_backup_restores_exactly_and_keeps_what_it_replaced() {
        let root =
            std::env::temp_dir().join(format!("ringtome-supervisor-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (data, out) = (root.join("data"), root.join("backups"));
        std::fs::create_dir_all(data.join("users")).unwrap();
        std::fs::write(data.join("node.db"), b"the node").unwrap();
        std::fs::write(data.join("users").join("ada.db"), b"a persona").unwrap();

        let archive = pack(&data, &out).unwrap();
        assert!(archive
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("backup_"));

        // What a failed newer version leaves behind: a migrated database and a new file.
        std::fs::write(data.join("node.db"), b"migrated forward").unwrap();
        std::fs::write(data.join("newer-only"), b"x").unwrap();

        let aside = unpack_over(&data, &archive).unwrap();
        assert_eq!(std::fs::read(data.join("node.db")).unwrap(), b"the node");
        assert_eq!(
            std::fs::read(data.join("users").join("ada.db")).unwrap(),
            b"a persona"
        );
        assert!(
            !data.join("newer-only").exists(),
            "the failed version's leftovers are gone"
        );
        assert_eq!(
            std::fs::read(aside.join("node.db")).unwrap(),
            b"migrated forward",
            "moved aside, not deleted"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
