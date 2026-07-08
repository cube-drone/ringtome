//! Discovery: publishing and resolving records that map keys to reachability.
//!
//! Two record kinds, two fates:
//!
//! - **Serving records** (protocol surface, `proto::directory`): signed statements published
//!   under an identity *leaf key* - "this leaf serves root R at endpoint E." Published only for
//!   identities explicitly marked served (publication is an act, never a side effect).
//! - **Endpoint records** (transport plumbing): endpoint id -> socket addresses. In mainline
//!   mode this is iroh's own discovery (relays + its pkarr records) and we publish nothing; in
//!   local mode the `LocalDirectory` simulates that layer with unsigned JSON, because the tests
//!   still need dial-by-id to work.
//!
//! The `LocalDirectory` is a shared folder posing as a DHT: same signed bytes, same
//! one-record-per-key semantics, same TTL-as-liveness expiry - spanning the multiple node
//! *processes* of the integration harness with zero network. It is also the future attack
//! harness: a directory that lies (withholds, staleness, wrong keys) is how eclipse behavior
//! gets tested on demand.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use ringtome_proto::directory::SignedServingRecord;

/// How this node publishes and resolves records. Parsed from `RINGTOME_DISCOVERY`.
#[derive(Debug, Clone)]
pub enum DiscoveryMode {
    /// No publishing, no resolution. Adoption codes (which carry bootstrap addresses) still
    /// work; anything else needs explicit addresses. The conservative default.
    Off,
    /// Shared-folder simulation for local/test use: `RINGTOME_DISCOVERY=local:/some/path`.
    Local(PathBuf),
    /// The real Mainline DHT via pkarr: `RINGTOME_DISCOVERY=mainline`.
    Mainline,
}

impl DiscoveryMode {
    pub fn from_env() -> Self {
        match std::env::var("RINGTOME_DISCOVERY").as_deref() {
            Ok("mainline") => DiscoveryMode::Mainline,
            Ok(s) if s.starts_with("local:") => {
                DiscoveryMode::Local(PathBuf::from(s.trim_start_matches("local:")))
            }
            _ => DiscoveryMode::Off,
        }
    }
}

/// Liveness window for local-mode records, mirroring DHT-expiry semantics: a record older than
/// this is treated as absent (its publisher stopped republishing, i.e. went offline).
const LOCAL_RECORD_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// TTL stamped on mainline DNS records.
const MAINLINE_TTL_SECS: u32 = 60 * 60;

/// The directory this node talks to. Enum dispatch: three modes, no trait objects.
#[derive(Clone)]
pub enum Directory {
    Off,
    Local(LocalDirectory),
    Mainline(MainlineDirectory),
}

impl Directory {
    pub fn build(mode: &DiscoveryMode) -> Result<Self> {
        Ok(match mode {
            DiscoveryMode::Off => Directory::Off,
            DiscoveryMode::Local(path) => Directory::Local(LocalDirectory::new(path.clone())?),
            DiscoveryMode::Mainline => Directory::Mainline(MainlineDirectory::new()?),
        })
    }

    /// Publish a serving record under its leaf key.
    pub async fn publish_serving(&self, record: &SignedServingRecord) -> Result<()> {
        match self {
            Directory::Off => Err(anyhow!("discovery is off (set RINGTOME_DISCOVERY)")),
            Directory::Local(d) => d.publish_serving(record),
            Directory::Mainline(d) => d.publish_serving(record).await,
        }
    }

    /// Resolve a leaf key to its serving record, if one is published and fresh.
    pub async fn resolve_serving(
        &self,
        node_key: &[u8; 32],
    ) -> Result<Option<SignedServingRecord>> {
        match self {
            Directory::Off => Ok(None),
            Directory::Local(d) => d.resolve_serving(node_key),
            Directory::Mainline(d) => d.resolve_serving(node_key).await,
        }
    }

    /// Publish this node's endpoint record (local mode only; iroh's own discovery covers
    /// mainline, and Off publishes nothing).
    pub async fn publish_endpoint(&self, endpoint_id: &str, addrs: &[String]) -> Result<()> {
        match self {
            Directory::Local(d) => d.publish_endpoint(endpoint_id, addrs),
            _ => Ok(()),
        }
    }

    /// Resolve an endpoint id to known socket addresses (local mode; mainline dials by id and
    /// lets iroh discovery do the rest, so `None` there is normal and fine).
    pub async fn resolve_endpoint(&self, endpoint_id: &str) -> Result<Option<Vec<String>>> {
        match self {
            Directory::Local(d) => d.resolve_endpoint(endpoint_id),
            _ => Ok(None),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Local: a shared folder posing as a DHT.

#[derive(Clone)]
pub struct LocalDirectory {
    dir: PathBuf,
    ttl: Duration,
}

impl LocalDirectory {
    pub fn new(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir).context("creating local discovery directory")?;
        Ok(Self {
            dir,
            ttl: LOCAL_RECORD_TTL,
        })
    }

    #[cfg(test)]
    fn with_ttl(dir: PathBuf, ttl: Duration) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir, ttl })
    }

    fn fresh(&self, path: &std::path::Path) -> bool {
        std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age <= self.ttl)
    }

    fn publish_serving(&self, record: &SignedServingRecord) -> Result<()> {
        let name = format!("s_{}.bin", hex::encode(record.record().node_key));
        std::fs::write(self.dir.join(name), record.bytes()).context("writing serving record")
    }

    fn resolve_serving(&self, node_key: &[u8; 32]) -> Result<Option<SignedServingRecord>> {
        let path = self.dir.join(format!("s_{}.bin", hex::encode(node_key)));
        if !path.exists() || !self.fresh(&path) {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).context("reading serving record")?;
        // Decode verifies the signature; and like a real relying party, confirm the record is
        // actually keyed by the key we asked for.
        let record = SignedServingRecord::decode(&bytes)
            .map_err(|e| anyhow!("stored serving record invalid: {e}"))?;
        if &record.record().node_key != node_key {
            return Err(anyhow!("serving record keyed under the wrong key"));
        }
        Ok(Some(record))
    }

    fn publish_endpoint(&self, endpoint_id: &str, addrs: &[String]) -> Result<()> {
        let name = format!("e_{endpoint_id}.json");
        std::fs::write(self.dir.join(name), serde_json::to_vec(addrs)?)
            .context("writing endpoint record")
    }

    fn resolve_endpoint(&self, endpoint_id: &str) -> Result<Option<Vec<String>>> {
        let path = self.dir.join(format!("e_{endpoint_id}.json"));
        if !path.exists() || !self.fresh(&path) {
            return Ok(None);
        }
        let bytes = std::fs::read(&path).context("reading endpoint record")?;
        Ok(Some(serde_json::from_slice(&bytes)?))
    }
}

// ---------------------------------------------------------------------------------------------
// Mainline: the real DHT via pkarr. Serving-record bytes travel base64ed in a TXT record named
// `_ringtome`, inside a packet signed by the same leaf key (pkarr's own signature layer).

#[derive(Clone)]
pub struct MainlineDirectory {
    client: pkarr::Client,
}

impl MainlineDirectory {
    pub fn new() -> Result<Self> {
        let client = pkarr::Client::builder()
            .build()
            .context("building pkarr client")?;
        Ok(Self { client })
    }

    /// Publishing needs the leaf *secret* (pkarr signs the packet with the record's own key), so
    /// the caller passes it; the trait-level method can't.
    pub async fn publish_serving_with_key(
        &self,
        record: &SignedServingRecord,
        leaf_secret: &[u8; 32],
    ) -> Result<()> {
        use base64::Engine;
        let keypair = pkarr::Keypair::from_secret_key(leaf_secret);
        let b64 = base64::engine::general_purpose::STANDARD.encode(record.bytes());
        let packet = pkarr::SignedPacket::builder()
            .txt(
                "_ringtome"
                    .try_into()
                    .map_err(|_| anyhow!("bad record name"))?,
                b64.as_str()
                    .try_into()
                    .map_err(|_| anyhow!("record too large for TXT"))?,
                MAINLINE_TTL_SECS,
            )
            .build(&keypair)
            .map_err(|e| anyhow!("building pkarr packet: {e}"))?;
        self.client
            .publish(&packet, None)
            .await
            .map_err(|e| anyhow!("publishing to mainline: {e}"))?;
        Ok(())
    }

    async fn publish_serving(&self, _record: &SignedServingRecord) -> Result<()> {
        // Reached only via the enum wrapper, which doesn't carry the secret; the publish task
        // calls `publish_serving_with_key` directly for mainline.
        Err(anyhow!(
            "mainline publishing requires the leaf secret (internal path)"
        ))
    }

    async fn resolve_serving(&self, node_key: &[u8; 32]) -> Result<Option<SignedServingRecord>> {
        use base64::Engine;
        let pk = pkarr::PublicKey::try_from(node_key)
            .map_err(|e| anyhow!("bad node key for pkarr: {e}"))?;
        let Some(packet) = self.client.resolve(&pk).await else {
            return Ok(None);
        };
        // Find our TXT record among the packet's resource records.
        for rr in packet.resource_records("_ringtome") {
            if let pkarr::dns::rdata::RData::TXT(txt) = &rr.rdata {
                let joined: String = txt.clone().try_into().unwrap_or_default();
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(joined) {
                    if let Ok(record) = SignedServingRecord::decode(&bytes) {
                        if &record.record().node_key == node_key {
                            return Ok(Some(record));
                        }
                    }
                }
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;
    use ringtome_proto::directory::{ServingRecord, RECORD_VERSION};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "ringtome-disc-{tag}-{}-{nanos}",
            std::process::id()
        ));
        dir
    }

    fn sample_record(seed: u8) -> (SigningKey, SignedServingRecord) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let record = ServingRecord {
            v: RECORD_VERSION,
            root: [1u8; 32],
            node_key: key.verifying_key().to_bytes(),
            endpoint_id: [3u8; 32],
            timestamp_ms: 1_700_000_400_000,
        };
        let signed = SignedServingRecord::create(&record, &key).unwrap();
        (key, signed)
    }

    #[test]
    fn local_directory_round_trips_serving_records() {
        let dir = temp_dir("serve");
        let local = LocalDirectory::new(dir.clone()).unwrap();
        let (_key, signed) = sample_record(9);

        local.publish_serving(&signed).unwrap();
        let resolved = local
            .resolve_serving(&signed.record().node_key)
            .unwrap()
            .expect("record present");
        assert_eq!(resolved, signed);

        // An unknown key resolves to nothing.
        assert!(local.resolve_serving(&[0xEE; 32]).unwrap().is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_directory_expires_stale_records() {
        let dir = temp_dir("ttl");
        let local = LocalDirectory::with_ttl(dir.clone(), Duration::ZERO).unwrap();
        let (_key, signed) = sample_record(9);
        local.publish_serving(&signed).unwrap();
        // TTL zero: everything is already too old - expiry-as-liveness, compressed.
        assert!(local
            .resolve_serving(&signed.record().node_key)
            .unwrap()
            .is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_directory_rejects_misfiled_records() {
        // A record stored under a different key's filename must not resolve: the directory
        // enforces the same key-binding a DHT gets for free.
        let dir = temp_dir("misfile");
        let local = LocalDirectory::new(dir.clone()).unwrap();
        let (_key, signed) = sample_record(9);
        let other_key = [7u8; 32];
        std::fs::write(
            dir.join(format!("s_{}.bin", hex::encode(other_key))),
            signed.bytes(),
        )
        .unwrap();
        assert!(local.resolve_serving(&other_key).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_directory_round_trips_endpoint_records() {
        let dir = temp_dir("ep");
        let local = LocalDirectory::new(dir.clone()).unwrap();
        local
            .publish_endpoint("someendpointid", &["127.0.0.1:5299".into()])
            .unwrap();
        assert_eq!(
            local.resolve_endpoint("someendpointid").unwrap().unwrap(),
            vec!["127.0.0.1:5299".to_string()]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
