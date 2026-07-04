//! Node configuration, loaded from environment variables with sane defaults.
//!
//! `Config` is the full internal configuration; `PublicConfig` is the subset safe to hand to a
//! browser client. The `RINGTOME_` prefix namespaces our vars.
//!
//! The mode seams here (bind address, tenancy) are the "flip a few switches" points from the
//! Delivery and Packaging plan: the same binary is a hosted node or a personal desktop app
//! depending on config, so these must be configuration rather than hardcoded assumptions.

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
    /// Hosted node: many identities, each gated behind its own login.
    Multi,
    /// Personal desktop app: one identity, auto-logged-in (the OS user is the tenant).
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
    pub environment: Environment,
    pub tenancy: Tenancy,
}

/// The subset of configuration safe to expose to a browser client.
#[derive(Debug, Clone, Serialize)]
pub struct PublicConfig {
    pub app_version: String,
    pub environment: Environment,
    pub tenancy: Tenancy,
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

        let data_directory = env::var("RINGTOME_DATA_DIRECTORY")
            .unwrap_or_else(|_| "./data".to_string())
            .into();

        let environment = match env::var("RINGTOME_ENVIRONMENT").as_deref() {
            Ok("prod") => Environment::Prod,
            _ => Environment::Dev,
        };

        let tenancy = match env::var("RINGTOME_TENANCY").as_deref() {
            Ok("single") => Tenancy::Single,
            _ => Tenancy::Multi,
        };

        Self {
            app_version,
            bind_address,
            port,
            data_directory,
            environment,
            tenancy,
        }
    }

    pub fn is_dev(&self) -> bool {
        self.environment == Environment::Dev
    }

    pub fn public(&self) -> PublicConfig {
        PublicConfig {
            app_version: self.app_version.clone(),
            environment: self.environment,
            tenancy: self.tenancy,
        }
    }
}
