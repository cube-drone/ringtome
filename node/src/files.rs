//! The file layer: encrypted, content-addressed file bodies, stored and transferred by iroh-blobs.
//!
//! A "file" is XChaCha ciphertext (epoch key, random nonce; see [`crate::private::encrypt_file`]),
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

use anyhow::{Context, Result};
use iroh::{Endpoint, EndpointAddr};
use iroh_blobs::api::Store;
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::store::mem::MemStore;
use iroh_blobs::{BlobsProtocol, Hash};

use crate::private::{decrypt_file, encrypt_file, EpochKeys};

/// The blob-serving ALPN. New protocol beside the sync ALPN on the same endpoint.
pub const BLOB_ALPN: &[u8] = iroh_blobs::ALPN;

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
pub struct FileStore {
    backend: Backend,
}

impl FileStore {
    /// In-memory store - tests and ephemeral nodes.
    pub fn memory() -> Self {
        Self {
            backend: Backend::Mem(MemStore::new()),
        }
    }

    /// Persistent redb-backed store rooted at `path` (created if absent).
    pub async fn fs(path: impl AsRef<Path>) -> Result<Self> {
        let store = FsStore::load(path).await.context("opening blob store")?;
        Ok(Self {
            backend: Backend::Fs(store),
        })
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
        let tag = self.store().add_bytes(blob).await.context("storing blob")?;
        Ok(tag.hash)
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
        self.store()
            .remote()
            .fetch(conn, hash)
            .await
            .context("fetching blob")?;
        Ok(())
    }

    /// Fetch several blobs from one provider over a single connection. Best-effort per hash:
    /// returns how many landed (the provider may lack some too - a body it also hasn't fetched
    /// yet is a normal state, not an error).
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
            match self.store().remote().fetch(conn.clone(), *hash).await {
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
        let ep_a = crate::p2p::build_endpoint(&keystore, &crate::discovery::DiscoveryMode::Off)
            .await
            .unwrap();
        let files_a = std::sync::Arc::new(FileStore::memory());
        let state = crate::AppState {
            config: crate::config::Config::from_env(),
            node_db: crate::db::open_node_db(&dir).await.unwrap(),
            user_dbs: crate::db::UserDbManager::new(&dir, 8),
            rate_limiter: crate::rate_limit::RateLimiter::new(false),
            keystore,
            endpoint: ep_a.clone(),
            directory: crate::discovery::Directory::build(&crate::discovery::DiscoveryMode::Off)
                .unwrap(),
            files: files_a.clone(),
            ingest: crate::ingest::Ingest::new(dir.join("quarantine")),
        };
        crate::p2p::spawn_accept_loop(ep_a.clone(), state);

        let epoch = 5u64;
        let key = [7u8; 32];
        let plaintext = b"served by the real accept loop".to_vec();
        let hash = files_a.put_encrypted(epoch, &key, &plaintext).await.unwrap();

        let addr_a =
            crate::sync::endpoint_addr(&ep_a.id().to_string(), &crate::p2p::addr_strings(&ep_a))
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
        let hash = store_a.put_encrypted(epoch, &key, &plaintext).await.unwrap();
        let _router_a = Router::builder(ep_a.clone())
            .accept(BLOB_ALPN, store_a.protocol())
            .spawn();

        // A's connectable address, built with the same helpers the sync path uses.
        let addr_a =
            crate::sync::endpoint_addr(&ep_a.id().to_string(), &crate::p2p::addr_strings(&ep_a))
                .unwrap();

        // Node B has never seen the blob; fetch it by hash and decrypt with the same epoch key.
        let ep_b = test_endpoint().await;
        let store_b = FileStore::memory();
        store_b.fetch(&ep_b, addr_a, hash).await.unwrap();

        let keys = EpochKeys::single(epoch, key);
        let got = store_b.get_decrypted(hash, &keys).await.unwrap();
        assert_eq!(got.unwrap(), plaintext);
    }
}
