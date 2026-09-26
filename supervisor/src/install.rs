//! Installed versions and the state file: what is running, what ran before, what failed.
//!
//! Each version lives at `<supervisor>/versions/<version>/ringtome`, extracted from its release
//! tarball only after the tarball passed `manifest::verify`. `state.json` records:
//!
//! - `current`: the version the supervisor runs;
//! - `previous`: the version before it, kept installed as the binary half of a rollback;
//! - `skipped`: versions that were tried and did not come up healthy - never tried again (a newer
//!   release is, since it may be the fix);
//! - `pending`: an update in flight. It is written BEFORE the new version starts and cleared once
//!   the update is settled either way, so a supervisor that dies mid-update finds it on its next
//!   start and finishes the job - probation, or rollback - rather than trusting a version nobody
//!   saw come up.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::manifest::{self, Manifest};

/// A release tarball is tens of megabytes; this is for a slow link, not a hung one.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MANIFEST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Installed {
    /// `major.minor.patch` - also the directory name, which is why it is validated first.
    pub version: String,
    /// `<version>-<release name>`, for people.
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pending {
    pub from: Option<Installed>,
    pub to: Installed,
    /// The backup taken before `to` first started; None under RINGTOME_BACKUP_STRATEGY=none.
    pub backup: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct State {
    pub current: Option<Installed>,
    pub previous: Option<Installed>,
    #[serde(default)]
    pub skipped: Vec<String>,
    #[serde(default)]
    pub pending: Option<Pending>,
}

impl State {
    pub fn load(config: &Config) -> Result<State> {
        let path = config.state_file();
        match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("reading {}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    /// Written whole to a temporary file and renamed over the old one: a crash leaves the old
    /// state or the new, never half of either.
    pub fn save(&self, config: &Config) -> Result<()> {
        let path = config.state_file();
        let temporary = path.with_extension("json.partial");
        let bytes = serde_json::to_vec_pretty(self).context("encoding the state")?;
        std::fs::write(&temporary, bytes)
            .with_context(|| format!("writing {}", temporary.display()))?;
        std::fs::rename(&temporary, &path)
            .with_context(|| format!("replacing {}", path.display()))?;
        Ok(())
    }
}

pub fn binary_path(config: &Config, version: &str) -> PathBuf {
    config.versions_directory().join(version).join("ringtome")
}

pub async fn fetch_manifest(client: &reqwest::Client, config: &Config) -> Result<Manifest> {
    let response = client
        .get(&config.manifest_url)
        .timeout(MANIFEST_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("fetching {}", config.manifest_url))?
        .error_for_status()
        .with_context(|| format!("fetching {}", config.manifest_url))?;
    let bytes = response.bytes().await.context("reading the manifest")?;
    serde_json::from_slice(&bytes).context("the manifest is not a release manifest")
}

/// Download this machine's tarball from `manifest`, verify it, and install its `ringtome` binary.
/// Nothing is written until the bytes have passed every check.
pub async fn download(
    client: &reqwest::Client,
    config: &Config,
    manifest: &Manifest,
) -> Result<Installed> {
    if manifest::parse_version(&manifest.version).is_none() {
        bail!(
            "the manifest's version {:?} is not major.minor.patch",
            manifest.version
        );
    }
    let download = manifest.platforms.get(&config.platform).with_context(|| {
        format!(
            "release {} has no build for {}",
            manifest.version, config.platform
        )
    })?;
    let bytes = client
        .get(&download.url)
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .with_context(|| format!("downloading {}", download.url))?
        .error_for_status()
        .with_context(|| format!("downloading {}", download.url))?
        .bytes()
        .await
        .with_context(|| format!("downloading {}", download.url))?;
    manifest::verify(&bytes, download, &config.public_key)
        .with_context(|| format!("refusing {} for {}", manifest.version, config.platform))?;

    let versions = config.versions_directory();
    let version = manifest.version.clone();
    tokio::task::spawn_blocking(move || install_binary(&bytes, &versions, &version))
        .await
        .context("the install task died")??;
    let name = if manifest.name.is_empty() {
        manifest.version.clone()
    } else {
        manifest.name.clone()
    };
    tracing::info!(version = manifest.version, name, "installed and verified");
    Ok(Installed {
        version: manifest.version.clone(),
        name,
    })
}

/// Install the node binary that shipped beside this supervisor in its release tarball, as this
/// supervisor's own version: the release job builds both from one commit, in one tarball
/// (`release.yml`, `server`), so the two versions are the same number. This is how a first start
/// runs the node the operator unpacked (and checked by hand, SERVER.md) rather than downloading a
/// second copy of it - and how a machine with RINGTOME_AUTO_UPDATE=false gets a node at all.
pub fn adopt(config: &Config, binary: &Path) -> Result<Installed> {
    let version = env!("CARGO_PKG_VERSION");
    let bytes = std::fs::read(binary).with_context(|| format!("reading {}", binary.display()))?;
    install_bytes(&bytes, &config.versions_directory(), version)?;
    tracing::info!(version, "adopted the node from {}", binary.display());
    Ok(Installed {
        version: version.to_string(),
        name: version.to_string(),
    })
}

/// Pull the one `ringtome` file out of a release tarball into `<versions>/<version>/ringtome`.
/// Only that file is read out - nothing else in the archive is written anywhere, so a path in
/// the archive cannot aim a write outside the versions directory.
fn install_binary(tarball: &[u8], versions: &Path, version: &str) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(tarball));
    let mut found: Option<Vec<u8>> = None;
    for entry in archive.entries().context("reading the tarball")? {
        let mut entry = entry.context("reading the tarball")?;
        let is_binary = entry.header().entry_type().is_file()
            && entry
                .path()
                .ok()
                .and_then(|p| p.file_name().map(|n| n == "ringtome"))
                .unwrap_or(false);
        if !is_binary {
            continue;
        }
        if found.is_some() {
            bail!("the tarball holds more than one `ringtome`");
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .context("reading the binary out of the tarball")?;
        found = Some(bytes);
    }
    let bytes = found.context("the tarball holds no `ringtome` binary")?;
    install_bytes(&bytes, versions, version)
}

/// Write `bytes` as `<versions>/<version>/ringtome`, executable, replacing any earlier copy; the
/// file appears under its final name only whole.
fn install_bytes(bytes: &[u8], versions: &Path, version: &str) -> Result<()> {
    std::fs::create_dir_all(versions)
        .with_context(|| format!("creating {}", versions.display()))?;
    let incoming = versions.join(format!(".incoming-{version}"));
    std::fs::write(&incoming, bytes).with_context(|| format!("writing {}", incoming.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&incoming, std::fs::Permissions::from_mode(0o755))
            .context("marking it executable")?;
    }
    let home = versions.join(version);
    if home.exists() {
        std::fs::remove_dir_all(&home).with_context(|| format!("replacing {}", home.display()))?;
    }
    std::fs::create_dir_all(&home).with_context(|| format!("creating {}", home.display()))?;
    std::fs::rename(&incoming, home.join("ringtome")).context("moving the binary into place")?;
    Ok(())
}

/// Remove every installed version but `keep`. Failures are logged, never fatal: a stale directory
/// costs disk, not correctness.
pub fn prune_versions(config: &Config, keep: &[&str]) {
    let Ok(entries) = std::fs::read_dir(config.versions_directory()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if keep.contains(&name.as_str()) {
            continue;
        }
        if let Err(e) =
            std::fs::remove_dir_all(entry.path()).or_else(|_| std::fs::remove_file(entry.path()))
        {
            tracing::warn!(error = %e, "could not remove old version {name}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tarball(files: &[(&str, &[u8])]) -> Vec<u8> {
        let gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut tar = tar::Builder::new(gz);
        for (path, bytes) in files {
            let mut header = tar::Header::new_gnu();
            // The name is written raw: the builder's own path setters refuse `..`, and a hostile
            // archive is exactly what one of these tests needs.
            header.as_old_mut().name[..path.len()].copy_from_slice(path.as_bytes());
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append(&header, *bytes).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ringtome-supervisor-test-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn only_the_binary_comes_out_of_the_tarball() {
        let versions = scratch("install");
        let archive = tarball(&[
            ("ringtome-server-0.2.0-x-linux-x86_64/SERVER.md", b"docs"),
            (
                "ringtome-server-0.2.0-x-linux-x86_64/ringtome",
                b"#!/bin/sh\n",
            ),
            ("../../escape", b"nope"),
        ]);
        install_binary(&archive, &versions, "0.2.0").unwrap();
        let installed = versions.join("0.2.0").join("ringtome");
        assert_eq!(std::fs::read(&installed).unwrap(), b"#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&installed).unwrap().permissions().mode() & 0o777,
                0o755
            );
        }
        let names: Vec<_> = std::fs::read_dir(&versions)
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(
            names,
            vec![std::ffi::OsString::from("0.2.0")],
            "nothing else, and no leftovers"
        );
        std::fs::remove_dir_all(&versions).unwrap();
    }

    #[test]
    fn an_adopted_binary_is_installed_as_this_supervisors_version() {
        let root = scratch("adopt");
        std::fs::create_dir_all(&root).unwrap();
        let beside = root.join("ringtome");
        std::fs::write(&beside, b"the node from the tarball").unwrap();
        let config = Config {
            supervisor_directory: root.join("supervisor"),
            ..crate::config::tests::config_for(&root)
        };
        let installed = adopt(&config, &beside).unwrap();
        assert_eq!(installed.version, env!("CARGO_PKG_VERSION"));
        assert_eq!(
            std::fs::read(binary_path(&config, &installed.version)).unwrap(),
            b"the node from the tarball"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_tarball_without_exactly_one_binary_is_refused() {
        let versions = scratch("refuse");
        assert!(install_binary(&tarball(&[("a/SERVER.md", b"docs")]), &versions, "0.2.0").is_err());
        assert!(install_binary(
            &tarball(&[("a/ringtome", b"1"), ("b/ringtome", b"2")]),
            &versions,
            "0.2.0"
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&versions);
    }
}
