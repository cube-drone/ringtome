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
use ringtome_proto::registry::{doc_format, entry_type, service};
use ringtome_proto::{DocHeaderPlain, Payload, PrivateRecord, SigningKey};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::files::FileStore;
use crate::private::{decrypt_doc_header, encrypt_doc_header, EpochKeys};

/// A document's body format. Plaintext is the default (absent on the wire); the enum grows
/// additively. Governs how the body is rendered and, for the text formats, merged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Plaintext,
    Marquee,
    /// A WebP image - the first *media* format. Opaque bytes: no line-merge, no inline conflict,
    /// served natively. (Text is the only substrate with multiple mergeable grammars; a media
    /// type is self-describing - it IS its format.)
    Webp,
}

impl Format {
    /// From the header's raw `format` field. Absent = plaintext; an unknown id degrades to
    /// plaintext (safe: the source is shown, never mis-rendered as a format we don't have).
    pub fn from_wire(w: Option<u64>) -> Self {
        match w {
            Some(doc_format::MARQUEE) => Format::Marquee,
            Some(doc_format::WEBP) => Format::Webp,
            _ => Format::Plaintext,
        }
    }

    pub fn to_wire(self) -> Option<u64> {
        match self {
            Format::Plaintext => None,
            Format::Marquee => Some(doc_format::MARQUEE),
            Format::Webp => Some(doc_format::WEBP),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Plaintext => "plaintext",
            Format::Marquee => "marquee",
            Format::Webp => "webp",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plaintext" => Some(Format::Plaintext),
            "marquee" => Some(Format::Marquee),
            "webp" => Some(Format::Webp),
            _ => None,
        }
    }

    /// Text formats merge line-wise and present conflicts inline; media formats are opaque
    /// (keep-both on divergence, served as bytes). This is the behavioral fork.
    pub fn is_mergeable_text(self) -> bool {
        matches!(self, Format::Plaintext | Format::Marquee)
    }

    /// The Content-Type for serving this body as bytes.
    pub fn mime(self) -> &'static str {
        match self {
            Format::Plaintext => "text/plain; charset=utf-8",
            Format::Marquee => "text/plain; charset=utf-8",
            Format::Webp => "image/webp",
        }
    }
}

/// One decrypted version of a document, as materialized.
#[derive(Debug, Clone)]
pub struct Version {
    /// The version's identity: its entry hash.
    pub hash: [u8; 32],
    pub header: DocHeaderPlain,
    /// The entry's claimed timestamp - display ordering only, never load-bearing (No Clocks).
    pub timestamp_ms: i64,
    /// The leaf key that signed this version - which device wrote it. Free attribution for
    /// conflict labels (chains are per-key, keys are per-device).
    pub author: [u8; 32],
}

/// One document: every decryptable version, threaded into a DAG.
#[derive(Debug, Default, Clone)]
pub struct Doc {
    pub versions: BTreeMap<[u8; 32], Version>,
    /// The DAG's true heads: versions no other version names as a parent. These are the
    /// `parents` a client's next save must list - folded heads included - so the fork heals
    /// through an ordinary write (commit-on-next-save).
    pub heads: Vec<[u8; 32]>,
    /// The heads after read-time mop-up: identical twins collapsed, ancestor echoes folded.
    /// What the user sees. Divergence is judged here - a fork whose sides carry the same words
    /// is not a decision anyone should be asked to make.
    pub logical_heads: Vec<[u8; 32]>,
}

impl Doc {
    /// Divergence as the USER experiences it: more than one logical head. The DAG may hold
    /// more heads than this; the extras carry no distinct words.
    pub fn diverged(&self) -> bool {
        self.logical_heads.len() > 1
    }

    /// The head to show by default: latest claimed timestamp, entry hash as the deterministic
    /// tiebreak - cosmetic choice only, every logical head stays a tap away.
    pub fn display_head(&self) -> Option<&Version> {
        self.logical_heads
            .iter()
            .filter_map(|h| self.versions.get(h))
            .max_by_key(|v| (v.timestamp_ms, v.hash))
    }

    /// A version's substance: what the mop-up rungs compare. Body fingerprint AND title - a
    /// rename is real content, so a head that only renamed never folds.
    fn content_of(&self, hash: &[u8; 32]) -> Option<([u8; 32], &str)> {
        self.versions
            .get(hash)
            .map(|v| (v.header.body_hash, v.header.title.as_str()))
    }

    /// All proper ancestors of a version we hold headers for (walks stop at retention gaps).
    fn ancestors(&self, of: &[u8; 32]) -> HashSet<[u8; 32]> {
        let mut out = HashSet::new();
        let mut stack: Vec<[u8; 32]> = self
            .versions
            .get(of)
            .map(|v| v.header.parents.clone())
            .unwrap_or_default();
        while let Some(h) = stack.pop() {
            if out.insert(h) {
                if let Some(v) = self.versions.get(&h) {
                    stack.extend(v.header.parents.iter().copied());
                }
            }
        }
        out
    }

    /// The fork point(s) of two versions: their *maximal* common ancestors - common ancestors
    /// no other common ancestor descends from. Usually exactly one; criss-cross histories can
    /// produce several, and the echo rung then requires ALL of them to match (conservative:
    /// when in doubt, stay diverged - keep-both never loses words).
    fn fork_points(&self, a: &[u8; 32], b: &[u8; 32]) -> Vec<[u8; 32]> {
        let ancestors_a = self.ancestors(a);
        let ancestors_b = self.ancestors(b);
        let common: Vec<[u8; 32]> = ancestors_a.intersection(&ancestors_b).copied().collect();
        common
            .iter()
            .copied()
            .filter(|c| !common.iter().any(|d| d != c && self.ancestors(d).contains(c)))
            .collect()
    }

    /// The read-time mop-up (NOTES_APP, The sync model): fold away DAG heads that carry no
    /// distinct words. Deterministic over chain data alone, so every device derives the same
    /// answer; nothing is written - the DAG heals when the next ordinary save lists all DAG
    /// heads as parents.
    fn compute_logical_heads(&mut self) {
        // Rung 1 - identical twins: heads with the same substance collapse to one
        // representative (latest stamp, hash tiebreak - same cosmetic order as display).
        let mut groups: BTreeMap<([u8; 32], String), [u8; 32]> = BTreeMap::new();
        for h in &self.heads {
            let Some(v) = self.versions.get(h) else {
                continue;
            };
            let key = (v.header.body_hash, v.header.title.clone());
            match groups.get(&key) {
                Some(cur) => {
                    let cur_v = &self.versions[cur];
                    if (v.timestamp_ms, v.hash) > (cur_v.timestamp_ms, cur_v.hash) {
                        groups.insert(key, *h);
                    }
                }
                None => {
                    groups.insert(key, *h);
                }
            }
        }
        let mut logical: Vec<[u8; 32]> = groups.into_values().collect();
        logical.sort();

        // Rung 2 - ancestor echoes: a head whose substance equals the fork point it shares
        // with a surviving sibling contributed nothing relative to that fork - exactly diff3's
        // degenerate case - and folds away. Content matching a DEEPER ancestor than the fork
        // point does not fold: relative to the fork, that side changed something too.
        loop {
            let mut folded = None;
            'search: for (i, h) in logical.iter().enumerate() {
                if logical.len() < 2 {
                    break;
                }
                for other in logical.iter().filter(|o| *o != h) {
                    let forks = self.fork_points(h, other);
                    if !forks.is_empty()
                        && forks
                            .iter()
                            .all(|f| self.content_of(f) == self.content_of(h))
                    {
                        folded = Some(i);
                        break 'search;
                    }
                }
            }
            match folded {
                Some(i) => {
                    logical.remove(i);
                }
                None => break,
            }
        }
        self.logical_heads = logical;
    }
}

/// The materialized notes view: every document this identity's chains hold, keyed by doc_id.
#[derive(Debug, Default)]
pub struct DocumentsView {
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
    /// A document's format is set at creation and carried, unchanged, on every save (a silent
    /// plaintext→marquee reinterpretation would sprout bullets from a `*`; conversion is a
    /// future explicit act). The client asserts it, like `parents`.
    pub format: Format,
}

/// Save one version of a document: body into the file layer, header onto the notes chain.
/// Returns the new version's hash (the client's next `parents` entry).
///
/// **The no-op bounce**: an ordinary save (exactly one parent) whose body fingerprint and title
/// both match that parent writes nothing and returns the parent's hash - the chain never grows
/// for a save that adds no words. The client's dirty check should prevent most of these; the
/// bounce is the node-side floor under impolite clients. (A save matching a *deeper* ancestor is
/// NOT bounced: an edit-then-revert is a real event the user performed, and its parent differs.)
pub async fn save_version(
    db: &SqlitePool,
    signer: &SigningKey,
    keys: &EpochKeys,
    files: &FileStore,
    save: Save,
) -> Result<[u8; 32], AppError> {
    let body_hash = DocHeaderPlain::body_hash(&save.doc_id, &save.body);
    let (epoch, epoch_key) = keys
        .current()
        .ok_or_else(|| AppError::Internal(anyhow!("no epoch key to write under")))?;

    let view = materialize(db, keys).await?;
    let doc = view.docs.get(&save.doc_id);

    // The no-op bounce: an ordinary save whose fingerprint and title match its own parent.
    if let [parent] = save.parents.as_slice() {
        if let Some(version) = doc.and_then(|d| d.versions.get(parent)) {
            if version.header.body_hash == body_hash && version.header.title == save.title {
                return Ok(*parent);
            }
        }
    }

    // Blob reuse: identical content ANYWHERE in this document's history (a revert, an edit
    // walked back) points at the existing blob instead of encrypting a fresh ciphertext - the
    // fingerprint proves equality without touching the bytes, so the storage that random-nonce
    // encryption "cost" comes back exactly where the encrypted headers can vouch for it.
    // (Scoped to one document by construction: body_hash is doc_id-keyed.)
    let file_hash = match doc.and_then(|d| {
        d.versions
            .values()
            .find(|v| v.header.body_hash == body_hash)
            .map(|v| v.header.file_hash)
    }) {
        Some(existing) => existing,
        None => *files
            .put_encrypted(epoch, &epoch_key, &save.body)
            .await?
            .as_bytes(),
    };

    let header = DocHeaderPlain {
        doc_id: save.doc_id,
        parents: save.parents,
        file_hash,
        body_hash,
        title: save.title,
        format: save.format.to_wire(),
    };
    let record = encrypt_doc_header(epoch, &epoch_key, &header)?;
    let payload = record
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding doc header record: {e}")))?;
    let signed = crate::imaol::append(
        db,
        signer,
        service::DOCUMENTS_PRIVATE,
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
pub async fn materialize(db: &SqlitePool, keys: &EpochKeys) -> Result<DocumentsView, AppError> {
    let entries =
        crate::imaol::entries_of_type(db, service::DOCUMENTS_PRIVATE, entry_type::DOC_HEADER).await?;

    let mut view = DocumentsView::default();
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
                        author: signed.entry().chain.author,
                    },
                );
            }
            None => view.undecryptable += 1,
        }
    }

    // Heads: versions no other version of the same doc names as a parent. A parent hash we
    // don't hold (retention dropped it, or it hasn't synced yet) still counts as claimed - the
    // child is a head either way. Then the mop-up: which heads carry distinct words.
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
        doc.compute_logical_heads();
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

/// The synthesized "current text" of a document - what an editor opens (NOTES_APP, The sync
/// model: conflicts are presented IN the document; there is no merge UI, ever).
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution {
    /// One logical head: its body, verbatim.
    Single,
    /// Divergence resolved by clean three-way merge: edits didn't overlap, every line from
    /// both sides is present. Rung 3 rides along: a title renamed on one side while the body
    /// changed on the other merges field-wise.
    Merged,
    /// Genuine overlap: the body carries the conflict inline, git-style, with device labels.
    /// The user resolves by editing - the tangle is text, never a UI.
    Conflict,
}

#[derive(Debug)]
pub struct ResolvedDoc {
    pub resolution: Resolution,
    pub title: String,
    /// `None` only when bodies this resolution needs aren't on this node yet.
    pub body: Option<String>,
}

/// A conflict side's label: which device, when. Cozy names are the UI's job; this is honest.
fn side_label(v: &Version) -> String {
    format!("device {} at {}", hex::encode(&v.author[..4]), v.timestamp_ms)
}

/// Present a conflict as *whole* alternatives - the shape used when three-way merge can't run
/// (no usable fork point, or more than two heads), and the *only* shape for Marquee (which gets
/// real vocabulary rather than markers). Degraded relative to per-hunk, still lossless. Text
/// only: `resolve` returns before this for media (which has no synthesized-text conflict).
fn whole_version_conflict(format: Format, sides: &[(&Version, String)]) -> String {
    match format {
        Format::Webp => unreachable!("media conflicts are keep-both, never synthesized text"),
        // Git-style marker fences: every side in full.
        Format::Plaintext => {
            let mut out = String::new();
            for (i, (v, body)) in sides.iter().enumerate() {
                out.push_str(&format!("<<<<<<< {}\n", side_label(v)));
                out.push_str(body);
                if !body.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(if i + 1 == sides.len() { ">>>>>>>\n" } else { "=======\n" });
            }
            out
        }
        // Marquee vocabulary: a `:::conflict` wrapping one `:::version` per side. An unknowing
        // renderer shrugs and shows every version's children in full - the degraded conflict is
        // still a lossless conflict (REQUEST_conflict_vocabulary.md, over in marquee).
        Format::Marquee => {
            let mut out = String::from(":::conflict\n");
            for (v, body) in sides {
                out.push_str(&format!(
                    ":::version label=\"{}\" when={}\n",
                    side_label(v),
                    v.timestamp_ms
                ));
                out.push_str(body);
                if !body.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("::: version\n");
            }
            out.push_str("::: conflict\n");
            out
        }
    }
}

/// Synthesize the document's current text from its logical heads. Deterministic over chain
/// data + bodies alone, so every device derives the same answer; nothing is written -
/// resolution commits when the user next saves (parents = all DAG heads).
pub async fn resolve(
    files: &FileStore,
    keys: &EpochKeys,
    doc: &Doc,
) -> Result<ResolvedDoc, AppError> {
    // Deterministic side order: oldest claimed stamp first (hash tiebreak).
    let mut heads: Vec<&Version> = doc
        .logical_heads
        .iter()
        .filter_map(|h| doc.versions.get(h))
        .collect();
    heads.sort_by_key(|v| (v.timestamp_ms, v.hash));

    let display_title = doc
        .display_head()
        .map(|v| v.header.title.clone())
        .unwrap_or_default();
    // The document's format governs presentation. Read from the display head; a document's
    // versions all carry the same format.
    let format = Format::from_wire(doc.display_head().and_then(|v| v.header.format));

    // Media bodies are opaque: no line-merge, no synthesized conflict text (you can't merge two
    // images, or inline a webp into JSON). One logical head or keep-both; the bytes are served
    // separately via the binary endpoint. Never run diffy/utf8 over binary.
    if !format.is_mergeable_text() {
        let resolution = if doc.logical_heads.len() > 1 {
            Resolution::Conflict
        } else {
            Resolution::Single
        };
        return Ok(ResolvedDoc {
            resolution,
            title: display_title,
            body: None,
        });
    }

    let [a, b] = match heads.as_slice() {
        [] => {
            return Ok(ResolvedDoc {
                resolution: Resolution::Single,
                title: display_title,
                body: None,
            })
        }
        [only] => {
            return Ok(ResolvedDoc {
                resolution: Resolution::Single,
                title: display_title,
                body: read_body(files, keys, only)
                    .await?
                    .map(|b| String::from_utf8_lossy(&b).into_owned()),
            })
        }
        [a, b] => [*a, *b],
        // Three-plus logical heads: the whole-document conflict, every side in full.
        many => {
            let mut sides = Vec::new();
            for v in many {
                let Some(body) = read_body(files, keys, v).await? else {
                    return Ok(ResolvedDoc {
                        resolution: Resolution::Conflict,
                        title: display_title,
                        body: None,
                    });
                };
                sides.push((*v, String::from_utf8_lossy(&body).into_owned()));
            }
            return Ok(ResolvedDoc {
                resolution: Resolution::Conflict,
                title: display_title,
                body: Some(whole_version_conflict(format, &sides)),
            });
        }
    };

    let (Some(body_a), Some(body_b)) = (read_body(files, keys, a).await?, read_body(files, keys, b).await?)
    else {
        return Ok(ResolvedDoc {
            resolution: Resolution::Conflict,
            title: display_title,
            body: None,
        });
    };
    let (text_a, text_b) = (
        String::from_utf8_lossy(&body_a).into_owned(),
        String::from_utf8_lossy(&body_b).into_owned(),
    );

    // The fork point's body is the three-way base. Exactly one usable fork point, body in
    // hand, or we degrade to the whole-document conflict - conservative, lossless.
    let base = match doc.fork_points(&a.hash, &b.hash).as_slice() {
        [one] => match doc.versions.get(one) {
            Some(fork) => read_body(files, keys, fork)
                .await?
                .map(|b| String::from_utf8_lossy(&b).into_owned()),
            None => None,
        },
        _ => None,
    };
    let Some(base) = base else {
        return Ok(ResolvedDoc {
            resolution: Resolution::Conflict,
            title: display_title,
            body: Some(whole_version_conflict(format, &[(a, text_a), (b, text_b)])),
        });
    };

    // Rung 3, field-wise title: if exactly one side renamed (relative to the fork point),
    // the rename wins; if both did, the display head's title stands (recoverable - titles
    // never lose words, bodies are the guarantee).
    let fork_title = doc
        .fork_points(&a.hash, &b.hash)
        .first()
        .and_then(|f| doc.versions.get(f))
        .map(|v| v.header.title.clone())
        .unwrap_or_default();
    let title = match (a.header.title != fork_title, b.header.title != fork_title) {
        (true, false) => a.header.title.clone(),
        (false, true) => b.header.title.clone(),
        _ => display_title,
    };

    // Rung 4: three-way line merge, which is format-agnostic (Marquee source is still lines).
    // Clean = every line from both sides present, nobody asked anything. Overlap presents the
    // conflict - inline per-hunk markers for plaintext, whole-version `:::conflict` vocabulary
    // for Marquee (its markers-are-vocabulary is the whole reason we split the formats).
    match diffy::merge(&base, &text_a, &text_b) {
        Ok(merged) => Ok(ResolvedDoc {
            resolution: Resolution::Merged,
            title,
            body: Some(merged),
        }),
        Err(marked) => Ok(ResolvedDoc {
            resolution: Resolution::Conflict,
            title,
            body: Some(match format {
                Format::Plaintext => marked
                    .replace("<<<<<<< ours", &format!("<<<<<<< {}", side_label(a)))
                    .replace(">>>>>>> theirs", &format!(">>>>>>> {}", side_label(b))),
                Format::Marquee => whole_version_conflict(format, &[(a, text_a), (b, text_b)]),
                Format::Webp => unreachable!("media never reaches text merge"),
            }),
        }),
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
                format: Format::Plaintext,
            },
        )
        .await
        .unwrap()
    }

    /// Save helper that lets a test pick the format (for the Marquee conflict tests).
    async fn save_fmt(
        db: &SqlitePool,
        key: &SigningKey,
        keys: &EpochKeys,
        files: &FileStore,
        doc_id: [u8; 16],
        parents: Vec<[u8; 32]>,
        title: &str,
        body: &[u8],
        format: Format,
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
                format,
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
    async fn no_op_saves_bounce_but_reverts_do_not() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"start").await;

        // Identical content + title against the same parent: bounced - the parent's own hash
        // comes back and the chain does not grow.
        let bounced = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"start").await;
        assert_eq!(bounced, v1);
        let view = materialize(&db, &keys).await.unwrap();
        assert_eq!(view.docs.get(&doc_id).unwrap().versions.len(), 1);

        // A title-only change is a real save.
        let renamed = save(&db, &key, &keys, &files, doc_id, vec![v1], "t2", b"start").await;
        assert_ne!(renamed, v1);

        // Edit, then revert to the ORIGINAL content: parent is the edit, so this is a real
        // event, not a no-op - the revert must be written (content matches the grandparent,
        // never the parent).
        let edited = save(&db, &key, &keys, &files, doc_id, vec![renamed], "t2", b"start, oops").await;
        let reverted = save(&db, &key, &keys, &files, doc_id, vec![edited], "t2", b"start").await;
        assert_ne!(reverted, edited);
        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.versions.len(), 4);
        assert_eq!(doc.heads, vec![reverted]);

        // And the revert REUSED the original blob: same content, same file - a fresh encrypt
        // would necessarily differ (random nonce), so hash equality proves no new blob.
        assert_eq!(
            doc.versions.get(&reverted).unwrap().header.file_hash,
            doc.versions.get(&v1).unwrap().header.file_hash,
        );
    }

    /// Notes are private: their entries AND their frontiers stay behind the member proof. A
    /// stranger syncing public chains must see no evidence the notes chain exists.
    #[tokio::test]
    async fn notes_chains_are_withheld_from_unproven_peers() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        save(&db, &key, &keys, &files, doc_id, vec![], "secret", b"words").await;

        let public = crate::sync::local_frontiers(&db, false).await.unwrap();
        assert!(
            !public
                .iter()
                .any(|f| f.service == ringtome_proto::registry::service::DOCUMENTS_PRIVATE),
            "notes frontiers must not be offered to unproven peers"
        );
        let member = crate::sync::local_frontiers(&db, true).await.unwrap();
        assert!(member
            .iter()
            .any(|f| f.service == ringtome_proto::registry::service::DOCUMENTS_PRIVATE));
    }

    /// Rung 1: the same fix made on two devices before they synced. Two DAG heads, identical
    /// words - not a decision anyone should be asked to make.
    #[tokio::test]
    async fn identical_twins_collapse_to_one_logical_head() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"start").await;
        // Both "devices" apply the same edit from the same parent (each dodges the bounce:
        // the content differs from v1).
        let a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"start, fixed").await;
        let b = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"start, fixed").await;
        assert_ne!(a, b, "distinct saves, distinct versions");

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.heads.len(), 2, "the DAG truthfully holds both");
        assert_eq!(doc.logical_heads.len(), 1, "the words diverged zero ways");
        assert!(!doc.diverged());
    }

    /// Rung 2: edit-then-revert on one side while the other side wrote something real. The
    /// revert equals the fork point, contributed nothing, and folds - diff3's degenerate case.
    #[tokio::test]
    async fn ancestor_echo_folds_away() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"start").await;
        let pc = save(
            &db, &key, &keys, &files, doc_id, vec![v1], "t", b"start, then an afternoon",
        )
        .await;
        // The phone: a real edit, then a revert back to the fork point's exact content.
        let typo = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"start, typo").await;
        let revert = save(&db, &key, &keys, &files, doc_id, vec![typo], "t", b"start").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let mut dag_heads = doc.heads.clone();
        dag_heads.sort();
        let mut expect = vec![pc, revert];
        expect.sort();
        assert_eq!(dag_heads, expect, "the DAG truthfully holds both");
        assert_eq!(doc.logical_heads, vec![pc], "the echo folds; the afternoon stands");
        assert!(!doc.diverged());
    }

    /// A revert to a DEEPER ancestor than the fork point is a real choice: relative to the
    /// fork, both sides changed something. Stays diverged - keep-both never loses words.
    #[tokio::test]
    async fn revert_past_the_fork_point_stays_diverged() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v0 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"draft one").await;
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![v0], "t", b"draft two").await;
        // Fork at v1: one side writes on; the other reverts all the way to v0's content.
        let _on = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"draft three").await;
        let _back = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"draft one").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.logical_heads.len(), 2, "both sides changed the fork's content");
        assert!(doc.diverged());
    }

    /// A rename is real content: body echoing the fork point does NOT fold when the title
    /// changed (that's rung 3's orthogonal merge, later - never the janitor's call).
    #[tokio::test]
    async fn title_change_never_folds() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"start").await;
        let _pc = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"start, more").await;
        let typo = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"start, typo").await;
        let _renamed_revert =
            save(&db, &key, &keys, &files, doc_id, vec![typo], "better title", b"start").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.logical_heads.len(), 2, "the rename survives as its own head");
        assert!(doc.diverged());
    }

    async fn resolve_doc(
        db: &SqlitePool,
        keys: &EpochKeys,
        files: &FileStore,
        doc_id: &[u8; 16],
    ) -> ResolvedDoc {
        let view = materialize(db, keys).await.unwrap();
        resolve(files, keys, view.docs.get(doc_id).unwrap())
            .await
            .unwrap()
    }

    /// Rung 4, the clean case: edits to different lines weave together with nobody asked.
    #[tokio::test]
    async fn non_overlapping_edits_merge_clean() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"alpha\nbeta\ngamma\n").await;
        let _a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"ALPHA\nbeta\ngamma\n").await;
        let _b = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"alpha\nbeta\nGAMMA\n").await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Merged);
        assert_eq!(r.body.unwrap(), "ALPHA\nbeta\nGAMMA\n", "both edits present, no questions");
    }

    /// Rung 5: the same line edited both ways - the conflict rides inline, labeled, and both
    /// sides' words are in the text.
    #[tokio::test]
    async fn overlapping_edits_present_the_conflict_in_the_document() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"the hat is red\n").await;
        let _a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"the hat is blue\n").await;
        let _b = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"the hat is green\n").await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(body.contains("the hat is blue"), "ours present:\n{body}");
        assert!(body.contains("the hat is green"), "theirs present:\n{body}");
        assert!(body.contains("<<<<<<<") && body.contains(">>>>>>>"), "markers present:\n{body}");
        assert!(body.contains("device "), "sides carry device labels:\n{body}");
    }

    /// Rung 3: a rename on one side, a body edit on the other - orthogonal fields, both win.
    #[tokio::test]
    async fn rename_and_edit_merge_field_wise() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "scratch", b"alpha\nbeta\n").await;
        let _rename = save(&db, &key, &keys, &files, doc_id, vec![v1], "the hat essay", b"alpha\nbeta\n").await;
        let _edit = save(&db, &key, &keys, &files, doc_id, vec![v1], "scratch", b"alpha\nbeta\nnew line\n").await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Merged);
        assert_eq!(r.title, "the hat essay", "the rename wins the title");
        assert_eq!(r.body.unwrap(), "alpha\nbeta\nnew line\n", "the edit wins the body");
    }

    /// Three-plus genuinely distinct heads: the whole-document conflict - every side in full.
    /// Degraded, still lossless.
    #[tokio::test]
    async fn three_way_divergence_presents_every_side() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"base\n").await;
        for body in [b"base one\n".as_slice(), b"base two\n", b"base three\n"] {
            save(&db, &key, &keys, &files, doc_id, vec![v1], "t", body).await;
        }

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        for text in ["base one", "base two", "base three"] {
            assert!(body.contains(text), "{text} present:\n{body}");
        }
    }

    /// The reason the formats split: a Marquee document presents a conflict with `:::conflict`
    /// vocabulary, not git markers - and both sides' words are inside, so the unknowing-renderer
    /// shrug is still lossless.
    #[tokio::test]
    async fn marquee_conflicts_use_directive_vocabulary_not_markers() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let m = Format::Marquee;
        let v1 = save_fmt(&db, &key, &keys, &files, doc_id, vec![], "t", b"the hat is *red*\n", m).await;
        let _a = save_fmt(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"the hat is *blue*\n", m).await;
        let _b = save_fmt(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"the hat is *green*\n", m).await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(body.contains(":::conflict"), "marquee vocabulary, not markers:\n{body}");
        assert!(body.contains(":::version"), "one version block per side:\n{body}");
        assert!(!body.contains("<<<<<<<"), "no git markers in a marquee doc:\n{body}");
        assert!(body.contains("*blue*") && body.contains("*green*"), "both sides' words present");
    }

    /// The same divergence in a plaintext doc gets git markers, not directives - the split is
    /// real and dispatched on `format`.
    #[tokio::test]
    async fn plaintext_conflicts_use_markers_not_directives() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"the hat is red\n").await;
        let _a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"the hat is blue\n").await;
        let _b = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"the hat is green\n").await;

        let body = resolve_doc(&db, &keys, &files, &doc_id).await.body.unwrap();
        assert!(body.contains("<<<<<<<"), "plaintext gets markers:\n{body}");
        assert!(!body.contains(":::conflict"), "and never marquee vocabulary");
    }

    /// The image case: a binary body round-trips as a document, byte-for-byte, and `resolve`
    /// never touches the bytes (no utf8, no diffy). WebP magic + some non-utf8 bytes.
    #[tokio::test]
    async fn webp_body_round_trips_and_resolve_leaves_binary_alone() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        // RIFF....WEBP header + bytes that are deliberately not valid UTF-8 (0xFF, 0xFE).
        let webp = [
            b"RIFF".as_slice(),
            &[0x1a, 0x00, 0x00, 0x00],
            b"WEBP",
            &[0xff, 0xfe, 0x00, 0x80, 0x7f],
        ]
        .concat();

        let doc_id = new_doc_id();
        let v1 = save_fmt(&db, &key, &keys, &files, doc_id, vec![], "sunset", &webp, Format::Webp).await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let head = doc.display_head().unwrap();
        assert_eq!(head.header.format, Some(2), "recorded as webp");

        // Byte-identical round trip.
        let got = read_body(&files, &keys, head).await.unwrap().unwrap();
        assert_eq!(got, webp, "the image comes back exactly");

        // resolve() must NOT mangle the binary: single head, no synthesized body.
        let r = resolve(&files, &keys, doc).await.unwrap();
        assert_eq!(r.resolution, Resolution::Single);
        assert_eq!(r.body, None, "binary is served separately, not inlined");

        // Diverge it: two different images from one parent. Keep-both, still no merge attempt.
        let other = [b"RIFF\x1a\x00\x00\x00WEBP".as_slice(), &[0x01, 0x02, 0x03]].concat();
        let _a = save_fmt(&db, &key, &keys, &files, doc_id, vec![v1], "sunset", &other, Format::Webp).await;
        let _b = save_fmt(&db, &key, &keys, &files, doc_id, vec![v1], "sunset", &webp[..webp.len() - 1], Format::Webp).await;
        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let r = resolve(&files, &keys, doc).await.unwrap();
        assert_eq!(r.resolution, Resolution::Conflict, "two images diverge -> keep both");
        assert!(doc.diverged());
    }

    // -------------------------------------------------------------------------------------
    // Adversarial cases: malformed DAGs, degenerate merges, and determinism.

    /// A client asserts a parent that does not exist (GC'd, or a bug). Must not panic, must
    /// treat the child as a head, must degrade to a conflict presentation (no fork point) - and
    /// crucially must never lose the child's words.
    #[tokio::test]
    async fn orphan_parent_is_a_head_and_degrades_safely() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let real = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"real start").await;
        // Sibling claims a parent that was never written.
        let phantom = [0xAB; 32];
        let orphan = save(&db, &key, &keys, &files, doc_id, vec![phantom], "t", b"orphan words").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let mut heads = doc.heads.clone();
        heads.sort();
        let mut expect = vec![real, orphan];
        expect.sort();
        assert_eq!(heads, expect, "both are heads; the phantom is not");
        // No common ancestor -> conservative conflict, both bodies present.
        let r = resolve(&files, &keys, doc).await.unwrap();
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(body.contains("real start") && body.contains("orphan words"));
    }

    /// A parent hash that belongs to a DIFFERENT document. The materializer is per-doc, so it's
    /// a phantom within this doc - same safe degradation, no cross-doc leakage.
    #[tokio::test]
    async fn cross_document_parent_is_treated_as_phantom() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let other_doc = new_doc_id();
        let alien = save(&db, &key, &keys, &files, other_doc, vec![], "other", b"other doc body").await;

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"mine").await;
        let child = save(&db, &key, &keys, &files, doc_id, vec![alien], "t", b"mine, edited").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        // v1 and child are both heads (child's only claimed parent lives in another doc).
        assert_eq!(doc.versions.len(), 2, "the alien parent is not pulled into this doc");
        assert!(doc.heads.contains(&v1) && doc.heads.contains(&child));
        let r = resolve(&files, &keys, doc).await.unwrap();
        assert!(r.body.unwrap().contains("mine, edited"), "no words lost");
    }

    /// A genuine echo cascade: two reverts at DIFFERENT depths both fold, leaving the one real
    /// head. (Same-depth echoes would be twins and collapse in rung 1 instead - a cascade only
    /// exists across depths, which is the case worth stressing for termination.)
    #[tokio::test]
    async fn echo_cascade_at_different_depths_folds_to_the_real_head() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"base").await;
        let v2 = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"level two").await;
        let real = save(&db, &key, &keys, &files, doc_id, vec![v2], "t", b"the real thing").await;
        // Each echo is an edit-then-revert (the only shape the no-op bounce lets through): the
        // parent differs, but the content lands back on a fork point. One reverts to v1's
        // content, one to v2's - distinct content, distinct fork depths, so they're not twins.
        let junk_a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"typo a").await;
        let _shallow = save(&db, &key, &keys, &files, doc_id, vec![junk_a], "t", b"base").await;
        let junk_b = save(&db, &key, &keys, &files, doc_id, vec![v2], "t", b"typo b").await;
        let _deep = save(&db, &key, &keys, &files, doc_id, vec![junk_b], "t", b"level two").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.heads.len(), 3, "three live heads: real + two reverts");
        assert_eq!(doc.logical_heads, vec![real], "both echoes fold; the real head stands");
        assert!(!doc.diverged());
    }

    /// The termination guard: many same-content heads. Rung 1 collapses the twins; the fold
    /// never empties the set, and picks the same survivor every run.
    #[tokio::test]
    async fn twin_storm_keeps_exactly_one_deterministically() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"base").await;
        // Five devices independently make the identical edit from v1: five twins.
        for _ in 0..5 {
            save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"base, fixed").await;
        }

        let a = materialize(&db, &keys).await.unwrap();
        let b = materialize(&db, &keys).await.unwrap();
        let da = a.docs.get(&doc_id).unwrap();
        assert_eq!(da.heads.len(), 5, "the DAG holds all five");
        assert_eq!(da.logical_heads.len(), 1, "one survivor, never zero");
        assert_eq!(
            da.logical_heads,
            b.docs.get(&doc_id).unwrap().logical_heads,
            "and the same one every time"
        );
    }

    /// Criss-cross history: two heads share *two* maximal common ancestors. The fold requires
    /// ALL fork points to match, and resolve() degrades a multi-fork merge to a whole-document
    /// conflict - conservative, never a silent wrong merge.
    #[tokio::test]
    async fn criss_cross_history_degrades_conservatively() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        // Two roots (both genesis - no parents), then two children each merging both roots.
        let r1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"root one").await;
        let r2 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"root two").await;
        let m1 = save(&db, &key, &keys, &files, doc_id, vec![r1, r2], "t", b"merge left").await;
        let m2 = save(&db, &key, &keys, &files, doc_id, vec![r1, r2], "t", b"merge right").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let mut heads = doc.heads.clone();
        heads.sort();
        let mut expect = vec![m1, m2];
        expect.sort();
        assert_eq!(heads, expect);
        assert_eq!(doc.fork_points(&m1, &m2).len(), 2, "two maximal common ancestors");
        let r = resolve(&files, &keys, doc).await.unwrap();
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(body.contains("merge left") && body.contains("merge right"));
    }

    /// A body that literally contains conflict markers. Single head: verbatim round-trip
    /// (markers are never parsed back). Diverged: still lossless, if visually gnarly.
    #[tokio::test]
    async fn body_containing_markers_round_trips_and_never_reparses() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let sneaky = "notes on git:\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>>\n";
        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", sneaky.as_bytes()).await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Single);
        assert_eq!(r.body.unwrap(), sneaky, "marker-laden prose survives verbatim");

        // Now force a real conflict on top - must still contain both bodies' words.
        let _a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", "one edit\n".as_bytes()).await;
        let _b = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", "other edit\n".as_bytes()).await;
        let r2 = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert!(r2.body.unwrap().contains("one edit") || r2.resolution == Resolution::Conflict);
    }

    /// One side deletes everything, the other edits. Must not panic and must not lose the
    /// surviving side's words (whether diffy calls it merged or conflict).
    #[tokio::test]
    async fn empty_side_merge_loses_nothing() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"keep\nthis\n").await;
        let _cleared = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"").await;
        let _added = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"keep\nthis\nand more\n").await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert!(r.body.is_some(), "a body was produced, no panic");
        assert!(r.body.unwrap().contains("and more"), "the added words survive");
    }

    /// A fork off a MID-HISTORY version (not a current head) still diverges correctly.
    #[tokio::test]
    async fn fork_from_deep_in_history() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"one\n").await;
        let v2 = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"one\ntwo\n").await;
        let _v3 = save(&db, &key, &keys, &files, doc_id, vec![v2], "t", b"one\ntwo\nthree\n").await;
        // Someone forks off v1, deep behind the current head v3.
        let _alt = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"one\nBRANCH\n").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert!(doc.diverged(), "the deep fork is a real divergence");
        let body = resolve(&files, &keys, doc).await.unwrap().body.unwrap();
        assert!(body.contains("three") && body.contains("BRANCH"), "both branches present");
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
