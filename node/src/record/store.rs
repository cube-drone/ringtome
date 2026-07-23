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

use std::collections::BTreeMap;

use crate::db::Db;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Payload, PrivateKind, PrivatePlain, SignedEntry, SigningKey};
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

    /// Private facts about documents: descriptions and other per-doc fields (LWW registers),
    /// tags (LWW set-elements), grouped per document on the doc-meta chain.
    pub fn annotations(&self) -> Annotations<'_> {
        Annotations { store: self }
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
        crate::record::documents::materialize(&self.store.db, &self.store.authorship.epoch_keys)
            .await
    }

    /// The docs-list read: every document's memoized display row (`doc_heads`), newest head
    /// first, plus the undecryptable count - one query after catch-up, no full-view fold.
    pub async fn summaries(
        &self,
    ) -> Result<(Vec<crate::record::documents::DocHeadRow>, usize), AppError> {
        crate::record::documents::list_heads(&self.store.db, &self.store.authorship.epoch_keys)
            .await
    }

    /// Memoized display rows for a specific set of documents (the docs-by-tag read). Doc ids
    /// with no local row (annotated but never held) are simply absent; ordering is the caller's.
    pub async fn summaries_for(
        &self,
        doc_ids: &[[u8; 16]],
    ) -> Result<Vec<crate::record::documents::DocHeadRow>, AppError> {
        crate::record::documents::heads_for(
            &self.store.db,
            &self.store.authorship.epoch_keys,
            doc_ids,
        )
        .await
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

    /// The document's synthesized current text: one head's body verbatim, a clean three-way
    /// merge, or the conflict presented inline (NOTES_APP, The sync model).
    pub async fn resolved(
        &self,
        doc: &crate::record::documents::Doc,
    ) -> Result<crate::record::documents::ResolvedDoc, AppError> {
        crate::record::documents::resolve(&self.store.files, &self.store.authorship.epoch_keys, doc)
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

    /// All of one document's tags, merged.
    pub async fn tags(&self, doc_id: &[u8; 16]) -> Result<Vec<String>, AppError> {
        let view = self.store.doc_meta_view().await?;
        Ok(view
            .set_elements(&self.collection(doc_id))
            .into_iter()
            .map(|e| e.element)
            .collect())
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
// (`record::rank`), with the element string as deterministic tiebreak. v1 is flat lists -
// cycles unrepresentable; trees arrive with the fold-time cycle rule they require.

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
    pub async fn place(
        &self,
        taxonomy_id: &[u8; 16],
        root: &[u8; 32],
        doc_id: &[u8; 16],
        index: Option<usize>,
    ) -> Result<SignedEntry, AppError> {
        let element = member_element(root, doc_id);
        let mut list = self.members(taxonomy_id).await?;
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

        // Per-doc direction.
        let tags = store.annotations().tags(&pier).await.unwrap();
        assert_eq!(tags, vec!["beach", "sunset"]);

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
    async fn append_is_the_only_write_the_log_offers() {
        // Not a runtime test - a documentation assertion: AppendLog's public surface is
        // append + page. If an update/delete method ever appears, this comment is where the
        // argument about tombstones (PROJECT_PLAN, Open Items) is required to happen first.
        let store = test_store().await;
        let entry = store.append_post(vec![0xa0]).await.unwrap();
        assert_eq!(entry.entry().seq, 0);
    }
}
