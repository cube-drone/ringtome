//! The file layer: encrypted, content-addressed file bodies, stored and transferred by iroh-blobs.
//!
//! A "file" is XChaCha ciphertext (epoch key, random nonce; see [`crate::record::private::encrypt_file`]),
//! which iroh-blobs content-addresses by the BLAKE3 of those ciphertext bytes. The store is
//! content-agnostic: it never sees plaintext and cannot tell a note body from a photo, so this one
//! layer serves notes, posts, and media alike (NOTES_APP, The file layer).
//!
//! Serving is **ungated**: encryption plus the unforgeable, unlinkable content hash *is* the
//! boundary. iroh-blobs is dark by default (it announces nothing to any DHT or index), and
//! discovery is the taxonomy/identity layer's job, so we use iroh-blobs purely as point-to-point
//! transfer - `fetch` opens the connection itself to an address we already hold, never touching
//! content discovery.

use std::path::Path;

use anyhow::{bail, Context, Result};
use iroh::endpoint::Connection;
use iroh::{Endpoint, EndpointAddr};
use iroh_blobs::api::remote::GetProgressItem;
use iroh_blobs::api::Store;
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::store::mem::MemStore;
use iroh_blobs::{BlobsProtocol, Hash};
use n0_future::StreamExt;

use crate::record::private::{decrypt_file, encrypt_file, EpochKeys};

/// The blob-serving ALPN. New protocol beside the sync ALPN on the same endpoint.
pub const BLOB_ALPN: &[u8] = iroh_blobs::ALPN;

/// The blob-size cap a store defaults to when none is configured (tests, ephemeral stores). A real
/// node overrides this from config (`max_document_bytes` + framing). Generous enough for any legit
/// blob; the point is only that "unset" isn't "unbounded".
const DEFAULT_MAX_BLOB_BYTES: u64 = 16 * 1024 * 1024;

enum Backend {
    Mem(MemStore),
    Fs(FsStore),
}

impl Backend {
    fn store(&self) -> &Store {
        match self {
            Backend::Mem(s) => s,
            Backend::Fs(s) => s,
        }
    }
}

/// The node's encrypted file store: one iroh-blobs store holding every identity's ciphertext
/// blobs by content hash.
///
/// The store enforces the network's per-blob size invariant - "nothing over ~10MB moves" - at the
/// two gates it controls: it refuses to *originate* an over-cap blob (`put_encrypted`) and refuses
/// to *pull* one (`fetch` aborts mid-stream once the download crosses the cap). Serving needs no
/// gate: an over-cap blob can never become a *complete* local blob, and only complete blobs are
/// served. The gate is on the ciphertext (plaintext + AEAD framing), and format-agnostic - a note
/// body, a transcoded image, and a thumbnail all pass the same check.
pub struct FileStore {
    backend: Backend,
    max_blob_bytes: u64,
}

impl FileStore {
    /// In-memory store - tests and ephemeral nodes.
    pub fn memory() -> Self {
        Self {
            backend: Backend::Mem(MemStore::new()),
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
        }
    }

    /// Persistent redb-backed store rooted at `path` (created if absent).
    pub async fn fs(path: impl AsRef<Path>) -> Result<Self> {
        let store = FsStore::load(path).await.context("opening blob store")?;
        Ok(Self {
            backend: Backend::Fs(store),
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
        })
    }

    /// Set the per-blob ciphertext ceiling (a real node derives it from `max_document_bytes`).
    pub fn with_max_blob_bytes(mut self, max: u64) -> Self {
        self.max_blob_bytes = max;
        self
    }

    fn store(&self) -> &Store {
        self.backend.store()
    }

    /// The iroh-blobs protocol handler to register on the blob ALPN in the accept loop.
    pub fn protocol(&self) -> BlobsProtocol {
        BlobsProtocol::new(self.store(), None)
    }

    /// Encrypt a body under an epoch key and store it; returns the ciphertext content hash a note
    /// header points at via `file_hash`.
    pub async fn put_encrypted(
        &self,
        epoch: u64,
        epoch_key: &[u8; 32],
        plaintext: &[u8],
    ) -> Result<Hash> {
        let blob = encrypt_file(epoch, epoch_key, plaintext)?;
        // Gate one: never originate an over-cap blob. Legit callers are already bounded upstream
        // (the HTTP document cap, the transcode's output bound); this is the floor under all of it,
        // at the layer that actually distributes.
        if blob.len() as u64 > self.max_blob_bytes {
            bail!(
                "blob is {} bytes, over the {}-byte cap",
                blob.len(),
                self.max_blob_bytes
            );
        }
        let tag = self.store().add_bytes(blob).await.context("storing blob")?;
        Ok(tag.hash)
    }

    /// Store a PUBLIC body: plaintext into the same content-addressed store, no key in the
    /// question - the public lane's bodies (avatar first, posts to follow). The privacy rule
    /// that forbids dedup for private bodies inverts here: plaintext is content-addressed
    /// plainly, and identical public bytes sharing a hash is fine and free.
    pub async fn put_public(&self, plaintext: &[u8]) -> Result<Hash> {
        if plaintext.len() as u64 > self.max_blob_bytes {
            bail!(
                "blob is {} bytes, over the {}-byte cap",
                plaintext.len(),
                self.max_blob_bytes
            );
        }
        let tag = self
            .store()
            .add_bytes(plaintext.to_vec())
            .await
            .context("storing public blob")?;
        Ok(tag.hash)
    }

    /// Read a PUBLIC body: the bytes as stored, no decryption. `Ok(None)` = not held locally
    /// (headers sync ahead of bodies, same as ever).
    pub async fn get_public(&self, hash: Hash) -> Result<Option<Vec<u8>>> {
        match self.store().get_bytes(hash).await {
            Ok(b) => Ok(Some(b.to_vec())),
            Err(e) => {
                tracing::debug!(%hash, "public blob not readable locally: {e}");
                Ok(None)
            }
        }
    }

    /// Read a locally-held blob and decrypt it. `Ok(None)` means we hold no working key for its
    /// epoch (a revoked-then-rotated member, or a newcomer not yet re-sealed into that era).
    pub async fn get_decrypted(&self, hash: Hash, keys: &EpochKeys) -> Result<Option<Vec<u8>>> {
        // A missing blob is Ok(None), not an error: headers sync ahead of their bodies, and
        // "not fetched yet" renders the same as "no key for its era" - no body to show, yet.
        let blob = match self.store().get_bytes(hash).await {
            Ok(b) => b,
            Err(e) => {
                tracing::debug!(%hash, "blob not readable locally: {e}");
                return Ok(None);
            }
        };
        Ok(decrypt_file(&blob, keys))
    }

    /// Do we hold this blob, complete, locally?
    pub async fn has(&self, hash: Hash) -> bool {
        matches!(
            self.store().blobs().status(hash).await,
            Ok(iroh_blobs::api::blobs::BlobStatus::Complete { .. })
        )
    }

    /// Fetch a blob from a known provider over iroh-blobs. No discovery: we open the connection
    /// ourselves to the address the taxonomy/sync layer already handed us.
    pub async fn fetch(
        &self,
        endpoint: &Endpoint,
        provider: EndpointAddr,
        hash: Hash,
    ) -> Result<()> {
        let conn = endpoint
            .connect(provider, BLOB_ALPN)
            .await
            .context("dialing blob provider")?;
        self.fetch_on(conn, hash).await
    }

    /// Gate two: pull a blob over one connection, aborting the moment the running download crosses
    /// the cap. The progress stream reports cumulative *verified* payload bytes (iroh-blobs streams
    /// BLAKE3-verified data, and the length is bound to the hash we asked for), so a lying or
    /// malicious peer can't sneak an over-cap blob past - and we drop the stream, cancelling the
    /// transfer, having pulled at most ~cap bytes rather than the whole thing.
    async fn fetch_on(&self, conn: Connection, hash: Hash) -> Result<()> {
        let mut progress = self.store().remote().fetch(conn, hash).stream();
        while let Some(item) = progress.next().await {
            match item {
                GetProgressItem::Progress(downloaded) => {
                    if downloaded > self.max_blob_bytes {
                        // Returning drops `progress`, which cancels the download future.
                        bail!(
                            "blob {hash} exceeds the {}-byte cap (aborted at {downloaded})",
                            self.max_blob_bytes
                        );
                    }
                }
                GetProgressItem::Done(_) => return Ok(()),
                GetProgressItem::Error(e) => bail!("fetching blob {hash}: {e:?}"),
            }
        }
        bail!("blob {hash} fetch ended without completing")
    }

    /// Fetch several blobs from one provider over a single connection. Best-effort per hash:
    /// returns how many landed (the provider may lack some too - a body it also hasn't fetched
    /// yet is a normal state, not an error - and an over-cap blob is refused the same way).
    pub async fn fetch_many(
        &self,
        endpoint: &Endpoint,
        provider: EndpointAddr,
        hashes: &[Hash],
    ) -> usize {
        let conn = match endpoint.connect(provider, BLOB_ALPN).await {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("dialing blob provider: {e}");
                return 0;
            }
        };
        let mut fetched = 0;
        for hash in hashes {
            match self.fetch_on(conn.clone(), *hash).await {
                Ok(_) => fetched += 1,
                Err(e) => tracing::debug!(%hash, "blob not fetched: {e}"),
            }
        }
        fetched
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::endpoint::presets;
    use iroh::protocol::Router;

    async fn test_endpoint() -> Endpoint {
        Endpoint::builder(presets::Minimal)
            .alpns(vec![BLOB_ALPN.to_vec()])
            .bind()
            .await
            .unwrap()
    }

    /// The wiring test: a blob fetched through the REAL node plumbing - `build_endpoint`
    /// (advertising both ALPNs) and `spawn_accept_loop` (routing by negotiated ALPN) - not a
    /// test-local Router. This is what proves a running node actually serves blobs.
    #[tokio::test]
    async fn accept_loop_routes_blob_connections() {
        let dir = std::env::temp_dir().join(format!(
            "ringtome-files-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        // Node A, assembled from the same constructors main() uses.
        let keystore = crate::keystore::Keystore::load(&dir).unwrap();
        let ep_a =
            crate::net::p2p::build_endpoint(&keystore, &crate::net::discovery::DiscoveryMode::Off)
                .await
                .unwrap();
        let files_a = std::sync::Arc::new(FileStore::memory());
        let state = crate::AppState {
            config: crate::config::Config::from_env(),
            node_db: crate::db::open_node_db(&dir, &keystore).await.unwrap(),
            user_dbs: crate::db::UserDbManager::new(&dir, keystore.clone(), 8),
            rate_limiter: crate::rate_limit::RateLimiter::new(false),
            keystore,
            endpoint: ep_a.clone(),
            directory: crate::net::discovery::Directory::build(
                &crate::net::discovery::DiscoveryMode::Off,
            )
            .unwrap(),
            files: files_a.clone(),
            ingest: crate::ingest::Ingest::new(dir.join("quarantine")),
            resync: crate::net::resync::ResyncTracker::default(),
            unfurl: crate::net::unfurl::Unfurler::new(30.0),
            view_epochs: crate::ViewEpochs::default(),
        };
        crate::net::p2p::spawn_accept_loop(ep_a.clone(), state);

        let epoch = 5u64;
        let key = [7u8; 32];
        let plaintext = b"served by the real accept loop".to_vec();
        let hash = files_a
            .put_encrypted(epoch, &key, &plaintext)
            .await
            .unwrap();

        let addr_a = crate::net::sync::endpoint_addr(
            &ep_a.id().to_string(),
            &crate::net::p2p::addr_strings(&ep_a),
        )
        .unwrap();

        // Node B fetches through A's accept loop.
        let ep_b = test_endpoint().await;
        let store_b = FileStore::memory();
        store_b.fetch(&ep_b, addr_a, hash).await.unwrap();

        let keys = EpochKeys::single(epoch, key);
        let got = store_b.get_decrypted(hash, &keys).await.unwrap();
        assert_eq!(got.unwrap(), plaintext);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn encrypted_blob_round_trips_between_two_nodes() {
        let epoch = 3u64;
        let key = [9u8; 32];
        let plaintext = b"a note body that travels the wire as ciphertext".to_vec();

        // Node A stores the encrypted body and serves blobs on its endpoint.
        let ep_a = test_endpoint().await;
        let store_a = FileStore::memory();
        let hash = store_a
            .put_encrypted(epoch, &key, &plaintext)
            .await
            .unwrap();
        let _router_a = Router::builder(ep_a.clone())
            .accept(BLOB_ALPN, store_a.protocol())
            .spawn();

        // A's connectable address, built with the same helpers the sync path uses.
        let addr_a = crate::net::sync::endpoint_addr(
            &ep_a.id().to_string(),
            &crate::net::p2p::addr_strings(&ep_a),
        )
        .unwrap();

        // Node B has never seen the blob; fetch it by hash and decrypt with the same epoch key.
        let ep_b = test_endpoint().await;
        let store_b = FileStore::memory();
        store_b.fetch(&ep_b, addr_a, hash).await.unwrap();

        let keys = EpochKeys::single(epoch, key);
        let got = store_b.get_decrypted(hash, &keys).await.unwrap();
        assert_eq!(got.unwrap(), plaintext);
    }

    /// Gate one: a store refuses to originate a blob over its cap. Synthetic bytes - a size gate
    /// cares only about length - kept small so it's instant.
    #[tokio::test]
    async fn put_refuses_a_blob_over_the_cap() {
        let store = FileStore::memory().with_max_blob_bytes(256 * 1024);
        let over = vec![0x42u8; 512 * 1024];
        assert!(
            store.put_encrypted(1, &[0u8; 32], &over).await.is_err(),
            "an over-cap body is refused at put"
        );
        // Under the cap still stores fine.
        let hash = store
            .put_encrypted(1, &[0u8; 32], b"a small body")
            .await
            .unwrap();
        assert!(store.has(hash).await);
    }

    /// Gate two: a node refuses to *pull* a blob past its cap, aborting mid-stream, even when a
    /// permissive peer is happily serving the whole thing. The fixture is the corpus's real
    /// (public-domain / CC, hence distributable) 34.6MB video - genuinely over any document cap.
    #[tokio::test]
    async fn fetch_refuses_a_blob_over_the_cap() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../sample_media/buck-twenty.mp4"
        );
        let big = std::fs::read(path).expect("corpus fixture sample_media/buck-twenty.mp4");
        assert!(
            big.len() as u64 > 10 * 1024 * 1024,
            "fixture must be over-cap"
        );

        let epoch = 1u64;
        let key = [3u8; 32];

        // A permissive peer (generous cap) holds and serves the oversized blob.
        let ep_a = test_endpoint().await;
        let store_a = FileStore::memory().with_max_blob_bytes(64 * 1024 * 1024);
        let hash = store_a.put_encrypted(epoch, &key, &big).await.unwrap();
        let _router_a = Router::builder(ep_a.clone())
            .accept(BLOB_ALPN, store_a.protocol())
            .spawn();
        let addr_a = crate::net::sync::endpoint_addr(
            &ep_a.id().to_string(),
            &crate::net::p2p::addr_strings(&ep_a),
        )
        .unwrap();

        // Our node caps blobs at 10MB and refuses to pull the whole thing.
        let ep_b = test_endpoint().await;
        let store_b = FileStore::memory().with_max_blob_bytes(10 * 1024 * 1024);
        assert!(
            store_b.fetch(&ep_b, addr_a, hash).await.is_err(),
            "an over-cap blob is refused mid-stream"
        );
        assert!(
            !store_b.has(hash).await,
            "and never lands as a complete blob"
        );
    }
}
