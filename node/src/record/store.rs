//! The store layer: the application's entire data API, and the data map that documents it.
//!
//! Application code (routes today, feature modules tomorrow) reads and writes identity data
//! through typed handles - never through `imaol`/`private` directly. Each handle exposes
//! exactly the operations its merge rule supports, so "which writes are legal here" is answered
//! by the type, not by remembering the chain semantics.
//!
//! ## The data map
//!
//! | store                       | chain (service) | CRDT               | who receives it     | materialized       | sync      |
//! |-----------------------------|-----------------|--------------------|---------------------|--------------------|-----------|
//! | `profile()`                 | profile-public (2) | LWW register       | everyone (public)   | `profile_view`     | full      |
//! | `private_registers(c)`      | general-private (5)| LWW register       | your own nodes only | in-memory, on read | full      |
//! | `private_set(c)`            | general-private (5)| LWW-element-set    | your own nodes only | in-memory, on read | full      |
//! | `posts()`                   | posts (3)       | append-only log    | everyone (public)   | none (log is view) | suffix*   |
//! | `documents()`               | documents-private (6)| version DAG        | your own nodes only | in-memory, on read | full      |
//!
//! (*) Declared, not yet implemented: append-only chains are the suffix-sync candidates
//! (PROJECT_PLAN, Shallow Sync), and `page()` already tolerates incomplete history, but the
//! sync engine currently transfers full chains. The gate work lands with Posts (REFACTOR.md).
//!
//! **When may a row claim `suffix`? Two questions, both must pass.** (1) Can this chain's
//! history change trust judgments? Only the identity chains can, and they are exempt from
//! shallowness at the protocol level, forever. (2) Is the materialized view a *fold over all
//! of history* (registers, sets - a suffix silently loses old keys and elements) or a *recent
//! window* (logs - the held range is the answer)? Folds need completeness until a signed
//! snapshot supersedes their prefix (PROJECT_PLAN, Open Items: Snapshots), which is how
//! fold-based stores earn `suffix` later.
//!
//! The identity chains are deliberately **not** stores: authority is not application data, and
//! the key tree keeps its own API (`imaol::load_key_tree`, `identity::revoke_key`).
//!
//! ## The sync contract (all stores, stated once)
//!
//! Writes land immediately on **this node's** chain, signed - a write never blocks on the
//! network. Reads are the merged view of **all** the identity's chains. Replication is
//! per-identity, all chains at once, on every sync exchange; the only distinction is
//! visibility - public chains go to anyone interested, private chains only to member-proven
//! peers. There are no per-store sync knobs.

// Built ahead of its consumers per STYLE.md's plan-in-hand clause: `read_public`/`PublicView`
// and the posts `AppendLog` are Tier 4S's surface (serving strangers, the post feed). This
// allow comes off when the first 4S route lands.
#![allow(dead_code)]

use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Payload, PrivateKind, PrivatePlain, SignedEntry, SigningKey};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppError;
use crate::record::private::EpochKeys;
use crate::record::{imaol, private};
use crate::AppState;

/// Profile fields settable in v0. A closed set: the profile is a schema, not a junk drawer.
pub const PROFILE_FIELDS: &[&str] = &["name", "bio"];

/// Write credentials for one identity on this node: the leaf signing key and the private-chain
/// epoch keys it can open.
struct Authorship {
    signer: SigningKey,
    epoch_keys: EpochKeys,
}

/// An identity's data, opened read-write by its owner. Handles hang off this.
pub struct Store {
    db: SqlitePool,
    authorship: Authorship,
    /// The node's file layer (document bodies live there, headers on the chain).
    files: std::sync::Arc<crate::files::FileStore>,
}

/// The public slice of an identity's data, opened without credentials - for serving readers who
/// aren't the owner (4S). Only public, read-only handles exist on it; the type is the gate.
pub struct PublicView {
    db: SqlitePool,
}

/// Open an identity's data for a logged-in owner: ownership check, signing key, epoch keys, and
/// the per-identity database, assembled once.
pub async fn open(state: &AppState, account_id: &Uuid, root_hex: &str) -> Result<Store, AppError> {
    let signer =
        crate::identity::load_signing_key(&state.node_db, &state.keystore, account_id, root_hex)
            .await?;
    let leaf = signer.verifying_key().to_bytes();
    let enc = private::load_enc_keypair(&state.keystore, &hex::encode(leaf))
        .map_err(AppError::Internal)?;
    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .map_err(AppError::Internal)?;
    let epoch_keys = private::unseal_epoch_keys(&db, &leaf, &enc).await?;
    Ok(Store {
        db,
        authorship: Authorship { signer, epoch_keys },
        files: state.files.clone(),
    })
}

/// Open the public slice of an identity this node holds (its own, or one it fronts). Uniform
/// 404 when the node doesn't agent it.
pub async fn read_public(state: &AppState, root_hex: &str) -> Result<PublicView, AppError> {
    if !crate::identity::is_agented(&state.node_db, root_hex).await? {
        return Err(AppError::NotFound("identity not found".into()));
    }
    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .map_err(AppError::Internal)?;
    Ok(PublicView { db })
}

impl Store {
    pub fn profile(&self) -> Profile<'_> {
        Profile { store: self }
    }

    /// A named private LWW-register collection ("contacts", "config", ...). Collections are
    /// created by writing to them; Tier 5's vouch/contact features will claim named ones.
    pub fn private_registers<'s>(&'s self, collection: &'s str) -> PrivateRegisters<'s> {
        PrivateRegisters {
            store: self,
            collection,
        }
    }

    /// A named private LWW-element-set collection ("follows", ...).
    pub fn private_set<'s>(&'s self, collection: &'s str) -> PrivateSet<'s> {
        PrivateSet {
            store: self,
            collection,
        }
    }

    pub fn posts(&self) -> AppendLog<'_> {
        AppendLog { db: &self.db }
    }

    /// Versioned documents (the notes app): headers on the documents-private chain, bodies in the file
    /// layer, divergence detected and kept - never LWW'd away.
    pub fn documents(&self) -> Documents<'_> {
        Documents { store: self }
    }
}

impl PublicView {
    /// The materialized public profile.
    pub async fn profile(&self) -> Result<Vec<imaol::ProfileField>, AppError> {
        imaol::get_profile(&self.db).await
    }

    /// The public post log, newest first.
    pub fn posts(&self) -> AppendLog<'_> {
        AppendLog { db: &self.db }
    }
}

// ---------------------------------------------------------------------------------------------
// LWW register, public: the profile.

pub struct Profile<'s> {
    store: &'s Store,
}

impl Profile<'_> {
    /// Set one profile field (LWW). Fields are a closed schema: unknown names are rejected.
    pub async fn set(&self, field: &str, value: &str) -> Result<SignedEntry, AppError> {
        if !PROFILE_FIELDS.contains(&field) {
            return Err(AppError::BadRequest(format!(
                "unknown profile field {:?} (allowed: {})",
                field,
                PROFILE_FIELDS.join(", ")
            )));
        }
        imaol::set_profile_field(&self.store.db, &self.store.authorship.signer, field, value).await
    }

    /// The materialized profile, merged across all the identity's nodes.
    pub async fn all(&self) -> Result<Vec<imaol::ProfileField>, AppError> {
        imaol::get_profile(&self.store.db).await
    }
}

// ---------------------------------------------------------------------------------------------
// LWW register + LWW-element-set, private: encrypted collections.

pub struct PrivateRegisters<'s> {
    store: &'s Store,
    collection: &'s str,
}

impl PrivateRegisters<'_> {
    /// Set one register (LWW per key).
    pub async fn set(&self, key: &str, value: &str) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(PrivatePlain {
                kind: PrivateKind::Register,
                collection: self.collection.to_string(),
                key: key.to_string(),
                value: Some(value.to_string()),
            })
            .await
    }

    /// Every register in the collection, merged, plus the count of records this node holds but
    /// cannot decrypt (history from outside this key's membership era - worth showing a user).
    pub async fn all(&self) -> Result<(Vec<private::RegisterValue>, u64), AppError> {
        let view = self.store.private_view().await?;
        Ok((view.registers_in(self.collection), view.undecryptable))
    }
}

pub struct PrivateSet<'s> {
    store: &'s Store,
    collection: &'s str,
}

impl PrivateSet<'_> {
    /// Add an element (LWW-element-set: an add/remove race resolves by timestamp).
    pub async fn add(&self, element: &str, value: Option<String>) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(PrivatePlain {
                kind: PrivateKind::SetAdd,
                collection: self.collection.to_string(),
                key: element.to_string(),
                value,
            })
            .await
    }

    /// Remove an element.
    pub async fn remove(&self, element: &str) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(PrivatePlain {
                kind: PrivateKind::SetRemove,
                collection: self.collection.to_string(),
                key: element.to_string(),
                value: None,
            })
            .await
    }

    /// The present elements, merged, plus the undecryptable count (see `PrivateRegisters::all`).
    pub async fn elements(&self) -> Result<(Vec<private::SetElement>, u64), AppError> {
        let view = self.store.private_view().await?;
        Ok((view.set_elements(self.collection), view.undecryptable))
    }
}

impl Store {
    async fn write_private(&self, plain: PrivatePlain) -> Result<SignedEntry, AppError> {
        private::write_record(
            &self.db,
            &self.authorship.signer,
            &self.authorship.epoch_keys,
            &plain,
        )
        .await
    }

    async fn private_view(&self) -> Result<private::PrivateView, AppError> {
        private::materialize(&self.db, &self.authorship.epoch_keys).await
    }
}

// ---------------------------------------------------------------------------------------------
// Version DAG, private: documents (the notes app). The one store whose merge rule is
// deliberately NOT last-writer-wins: concurrent saves are detected and both kept
// (never-lose-words - NOTES_APP, The sync model).

pub struct Documents<'s> {
    store: &'s Store,
}

impl Documents<'_> {
    /// Create a document: mint its id, save the genesis version. Returns (doc_id, version hash).
    pub async fn create(
        &self,
        title: &str,
        body: &[u8],
        format: crate::record::documents::Format,
    ) -> Result<([u8; 16], [u8; 32]), AppError> {
        let doc_id = crate::record::documents::new_doc_id();
        let version = self
            .save(crate::record::documents::Save {
                doc_id,
                parents: vec![],
                title: title.to_string(),
                body: body.to_vec(),
                format,
                media: None,
            })
            .await?;
        Ok((doc_id, version))
    }

    /// Save one version (the client asserts its parents). Returns the new version's hash.
    pub async fn save(&self, save: crate::record::documents::Save) -> Result<[u8; 32], AppError> {
        crate::record::documents::save_version(
            &self.store.db,
            &self.store.authorship.signer,
            &self.store.authorship.epoch_keys,
            &self.store.files,
            save,
        )
        .await
    }

    /// The materialized view: every document, its version DAG, heads, and divergence state.
    pub async fn all(&self) -> Result<crate::record::documents::DocumentsView, AppError> {
        crate::record::documents::materialize(&self.store.db, &self.store.authorship.epoch_keys).await
    }

    /// Read and decrypt one version's body. `Ok(None)` when we hold no key for its era or the
    /// body hasn't been fetched to this node yet.
    pub async fn body(&self, version: &crate::record::documents::Version) -> Result<Option<Vec<u8>>, AppError> {
        crate::record::documents::read_body(
            &self.store.files,
            &self.store.authorship.epoch_keys,
            version,
        )
        .await
    }

    /// Read and decrypt an arbitrary referenced blob by hash (e.g. a version's thumbnail).
    /// `Ok(None)` when we hold no key for its era or it hasn't been fetched to this node yet.
    pub async fn blob(&self, hash: [u8; 32]) -> Result<Option<Vec<u8>>, AppError> {
        self.store
            .files
            .get_decrypted(
                iroh_blobs::Hash::from_bytes(hash),
                &self.store.authorship.epoch_keys,
            )
            .await
            .map_err(AppError::Internal)
    }

    /// The document's synthesized current text: one head's body verbatim, a clean three-way
    /// merge, or the conflict presented inline (NOTES_APP, The sync model).
    pub async fn resolved(
        &self,
        doc: &crate::record::documents::Doc,
    ) -> Result<crate::record::documents::ResolvedDoc, AppError> {
        crate::record::documents::resolve(&self.store.files, &self.store.authorship.epoch_keys, doc).await
    }
}

// ---------------------------------------------------------------------------------------------
// Append-only log, public: posts. Additive content has no conflicts, so the only write is
// `append` and there is deliberately no update or delete here (deletion is a future tombstone
// type - PROJECT_PLAN, Open Items - not a log operation).

/// One page cursor: the `(timestamp_ms, seq, entry_hash)` of the last item seen - the same
/// total order the LWW views use, so paging is stable within a device's same-millisecond
/// bursts (seq) and across devices (hash).
pub type PageCursor = (i64, u64, [u8; 32]);

#[derive(Debug, serde::Serialize)]
pub struct LogItem {
    pub author_hex: String,
    pub seq: u64,
    /// Claimed by the author; ADVISORY (display interleaving only).
    pub timestamp_ms: i64,
    /// When this replica first stored it - the local upper bound on authorship time.
    pub received_at_ms: i64,
    pub hash_hex: String,
    /// The payload bytes, codec-opaque at this layer: the post format belongs to 4M's markup
    /// track; the store fixes only the chain, the type id, and the merge semantics.
    pub payload_hex: String,
}

pub struct AppendLog<'s> {
    db: &'s SqlitePool,
}

impl AppendLog<'_> {
    /// Append one post. The caller brings encoded payload bytes (the codec is the feature's);
    /// the store signs it onto this node's posts chain.
    pub async fn append(
        &self,
        signer: &SigningKey,
        payload_bytes: Vec<u8>,
    ) -> Result<SignedEntry, AppError> {
        imaol::append(
            self.db,
            signer,
            service::POSTS,
            entry_type::POST,
            Payload::Inline(payload_bytes),
        )
        .await
    }

    /// One page, newest first, interleaved across the identity's devices by claimed timestamp
    /// (hash-tiebroken). Written for incomplete history from day one: a replica holding only a
    /// suffix of a chain pages whatever it holds - no operation here assumes seq 0 is present.
    pub async fn page(
        &self,
        limit: u32,
        before: Option<PageCursor>,
    ) -> Result<Vec<LogItem>, AppError> {
        let entries = imaol::entries_page(self.db, service::POSTS, limit, before).await?;
        entries
            .into_iter()
            .map(|(signed, received_at_ms)| {
                let payload = match &signed.entry().payload {
                    Payload::Inline(bytes) => hex::encode(bytes),
                    Payload::Blob(hash) => hex::encode(hash),
                };
                Ok(LogItem {
                    author_hex: hex::encode(signed.entry().chain.author),
                    seq: signed.entry().seq,
                    timestamp_ms: signed.entry().timestamp_ms,
                    received_at_ms,
                    hash_hex: hex::encode(signed.hash()),
                    payload_hex: payload,
                })
            })
            .collect()
    }
}

// The append signature takes the signer explicitly rather than reading Store.authorship because
// PublicView also hands out AppendLog (read-only use: no signer to give). Revisit if it chafes.
impl Store {
    /// Append to this identity's posts chain with the store's own authorship.
    pub async fn append_post(&self, payload_bytes: Vec<u8>) -> Result<SignedEntry, AppError> {
        self.posts()
            .append(&self.authorship.signer, payload_bytes)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::EncKeyPair;

    /// Build a Store directly against an in-memory db - no AppState, no HTTP. The unit tests
    /// exercise handle semantics; the integration suite exercises the full plumbing via routes.
    async fn test_store() -> Store {
        let db = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::user_migrator_for_test(&db).await;

        let signer = SigningKey::from_bytes(&[11u8; 32]);
        let leaf = signer.verifying_key().to_bytes();
        let enc = EncKeyPair::generate();
        private::mint_epoch(
            &db,
            &signer,
            0,
            &private::fresh_epoch_key(),
            &[(leaf, enc.public)],
        )
        .await
        .unwrap();
        let epoch_keys = private::unseal_epoch_keys(&db, &leaf, &enc).await.unwrap();

        Store {
            db,
            authorship: Authorship { signer, epoch_keys },
            files: std::sync::Arc::new(crate::files::FileStore::memory()),
        }
    }

    #[tokio::test]
    async fn profile_is_a_schema_not_a_junk_drawer() {
        let store = test_store().await;
        store.profile().set("name", "Hats Ahoy").await.unwrap();
        assert!(store
            .profile()
            .set("favorite_crime", "arson")
            .await
            .is_err());

        let profile = store.profile().all().await.unwrap();
        assert_eq!(profile.len(), 1);
        assert_eq!(profile[0].value, "Hats Ahoy");
    }

    #[tokio::test]
    async fn private_collections_round_trip_through_the_handles() {
        let store = test_store().await;

        store
            .private_registers("contacts")
            .set("dave", "Dave")
            .await
            .unwrap();
        store
            .private_set("follows")
            .add("aabb", None)
            .await
            .unwrap();
        store
            .private_set("follows")
            .add("ccdd", None)
            .await
            .unwrap();
        store.private_set("follows").remove("aabb").await.unwrap();

        let (registers, undecryptable) = store.private_registers("contacts").all().await.unwrap();
        assert_eq!(registers.len(), 1);
        assert_eq!(registers[0].value, "Dave");
        assert_eq!(undecryptable, 0);

        let (elements, _) = store.private_set("follows").elements().await.unwrap();
        assert_eq!(elements.len(), 1);
        assert_eq!(elements[0].element, "ccdd");
    }

    #[tokio::test]
    async fn the_post_log_appends_and_pages_newest_first() {
        let store = test_store().await;
        for n in 0..5u8 {
            store.append_post(vec![0xa0, n]).await.unwrap();
        }

        let first_page = store.posts().page(3, None).await.unwrap();
        assert_eq!(first_page.len(), 3);
        let cursor = (
            first_page[2].timestamp_ms,
            first_page[2].seq,
            crate::pubkey::decode(&first_page[2].hash_hex).unwrap(),
        );
        let second_page = store.posts().page(3, Some(cursor)).await.unwrap();
        assert_eq!(
            second_page.len(),
            2,
            "pagination drains the log exactly once"
        );

        let all: Vec<u64> = store
            .posts()
            .page(10, None)
            .await
            .unwrap()
            .iter()
            .map(|item| item.seq)
            .collect();
        assert_eq!(all, vec![4, 3, 2, 1, 0], "newest first");
    }

    #[tokio::test]
    async fn append_is_the_only_write_the_log_offers() {
        // Not a runtime test - a documentation assertion: AppendLog's public surface is
        // append + page. If an update/delete method ever appears, this comment is where the
        // argument about tombstones (PROJECT_PLAN, Open Items) is required to happen first.
        let store = test_store().await;
        let entry = store.append_post(vec![0xa0]).await.unwrap();
        assert_eq!(entry.entry().seq, 0);
    }
}
