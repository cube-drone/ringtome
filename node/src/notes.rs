//! Versioned documents (PROJECT_PLAN, Versioned Documents) - the notes app's storage.
//!
//! A document is a stable `doc_id` whose versions form a DAG. Each save appends one encrypted
//! `doc-header` entry to the `notes` chain (the version's identity is the entry's own hash;
//! `parents` are the entry hashes it was edited from) and writes the body as an encrypted file
//! in the file layer. The materializer folds headers into per-document DAGs and *detects*
//! divergence - two versions sharing a parent - rather than resolving it: keep-both is the
//! universal never-lose answer, and merge is a later, per-format capability (NOTES_APP, The sync
//! model). Deliberately NOT a naive LWW fold: LWW-by-doc-id is the stale-tab failure that
//! silently destroys an afternoon of writing.

use std::collections::{BTreeMap, HashSet};

use anyhow::anyhow;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{DocHeaderPlain, Payload, PrivateRecord, SigningKey};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::files::FileStore;
use crate::private::{decrypt_doc_header, encrypt_doc_header, EpochKeys};

/// One decrypted version of a document, as materialized.
#[derive(Debug, Clone)]
pub struct Version {
    /// The version's identity: its entry hash.
    pub hash: [u8; 32],
    pub header: DocHeaderPlain,
    /// The entry's claimed timestamp - display ordering only, never load-bearing (No Clocks).
    pub timestamp_ms: i64,
}

/// One document: every decryptable version, threaded into a DAG.
#[derive(Debug, Default, Clone)]
pub struct Doc {
    pub versions: BTreeMap<[u8; 32], Version>,
    /// Versions no other version names as a parent. One head = clean; several = divergence,
    /// every head kept and surfaced.
    pub heads: Vec<[u8; 32]>,
}

impl Doc {
    pub fn diverged(&self) -> bool {
        self.heads.len() > 1
    }

    /// The head to show by default: latest claimed timestamp, entry hash as the deterministic
    /// tiebreak - cosmetic choice only, every head stays a tap away.
    pub fn display_head(&self) -> Option<&Version> {
        self.heads
            .iter()
            .filter_map(|h| self.versions.get(h))
            .max_by_key(|v| (v.timestamp_ms, v.hash))
    }
}

/// The materialized notes view: every document this identity's chains hold, keyed by doc_id.
#[derive(Debug, Default)]
pub struct NotesView {
    pub docs: BTreeMap<[u8; 16], Doc>,
    /// Headers we hold but cannot decrypt (wrong era for this device) - surfaced, not hidden.
    pub undecryptable: usize,
}

/// One save, as the client asserts it: which document, edited from which version(s), the new
/// title and body. `parents` is empty at a document's genesis, the current head for an ordinary
/// save - the CLIENT asserts what it edited from; the materializer only ever detects the
/// consequences.
pub struct Save {
    pub doc_id: [u8; 16],
    pub parents: Vec<[u8; 32]>,
    pub title: String,
    pub body: Vec<u8>,
}

/// Save one version of a document: body into the file layer, header onto the notes chain.
/// Returns the new version's hash (the client's next `parents` entry).
pub async fn save_version(
    db: &SqlitePool,
    signer: &SigningKey,
    keys: &EpochKeys,
    files: &FileStore,
    save: Save,
) -> Result<[u8; 32], AppError> {
    let (epoch, epoch_key) = keys
        .current()
        .ok_or_else(|| AppError::Internal(anyhow!("no epoch key to write under")))?;
    let file_hash = files.put_encrypted(epoch, &epoch_key, &save.body).await?;
    let header = DocHeaderPlain {
        doc_id: save.doc_id,
        parents: save.parents,
        file_hash: *file_hash.as_bytes(),
        title: save.title,
        format: None,
    };
    let record = encrypt_doc_header(epoch, &epoch_key, &header)?;
    let payload = record
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding doc header record: {e}")))?;
    let signed = crate::imaol::append(
        db,
        signer,
        service::NOTES,
        entry_type::DOC_HEADER,
        Payload::Inline(payload),
    )
    .await?;
    Ok(*signed.hash())
}

/// Mint a fresh document id. 16 random bytes; identity is the id, collision is negligible.
pub fn new_doc_id() -> [u8; 16] {
    use rand::RngCore;
    let mut id = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut id);
    id
}

/// Fold every stored doc-header we can decrypt into per-document DAGs. Recomputed per read,
/// same disposable-view discipline as the private store.
pub async fn materialize(db: &SqlitePool, keys: &EpochKeys) -> Result<NotesView, AppError> {
    let entries =
        crate::imaol::entries_of_type(db, service::NOTES, entry_type::DOC_HEADER).await?;

    let mut view = NotesView::default();
    for signed in entries {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(record) = PrivateRecord::decode(payload) else {
            tracing::warn!("skipping undecodable doc-header payload");
            continue;
        };
        match decrypt_doc_header(&record, keys) {
            Some(header) => {
                let doc = view.docs.entry(header.doc_id).or_default();
                doc.versions.insert(
                    *signed.hash(),
                    Version {
                        hash: *signed.hash(),
                        header,
                        timestamp_ms: signed.entry().timestamp_ms,
                    },
                );
            }
            None => view.undecryptable += 1,
        }
    }

    // Heads: versions no other version of the same doc names as a parent. A parent hash we
    // don't hold (retention dropped it, or it hasn't synced yet) still counts as claimed - the
    // child is a head either way.
    for doc in view.docs.values_mut() {
        let claimed: HashSet<[u8; 32]> = doc
            .versions
            .values()
            .flat_map(|v| v.header.parents.iter().copied())
            .collect();
        doc.heads = doc
            .versions
            .keys()
            .filter(|h| !claimed.contains(*h))
            .copied()
            .collect();
    }
    Ok(view)
}

/// After a sync: fetch, from the peer we just exchanged with, every referenced body we lack.
/// Headers ride entry sync; bodies ride iroh-blobs - this is the pass that joins them. Runs on
/// the initiator's side only (the responder catches up on its own next initiated sync).
/// Best-effort by design: a body that doesn't land now is fetchable on any later sync, so
/// nothing here may fail the exchange.
pub async fn fetch_missing_bodies(
    state: &crate::AppState,
    root_hex: &str,
    addr: iroh::EndpointAddr,
) -> u64 {
    let result: anyhow::Result<u64> = async {
        // The node's own leaf for this identity - the session-free path sync itself uses.
        let Some(leaf) =
            crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, root_hex).await?
        else {
            return Ok(0); // not an identity we agent: nothing to decrypt, nothing to fetch
        };
        let leaf_pub = leaf.verifying_key().to_bytes();
        let enc = crate::private::load_enc_keypair(&state.keystore, &hex::encode(leaf_pub))?;
        let db = state.user_dbs.get(root_hex).await?;
        let keys = crate::private::unseal_epoch_keys(&db, &leaf_pub, &enc).await?;

        let view = materialize(&db, &keys).await?;
        let mut missing: Vec<iroh_blobs::Hash> = Vec::new();
        for doc in view.docs.values() {
            for version in doc.versions.values() {
                let hash = iroh_blobs::Hash::from_bytes(version.header.file_hash);
                if !missing.contains(&hash) && !state.files.has(hash).await {
                    missing.push(hash);
                }
            }
        }
        if missing.is_empty() {
            return Ok(0);
        }
        Ok(state.files.fetch_many(&state.endpoint, addr, &missing).await as u64)
    }
    .await;

    match result {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(root = %root_hex, "body fetch after sync failed: {e:#}");
            0
        }
    }
}

/// Read and decrypt one version's body from the file layer.
pub async fn read_body(
    files: &FileStore,
    keys: &EpochKeys,
    version: &Version,
) -> Result<Option<Vec<u8>>, AppError> {
    let hash = iroh_blobs::Hash::from_bytes(version.header.file_hash);
    files
        .get_decrypted(hash, keys)
        .await
        .map_err(AppError::Internal)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::user_migrator_for_test(&pool).await;
        pool
    }

    fn signer(byte: u8) -> SigningKey {
        SigningKey::from_bytes(&[byte; 32])
    }

    async fn save(
        db: &SqlitePool,
        key: &SigningKey,
        keys: &EpochKeys,
        files: &FileStore,
        doc_id: [u8; 16],
        parents: Vec<[u8; 32]>,
        title: &str,
        body: &[u8],
    ) -> [u8; 32] {
        save_version(
            db,
            key,
            keys,
            files,
            Save {
                doc_id,
                parents,
                title: title.into(),
                body: body.into(),
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn save_materialize_read_round_trip() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "shopping", b"eggs").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.heads, vec![v1]);
        assert!(!doc.diverged());

        let head = doc.display_head().unwrap();
        assert_eq!(head.header.title, "shopping");
        let body = read_body(&files, &keys, head).await.unwrap();
        assert_eq!(body.unwrap(), b"eggs");
    }

    #[tokio::test]
    async fn fast_forward_saves_keep_one_head() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"one").await;
        let v2 = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"one two").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.heads, vec![v2]);
        assert_eq!(doc.versions.len(), 2);
        assert!(!doc.diverged());
    }

    /// NOTES_APP's acceptance scenario: a stale tab saves old text after another device moved
    /// the head. Whole-note LWW would silently destroy the newer words; the DAG keeps both.
    #[tokio::test]
    async fn stale_tab_divergence_keeps_both_versions() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "draft", b"start").await;
        // The PC afternoon: a real continuation.
        let pc = save(
            &db, &key, &keys, &files, doc_id, vec![v1], "draft", b"start, then a whole afternoon",
        )
        .await;
        // The stale phone tab: same parent, older text, NEWER wall-clock claim.
        let phone = save(&db, &key, &keys, &files, doc_id, vec![v1], "draft", b"start!").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();

        assert!(doc.diverged(), "two saves sharing a parent must be detected");
        let mut heads = doc.heads.clone();
        heads.sort();
        let mut expect = vec![pc, phone];
        expect.sort();
        assert_eq!(heads, expect, "both siblings survive as heads");

        // Never-lose: BOTH bodies remain readable, whatever the display order says.
        for h in &doc.heads {
            let v = doc.versions.get(h).unwrap();
            assert!(read_body(&files, &keys, v).await.unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn undecryptable_headers_are_counted_not_hidden() {
        let db = test_db().await;
        let key = signer(1);
        let write_keys = EpochKeys::single(3, [9u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        save(&db, &key, &write_keys, &files, doc_id, vec![], "secret", b"x").await;

        // A device that never got epoch 3 (revoked before, or adopted without the re-seal).
        let wrong_keys = EpochKeys::single(3, [1u8; 32]);
        let view = materialize(&db, &wrong_keys).await.unwrap();
        assert!(view.docs.is_empty());
        assert_eq!(view.undecryptable, 1);
    }
}
