//! The supervisor's settings: environment variables, like the node's own (SERVER.md, "Settings").
//!
//! One environment serves both programs. The supervisor reads the node's variables it needs to
//! agree with - where the data lives, where backups go, the address the node answers on - and the
//! child inherits the whole environment, so an operator configures the node exactly as they would
//! without a supervisor. The two directories the supervisor must be certain of are resolved to
//! absolute paths and handed to the child explicitly, so both processes mean the same place.

use std::env;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};

/// Where the newest release is described. GitHub's `latest/download` always names the newest
/// non-prerelease release's asset; `release.yml`'s `server-publish` job writes it.
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/cube-drone/ringtome/releases/latest/download/server-latest.json";

/// The release key's public half - the minisign key the Tauri updater also trusts
/// (`desktop/tauri.conf.json`'s `plugins.updater.pubkey`, base64 of this same key file).
/// SIGNING.md explains the key and where its secret half lives.
pub const RELEASE_PUBLIC_KEY: &str = "RWS8OTS+AgxV50ecE3P4OKhhLRQrosZc08PVRsF6mcQjK3wWIM9LzRgx";

/// What gets backed up, and when. Every strategy but `None` takes a backup before each update -
/// it is the rollback's data half; `Hourly` and `Nightly` add backups on a clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackupStrategy {
    None,
    OnUpdate,
    Hourly,
    Nightly,
}

impl BackupStrategy {
    fn parse(s: &str) -> Result<Self> {
        Ok(match s {
            "none" => Self::None,
            "on-update" => Self::OnUpdate,
            "hourly" => Self::Hourly,
            "nightly" => Self::Nightly,
            other => bail!(
                "RINGTOME_BACKUP_STRATEGY={other:?}: expected none, on-update, hourly or nightly"
            ),
        })
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    /// Installed node versions and the supervisor's state file. RINGTOME_SUPERVISOR_DIRECTORY,
    /// default `./ringtome-supervisor`.
    pub supervisor_directory: PathBuf,
    /// The node's data directory - identity, keys, databases. RINGTOME_DATA_DIRECTORY, default
    /// `./data` (the node's own default).
    pub data_directory: PathBuf,
    /// Where backups are written, by the node and by the supervisor. RINGTOME_BACKUP_DIRECTORY,
    /// default `<supervisor directory>/backups` - NOT the node's default of `<data>/backups`,
    /// because a rollback empties the data directory and must not take the backups with it.
    pub backup_directory: PathBuf,
    /// RINGTOME_BACKUP_STRATEGY: `none`, `on-update` (default), `hourly`, `nightly` (04:00 UTC).
    pub backup_strategy: BackupStrategy,
    /// How many `backup_*.tar.gz` archives to keep, newest first, whoever made them.
    /// RINGTOME_BACKUP_RETENTION, default 7. Never below 1.
    pub backup_retention: usize,
    /// Install releases as they appear. RINGTOME_AUTO_UPDATE, default `true`.
    pub auto_update: bool,
    /// The release manifest. RINGTOME_UPDATE_MANIFEST_URL, default [`DEFAULT_MANIFEST_URL`].
    pub manifest_url: String,
    /// The minisign public key releases must be signed with. RINGTOME_UPDATE_PUBLIC_KEY, default
    /// [`RELEASE_PUBLIC_KEY`] - overridable for a fork's own releases and for the test rig.
    pub public_key: String,
    /// How often to look for a release. RINGTOME_UPDATE_CHECK_SECONDS, default 3600.
    pub update_check: Duration,
    /// How long a started node has to answer `/health` - migrations run before it can, so this is
    /// generous. RINGTOME_UPDATE_HEALTH_TIMEOUT_SECONDS, default 600.
    pub health_timeout: Duration,
    /// After its first healthy answer, how long a new version must stay up and healthy before the
    /// update counts. RINGTOME_UPDATE_PROBATION_SECONDS, default 60.
    pub probation: Duration,
    /// How long the node gets to exit after SIGTERM before SIGKILL. RINGTOME_STOP_GRACE_SECONDS,
    /// default 30.
    pub stop_grace: Duration,
    /// Where the node answers HTTP, for `/health` and backups: from RINGTOME_BIND_ADDRESS and
    /// RINGTOME_PORT (a wildcard bind is reached on loopback).
    pub node_url: String,
    /// This machine's key in the manifest's `platforms`: `linux-x86_64`, `linux-aarch64`.
    pub platform: String,
}

fn var(name: &str) -> Option<String> {
    env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn seconds(name: &str, default: u64) -> Result<Duration> {
    match var(name) {
        None => Ok(Duration::from_secs(default)),
        Some(v) => v
            .trim()
            .parse::<u64>()
            .map(Duration::from_secs)
            .with_context(|| format!("{name}={v:?} is not a number of seconds")),
    }
}

fn absolute(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(env::current_dir()
        .context("reading the working directory")?
        .join(path))
}

/// Is `inner` the same as, or inside, `outer`? Lexical - both are absolute, neither need exist.
fn is_within(inner: &Path, outer: &Path) -> bool {
    inner.starts_with(outer)
}

/// The URL the node answers on, from its bind address and port.
fn node_url(bind: &str, port: u16) -> String {
    let host = match bind {
        "0.0.0.0" | "" => "127.0.0.1".to_string(),
        "::" | "[::]" => "[::1]".to_string(),
        v if v.contains(':') && !v.starts_with('[') => format!("[{v}]"),
        v => v.to_string(),
    };
    format!("http://{host}:{port}")
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let supervisor_directory = absolute(
            var("RINGTOME_SUPERVISOR_DIRECTORY")
                .map(PathBuf::from)
                .unwrap_or_else(|| "ringtome-supervisor".into()),
        )?;
        let data_directory = absolute(
            var("RINGTOME_DATA_DIRECTORY")
                .map(PathBuf::from)
                .unwrap_or_else(|| "data".into()),
        )?;
        let backup_directory = absolute(
            var("RINGTOME_BACKUP_DIRECTORY")
                .map(PathBuf::from)
                .unwrap_or_else(|| supervisor_directory.join("backups")),
        )?;
        // A rollback moves everything in the data directory aside and unpacks a backup in its
        // place; the backups and the installed versions have to be somewhere that move leaves be.
        if is_within(&backup_directory, &data_directory) {
            bail!(
                "RINGTOME_BACKUP_DIRECTORY ({}) is inside the data directory ({}); under the supervisor, backups must live \
                 outside it, since restoring one replaces the data directory's contents",
                backup_directory.display(),
                data_directory.display()
            );
        }
        if is_within(&supervisor_directory, &data_directory)
            || is_within(&data_directory, &supervisor_directory)
        {
            bail!(
                "RINGTOME_SUPERVISOR_DIRECTORY ({}) and the data directory ({}) must not contain one another",
                supervisor_directory.display(),
                data_directory.display()
            );
        }
        let backup_strategy = BackupStrategy::parse(
            var("RINGTOME_BACKUP_STRATEGY")
                .as_deref()
                .unwrap_or("on-update"),
        )?;
        let backup_retention = match var("RINGTOME_BACKUP_RETENTION") {
            None => 7,
            Some(v) => v
                .trim()
                .parse::<usize>()
                .with_context(|| format!("RINGTOME_BACKUP_RETENTION={v:?} is not a count"))?,
        }
        .max(1);
        let auto_update = match var("RINGTOME_AUTO_UPDATE").as_deref() {
            None | Some("true") | Some("1") | Some("on") => true,
            Some("false") | Some("0") | Some("off") => false,
            Some(other) => bail!("RINGTOME_AUTO_UPDATE={other:?}: expected true or false"),
        };
        let port = match var("RINGTOME_PORT") {
            None => 5281,
            Some(v) => v
                .trim()
                .parse::<u16>()
                .with_context(|| format!("RINGTOME_PORT={v:?} is not a port"))?,
        };
        let bind = var("RINGTOME_BIND_ADDRESS").unwrap_or_else(|| "127.0.0.1".into());
        Ok(Self {
            supervisor_directory,
            data_directory,
            backup_directory,
            backup_strategy,
            backup_retention,
            auto_update,
            manifest_url: var("RINGTOME_UPDATE_MANIFEST_URL")
                .unwrap_or_else(|| DEFAULT_MANIFEST_URL.into()),
            public_key: var("RINGTOME_UPDATE_PUBLIC_KEY")
                .unwrap_or_else(|| RELEASE_PUBLIC_KEY.into()),
            update_check: seconds("RINGTOME_UPDATE_CHECK_SECONDS", 3600)?
                .max(Duration::from_secs(1)),
            health_timeout: seconds("RINGTOME_UPDATE_HEALTH_TIMEOUT_SECONDS", 600)?,
            probation: seconds("RINGTOME_UPDATE_PROBATION_SECONDS", 60)?,
            stop_grace: seconds("RINGTOME_STOP_GRACE_SECONDS", 30)?,
            node_url: node_url(bind.trim(), port),
            platform: format!("{}-{}", env::consts::OS, env::consts::ARCH),
        })
    }

    /// Where each installed version's binary lives: `<supervisor>/versions/<version>/ringtome`.
    pub fn versions_directory(&self) -> PathBuf {
        self.supervisor_directory.join("versions")
    }

    pub fn state_file(&self) -> PathBuf {
        self.supervisor_directory.join("state.json")
    }

    /// The running node's process id, for an operator (or a test) who has to find it.
    pub fn pid_file(&self) -> PathBuf {
        self.supervisor_directory.join("node.pid")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A config rooted at `root`, with every setting at its default.
    pub(crate) fn config_for(root: &Path) -> Config {
        Config {
            supervisor_directory: root.join("supervisor"),
            data_directory: root.join("data"),
            backup_directory: root.join("backups"),
            backup_strategy: BackupStrategy::OnUpdate,
            backup_retention: 7,
            auto_update: true,
            manifest_url: DEFAULT_MANIFEST_URL.into(),
            public_key: RELEASE_PUBLIC_KEY.into(),
            update_check: Duration::from_secs(3600),
            health_timeout: Duration::from_secs(600),
            probation: Duration::from_secs(60),
            stop_grace: Duration::from_secs(30),
            node_url: node_url("127.0.0.1", 5281),
            platform: "linux-x86_64".into(),
        }
    }

    #[test]
    fn a_wildcard_bind_is_reached_on_loopback() {
        assert_eq!(node_url("0.0.0.0", 5281), "http://127.0.0.1:5281");
        assert_eq!(node_url("::", 5281), "http://[::1]:5281");
        assert_eq!(node_url("127.0.0.1", 6000), "http://127.0.0.1:6000");
        assert_eq!(node_url("fd00::7", 5281), "http://[fd00::7]:5281");
    }

    #[test]
    fn containment_is_by_component_not_by_prefix() {
        assert!(is_within(
            Path::new("/srv/data/backups"),
            Path::new("/srv/data")
        ));
        assert!(is_within(Path::new("/srv/data"), Path::new("/srv/data")));
        assert!(
            !is_within(Path::new("/srv/data-backups"), Path::new("/srv/data")),
            "a sibling that shares a prefix"
        );
    }
}
