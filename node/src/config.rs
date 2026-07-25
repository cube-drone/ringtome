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
    pub discovery: crate::net::discovery::DiscoveryMode,
    /// The pre-crunch upload ceiling: the largest RAW media a client may POST before transcode
    /// (scoped to the binary-upload routes). This is NOT the distribution size - ingest crushes
    /// media to a far smaller canonical artifact, and the ~10MB *output* cap is enforced in the
    /// transcode. This is purely "how big a raw upload will this node spend disk+CPU on". A public
    /// (multi-tenant) node is a DoS surface, so it defaults far lower than a single-tenant desktop;
    /// override with `RINGTOME_MAX_UPLOAD_BYTES`.
    pub max_upload_bytes: usize,
    /// The largest text/marquee document body a client may POST (scoped to the JSON doc routes).
    /// Unlike media, text isn't crushed - its upload size IS its stored-and-distributed size - so
    /// this is the *distribution* ceiling: the same ~10MB "nothing bigger moves on the network"
    /// bound that the transcode enforces on media output. A legitimate note is always kilobytes;
    /// this only caps a novel-stuffer. Override with `RINGTOME_MAX_DOCUMENT_BYTES`.
    pub max_document_bytes: usize,
    /// How long a changed identity must sit quiet before its peers get an eager push - batches
    /// a burst of writes into one exchange. Local writes ring the eager loop's doorbell
    /// (`Db::nudge_sync`) so the debounce clock starts at the write itself; the ~1s tick then
    /// finds the debounce open, making the write-to-peer floor ~debounce rounded up to a tick
    /// (a save is on its peers in roughly a second at defaults). The UI's own autosave
    /// debounce (~10s) is what batches a typing burst into one save, so this stays short.
    /// Override with `RINGTOME_SYNC_DEBOUNCE_MS`.
    pub sync_debounce_ms: i64,
    /// Anti-entropy cadence: every interval, each identity with peers runs a full exchange with
    /// up to 3 randomly chosen peers, dirty or not (PROJECT_PLAN, sync discipline: random
    /// selection keeps the sync graph well-connected). Also the boot catch-up - the first pass
    /// fires immediately. Override with `RINGTOME_RESYNC_INTERVAL_SECS`.
    pub resync_interval_secs: u64,
    /// This node's human name - what a key hosted here is labeled with in its identity's
    /// device names (PROJECT_PLAN, Device Names). A desktop node defaults to the machine's
    /// hostname; a public operator sets the domain (`RINGTOME_NODE_NAME=ringtome.example`).
    /// Purely a label: it appears only as private register values on identities this node
    /// hosts, never in any public surface, and it confers no authority anywhere.
    pub node_name: String,
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

        let discovery = crate::net::discovery::DiscoveryMode::from_env();

        // Pre-crunch upload ceiling. Default by role: a desktop node ingests its own phone media,
        // so it's generous; a public node accepts uploads from strangers, so it defaults FAR lower
        // (a stranger POSTing 1GB to fail-transcode is an attack). "Public should be much lower"
        // is baked in as the default rather than left to the operator to remember - secure by
        // default - but any operator can override it either way with RINGTOME_MAX_UPLOAD_BYTES.
        let upload_default = match tenancy {
            Tenancy::Single => 1024 * 1024 * 1024, // 1 GiB: your own device, your own media
            Tenancy::Multi => 128 * 1024 * 1024,   // 128 MiB: a public node is a DoS surface
        };
        let max_upload_bytes = env::var("RINGTOME_MAX_UPLOAD_BYTES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(upload_default);

        // The distribution ceiling for a text document, same on every node (text is stored as
        // uploaded - no crush - so this bound is what actually crosses the wire). 10 MiB ~= a few
        // novels; real notes are kilobytes.
        let max_document_bytes = env::var("RINGTOME_MAX_DOCUMENT_BYTES")
            .ok()
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(10 * 1024 * 1024);

        let sync_debounce_ms = env::var("RINGTOME_SYNC_DEBOUNCE_MS")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(750);

        let resync_interval_secs = env::var("RINGTOME_RESYNC_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300);

        // Env wins; otherwise the machine's hostname - the name a person already calls this
        // computer. An unresolvable hostname falls back to a constant rather than failing boot:
        // the name is a label, and labels must never be load-bearing. Clamped once here to the
        // device-name cap (at a char boundary), so every downstream write is a valid label.
        let node_name = {
            let raw = env::var("RINGTOME_NODE_NAME")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    let host = gethostname::gethostname().to_string_lossy().into_owned();
                    if host.trim().is_empty() {
                        "unnamed-node".to_string()
                    } else {
                        host
                    }
                });
            let mut end = raw.len().min(crate::record::store::Devices::MAX_NAME_BYTES);
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            raw[..end].to_string()
        };

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
            max_upload_bytes,
            max_document_bytes,
            sync_debounce_ms,
            resync_interval_secs,
            node_name,
        }
    }

    pub fn is_dev(&self) -> bool {
        self.environment == Environment::Dev
    }

    /// The minimum password length, derived from reachability rather than tenancy: a node
    /// bound to loopback can only be reached by someone already at the machine, so a short
    /// PIN is an honest posture there ("breaching physical access is the rare case") - while
    /// any non-loopback bind faces the network and keeps the 8-character floor, regardless of
    /// how many accounts it holds. An unparseable bind address (e.g. `localhost`) fails
    /// closed to the strict floor; use `127.0.0.1` to get the relaxed one.
    pub fn password_min_len(&self) -> usize {
        let loopback = self
            .bind_address
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
        if loopback {
            1
        } else {
            8
        }
    }

    pub fn public(&self) -> PublicConfig {
        PublicConfig {
            app_version: self.app_version.clone(),
            environment: self.environment,
        }
    }
}
