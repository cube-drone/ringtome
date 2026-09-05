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

/// How the reaper learns what must live: a callback armed after boot that walks the node's own
/// reference ledgers (held chains' doc_versions, the fragment shelf, the wants ledger) and
/// returns every hash something still points at. `Err` from the source means the reaper CANNOT
/// see every reference right now, and the only safe answer is to reap nothing.
/// The armed reaper: the mark source plus the store handle its tag hygiene needs.
type ArmedGc = std::sync::Arc<std::sync::OnceLock<(LiveSource, Store)>>;
/// Recently touched blobs, protected while their referencing rows land.
/// Ring entries carry the put's [`iroh_blobs::api::TempTag`] when there is one (puts; a
/// fetched blob's protection is the fetch machinery's own). A LIVE temp tag is the one
/// protection the reaper's mark phase reads AFTER `clear_protected` - the hash set alone
/// closes every window except the put that lands between the protect snapshot and the
/// clear, and that window ate a 75ms-old body on CI (2026-08-25, journalfill). Entries
/// prune by grace on every insert and every GC round, which is what releases the tags.
type RecentRing = std::sync::Arc<
    std::sync::Mutex<Vec<(Hash, std::time::Instant, Option<iroh_blobs::api::TempTag>)>>,
>;

pub type LiveSource = std::sync::Arc<
    dyn Fn() -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<std::collections::HashSet<Hash>>> + Send>,
        > + Send
        + Sync,
>;

/// Blobs put or fetched this recently are protected regardless of the ledgers: a put returns
/// its hash BEFORE the caller writes the row that references it, and the reaper must not win
/// that race. Ten minutes is oceans beside the milliseconds the row-write takes. Tests shrink
/// it (`RINGTOME_TEST_REAP_GRACE_MS`) so a reap is watchable inside one suite.
///
/// Read LIVE on every use, deliberately not latched in a process-wide OnceLock: the
/// unit-test binary is one process running many tests, and a latch let whichever test touched
/// a store first freeze the grace for every test after it - the reaper test's shrunk value
/// lost that race exactly when the runner was slow enough to serialize the suite, which is
/// how CI was red for a day while every parallel local run stayed green (found 2026-08-16).
/// The read is an env scan, paid per put/fetch and per GC round - nothing on a hot path.
fn recent_grace() -> std::time::Duration {
    std::env::var("RINGTOME_TEST_REAP_GRACE_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .map(std::time::Duration::from_millis)
        .unwrap_or(std::time::Duration::from_secs(600))
}

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
    /// The reaper's mark source plus a store handle for tag hygiene, armed once after the
    /// node's ledgers exist (`reaper::arm`). Until then the GC callback aborts every run - an
    /// unarmed reaper reaps nothing.
    armed: ArmedGc,
    /// Hashes put or fetched recently, protected from the reaper while their referencing rows
    /// land (see [`recent_grace`]).
    recent: RecentRing,
    /// A clone of the node's test transport gate, because this layer opens its OWN connections
    /// (see `fetch`) and would otherwise be the one hole in `/test/unplug`. Default-constructed
    /// here, so a store built without one refuses nothing - see [`crate::net::p2p::Unplugged`].
    unplugged: crate::net::p2p::Unplugged,
}

impl FileStore {
    /// In-memory store - tests and ephemeral nodes. GC runs fast here (the unit tests want to
    /// watch it), and reaps nothing until armed, which tests almost never do.
    pub fn memory() -> Self {
        let (armed, recent) = Self::gc_state();
        Self {
            backend: Backend::Mem(MemStore::new_with_opts(iroh_blobs::store::mem::Options {
                gc_config: Some(Self::gc_config(
                    std::time::Duration::from_millis(200),
                    armed.clone(),
                    recent.clone(),
                )),
            })),
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
            unplugged: crate::net::p2p::Unplugged::default(),
            armed,
            recent,
        }
    }

    /// Persistent redb-backed store rooted at `path` (created if absent). `gc_interval` paces
    /// the blob reaper's rounds; the reaper still reaps nothing until `arm_gc` is called.
    pub async fn fs(path: impl AsRef<Path>, gc_interval: std::time::Duration) -> Result<Self> {
        let (armed, recent) = Self::gc_state();
        let path = path.as_ref();
        let mut options = iroh_blobs::store::fs::options::Options::new(path);
        options.gc = Some(Self::gc_config(gc_interval, armed.clone(), recent.clone()));
        let store = FsStore::load_with_opts(path.join("blobs.db"), options)
            .await
            .context("opening blob store")?;
        Ok(Self {
            backend: Backend::Fs(store),
            max_blob_bytes: DEFAULT_MAX_BLOB_BYTES,
            unplugged: crate::net::p2p::Unplugged::default(),
            armed,
            recent,
        })
    }

    fn gc_state() -> (ArmedGc, RecentRing) {
        (Default::default(), Default::default())
    }

    /// Arm the reaper: from now on, GC runs mark from `source` (plus the recent ring) and
    /// sweep the rest. Idempotent; the first arm wins.
    pub fn arm_gc(&self, source: LiveSource) {
        let _ = self.armed.set((source, self.store().clone()));
    }

    /// Note a blob as recently touched, so the reaper cannot win the race against the row
    /// that is about to reference it.
    fn note_recent(&self, hash: Hash) {
        self.note_recent_inner(hash, None);
    }

    /// Note a fresh PUT: the hash rides the ring WITH its temp tag, so the mark phase sees
    /// a live root even when the put landed inside the reaper's snapshot-to-clear window.
    fn note_recent_tagged(&self, tag: iroh_blobs::api::TempTag) {
        self.note_recent_inner(*tag.as_ref(), Some(tag));
    }

    fn note_recent_inner(&self, hash: Hash, tag: Option<iroh_blobs::api::TempTag>) {
        let mut ring = self.recent.lock().expect("recent ring poisoned");
        let cutoff = std::time::Instant::now() - recent_grace();
        ring.retain(|(_, at, _)| *at > cutoff);
        ring.push((hash, std::time::Instant::now(), tag));
    }

    /// The GC hook, shared by both backends: iroh-blobs runs the sweep on its own interval and
    /// asks this callback what must live. Unarmed, or a source error, ABORTS the run - the
    /// documented use of that outcome, because a reaper that cannot see every reference must
    /// not reap. Tags are dropped for anything outside the live set: a tag here is
    /// `add_bytes` bookkeeping, never a reference - the ledgers are the references - and
    /// iroh's mark phase treats tags as roots, so a dead blob's tag would keep it immortal.
    fn gc_config(
        interval: std::time::Duration,
        armed: ArmedGc,
        recent: RecentRing,
    ) -> iroh_blobs::store::GcConfig {
        use iroh_blobs::store::ProtectOutcome;
        iroh_blobs::store::GcConfig {
            interval,
            // The callback's future must be Sync (iroh's ProtectCb) and the store's own
            // sub-futures are not - so the real work runs in a spawned task and the callback
            // awaits its JoinHandle, which is.
            add_protected: Some(std::sync::Arc::new(move |live| {
                let armed = armed.clone();
                let recent = recent.clone();
                let work = tokio::spawn(async move {
                    let Some((source, store)) = armed.get() else {
                        return None; // unarmed reaps nothing
                    };
                    let mut keep = match source().await {
                        Ok(set) => set,
                        Err(e) => {
                            tracing::warn!(error = ?e, "blob reaper could not see every reference - run skipped");
                            return None;
                        }
                    };
                    {
                        // Prune, not just filter: dropping an expired entry is what
                        // releases its temp tag, and the GC round is the one place this
                        // runs even when no new put ever comes.
                        let cutoff = std::time::Instant::now() - recent_grace();
                        let mut ring = recent.lock().expect("recent ring poisoned");
                        ring.retain(|(_, at, _)| *at > cutoff);
                        keep.extend(ring.iter().map(|(h, _, _)| *h));
                    }
                    // Tag hygiene: a tag here is `add_bytes` bookkeeping, never a reference -
                    // the ledgers are the references - and iroh's mark phase treats tags as
                    // roots, so a dead blob's tag would keep it immortal. Dropped only for
                    // hashes outside the keep set; the recent ring guards a fresh put's gap.
                    let tags = match store.tags().list().await {
                        Ok(stream) => {
                            match stream
                                .collect::<Vec<_>>()
                                .await
                                .into_iter()
                                .collect::<Result<Vec<_>, _>>()
                            {
                                Ok(tags) => tags,
                                Err(e) => {
                                    tracing::warn!(error = ?e, "blob reaper could not read a tag - run skipped");
                                    return None;
                                }
                            }
                        }
                        Err(e) => {
                            tracing::warn!(error = ?e, "blob reaper could not list tags - run skipped");
                            return None;
                        }
                    };
                    for tag in tags {
                        if !keep.contains(&tag.hash) {
                            if let Err(e) = store.tags().delete(&tag.name).await {
                                tracing::debug!(error = ?e, "could not drop a dead blob's tag");
                            }
                        }
                    }
                    Some(keep)
                });
                Box::pin(async move {
                    match work.await {
                        Ok(Some(keep)) => {
                            live.extend(keep);
                            ProtectOutcome::Continue
                        }
                        _ => ProtectOutcome::Abort,
                    }
                })
            })),
        }
    }

    /// Set the per-blob ciphertext ceiling (a real node derives it from `max_document_bytes`).
    pub fn with_max_blob_bytes(mut self, max: u64) -> Self {
        self.max_blob_bytes = max;
        self
    }

    /// Share the node's transport gate, so blob dials obey `/test/unplug` like every other dial.
    pub fn with_unplugged(mut self, unplugged: crate::net::p2p::Unplugged) -> Self {
        self.unplugged = unplugged;
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
        let tag = self
            .store()
            .add_bytes(blob)
            .temp_tag()
            .await
            .context("storing blob")?;
        let hash = *tag.as_ref();
        self.note_recent_tagged(tag);
        Ok(hash)
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
            .temp_tag()
            .await
            .context("storing public blob")?;
        let hash = *tag.as_ref();
        self.note_recent_tagged(tag);
        Ok(hash)
    }

    /// What hash a public body WILL have, without storing it - the same content address
    /// `put_public` produces, for asking "would this be a change?" before making one.
    pub fn public_hash(bytes: &[u8]) -> Hash {
        Hash::new(bytes)
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

    /// How big is this blob, if we hold it whole? Metadata only - never reads the bytes.
    ///
    /// Used by the publish-time media budget (`record::bake`), which has to total up what a post
    /// is about to ask every node that carries it to store. Reading each blob to measure it
    /// would mean pulling megabytes through memory to learn a number the store already knows.
    pub async fn size_of(&self, hash: Hash) -> Option<u64> {
        match self.store().blobs().status(hash).await {
            Ok(iroh_blobs::api::blobs::BlobStatus::Complete { size }) => Some(size),
            _ => None,
        }
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
        let conn = crate::net::p2p::dial(&self.unplugged, endpoint, provider, BLOB_ALPN)
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
                GetProgressItem::Done(_) => {
                    self.note_recent(hash);
                    return Ok(());
                }
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
        let conn = match crate::net::p2p::dial(&self.unplugged, endpoint, provider, BLOB_ALPN).await
        {
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
    // (the reaper test below shrinks the recent-put grace so a reap is watchable; harmless to
    // every other test because the reaper only acts on ARMED stores, and only that test arms)


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
            refreshing: Default::default(),
            activity: Default::default(),
            sweep_marks: Default::default(),
            unplugged: Default::default(),
            admission: crate::net::admission::Admission::new(Default::default()),
            behind: Default::default(),
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

    /// A put's protection must OUTLIVE the put call. The reaper's protect snapshot (the
    /// live-set walk plus the recent ring) is taken BEFORE iroh clears write-time
    /// protection, so a blob put between the snapshot and the clear falls through every
    /// net - not in the walk (its referencing row is younger than the walk), not in the
    /// ring (read at snapshot time), write-protection wiped by the clear - EXCEPT a live
    /// TempTag, which the mark phase reads AFTER the clear. Caught 2026-08-25 on CI:
    /// journalfill's rapid publishes met the rig's 2-second GC cadence and a 75ms-old
    /// body died between its create and its publish ("blob not readable locally: encode
    /// error"). The ring holds each put's TempTag for the grace window - exactly the
    /// "referencing row is about to land" gap the ring has always stood for.
    #[tokio::test]
    async fn a_fresh_puts_temp_tag_outlives_the_put() {
        let store = FileStore::memory();
        let hash = store.put_public(b"fresh words, row still landing").await.unwrap();
        let mut tts = store.store().tags().list_temp_tags().await.unwrap();
        let mut held = false;
        while let Some(tt) = tts.next().await {
            if tt.hash == hash {
                held = true;
            }
        }
        assert!(
            held,
            "the put's temp tag lives on past its return - the reaper's one blind spot"
        );
    }

    /// The blob reaper end to end, in memory: two blobs, one referenced, one not - the armed
    /// mark keeps the first, the sweep collects the second, and nothing happens at all until
    /// the store is armed (the unarmed abort is the safety the whole design leans on).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_reaper_collects_what_nothing_references() {
        std::env::set_var("RINGTOME_TEST_REAP_GRACE_MS", "50");
        let store = FileStore::memory();
        let keep = store.put_public(b"keep me").await.unwrap();
        let dead = store.put_public(b"reap me").await.unwrap();

        // Unarmed: several GC intervals pass and both stand. A reaper that cannot see the
        // ledgers must not reap.
        tokio::time::sleep(std::time::Duration::from_millis(700)).await;
        assert!(store.has(keep).await && store.has(dead).await, "unarmed reaps nothing");

        let live: std::collections::HashSet<Hash> = [keep].into_iter().collect();
        store.arm_gc(std::sync::Arc::new(move || {
            let live = live.clone();
            Box::pin(async move { Ok(live) })
        }));

        // Armed: the dead blob goes within a few rounds; the referenced one never does.
        let mut reaped = false;
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            if !store.has(dead).await {
                reaped = true;
                break;
            }
        }
        assert!(reaped, "the unreferenced blob was collected");
        assert!(store.has(keep).await, "the referenced blob stands");
    }
}
