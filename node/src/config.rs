//! Node configuration, loaded from environment variables with sane defaults.
//!
//! `Config` is the full internal configuration; `PublicConfig` is the subset safe to hand to a
//! browser client. The `RINGTOME_` prefix namespaces our vars.

use std::env;
use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    Dev,
    Prod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Tenancy {
    /// Hosted node: many accounts, each gated behind its own login.
    Multi,
    /// Personal desktop app: one implicit account, login is a formality (the OS user is the tenant).
    Single,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub app_version: String,
    /// Address the HTTP server binds to. Hosted nodes bind publicly (`0.0.0.0`); desktop mode
    /// binds `127.0.0.1`.
    pub bind_address: String,
    pub port: u16,
    /// Where per-user databases, key files, and other node state live.
    pub data_directory: PathBuf,
    /// Where uploaded media sits, in the clear, between arrival and transcode - deliberately
    /// disposable (defaults under the system temp dir). If a reboot wipes it mid-queue the
    /// affected uploads just fail and the user re-uploads; nothing durable is ever staged here.
    /// The plaintext only exists on this trusted, key-holding node; relaying nodes see only the
    /// encrypted AVIF. Overridable with `RINGTOME_QUARANTINE_DIRECTORY`.
    pub quarantine_directory: PathBuf,
    pub environment: Environment,
    /// Whether this node serves many accounts (hosted) or one (desktop). See the `Session`
    /// extractor, which branches on it.
    pub tenancy: Tenancy,
    /// DANGEROUS. Enables an extremely compromised mode intended ONLY for local integration
    /// testing: it exposes a raw SQL passthrough endpoint over HTTP, disables rate limiting,
    /// skips the first-account admin bootstrap, and hashes passwords with minimal Argon2
    /// parameters (fast, weak). Never enable on a node that is reachable by anyone but the
    /// developer running its tests.
    pub local_test: bool,
    /// How this node publishes/resolves discovery records (`RINGTOME_DISCOVERY`): `off`
    /// (default), `local:<path>` (shared-folder simulation), or `mainline` (real DHT + relays).
    /// Also selects the iroh preset: mainline gets `N0`, everything else `Minimal`.
    pub discovery: crate::discovery::DiscoveryMode,
}

/// The subset of configuration safe to expose to a browser client.
#[derive(Debug, Clone, Serialize)]
pub struct PublicConfig {
    pub app_version: String,
    pub environment: Environment,
}

impl Config {
    pub fn from_env() -> Self {
        let app_version = env!("CARGO_PKG_VERSION").to_string();

        let bind_address =
            env::var("RINGTOME_BIND_ADDRESS").unwrap_or_else(|_| "127.0.0.1".to_string());

        let port = env::var("RINGTOME_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(5281);

        let data_directory: PathBuf = env::var("RINGTOME_DATA_DIRECTORY")
            .unwrap_or_else(|_| "./data".to_string())
            .into();

        let quarantine_directory = env::var("RINGTOME_QUARANTINE_DIRECTORY")
            .map(PathBuf::from)
            .unwrap_or_else(|_| env::temp_dir().join("ringtome-upload-quarantine"));

        let environment = match env::var("RINGTOME_ENVIRONMENT").as_deref() {
            Ok("prod") => Environment::Prod,
            _ => Environment::Dev,
        };

        let tenancy = match env::var("RINGTOME_TENANCY").as_deref() {
            Ok("single") => Tenancy::Single,
            _ => Tenancy::Multi,
        };

        let local_test = matches!(
            env::var("RINGTOME_LOCAL_TEST").as_deref(),
            Ok("1") | Ok("true")
        );

        let discovery = crate::discovery::DiscoveryMode::from_env();

        Self {
            app_version,
            bind_address,
            port,
            data_directory,
            quarantine_directory,
            environment,
            tenancy,
            local_test,
            discovery,
        }
    }

    pub fn is_dev(&self) -> bool {
        self.environment == Environment::Dev
    }

    pub fn public(&self) -> PublicConfig {
        PublicConfig {
            app_version: self.app_version.clone(),
            environment: self.environment,
        }
    }
}
