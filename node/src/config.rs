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
    /// Admission (PEEK.md ruling 14, `net::admission`): incoming connections held at once,
    /// how many of those may still be unproven, and how many one peer may hold. Over any of
    /// them a connection is closed at accept. `RINGTOME_ADMIT_MAX_CONNECTIONS`,
    /// `RINGTOME_ADMIT_MAX_UNPROVEN`, `RINGTOME_ADMIT_MAX_PER_PEER`.
    pub admit_max_connections: usize,
    pub admit_max_unproven: usize,
    pub admit_max_per_peer: usize,
    /// The exchange budgets (PEEK.md ruling 2): entries and bytes one direction of one
    /// exchange may carry before it ends short and the requester is marked behind.
    /// `RINGTOME_SYNC_BUDGET_ENTRIES`, `RINGTOME_SYNC_BUDGET_BYTES`.
    pub sync_budget_entries: u64,
    pub sync_budget_bytes: u64,
    /// The serve side's first-frame deadline and both sides' whole-exchange wall clock, in
    /// milliseconds. `RINGTOME_SYNC_FIRST_FRAME_MS`, `RINGTOME_SYNC_EXCHANGE_MAX_MS`.
    pub sync_first_frame_ms: u64,
    pub sync_exchange_max_ms: u64,
    /// The identity-chain ceiling (PEEK.md ruling 3): a persona this node does not host whose
    /// identity entries would exceed it is refused at the gate. `RINGTOME_IDENTITY_CHAIN_CEILING`.
    pub identity_chain_ceiling: usize,
    /// How long a changed identity must sit quiet before its peers get an eager push - batches
    /// a burst of writes into one exchange. Local writes ring the eager loop's doorbell
    /// (`Db::nudge_sync`) so the debounce clock starts at the write itself; the ~1s tick then
    /// finds the debounce open, making the write-to-peer floor ~debounce rounded up to a tick
    /// (a save is on its peers in roughly a second at defaults). The UI's own autosave
    /// debounce (~10s) is what batches a typing burst into one save, so this stays short.
    /// Override with `RINGTOME_SYNC_DEBOUNCE_MS`.
    pub sync_debounce_ms: i64,
    /// What this node's delivery door charges a stranger to knock, in leading zero bits
    /// (`ringtome_proto::pow`). Override with `RINGTOME_POW_REQUESTED_BITS`; zero turns the
    /// price off entirely.
    ///
    /// **Fixed at boot, never adjusted at runtime.** There is no flood detector and no dial:
    /// the price is what the operator set, and it stays there. The number exists so that it can
    /// be *re-set* - a default calibrated to tens of milliseconds on 2026 hardware is a
    /// rounding error on 2035 hardware, and an operator should be able to keep it honest
    /// without waiting for a release.
    ///
    /// An operator who sets this above what other nodes will pay has not raised a drawbridge -
    /// they have obliquely closed their own inbox to strangers, which is a legitimate thing to
    /// want and an illegitimate thing to do by accident. Hence the log line at boot.
    pub pow_requested_bits: u32,
    /// The most this node will spend to deliver one notice, in the same units. Override with
    /// `RINGTOME_POW_WILLING_BITS`.
    ///
    /// Separate from the price we *charge* because they answer different questions, and the gap
    /// between them is what stops a hostile door from farming our CPU: failing to deliver a
    /// notice is nearly free (the statement is already published; the subject learns it the
    /// moment they ever sync us), so this is a judgment about what the message is worth, not
    /// about what we are capable of.
    pub pow_willing_bits: u32,
    /// How many per-user databases stay open at once (the handle cache's size). A miss is a
    /// PER-FILE act - key unseal, decrypt, migration check, journal attach - so the cache is
    /// what keeps a node with many personas from paying it constantly; a node holding more
    /// personas than this thrashes, which is exactly what the 3-node test-data run found
    /// (150 databases per node against a cache of 128, 2026-08-08).
    ///
    /// It is a FILE DESCRIPTOR budget in disguise: roughly four per open database (main, WAL,
    /// shm, journal), so the default 128 is about 512 descriptors. Stock limits vary wildly -
    /// old macOS defaults to 256 soft, Linux commonly 1024, a tuned machine may allow a
    /// million - and a userspace p2p node gets whatever the host hands it, so this is a knob
    /// rather than a constant. Leave headroom: sockets (iroh, HTTP, blobs) come out of the
    /// same budget. Override with `RINGTOME_MAX_OPEN_DATABASES`.
    pub max_open_databases: u64,
    /// The unfurl endpoint's global outbound budget, in fetches per minute - also the burst
    /// capacity (one minute's allowance up front). This exists so a node can't be aimed at a
    /// foreign server as a load test; it is sized per NODE, not per user, so a single-user
    /// node is generous at the default 30 and a many-user node raises it to taste. Override
    /// with `RINGTOME_UNFURL_RATE_PER_MIN`.
    pub unfurl_rate_per_min: f64,
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
    /// `RINGTOME_PUBLIC_URL`: the base URL this node is publicly reachable at
    /// (`https://my-node.ca`), declared by the operator - the node cannot verify its own
    /// reachability, so this is an assertion, not a discovery. When set, minted identity
    /// addresses carry it as the origin (Addressing: the origin slot is provenance and
    /// preferred first contact); when absent, addresses mint in the origin-free path form,
    /// which is the honest shape for a node the web cannot reach. `window.location` is
    /// deliberately NOT the fallback: the origin a browser happens to use (localhost, a LAN
    /// name, a tailnet alias) proves nothing about what the world can dial.
    pub public_url: Option<String>,
}

/// The subset of configuration safe to expose to a browser client.
#[derive(Debug, Clone, Serialize)]
pub struct PublicConfig {
    pub app_version: String,
    pub environment: Environment,
    /// The node's publicly reachable base URL, if the operator declared one - see
    /// `Config::public_url`. The client mints shareable identity addresses with this as the
    /// origin; absent, it mints the origin-free path form.
    pub public_url: Option<String>,
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

        // Admission and exchange dials (PEEK.md slice 1). Every one refuses rather than
        // queues; the defaults are sized for a small multi-tenant node.
        let dial = |name: &str, default: u64| -> u64 {
            env::var(name).ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(default)
        };
        // Sized for fleets, not for one visitor: a peer NODE carries every persona it fronts,
        // so one peer legitimately holds dozens of connections at once (the five-node rig
        // found a cap of eight refusing a quarter of a million fragment asks, 2026-09-05).
        let admit_max_connections = dial("RINGTOME_ADMIT_MAX_CONNECTIONS", 512) as usize;
        let admit_max_unproven = dial("RINGTOME_ADMIT_MAX_UNPROVEN", 256) as usize;
        let admit_max_per_peer = dial("RINGTOME_ADMIT_MAX_PER_PEER", 128) as usize;
        let sync_budget_entries = dial("RINGTOME_SYNC_BUDGET_ENTRIES", 5_000);
        let sync_budget_bytes = dial("RINGTOME_SYNC_BUDGET_BYTES", 64 * 1024 * 1024);
        let sync_first_frame_ms = dial("RINGTOME_SYNC_FIRST_FRAME_MS", 10_000);
        let sync_exchange_max_ms = dial("RINGTOME_SYNC_EXCHANGE_MAX_MS", 10 * 60 * 1000);
        let identity_chain_ceiling = dial("RINGTOME_IDENTITY_CHAIN_CEILING", 10_000) as usize;

        // Floored at 8: a cache too small to hold the handles one request touches would
        // thrash on a single operation, which is worse than any descriptor it saves.
        let max_open_databases = env::var("RINGTOME_MAX_OPEN_DATABASES")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(128)
            .max(8);

        // The delivery price, both halves. Read here rather than at the door so that "what does
        // this node charge" is answerable by reading one struct, and so a bad value fails at
        // boot instead of on the first stranger's knock.
        let bits = |name: &str| {
            env::var(name)
                .ok()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(ringtome_proto::pow::DEFAULT_BITS)
        };
        let pow_requested_bits = bits("RINGTOME_POW_REQUESTED_BITS");
        let pow_willing_bits = bits("RINGTOME_POW_WILLING_BITS");

        let sync_debounce_ms = env::var("RINGTOME_SYNC_DEBOUNCE_MS")
            .ok()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(750);

        let resync_interval_secs = env::var("RINGTOME_RESYNC_INTERVAL_SECS")
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(300);

        let unfurl_rate_per_min = env::var("RINGTOME_UNFURL_RATE_PER_MIN")
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(30.0);

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

        // Trailing slashes trimmed once here so every consumer can append `/id/...` blindly;
        // a blank or whitespace value is the same as unset.
        let public_url = env::var("RINGTOME_PUBLIC_URL")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty());

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
            admit_max_connections,
            admit_max_unproven,
            admit_max_per_peer,
            sync_budget_entries,
            sync_budget_bytes,
            sync_first_frame_ms,
            sync_exchange_max_ms,
            identity_chain_ceiling,
            max_open_databases,
            sync_debounce_ms,
            pow_requested_bits,
            pow_willing_bits,
            resync_interval_secs,
            unfurl_rate_per_min,
            node_name,
            public_url,
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
            public_url: self.public_url.clone(),
        }
    }
}
