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
//! | `devices()`                 | general-private (5)| LWW register (the `devices` collection) | your own nodes only | persisted, catch-up | full      |
//! | `posts()`                   | posts (3)       | append-only log    | everyone (public)   | none (log is view) | suffix*   |
//! | `documents()`               | documents-private (6)| version DAG        | your own nodes only | in-memory, on read | full      |
//! | `annotations()`             | doc-meta-private (7)| LWW register + LWW-element-set per doc | your own nodes only | persisted, catch-up | full      |
//! | `taxonomies()`              | doc-meta-private (7)| LWW-element-set per list, ranked values | your own nodes only | persisted, catch-up | full      |
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

use std::collections::{BTreeMap, BTreeSet};

use crate::db::Db;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Payload, PrivateKind, PrivatePlain, SignedEntry, SigningKey};
use uuid::Uuid;

use crate::error::AppError;
use crate::record::private::EpochKeys;
use crate::record::{imaol, private};
use crate::AppState;

/// The annotation field naming a note's published form (its post's doc_id, hex). Private,
/// like every annotation: the world sees the post, only you see which note it came from.
pub const PUBLISHED_AS: &str = "published_as";

/// Profile fields settable in v0. A closed set: the profile is a schema, not a junk drawer.
pub const PROFILE_FIELDS: &[&str] = &["name", "bio", "avatar"];

/// Write credentials for one identity on this node: the leaf signing key and the private-chain
/// epoch keys it can open.
struct Authorship {
    signer: SigningKey,
    epoch_keys: EpochKeys,
}

/// An identity's data, opened read-write by its owner. Handles hang off this.
pub struct Store {
    db: Db,
    /// The identity's root key - the identity's name in reference forms (`annot:<root>/...`).
    root: [u8; 32],
    authorship: Authorship,
    /// The node's file layer (document bodies live there, headers on the chain).
    files: std::sync::Arc<crate::files::FileStore>,
}

/// The public slice of an identity's data, opened without credentials - for serving readers who
/// aren't the owner (4S). Only public, read-only handles exist on it; the type is the gate.
pub struct PublicView {
    db: Db,
}

/// Open an identity's data for a logged-in owner: ownership check, signing key, epoch keys, and
/// the per-identity database, assembled once.
pub async fn open(state: &AppState, account_id: &Uuid, root_hex: &str) -> Result<Store, AppError> {
    let root = crate::pubkey::decode(root_hex)
        .ok_or_else(|| AppError::BadRequest("bad root pubkey".into()))?;
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
        root,
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

    /// Every contact the ledger knows: one row per `contact:<root>` collection, its
    /// registers folded to a key -> value map. Feeds the stream's `contacts` kind (the
    /// People app and the id page's relationship panel read the MIRROR, per The Browser Is
    /// a View); Tier 5's flow engine will read the same rows.
    pub async fn contacts(
        &self,
    ) -> Result<Vec<(String, std::collections::BTreeMap<String, String>)>, AppError> {
        let view = self.private_view().await?;
        let mut out = Vec::new();
        for collection in view.collections() {
            if let Some(root) = collection.strip_prefix("contact:") {
                let facts = view
                    .registers_in(collection)
                    .into_iter()
                    .map(|r| (r.key, r.value))
                    .collect();
                out.push((root.to_string(), facts));
            }
        }
        Ok(out)
    }

    /// A named private LWW-element-set collection ("follows", ...).
    pub fn private_set<'s>(&'s self, collection: &'s str) -> PrivateSet<'s> {
        PrivateSet {
            store: self,
            collection,
        }
    }

    /// Private labels for the identity's own keys ("macbook-curtis", not `dd7ee7d7...`) -
    /// the `devices` register collection, typed (PROJECT_PLAN, Device Names).
    pub fn devices(&self) -> Devices<'_> {
        Devices { store: self }
    }

    pub fn posts(&self) -> AppendLog<'_> {
        AppendLog { db: &self.db }
    }

    /// Versioned documents (the notes app): headers on the documents-private chain, bodies in the file
    /// layer, divergence detected and kept - never LWW'd away.
    pub fn documents(&self) -> Documents<'_> {
        Documents { store: self }
    }

    /// Private facts about documents: descriptions and other per-doc fields (LWW registers),
    /// tags (LWW set-elements), grouped per document on the doc-meta chain.
    pub fn annotations(&self) -> Annotations<'_> {
        Annotations { store: self }
    }

    /// Bucket membership: which project(s)/notebook(s) a document belongs to - the tag
    /// mechanism in its own namespace, the axis tags and search are scoped to.
    pub fn buckets(&self) -> Buckets<'_> {
        Buckets { store: self }
    }

    /// User-defined ordered structure over documents - reading lists, albums, curated
    /// sequences: per-element ranked facts on the doc-meta chain, never document bodies
    /// (PROJECT_PLAN, Taxonomies).
    pub fn taxonomies(&self) -> Taxonomies<'_> {
        Taxonomies { store: self }
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
            .write_private(
                service::GENERAL_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::Register,
                    collection: self.collection.to_string(),
                    key: key.to_string(),
                    value: Some(value.to_string()),
                },
            )
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
            .write_private(
                service::GENERAL_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: self.collection.to_string(),
                    key: element.to_string(),
                    value,
                },
            )
            .await
    }

    /// Remove an element.
    pub async fn remove(&self, element: &str) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::GENERAL_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: self.collection.to_string(),
                    key: element.to_string(),
                    value: None,
                },
            )
            .await
    }

    /// The present elements, merged, plus the undecryptable count (see `PrivateRegisters::all`).
    pub async fn elements(&self) -> Result<(Vec<private::SetElement>, u64), AppError> {
        let view = self.store.private_view().await?;
        Ok((view.set_elements(self.collection), view.undecryptable))
    }
}

// ---------------------------------------------------------------------------------------------
// Device names: private labels for the identity's own keys (PROJECT_PLAN, Device Names - the
// fourth member of the naming family: identicon, display name, contact name, device name).
// "I've adopted dd7ee7d7... but I don't trust 039def..." is a statement for the utterly
// deranged; "macbook-curtis and the spare key" is one for a person. A register collection on
// general-private: synced to all the identity's own nodes, structurally withheld from
// strangers - the greater internet never learns what you call your laptop.
//
// NAMES ARE POINTERS, NEVER AUTHORITY (Doctrine): a label must never be the argument to any
// ceremony - revocation targets pubkeys, confirmations echo the fingerprint. Any member device
// can rename any key (LWW; vandalism is recoverable from chain history, and a repudiation
// retroactively quarantines a hostile key's renames with everything else it signed).
// Disambiguation is the UI's job, derived, never stored: two visible keys sharing a name
// render with a pubkey-derived shortcode suffix - the common collision is time, not
// simultaneity ("macbook" revoked and re-adopted is two keys, both honestly "macbook").

/// The register collection device names live in. A claimed name, per the store's collection
/// convention.
pub const DEVICES_COLLECTION: &str = "devices";

pub struct Devices<'s> {
    store: &'s Store,
}

impl Devices<'_> {
    /// Cap on one label. A device name is a nickname, not a description - past this it is
    /// prose, and prose has other homes.
    pub const MAX_NAME_BYTES: usize = 120;

    /// Label a key (LWW per key; renaming is just writing again).
    pub async fn set_name(&self, leaf: &[u8; 32], name: &str) -> Result<SignedEntry, AppError> {
        if name.len() > Self::MAX_NAME_BYTES {
            return Err(AppError::BadRequest(format!(
                "device names are capped at {} bytes - this is a nickname, not a description",
                Self::MAX_NAME_BYTES
            )));
        }
        self.store
            .private_registers(DEVICES_COLLECTION)
            .set(&hex::encode(leaf), name)
            .await
    }

    /// Every named key, `pubkey hex → label`, merged across the identity's nodes. Empty labels
    /// read as unnamed (clearing a name is writing an empty one).
    pub async fn all(&self) -> Result<BTreeMap<String, String>, AppError> {
        let (registers, _) = self
            .store
            .private_registers(DEVICES_COLLECTION)
            .all()
            .await?;
        Ok(registers
            .into_iter()
            .filter(|r| !r.value.is_empty())
            .map(|r| (r.key, r.value))
            .collect())
    }
}

impl Store {
    async fn write_private(
        &self,
        service_id: u32,
        plain: PrivatePlain,
    ) -> Result<SignedEntry, AppError> {
        private::write_record(
            &self.db,
            &self.authorship.signer,
            &self.authorship.epoch_keys,
            service_id,
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

/// The tombstone roster: an LWW-element-set of deleted document ids (hex), on the doc-meta
/// chain. Deletion is a *fact that syncs*, not an erasure - the version chain stays whole
/// (Immutable Chains ≠ Immutable Content), the doc simply drops out of every list and search,
/// and a `restore` (LWW remove) brings it back with its history intact. Exactly the taxonomy
/// roster's shape: one collection, membership is the fact, convergent by construction. (Dropping
/// the content blobs is a separate erasure pass - PROJECT_PLAN, Open Items - so a delete here
/// hides the document without yet reclaiming its bytes.)
const DELETED_DOCS: &str = "deleted";

/// The pin roster: an LWW-element-set of pinned document ids (hex), on the doc-meta chain -
/// the delete tombstone's twin, opposite in effect. A pin does NOT filter any read; it rides the
/// list row as a flag (`DocSummary.pinned`) so the client sorts pinned documents to the top. Same
/// shape, same convergence, its own collection so a pin is never mistaken for a delete or a tag.
const PINNED_DOCS: &str = "pinned";

/// The tombstoned doc ids present in a doc-meta view - shared by `deleted()` (the list filter)
/// and `search_rows` (which already holds a view and reuses it rather than re-folding).
fn deleted_from_view(view: &private::PrivateView) -> BTreeSet<[u8; 16]> {
    ids_in(view, DELETED_DOCS)
}

/// The doc ids present as elements of one doc-meta roster collection (`deleted`, `pinned`).
fn ids_in(view: &private::PrivateView, collection: &str) -> BTreeSet<[u8; 16]> {
    view.set_elements(collection)
        .into_iter()
        .filter_map(|e| hex::decode(&e.element).ok()?.try_into().ok())
        .collect()
}

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

    /// Retitle without touching content: a media-safe rename (a new version reusing the display
    /// head's blobs). The rename path for processed uploads; sound for text docs too.
    pub async fn retitle(&self, doc_id: &[u8; 16], title: &str) -> Result<[u8; 32], AppError> {
        crate::record::documents::retitle(
            &self.store.db,
            &self.store.authorship.signer,
            &self.store.authorship.epoch_keys,
            *doc_id,
            title,
        )
        .await
    }

    /// The materialized view: every document, its version DAG, heads, and divergence state.
    pub async fn all(&self) -> Result<crate::record::documents::DocumentsView, AppError> {
        crate::record::documents::materialize(&self.store.db, &self.store.authorship.epoch_keys)
            .await
    }

    /// The search index, current: one token-bag row per document over title, resolved body,
    /// and annotation text (field values and tags, so a long description is exactly as
    /// findable as body prose). Stale rows refresh on this read, the same catch-up-on-read
    /// discipline as every view; the stream ships these to the mirror, where queries run local.
    pub async fn search_rows(
        &self,
    ) -> Result<Vec<crate::record::documents::SearchRow>, AppError> {
        // Annotation text per doc, own-root collections only: value text and tag names, in
        // stable order so the staleness fingerprint can't wobble.
        let view = self.store.doc_meta_view().await?;
        let mut annots: BTreeMap<[u8; 16], String> = BTreeMap::new();
        for collection in view.collections() {
            let Some((root, doc_id)) = parse_annot_collection(collection) else {
                continue;
            };
            if root != self.store.root {
                continue;
            }
            let mut text = String::new();
            for r in view.registers_in(collection) {
                if !r.value.is_empty() {
                    text.push_str(&r.value);
                    text.push('\n');
                }
            }
            for e in view.set_elements(collection) {
                text.push_str(&e.element);
                text.push('\n');
            }
            if !text.is_empty() {
                annots.insert(doc_id, text);
            }
        }
        // Deleted docs drop out of search too, read from the same view we already folded.
        let deleted: BTreeSet<String> = deleted_from_view(&view)
            .iter()
            .map(hex::encode)
            .collect();
        let rows = crate::record::documents::search_rows(
            &self.store.db,
            &self.store.authorship.epoch_keys,
            &self.store.files,
            &annots,
        )
        .await?;
        Ok(rows
            .into_iter()
            .filter(|r| !deleted.contains(&r.doc_id))
            .collect())
    }

    /// Delete a document: add its id to the tombstone roster (an LWW set-add on doc-meta). The
    /// version chain is untouched - this is a *hide that syncs*, reversible by `restore`. Every
    /// list and search read filters the roster, so the doc vanishes from all of them at once.
    /// Idempotent.
    pub async fn delete(&self, doc_id: &[u8; 16]) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: DELETED_DOCS.to_string(),
                    key: hex::encode(doc_id),
                    value: None,
                },
            )
            .await
    }

    /// Undelete a document (LWW set-remove): it reappears in every list with its history intact,
    /// since nothing on the version chain was ever removed. A delete/restore race resolves by
    /// timestamp, like every other LWW fact.
    pub async fn restore(&self, doc_id: &[u8; 16]) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: DELETED_DOCS.to_string(),
                    key: hex::encode(doc_id),
                    value: None,
                },
            )
            .await
    }

    /// The tombstone roster: every deleted document's id. The filter every list read applies.
    pub async fn deleted(&self) -> Result<BTreeSet<[u8; 16]>, AppError> {
        let view = self.store.doc_meta_view().await?;
        Ok(deleted_from_view(&view))
    }

    /// Pin a document to the top of the list (an LWW set-add on the `pinned` roster). Unlike
    /// delete, this changes no read's membership - it only sets the `pinned` flag the list row
    /// carries, so the client sorts it first. Idempotent.
    pub async fn pin(&self, doc_id: &[u8; 16]) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: PINNED_DOCS.to_string(),
                    key: hex::encode(doc_id),
                    value: None,
                },
            )
            .await
    }

    /// Unpin a document (LWW set-remove): it falls back into ordinary date order. A pin/unpin
    /// race resolves by timestamp.
    pub async fn unpin(&self, doc_id: &[u8; 16]) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: PINNED_DOCS.to_string(),
                    key: hex::encode(doc_id),
                    value: None,
                },
            )
            .await
    }

    /// The pin roster: every pinned document's id - the join input that sets `DocSummary.pinned`.
    pub async fn pinned(&self) -> Result<BTreeSet<[u8; 16]>, AppError> {
        let view = self.store.doc_meta_view().await?;
        Ok(ids_in(&view, PINNED_DOCS))
    }

    /// The docs-list read: every (non-deleted) document's memoized display row (`doc_heads`),
    /// newest head first, plus the undecryptable count - one query after catch-up, then the
    /// tombstone filter (a deleted doc still has its `doc_heads` row; it is hidden, not erased).
    pub async fn summaries(
        &self,
    ) -> Result<(Vec<crate::record::documents::DocHeadRow>, usize), AppError> {
        let (mut rows, undecryptable) =
            crate::record::documents::list_heads(&self.store.db, &self.store.authorship.epoch_keys)
                .await?;
        let deleted = self.deleted().await?;
        rows.retain(|r| !deleted.contains(&r.doc_id));
        Ok((rows, undecryptable))
    }

    /// Memoized display rows for a specific set of documents (the docs-by-tag read). Doc ids
    /// with no local row (annotated but never held) are simply absent, as are deleted ones;
    /// ordering is the caller's.
    pub async fn summaries_for(
        &self,
        doc_ids: &[[u8; 16]],
    ) -> Result<Vec<crate::record::documents::DocHeadRow>, AppError> {
        let rows = crate::record::documents::heads_for(
            &self.store.db,
            &self.store.authorship.epoch_keys,
            doc_ids,
        )
        .await?;
        let deleted = self.deleted().await?;
        Ok(rows
            .into_iter()
            .filter(|r| !deleted.contains(&r.doc_id))
            .collect())
    }

    /// Read and decrypt one version's body. `Ok(None)` when we hold no key for its era or the
    /// body hasn't been fetched to this node yet.
    pub async fn body(
        &self,
        version: &crate::record::documents::Version,
    ) -> Result<Option<Vec<u8>>, AppError> {
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

    /// **Publish** a private note to the public lane - the membrane crossing itself
    /// (NOTES_APP, Publication: the moment a note becomes a post).
    ///
    /// Copy, don't flip: this reads the note's synthesized text and MINTS a new artifact on
    /// the public lane. There is no bit that could be toggled, so accidental publication by
    /// misconfiguration stays unrepresentable, and the note's editing history - revisions,
    /// abandoned paragraphs, its age - never crosses, as a consequence rather than a policy.
    /// The post is born with a public history of one.
    ///
    /// A DIVERGED note is refused rather than published: its synthesized text would carry
    /// conflict scaffolding, and shipping that to the world is nobody's intent. Settle it
    /// first - which is an ordinary save.
    ///
    /// Re-publishing is another explicit act (canon), and lands as a further VERSION of the
    /// same post: the private note remembers which post is its own through the `published_as`
    /// annotation, so a second publish parents onto that post's head rather than minting a
    /// stranger. That link lives in the annotation layer rather than the note's header
    /// (amending canon's original sketch, 2026-08-03): recording a publication must not mint
    /// a new VERSION of the note - it would read as an edit in the history, and two computers
    /// publishing at once would fork the note over bookkeeping.
    pub async fn publish(&self, doc_id: &[u8; 16]) -> Result<[u8; 16], AppError> {
        let view = self.all().await?;
        let doc = view
            .docs
            .get(doc_id)
            .ok_or_else(|| AppError::NotFound("no such document".into()))?;
        if doc.diverged() {
            return Err(AppError::BadRequest(
                "this note is diverged - settle it (an ordinary save) before publishing, or                  the post would carry the conflict"
                    .into(),
            ));
        }
        let resolved = self.resolved(doc).await?;
        let body = resolved.body.ok_or_else(|| {
            AppError::BadRequest("this note's words haven't arrived on this computer yet".into())
        })?;
        let format = doc
            .display_head()
            .map(|h| crate::record::documents::Format::from_wire(h.header.format))
            .unwrap_or(crate::record::documents::Format::Plaintext);
        if !matches!(
            format,
            crate::record::documents::Format::Plaintext | crate::record::documents::Format::Marquee
        ) {
            return Err(AppError::BadRequest(
                "media publishes by its own door, not this one".into(),
            ));
        }

        // Already published? Then this is a new version of that post, not a new post.
        let existing = self
            .store
            .annotations()
            .field(doc_id, PUBLISHED_AS)
            .await?
            .and_then(|v| hex::decode(v).ok())
            .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok());
        // Re-publishing the same words says nothing new, so it writes nothing: the
        // no-op bounce `retitle` already uses, one lane over. Without it, tapping Post
        // twice grows the public chain with a version identical to the one before it.
        let head = match existing {
            Some(post) => crate::record::documents::public_head(&self.store.db, &post).await?,
            None => None,
        };
        if let Some(head) = &head {
            let same_words =
                head.file_hash == *crate::files::FileStore::public_hash(body.as_bytes()).as_bytes();
            if same_words && head.title == resolved.title {
                return Ok(existing.expect("a head implies a post"));
            }
        }
        let onto = existing.map(|post| {
            (
                post,
                head.as_ref().map(|h| vec![h.head]).unwrap_or_default(),
            )
        });

        let post = crate::record::documents::save_public_text(
            &self.store.db,
            &self.store.authorship.signer,
            &self.store.files,
            crate::record::documents::PublicText {
                onto,
                title: &resolved.title,
                body: &body,
                format,
            },
        )
        .await?;
        self.store
            .annotations()
            .set_field(doc_id, PUBLISHED_AS, &hex::encode(post))
            .await?;
        Ok(post)
    }

    /// The document's synthesized current text: one head's body verbatim, a clean three-way
    /// merge, or the conflict presented inline (NOTES_APP, The sync model) - with conflict
    /// sides labeled by DEVICE NAME ("from macbook-curtis, 2026-07-25 03:12"), the promise
    /// the labels were minted for.
    pub async fn resolved(
        &self,
        doc: &crate::record::documents::Doc,
    ) -> Result<crate::record::documents::ResolvedDoc, AppError> {
        let names: BTreeMap<[u8; 32], String> = self
            .store
            .private_view()
            .await?
            .registers_in(DEVICES_COLLECTION)
            .into_iter()
            .filter(|r| !r.value.is_empty())
            .filter_map(|r| crate::pubkey::decode(&r.key).map(|pk| (pk, r.value)))
            .collect();
        crate::record::documents::resolve(
            &self.store.files,
            &self.store.authorship.epoch_keys,
            doc,
            &names,
        )
        .await
    }
}

// ---------------------------------------------------------------------------------------------
// LWW register + LWW-element-set, private, grouped per document: annotations (PROJECT_PLAN,
// Annotations: Private Facts About Documents). The placement test's third category - a human
// assertion about one document, editable without minting a version - so it is neither header
// data nor a taxonomy. Everything the user asserts about doc D lives in ONE collection (the
// per-doc grouping keeps a document's assertions, deletions, and exports single-collection);
// read direction is the materializer's job, not the storage shape's.

/// The collection naming convention for annotations - a client-of-the-store convention, never
/// protocol: `annot:<root_hex>/<doc_id_hex>`, the full `(root, doc_id)` reference form, so
/// privately annotating *someone else's* document stays representable.
pub fn annot_collection(root: &[u8; 32], doc_id: &[u8; 16]) -> String {
    format!("annot:{}/{}", hex::encode(root), hex::encode(doc_id))
}

/// The convention read back: `(root, doc_id)` from a collection name, `None` for anything that
/// isn't a well-formed annotation collection.
fn parse_annot_collection(name: &str) -> Option<([u8; 32], [u8; 16])> {
    let (root_hex, doc_id_hex) = name.strip_prefix("annot:")?.split_once('/')?;
    let root = crate::pubkey::decode(root_hex)?;
    let doc_id: [u8; 16] = hex::decode(doc_id_hex).ok()?.try_into().ok()?;
    Some((root, doc_id))
}

pub struct Annotations<'s> {
    store: &'s Store,
}

/// One document's annotations for the stream/mirror: its named fields (description, ...) and
/// its tags. Serialized straight to the browser mirror.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AnnotationRow {
    pub doc_id: String,
    pub fields: BTreeMap<String, String>,
    pub tags: Vec<String>,
}

impl AnnotationRow {
    fn is_empty(&self) -> bool {
        self.fields.is_empty() && self.tags.is_empty()
    }
}

impl Annotations<'_> {
    /// Cap on one annotation value. Doctrine, enforced at the handle: past a couple of KiB a
    /// "description" is becoming another document - write one and reference it.
    pub const MAX_VALUE_BYTES: usize = 2048;

    /// The identity's own documents are the common case; the store's authorship context
    /// supplies the root. Annotating another identity's document is `annot_collection` with its
    /// root - a caller-built collection, when a handle for it is earned.
    fn collection(&self, doc_id: &[u8; 16]) -> String {
        annot_collection(&self.store.root, doc_id)
    }

    /// Read one annotation field, or None. Reads the DOC-META view, not the general-private
    /// one - annotations have their own chain, and the watermark table is keyed by service, so
    /// the two folds never see each other (a reader pointed at the wrong one finds an empty
    /// collection and says "no such field", which is how the first version of this silently
    /// re-published a post as a stranger).
    pub async fn field(&self, doc_id: &[u8; 16], field: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .store
            .doc_meta_view()
            .await?
            .registers_in(&self.collection(doc_id))
            .into_iter()
            .find(|r| r.key == field)
            .map(|r| r.value)
            .filter(|v| !v.is_empty()))
    }

    /// Set one field of a document's annotations (`description`, `artist`, ... - a conventional
    /// vocabulary, client custom, never protocol). LWW per field.
    pub async fn set_field(
        &self,
        doc_id: &[u8; 16],
        field: &str,
        value: &str,
    ) -> Result<SignedEntry, AppError> {
        if value.len() > Self::MAX_VALUE_BYTES {
            return Err(AppError::BadRequest(format!(
                "annotation value exceeds {} bytes: past that, a description is becoming \
                 another document - write one and reference it",
                Self::MAX_VALUE_BYTES
            )));
        }
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::Register,
                    collection: self.collection(doc_id),
                    key: field.to_string(),
                    value: Some(value.to_string()),
                },
            )
            .await
    }

    /// Clear one field: a register write with an absent value (absent value means cleared -
    /// PROJECT_PLAN, Annotations), so the clear is itself an LWW write that beats older sets.
    pub async fn clear_field(
        &self,
        doc_id: &[u8; 16],
        field: &str,
    ) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::Register,
                    collection: self.collection(doc_id),
                    key: field.to_string(),
                    value: None,
                },
            )
            .await
    }

    /// Every set field of one document, merged. Cleared fields (absent value) do not appear -
    /// and an empty value reads as cleared too: an empty description is no description.
    pub async fn fields(&self, doc_id: &[u8; 16]) -> Result<BTreeMap<String, String>, AppError> {
        let view = self.store.doc_meta_view().await?;
        Ok(view
            .registers_in(&self.collection(doc_id))
            .into_iter()
            .filter(|r| !r.value.is_empty())
            .map(|r| (r.key, r.value))
            .collect())
    }

    /// Tag a document. Tags are set elements in the same per-doc collection as the fields; the
    /// merge unit is the single `(doc, tag)` pair, so concurrent tagging merges automatically.
    pub async fn tag(&self, doc_id: &[u8; 16], tag: &str) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: self.collection(doc_id),
                    key: tag.to_string(),
                    value: None,
                },
            )
            .await
    }

    /// Untag a document (LWW-element-set remove: a tag/untag race resolves by timestamp).
    pub async fn untag(&self, doc_id: &[u8; 16], tag: &str) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: self.collection(doc_id),
                    key: tag.to_string(),
                    value: None,
                },
            )
            .await
    }

    /// All of one document's tags, in insertion order - the LWW stamp when each tag was added
    /// (element as the deterministic tiebreak for same-millisecond adds). Insertion order is the
    /// order the author built, so it reads more like their intent than an alphabetical shuffle.
    pub async fn tags(&self, doc_id: &[u8; 16]) -> Result<Vec<String>, AppError> {
        let view = self.store.doc_meta_view().await?;
        Ok(view
            .set_elements_ordered(&self.collection(doc_id))
            .into_iter()
            .map(|e| e.element)
            .collect())
    }

    /// Every document's annotations at once (own-root collections only) - the stream's bulk
    /// read, so the mirror can carry tags and descriptions the way it carries doc summaries.
    /// One fold of the doc-meta view, swept by collection.
    pub async fn all(&self) -> Result<Vec<AnnotationRow>, AppError> {
        let view = self.store.doc_meta_view().await?;
        let mut rows: BTreeMap<[u8; 16], AnnotationRow> = BTreeMap::new();
        for collection in view.collections() {
            let Some((root, doc_id)) = parse_annot_collection(collection) else {
                continue;
            };
            if root != self.store.root {
                continue; // annotations on someone else's document aren't this identity's list
            }
            let entry = rows.entry(doc_id).or_insert_with(|| AnnotationRow {
                doc_id: hex::encode(doc_id),
                fields: BTreeMap::new(),
                tags: Vec::new(),
            });
            for r in view.registers_in(collection) {
                if !r.value.is_empty() {
                    entry.fields.insert(r.key, r.value);
                }
            }
            // Insertion order, matching the per-doc `tags()` read (LWW-stamp total order).
            entry
                .tags
                .extend(view.set_elements_ordered(collection).into_iter().map(|e| e.element));
        }
        Ok(rows.into_values().filter(|r| !r.is_empty()).collect())
    }

    /// The inverted read: every `(root, doc_id)` currently tagged `tag`, across every identity
    /// whose documents this user has annotated. Both read directions are indexes over the same
    /// materialized table; neither is privileged - which is why tags could group per-doc
    /// without sacrificing this query (PROJECT_PLAN, Annotations).
    pub async fn docs_tagged(&self, tag: &str) -> Result<Vec<([u8; 32], [u8; 16])>, AppError> {
        let collections = private::collections_with_element(
            &self.store.db,
            &self.store.authorship.epoch_keys,
            service::DOC_META_PRIVATE,
            tag,
        )
        .await?;
        Ok(collections
            .iter()
            .filter_map(|name| parse_annot_collection(name))
            .collect())
    }

    /// The identity's OWN documents currently tagged `tag` - the docs-by-tag listing's spine.
    /// (`docs_tagged` can also name other identities' documents; those have no local `doc_heads`
    /// row and belong to a later cross-identity surface.)
    pub async fn own_docs_tagged(&self, tag: &str) -> Result<Vec<[u8; 16]>, AppError> {
        Ok(self
            .docs_tagged(tag)
            .await?
            .into_iter()
            .filter(|(root, _)| *root == self.store.root)
            .map(|(_, doc_id)| doc_id)
            .collect())
    }
}

// ---------------------------------------------------------------------------------------------
// Buckets: which project(s)/notebook(s) a document belongs to. Membership is the SAME
// LWW-element-set mechanism as tags - unordered, multiple, unions cleanly when two devices add
// the same doc at once - in a SEPARATE collection namespace so buckets never mingle with tags.
// That separation is the point: a bucket is the axis search and tags are *scoped to* ("braise"
// in the recipe book finds braised pork, never the journal), so it must not appear in the tag
// cloud it filters. A bucket is keyed by its name, exactly as a tag is its string.
//
// Beside membership sits a tiny REGISTRY: a single LWW register mapping bucket name -> app-type
// (`grandmas-recipes` -> `recipes`, `very-personal-private` -> `journal`). It does two small
// jobs and no more: it says which application should open a bucket (so a wiki never opens in the
// recipe app), and it lets an empty bucket exist in the window between "created" and "earned its
// first document". Not a Taxonomy (no ordering, no tree) and not a document (no versioning) -
// just a name->value register, the lightest thing that carries the mapping.

/// The collection naming convention for a document's bucket memberships: `bucket:<root>/<doc>`,
/// the full `(root, doc_id)` reference form so bucketing *someone else's* document stays
/// representable - and a namespace distinct from `annot:`, so the two axes never collide.
pub fn bucket_collection(root: &[u8; 32], doc_id: &[u8; 16]) -> String {
    format!("bucket:{}/{}", hex::encode(root), hex::encode(doc_id))
}

fn parse_bucket_collection(name: &str) -> Option<([u8; 32], [u8; 16])> {
    let (root_hex, doc_id_hex) = name.strip_prefix("bucket:")?.split_once('/')?;
    let root = crate::pubkey::decode(root_hex)?;
    let doc_id: [u8; 16] = hex::decode(doc_id_hex).ok()?.try_into().ok()?;
    Some((root, doc_id))
}

/// The bucket registry: one LWW register collection, `key = bucket name`, `value = app-type`.
/// Membership lives elsewhere (the `bucket:` sets); this only carries the name->app mapping and
/// gives an empty bucket a place to be. (A plain string, not a `bucket:` collection, so the
/// membership parser never mistakes it for one.)
const BUCKET_REGISTRY: &str = "buckets";

/// One bucket in the roster: its name, the app-type meant to open it (empty if unregistered),
/// and how many of this identity's documents it holds.
#[derive(Debug, Clone)]
pub struct BucketSummary {
    pub name: String,
    pub app: String,
    pub members: usize,
}

pub struct Buckets<'s> {
    store: &'s Store,
}

impl Buckets<'_> {
    /// A bucket name past this is becoming a document - a notebook is a short label.
    pub const MAX_NAME_BYTES: usize = 120;

    fn collection(&self, doc_id: &[u8; 16]) -> String {
        bucket_collection(&self.store.root, doc_id)
    }

    fn clean(bucket: &str) -> Result<String, AppError> {
        let name = bucket.trim().to_string();
        if name.is_empty() {
            return Err(AppError::BadRequest("bucket name is empty".into()));
        }
        if name.len() > Self::MAX_NAME_BYTES {
            return Err(AppError::BadRequest(format!(
                "bucket name exceeds {} bytes",
                Self::MAX_NAME_BYTES
            )));
        }
        Ok(name)
    }

    /// Register a bucket's app-type (creating the bucket if new): an LWW register write,
    /// `name -> app`. This is also how an empty bucket comes into being - it exists in the
    /// registry before any document is placed in it. Idempotent; re-registering updates the app.
    pub async fn define(&self, bucket: &str, app: &str) -> Result<SignedEntry, AppError> {
        let name = Self::clean(bucket)?;
        let app = app.trim().to_string();
        if app.len() > Self::MAX_NAME_BYTES {
            return Err(AppError::BadRequest(format!(
                "app-type exceeds {} bytes",
                Self::MAX_NAME_BYTES
            )));
        }
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::Register,
                    collection: BUCKET_REGISTRY.to_string(),
                    key: name,
                    value: Some(app),
                },
            )
            .await
    }

    /// Forget a bucket's registry entry (an LWW clear - absent value). Membership tags stay on
    /// the chain like everything else; a bucket still holding documents remains in the roster
    /// (via those members), just without a known app-type until re-registered.
    pub async fn undefine(&self, bucket: &str) -> Result<SignedEntry, AppError> {
        let name = Self::clean(bucket)?;
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::Register,
                    collection: BUCKET_REGISTRY.to_string(),
                    key: name,
                    value: None,
                },
            )
            .await
    }

    /// Put a document in a bucket (LWW-element-set add; the `(doc, bucket)` pair is the merge
    /// unit, so two devices bucketing at once union rather than conflict). Idempotent.
    pub async fn place(&self, doc_id: &[u8; 16], bucket: &str) -> Result<SignedEntry, AppError> {
        let name = Self::clean(bucket)?;
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: self.collection(doc_id),
                    key: name,
                    value: None,
                },
            )
            .await
    }

    /// Take a document out of a bucket (LWW-element-set remove; a place/remove race resolves by
    /// timestamp).
    pub async fn remove(&self, doc_id: &[u8; 16], bucket: &str) -> Result<SignedEntry, AppError> {
        let name = Self::clean(bucket)?;
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: self.collection(doc_id),
                    key: name,
                    value: None,
                },
            )
            .await
    }

    /// Every bucket one document is in, sorted.
    pub async fn of(&self, doc_id: &[u8; 16]) -> Result<Vec<String>, AppError> {
        let view = self.store.doc_meta_view().await?;
        let mut names: Vec<String> = view
            .set_elements(&self.collection(doc_id))
            .into_iter()
            .map(|e| e.element)
            .collect();
        names.sort();
        Ok(names)
    }

    /// Each of this identity's own documents mapped to its buckets - the join the mirror row
    /// carries, so the client can scope and filter by bucket. One view fold, swept by
    /// collection (own-root only; bucketing another identity's doc is a future surface).
    pub async fn all(&self) -> Result<BTreeMap<[u8; 16], Vec<String>>, AppError> {
        let view = self.store.doc_meta_view().await?;
        let mut out: BTreeMap<[u8; 16], Vec<String>> = BTreeMap::new();
        for collection in view.collections() {
            let Some((root, doc_id)) = parse_bucket_collection(collection) else {
                continue;
            };
            if root != self.store.root {
                continue;
            }
            let mut names: Vec<String> = view
                .set_elements(collection)
                .into_iter()
                .map(|e| e.element)
                .collect();
            if names.is_empty() {
                continue;
            }
            names.sort();
            out.insert(doc_id, names);
        }
        Ok(out)
    }

    /// The roster: every bucket - name, its registered app-type, and this identity's member
    /// count. A bucket appears if it is registered (empty buckets included) OR if any document
    /// is in it (a membership without a registry entry has an empty app-type). One view fold.
    /// Sorted by name.
    pub async fn roster(&self) -> Result<Vec<BucketSummary>, AppError> {
        let view = self.store.doc_meta_view().await?;

        // name -> app, from the registry (empty values are cleared entries).
        let mut apps: BTreeMap<String, String> = view
            .registers_in(BUCKET_REGISTRY)
            .into_iter()
            .filter(|r| !r.value.is_empty())
            .map(|r| (r.key, r.value))
            .collect();

        // name -> member count, from the per-doc membership sets (own root).
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for collection in view.collections() {
            let Some((root, _)) = parse_bucket_collection(collection) else {
                continue;
            };
            if root != self.store.root {
                continue;
            }
            for e in view.set_elements(collection) {
                *counts.entry(e.element).or_insert(0) += 1;
            }
        }

        let mut names: std::collections::BTreeSet<String> = apps.keys().cloned().collect();
        names.extend(counts.keys().cloned());
        Ok(names
            .into_iter()
            .map(|name| BucketSummary {
                app: apps.remove(&name).unwrap_or_default(),
                members: counts.get(&name).copied().unwrap_or(0),
                name,
            })
            .collect())
    }

    /// The app-type registered to open a bucket, if any.
    pub async fn app_of(&self, bucket: &str) -> Result<Option<String>, AppError> {
        let name = Self::clean(bucket)?;
        let view = self.store.doc_meta_view().await?;
        Ok(view
            .registers_in(BUCKET_REGISTRY)
            .into_iter()
            .find(|r| r.key == name && !r.value.is_empty())
            .map(|r| r.value))
    }

    /// This identity's own documents currently in `bucket` - the app view's spine (the inverse
    /// read, same machinery as `own_docs_tagged`, filtered to the bucket namespace).
    pub async fn own_docs_in(&self, bucket: &str) -> Result<Vec<[u8; 16]>, AppError> {
        let name = Self::clean(bucket)?;
        let collections = private::collections_with_element(
            &self.store.db,
            &self.store.authorship.epoch_keys,
            service::DOC_META_PRIVATE,
            &name,
        )
        .await?;
        Ok(collections
            .iter()
            .filter_map(|c| parse_bucket_collection(c))
            .filter(|(root, _)| *root == self.store.root)
            .map(|(_, doc_id)| doc_id)
            .collect())
    }
}

impl Store {
    async fn doc_meta_view(&self) -> Result<private::PrivateView, AppError> {
        private::materialize_service(
            &self.db,
            &self.authorship.epoch_keys,
            service::DOC_META_PRIVATE,
        )
        .await
    }
}

// ---------------------------------------------------------------------------------------------
// LWW-element-set with ranked values, private, one collection per list: taxonomies
// (PROJECT_PLAN, Taxonomies - amended 2026-07-22). Ordered structure decomposes to per-element
// facts exactly as tags did, because a list's commonest concurrent edit is two devices each
// adding an item, and any whole-value shape turns that obvious union into a manufactured
// conflict. Order is never stored; it is assembled at read time from each member's rank
// (`record::rank`), with the element string as deterministic tiebreak.
//
// Trees are COMPOSITION, not structure (amended 2026-07-23): a taxonomy placed as a member of
// another taxonomy IS the tree - interior nodes are themselves taxonomies (titled, taggable
// for free), a sub-list can live under two parents, and cycles never corrupt storage because
// membership facts are independent. A merge-created loop is a *render* concern: `tree` walks
// with a visited set and a repeat visit becomes a stub - the conflict-markers philosophy
// holding for shape. Prevention where cheap, recoverability always: `place` refuses the
// locally-visible cycle (the single-device mistake); the visited set absorbs what merge can
// still mint.

/// The collection naming convention for a taxonomy's members - a client-of-the-store
/// convention, never protocol: `tax:<taxonomy_id_hex>`. No root in the name (a taxonomy is
/// this identity's own artifact, on its own chain); the *members* carry full `(root, doc_id)`
/// references, so a reading list over someone else's documents stays representable.
pub fn tax_collection(taxonomy_id: &[u8; 16]) -> String {
    format!("tax:{}", hex::encode(taxonomy_id))
}

/// The roster: the LWW-element-set of this identity's taxonomies (elements are taxonomy id
/// hex). Existence lives here - not in the member collections - so an empty list exists, and
/// deleting a taxonomy is one remove instead of N. A member collection whose roster element is
/// absent (deleted, or its create not yet synced) is simply not shown; the entries stay on the
/// chain like everything else (Immutable Chains ≠ Immutable Content).
const TAXONOMY_ROSTER: &str = "taxonomies";

/// One member of a taxonomy, in list order once sorted by `(rank, element tiebreak)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaxonomyMember {
    pub root: [u8; 32],
    pub doc_id: [u8; 16],
    pub rank: String,
}

/// One roster row for the all-taxonomies listing.
#[derive(Debug, Clone)]
pub struct TaxonomySummary {
    pub taxonomy_id: [u8; 16],
    /// From the taxonomy's `title` annotation; empty when never titled.
    pub title: String,
    pub members: usize,
}

/// A member's set-element string: the full reference form, `<root_hex>/<doc_id_hex>` - the
/// same shape `annot:` collections use after their prefix.
fn member_element(root: &[u8; 32], doc_id: &[u8; 16]) -> String {
    format!("{}/{}", hex::encode(root), hex::encode(doc_id))
}

fn parse_member_element(element: &str) -> Option<([u8; 32], [u8; 16])> {
    let (root_hex, doc_id_hex) = element.split_once('/')?;
    let root = crate::pubkey::decode(root_hex)?;
    let doc_id: [u8; 16] = hex::decode(doc_id_hex).ok()?.try_into().ok()?;
    Some((root, doc_id))
}

pub struct Taxonomies<'s> {
    store: &'s Store,
}

impl Taxonomies<'_> {
    /// Create a taxonomy: mint its id, add it to the roster, and (unless empty) write its
    /// `title` annotation - taxonomy-level facts are ordinary annotations on the taxonomy's
    /// own id, so rename/describe/default_view need no machinery here.
    pub async fn create(&self, title: &str) -> Result<[u8; 16], AppError> {
        let taxonomy_id = crate::record::documents::new_doc_id();
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: TAXONOMY_ROSTER.to_string(),
                    key: hex::encode(taxonomy_id),
                    value: None,
                },
            )
            .await?;
        if !title.is_empty() {
            self.store
                .annotations()
                .set_field(&taxonomy_id, "title", title)
                .await?;
        }
        Ok(taxonomy_id)
    }

    /// Delete a taxonomy: one roster remove. Member elements stay on the chain (the fact of
    /// the list is permanent) but no read surfaces them; re-creating the same id un-hides them
    /// by design - it is the same taxonomy coming back.
    pub async fn delete(&self, taxonomy_id: &[u8; 16]) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: TAXONOMY_ROSTER.to_string(),
                    key: hex::encode(taxonomy_id),
                    value: None,
                },
            )
            .await
    }

    /// Every taxonomy on the roster, with title and member count - one view materialization,
    /// however many lists. Sorted by title, id-tiebroken, for a stable listing.
    pub async fn all(&self) -> Result<Vec<TaxonomySummary>, AppError> {
        let view = self.store.doc_meta_view().await?;
        let mut out: Vec<TaxonomySummary> = view
            .set_elements(TAXONOMY_ROSTER)
            .into_iter()
            .filter_map(|e| {
                let taxonomy_id: [u8; 16] = hex::decode(&e.element).ok()?.try_into().ok()?;
                let title = view
                    .registers_in(&annot_collection(&self.store.root, &taxonomy_id))
                    .into_iter()
                    .find(|r| r.key == "title" && !r.value.is_empty())
                    .map(|r| r.value)
                    .unwrap_or_default();
                let members = view.set_elements(&tax_collection(&taxonomy_id)).len();
                Some(TaxonomySummary {
                    taxonomy_id,
                    title,
                    members,
                })
            })
            .collect();
        out.sort_by(|a, b| (&a.title, a.taxonomy_id).cmp(&(&b.title, b.taxonomy_id)));
        Ok(out)
    }

    /// A taxonomy's members in list order: rank ascending, element string as the deterministic
    /// tiebreak (equal ranks are the concurrent same-spot race - adjacent, arbitrary relative
    /// order, every device agreeing; `record::rank`).
    pub async fn members(&self, taxonomy_id: &[u8; 16]) -> Result<Vec<TaxonomyMember>, AppError> {
        let view = self.store.doc_meta_view().await?;
        Ok(Self::members_of(&view, taxonomy_id))
    }

    fn members_of(view: &private::PrivateView, taxonomy_id: &[u8; 16]) -> Vec<TaxonomyMember> {
        let mut members: Vec<(TaxonomyMember, String)> = view
            .set_elements(&tax_collection(taxonomy_id))
            .into_iter()
            .filter_map(|e| {
                let (root, doc_id) = parse_member_element(&e.element)?;
                let rank = e.value.unwrap_or_default();
                Some((TaxonomyMember { root, doc_id, rank }, e.element))
            })
            .collect();
        members.sort_by(|(a, ae), (b, be)| (&a.rank, ae).cmp(&(&b.rank, be)));
        members.into_iter().map(|(m, _)| m).collect()
    }

    /// Place a member at `index` (`None` = append): add and move are one operation, because a
    /// set re-add updates the element's value under the same LWW stamp - a move never removes,
    /// so a concurrent read on another device sees the member somewhere, never nowhere.
    /// `index` counts positions in the list *without* the member (the arrive-at semantics a
    /// drag-and-drop produces); out-of-range clamps to append.
    ///
    /// Placing one of our own taxonomies is how trees are built - and is refused when this
    /// device can already see that the destination lives *inside* the placed list (a cycle).
    /// The check is a courtesy, not a guarantee: two devices can each make a locally-innocent
    /// placement that merges into a loop, which `tree`'s visited set then renders as a stub.
    pub async fn place(
        &self,
        taxonomy_id: &[u8; 16],
        root: &[u8; 32],
        doc_id: &[u8; 16],
        index: Option<usize>,
    ) -> Result<SignedEntry, AppError> {
        let view = self.store.doc_meta_view().await?;

        if *root == self.store.root
            && Self::is_on_roster(&view, doc_id)
            && Self::reaches(&view, &self.store.root, doc_id, taxonomy_id)
        {
            return Err(AppError::BadRequest(
                "placing this list here would create a cycle: the destination is already \
                 inside it (directly or through nested lists)"
                    .into(),
            ));
        }

        let element = member_element(root, doc_id);
        let mut list = Self::members_of(&view, taxonomy_id);
        list.retain(|m| !(m.root == *root && m.doc_id == *doc_id));

        let at = index.unwrap_or(list.len()).min(list.len());
        let rank = if at == list.len() {
            crate::record::rank::after(list.last().map(|m| m.rank.as_str()))
        } else {
            let lo = at.checked_sub(1).map(|i| list[i].rank.as_str());
            crate::record::rank::between(lo, Some(list[at].rank.as_str()))
        };

        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: tax_collection(taxonomy_id),
                    key: element,
                    value: Some(rank),
                },
            )
            .await
    }

    fn is_on_roster(view: &private::PrivateView, id: &[u8; 16]) -> bool {
        let id_hex = hex::encode(id);
        view.set_elements(TAXONOMY_ROSTER)
            .iter()
            .any(|e| e.element == id_hex)
    }

    /// Is `target` reachable from `from` through this identity's own membership edges, in the
    /// local view? (`from == target` counts: a list contains itself.) Only own-root taxonomy
    /// members are walkable - a foreign taxonomy's contents aren't ours to know here.
    fn reaches(
        view: &private::PrivateView,
        own_root: &[u8; 32],
        from: &[u8; 16],
        target: &[u8; 16],
    ) -> bool {
        let mut stack = vec![*from];
        let mut seen = std::collections::BTreeSet::new();
        while let Some(id) = stack.pop() {
            if id == *target {
                return true;
            }
            if !seen.insert(id) {
                continue;
            }
            for m in Self::members_of(view, &id) {
                if m.root == *own_root && Self::is_on_roster(view, &m.doc_id) {
                    stack.push(m.doc_id);
                }
            }
        }
        false
    }

    /// Remove a member (LWW set-element remove: a remove/place race resolves by timestamp -
    /// one intent wins whole, the member is in the list or out of it, never half-placed).
    pub async fn remove(
        &self,
        taxonomy_id: &[u8; 16],
        root: &[u8; 32],
        doc_id: &[u8; 16],
    ) -> Result<SignedEntry, AppError> {
        self.store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetRemove,
                    collection: tax_collection(taxonomy_id),
                    key: member_element(root, doc_id),
                    value: None,
                },
            )
            .await
    }

    /// The tree read: this taxonomy's members with every own-root member taxonomy expanded in
    /// place, depth-first in list order. The walk carries a visited set - the SECOND encounter
    /// of any taxonomy (a diamond's other parent, or a merge-created cycle) is a **stub**
    /// (`members: None`): present, titled, navigable as a link, never re-expanded. Stubbing
    /// diamonds too is deliberate - it is what bounds the walk (and the response) linearly in
    /// the number of taxonomies, and a renderer links to the first occurrence either way.
    pub async fn tree(&self, taxonomy_id: &[u8; 16]) -> Result<TaxonomyNode, AppError> {
        let view = self.store.doc_meta_view().await?;
        let mut visited = std::collections::BTreeSet::from([*taxonomy_id]);
        Ok(TaxonomyNode {
            taxonomy_id: *taxonomy_id,
            title: Self::title_of(&view, &self.store.root, taxonomy_id),
            members: Some(Self::expand(
                &view,
                &self.store.root,
                taxonomy_id,
                &mut visited,
            )),
        })
    }

    fn title_of(view: &private::PrivateView, own_root: &[u8; 32], id: &[u8; 16]) -> String {
        view.registers_in(&annot_collection(own_root, id))
            .into_iter()
            .find(|r| r.key == "title" && !r.value.is_empty())
            .map(|r| r.value)
            .unwrap_or_default()
    }

    fn expand(
        view: &private::PrivateView,
        own_root: &[u8; 32],
        taxonomy_id: &[u8; 16],
        visited: &mut std::collections::BTreeSet<[u8; 16]>,
    ) -> Vec<TreeMember> {
        Self::members_of(view, taxonomy_id)
            .into_iter()
            .map(|m| {
                let taxonomy =
                    (m.root == *own_root && Self::is_on_roster(view, &m.doc_id)).then(|| {
                        let members = visited
                            .insert(m.doc_id)
                            .then(|| Self::expand(view, own_root, &m.doc_id, visited));
                        TaxonomyNode {
                            taxonomy_id: m.doc_id,
                            title: Self::title_of(view, own_root, &m.doc_id),
                            members,
                        }
                    });
                TreeMember {
                    root: m.root,
                    doc_id: m.doc_id,
                    taxonomy,
                }
            })
            .collect()
    }
}

/// One expanded taxonomy in a tree read. `members: None` marks a stub: this taxonomy appears
/// (again) here, but its expansion lives at its first encounter - a cycle or a diamond,
/// rendered as a link either way.
#[derive(Debug, Clone)]
pub struct TaxonomyNode {
    pub taxonomy_id: [u8; 16],
    pub title: String,
    pub members: Option<Vec<TreeMember>>,
}

/// One member in a tree read: a document reference, plus its expansion when it is one of our
/// own taxonomies.
#[derive(Debug, Clone)]
pub struct TreeMember {
    pub root: [u8; 32],
    pub doc_id: [u8; 16],
    pub taxonomy: Option<TaxonomyNode>,
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
    db: &'s Db,
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
        let db = crate::db::test_user_db().await;

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
            // A single-key test identity: the leaf doubles as the root.
            root: leaf,
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
    async fn device_names_label_rename_and_clear() {
        let store = test_store().await;
        let (macbook, pi) = ([0xAA; 32], [0xBB; 32]);

        store.devices().set_name(&macbook, "macbook-curtis").await.unwrap();
        store.devices().set_name(&pi, "asceticbot").await.unwrap();

        let names = store.devices().all().await.unwrap();
        assert_eq!(names.len(), 2);
        assert_eq!(names[&hex::encode(macbook)], "macbook-curtis");

        // Rename is just writing again (LWW); clearing is writing the empty label.
        store.devices().set_name(&pi, "asceticbot-curtis").await.unwrap();
        store.devices().set_name(&macbook, "").await.unwrap();
        let names = store.devices().all().await.unwrap();
        assert_eq!(names.len(), 1, "cleared label reads as unnamed");
        assert_eq!(names[&hex::encode(pi)], "asceticbot-curtis");

        // A label past the cap is refused as a nickname, not silently truncated.
        let err = store
            .devices()
            .set_name(&pi, &"x".repeat(Devices::MAX_NAME_BYTES + 1))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("nickname"), "{err}");
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
    async fn annotations_round_trip_and_the_later_write_wins() {
        let store = test_store().await;
        let doc_id = [7u8; 16];

        // Round trip: a description in, the same description out.
        store
            .annotations()
            .set_field(&doc_id, "description", "a sunset over the pier")
            .await
            .unwrap();
        // LWW conflict: two writes to the same field; the later stamp wins (the authoring
        // clamp guarantees same-chain successors never stamp backwards).
        store
            .annotations()
            .set_field(&doc_id, "artist", "someone")
            .await
            .unwrap();
        store
            .annotations()
            .set_field(&doc_id, "artist", "Corff Burblepunk")
            .await
            .unwrap();

        let fields = store.annotations().fields(&doc_id).await.unwrap();
        assert_eq!(fields.len(), 2);
        assert_eq!(fields["description"], "a sunset over the pier");
        assert_eq!(fields["artist"], "Corff Burblepunk", "later write wins");

        // Clearing is an LWW write of an absent value: the field disappears from reads.
        store
            .annotations()
            .clear_field(&doc_id, "artist")
            .await
            .unwrap();
        let fields = store.annotations().fields(&doc_id).await.unwrap();
        assert_eq!(fields.len(), 1);
        assert!(!fields.contains_key("artist"));

        // Another document's collection is untouched throughout.
        let other = store.annotations().fields(&[8u8; 16]).await.unwrap();
        assert!(other.is_empty());
    }

    #[tokio::test]
    async fn tags_answer_in_both_directions() {
        let store = test_store().await;
        let (pier, cat) = ([1u8; 16], [2u8; 16]);

        store.annotations().tag(&pier, "sunset").await.unwrap();
        store.annotations().tag(&pier, "beach").await.unwrap();
        store.annotations().tag(&cat, "sunset").await.unwrap();

        // Per-doc direction: insertion order (sunset tagged first), not alphabetical.
        let tags = store.annotations().tags(&pier).await.unwrap();
        assert_eq!(tags, vec!["sunset", "beach"]);

        // Inverted direction: same table, other index. Doc refs parse back out of the
        // collection names, root and all.
        let tagged = store.annotations().docs_tagged("sunset").await.unwrap();
        assert_eq!(tagged, vec![(store.root, pier), (store.root, cat)]);

        // Untag, then re-tag: the LWW element flips present-absent-present, both directions
        // agreeing at every step.
        store.annotations().untag(&pier, "sunset").await.unwrap();
        assert_eq!(store.annotations().tags(&pier).await.unwrap(), ["beach"]);
        assert_eq!(
            store.annotations().docs_tagged("sunset").await.unwrap(),
            vec![(store.root, cat)]
        );
        store.annotations().tag(&pier, "sunset").await.unwrap();
        assert_eq!(
            store.annotations().docs_tagged("sunset").await.unwrap(),
            vec![(store.root, pier), (store.root, cat)]
        );
    }

    #[tokio::test]
    async fn deleting_a_document_hides_it_from_every_list_and_restore_brings_it_back() {
        use crate::record::documents::Format;
        let store = test_store().await;

        let (keep, _) = store
            .documents()
            .create("keeper", b"the good one", Format::Plaintext)
            .await
            .unwrap();
        let (gone, _) = store
            .documents()
            .create("regret", b"braise the pork", Format::Plaintext)
            .await
            .unwrap();
        store.annotations().tag(&gone, "braise").await.unwrap();

        // Both present up front, in the list and (for the tagged one) via the inverse read.
        let ids = |rows: &[crate::record::documents::DocHeadRow]| {
            rows.iter().map(|r| r.doc_id).collect::<std::collections::BTreeSet<_>>()
        };
        let (rows, _) = store.documents().summaries().await.unwrap();
        assert!(ids(&rows).contains(&gone) && ids(&rows).contains(&keep));

        // Delete: it leaves the main list AND the tag/bucket-shaped `summaries_for` read, while
        // the keeper is untouched. The version chain is not consulted - the tombstone is enough.
        store.documents().delete(&gone).await.unwrap();
        let (rows, _) = store.documents().summaries().await.unwrap();
        assert!(!ids(&rows).contains(&gone), "deleted doc is hidden from the list");
        assert!(ids(&rows).contains(&keep), "the keeper stays");
        let by_id = store.documents().summaries_for(&[gone, keep]).await.unwrap();
        assert_eq!(ids(&by_id), std::collections::BTreeSet::from([keep]));
        assert!(store.documents().deleted().await.unwrap().contains(&gone));

        // Restore: the tombstone is an LWW fact, so removing it un-hides the document whole -
        // its history was never touched.
        store.documents().restore(&gone).await.unwrap();
        let (rows, _) = store.documents().summaries().await.unwrap();
        assert!(ids(&rows).contains(&gone), "restore brings it back");
        assert!(store.documents().deleted().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn pinning_flags_a_document_without_hiding_it_and_unpin_clears_it() {
        use crate::record::documents::Format;
        let store = test_store().await;
        let (a, _) = store
            .documents()
            .create("a", b"one", Format::Plaintext)
            .await
            .unwrap();
        let (b, _) = store
            .documents()
            .create("b", b"two", Format::Plaintext)
            .await
            .unwrap();

        assert!(store.documents().pinned().await.unwrap().is_empty());

        // Pin `a`: it's flagged, but STILL in the list (a pin sorts, it never filters - the
        // client orders on the flag; the server keeps every row).
        store.documents().pin(&a).await.unwrap();
        assert_eq!(
            store.documents().pinned().await.unwrap(),
            std::collections::BTreeSet::from([a])
        );
        let (rows, _) = store.documents().summaries().await.unwrap();
        let ids: std::collections::BTreeSet<_> = rows.iter().map(|r| r.doc_id).collect();
        assert!(ids.contains(&a) && ids.contains(&b), "pinning hides nothing");

        // Unpin: the flag clears (LWW remove).
        store.documents().unpin(&a).await.unwrap();
        assert!(store.documents().pinned().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_oversized_annotation_is_told_to_become_a_document() {
        let store = test_store().await;
        let doc_id = [3u8; 16];

        // Exactly at the cap is fine; one byte past it is refused, and the error says why.
        let at_cap = "d".repeat(Annotations::MAX_VALUE_BYTES);
        store
            .annotations()
            .set_field(&doc_id, "description", &at_cap)
            .await
            .unwrap();
        let err = store
            .annotations()
            .set_field(&doc_id, "description", &format!("{at_cap}!"))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("another document"),
            "the refusal names the alternative: {err}"
        );
    }

    /// The doc-meta clone of the notes-chain test: annotations are private, so their entries
    /// AND their frontiers stay behind the member proof. A stranger syncing public chains must
    /// see no evidence the doc-meta chain exists.
    #[tokio::test]
    async fn doc_meta_chains_are_withheld_from_unproven_peers() {
        let store = test_store().await;
        store
            .annotations()
            .set_field(&[9u8; 16], "description", "secret assertions")
            .await
            .unwrap();

        let public = crate::net::sync::local_frontiers(&store.db, false)
            .await
            .unwrap();
        assert!(
            !public
                .iter()
                .any(|f| f.service == service::DOC_META_PRIVATE),
            "doc-meta frontiers must not be offered to unproven peers"
        );
        let member = crate::net::sync::local_frontiers(&store.db, true)
            .await
            .unwrap();
        assert!(member
            .iter()
            .any(|f| f.service == service::DOC_META_PRIVATE));
    }

    /// Annotations are a view over the log, so they survive drop + refold: `rebuild_views`
    /// wipes the private tables and watermarks, and the next keyed read reconstructs the exact
    /// same state from the entries.
    #[tokio::test]
    async fn annotations_survive_rebuild_views() {
        let store = test_store().await;
        let doc_id = [4u8; 16];
        store
            .annotations()
            .set_field(&doc_id, "description", "still here after the flood")
            .await
            .unwrap();
        store.annotations().tag(&doc_id, "ark").await.unwrap();
        let fields_before = store.annotations().fields(&doc_id).await.unwrap();
        let tags_before = store.annotations().tags(&doc_id).await.unwrap();

        imaol::rebuild_views(&store.db).await.unwrap();

        assert_eq!(
            store.annotations().fields(&doc_id).await.unwrap(),
            fields_before
        );
        assert_eq!(
            store.annotations().tags(&doc_id).await.unwrap(),
            tags_before
        );
        assert_eq!(
            store.annotations().docs_tagged("ark").await.unwrap(),
            vec![(store.root, doc_id)]
        );
    }

    #[tokio::test]
    async fn taxonomies_hold_their_order_through_the_crdt() {
        let store = test_store().await;
        let (a, b, c) = ([1u8; 16], [2u8; 16], [3u8; 16]);
        let root = store.root;

        let list = store
            .taxonomies()
            .create("BOOK ABOUT HORSES")
            .await
            .unwrap();

        // Appends land in insertion order.
        for doc in [&a, &b, &c] {
            store
                .taxonomies()
                .place(&list, &root, doc, None)
                .await
                .unwrap();
        }
        let order = |ms: &[TaxonomyMember]| ms.iter().map(|m| m.doc_id).collect::<Vec<_>>();
        assert_eq!(
            order(&store.taxonomies().members(&list).await.unwrap()),
            [a, b, c]
        );

        // Move: place c at the front. One write, nothing else renumbered.
        store
            .taxonomies()
            .place(&list, &root, &c, Some(0))
            .await
            .unwrap();
        assert_eq!(
            order(&store.taxonomies().members(&list).await.unwrap()),
            [c, a, b]
        );

        // Insert into the middle.
        let d = [4u8; 16];
        store
            .taxonomies()
            .place(&list, &root, &d, Some(1))
            .await
            .unwrap();
        assert_eq!(
            order(&store.taxonomies().members(&list).await.unwrap()),
            [c, d, a, b]
        );

        // Remove.
        store.taxonomies().remove(&list, &root, &a).await.unwrap();
        assert_eq!(
            order(&store.taxonomies().members(&list).await.unwrap()),
            [c, d, b]
        );

        // The roster listing carries title and count.
        let all = store.taxonomies().all().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "BOOK ABOUT HORSES");
        assert_eq!(all[0].members, 3);

        // Rename is just the title annotation - no taxonomy machinery involved.
        store
            .annotations()
            .set_field(&list, "title", "EQUINE COMPENDIUM")
            .await
            .unwrap();
        assert_eq!(
            store.taxonomies().all().await.unwrap()[0].title,
            "EQUINE COMPENDIUM"
        );
    }

    #[tokio::test]
    async fn an_empty_taxonomy_exists_and_a_deleted_one_does_not() {
        let store = test_store().await;
        let list = store.taxonomies().create("someday pile").await.unwrap();
        assert_eq!(
            store.taxonomies().all().await.unwrap().len(),
            1,
            "empty list exists"
        );

        store
            .taxonomies()
            .place(&list, &store.root, &[9u8; 16], None)
            .await
            .unwrap();
        store.taxonomies().delete(&list).await.unwrap();
        assert!(
            store.taxonomies().all().await.unwrap().is_empty(),
            "deleted list is gone"
        );

        // Deletion is a roster fact, so re-creating the id (LWW re-add) un-hides the members:
        // it is the same taxonomy coming back, not a new one born clean.
        store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: TAXONOMY_ROSTER.to_string(),
                    key: hex::encode(list),
                    value: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(store.taxonomies().all().await.unwrap()[0].members, 1);
    }

    #[tokio::test]
    async fn a_taxonomy_can_reference_someone_elses_documents() {
        let store = test_store().await;
        let list = store
            .taxonomies()
            .create("their greatest hits")
            .await
            .unwrap();
        let stranger_root = [0xEE; 32];
        let their_doc = [7u8; 16];

        store
            .taxonomies()
            .place(&list, &stranger_root, &their_doc, None)
            .await
            .unwrap();
        let members = store.taxonomies().members(&list).await.unwrap();
        assert_eq!(members[0].root, stranger_root);
        assert_eq!(members[0].doc_id, their_doc);
    }

    #[tokio::test]
    async fn taxonomies_survive_rebuild_views() {
        let store = test_store().await;
        let list = store.taxonomies().create("flood insurance").await.unwrap();
        for doc in [[1u8; 16], [2u8; 16]] {
            store
                .taxonomies()
                .place(&list, &store.root, &doc, None)
                .await
                .unwrap();
        }
        store
            .taxonomies()
            .place(&list, &store.root, &[2u8; 16], Some(0))
            .await
            .unwrap();
        let before = store.taxonomies().members(&list).await.unwrap();

        imaol::rebuild_views(&store.db).await.unwrap();

        assert_eq!(store.taxonomies().members(&list).await.unwrap(), before);
        assert_eq!(
            store.taxonomies().all().await.unwrap()[0].title,
            "flood insurance"
        );
    }

    #[tokio::test]
    async fn locally_visible_cycles_are_refused_at_place() {
        let store = test_store().await;
        let root = store.root;
        let a = store.taxonomies().create("A").await.unwrap();
        let b = store.taxonomies().create("B").await.unwrap();
        let c = store.taxonomies().create("C").await.unwrap();

        // Build A > B > C, each placement legal.
        store.taxonomies().place(&a, &root, &b, None).await.unwrap();
        store.taxonomies().place(&b, &root, &c, None).await.unwrap();

        // Self, inverse, and transitive-inverse placements all name the cycle.
        for (list, member) in [(&a, &a), (&b, &a), (&c, &a), (&c, &b)] {
            let err = store
                .taxonomies()
                .place(list, &root, member, None)
                .await
                .unwrap_err();
            assert!(
                err.to_string().contains("cycle"),
                "refusal names the cycle: {err}"
            );
        }

        // A foreign taxonomy's contents aren't ours to walk: placing one is never refused.
        store
            .taxonomies()
            .place(&c, &[0xEE; 32], &a, None)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_tree_read_expands_nests_and_stubs_repeats() {
        let store = test_store().await;
        let root = store.root;
        let book = store
            .taxonomies()
            .create("BOOK ABOUT HORSES")
            .await
            .unwrap();
        let anatomy = store.taxonomies().create("Horse Anatomy").await.unwrap();
        let doc = [7u8; 16];

        store
            .taxonomies()
            .place(&book, &root, &doc, None)
            .await
            .unwrap();
        store
            .taxonomies()
            .place(&book, &root, &anatomy, None)
            .await
            .unwrap();
        store
            .taxonomies()
            .place(&anatomy, &root, &[8u8; 16], None)
            .await
            .unwrap();

        let tree = store.taxonomies().tree(&book).await.unwrap();
        assert_eq!(tree.title, "BOOK ABOUT HORSES");
        let members = tree.members.as_ref().unwrap();
        assert_eq!(members.len(), 2);
        assert!(members[0].taxonomy.is_none(), "a plain doc is not expanded");
        let nested = members[1].taxonomy.as_ref().unwrap();
        assert_eq!(nested.title, "Horse Anatomy");
        assert_eq!(
            nested.members.as_ref().unwrap().len(),
            1,
            "expanded in place"
        );

        // A diamond: a second list also containing Anatomy. First encounter (list order)
        // expands; the second is a stub - present and titled, members: None.
        let vet = store.taxonomies().create("Vet Notes").await.unwrap();
        store
            .taxonomies()
            .place(&vet, &root, &anatomy, None)
            .await
            .unwrap();
        store
            .taxonomies()
            .place(&book, &root, &vet, None)
            .await
            .unwrap();
        let tree = store.taxonomies().tree(&book).await.unwrap();
        let members = tree.members.as_ref().unwrap();
        let first = members[1].taxonomy.as_ref().unwrap();
        let via_vet = members[2]
            .taxonomy
            .as_ref()
            .unwrap()
            .members
            .as_ref()
            .unwrap()[0]
            .taxonomy
            .as_ref()
            .unwrap();
        assert!(first.members.is_some());
        assert_eq!(via_vet.title, "Horse Anatomy", "the stub keeps its title");
        assert!(
            via_vet.members.is_none(),
            "the diamond's second visit is a stub"
        );
    }

    #[tokio::test]
    async fn a_merge_created_cycle_renders_as_a_stub_not_a_hang() {
        let store = test_store().await;
        let root = store.root;
        let a = store.taxonomies().create("A").await.unwrap();
        let b = store.taxonomies().create("B").await.unwrap();
        store.taxonomies().place(&a, &root, &b, None).await.unwrap();

        // The other device's half of the loop: B > A, written directly past the local check
        // (exactly what a sync merge delivers - each side's write was locally innocent).
        store
            .write_private(
                service::DOC_META_PRIVATE,
                PrivatePlain {
                    kind: PrivateKind::SetAdd,
                    collection: tax_collection(&b),
                    key: member_element(&root, &a),
                    value: Some("i".to_string()),
                },
            )
            .await
            .unwrap();

        let tree = store.taxonomies().tree(&a).await.unwrap();
        let b_node = tree.members.as_ref().unwrap()[0].taxonomy.as_ref().unwrap();
        let a_again = b_node.members.as_ref().unwrap()[0]
            .taxonomy
            .as_ref()
            .unwrap();
        assert_eq!(a_again.taxonomy_id, a);
        assert!(
            a_again.members.is_none(),
            "the loop closes as a stub, visibly"
        );
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
