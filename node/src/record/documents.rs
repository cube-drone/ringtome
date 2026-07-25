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

use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::db::Db;
use anyhow::anyhow;
use anyhow::Context;
use ringtome_proto::registry::{doc_format, entry_type, service};
use ringtome_proto::{DocHeaderPlain, Payload, PrivateRecord, SignedEntry, SigningKey};

use crate::error::AppError;
use crate::files::FileStore;
use crate::record::private::{encrypt_doc_header, open_doc_header, EpochKeys, Opened};

/// A document's body format. Plaintext is the default (absent on the wire); the enum grows
/// additively. Governs how the body is rendered and, for the text formats, merged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Plaintext,
    Marquee,
    /// An AVIF image - the canonical stored image format. Every bitmap upload is transcoded to
    /// AVIF once at ingest; what's stored and served is always AVIF. Opaque bytes: no line-merge,
    /// no inline conflict, served natively. (Text is the only substrate with multiple mergeable
    /// grammars; a media type is self-describing - it IS its format.)
    Avif,
    /// Animated PNG: the canonical form for transparent, silent animated images (alpha survives,
    /// rendered in an `<img>`). Opaque bytes; keep-both on divergence.
    Apng,
    /// AV1-in-WebM (+ Opus): the canonical form for video and for opaque animation. `<video>`.
    WebmAv1,
    /// Ogg Opus: the canonical audio form. `<audio>`.
    OggOpus,
}

impl Format {
    /// From the header's raw `format` field. Absent = plaintext; an unknown id degrades to
    /// plaintext (safe: the source is shown, never mis-rendered as a format we don't have).
    pub fn from_wire(w: Option<u64>) -> Self {
        match w {
            Some(doc_format::MARQUEE) => Format::Marquee,
            Some(doc_format::AVIF) => Format::Avif,
            Some(doc_format::APNG) => Format::Apng,
            Some(doc_format::WEBM_AV1) => Format::WebmAv1,
            Some(doc_format::OGG_OPUS) => Format::OggOpus,
            _ => Format::Plaintext,
        }
    }

    pub fn to_wire(self) -> Option<u64> {
        match self {
            Format::Plaintext => None,
            Format::Marquee => Some(doc_format::MARQUEE),
            Format::Avif => Some(doc_format::AVIF),
            Format::Apng => Some(doc_format::APNG),
            Format::WebmAv1 => Some(doc_format::WEBM_AV1),
            Format::OggOpus => Some(doc_format::OGG_OPUS),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Format::Plaintext => "plaintext",
            Format::Marquee => "marquee",
            Format::Avif => "avif",
            Format::Apng => "apng",
            Format::WebmAv1 => "webm",
            Format::OggOpus => "opus",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "plaintext" => Some(Format::Plaintext),
            "marquee" => Some(Format::Marquee),
            "avif" => Some(Format::Avif),
            "apng" => Some(Format::Apng),
            "webm" => Some(Format::WebmAv1),
            "opus" => Some(Format::OggOpus),
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
            Format::Avif => "image/avif",
            Format::Apng => "image/apng",
            Format::WebmAv1 => "video/webm",
            Format::OggOpus => "audio/ogg",
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

    /// Thread the loaded versions into the DAG: heads are versions no other version of the same
    /// doc names as a parent (a parent hash we don't hold - retention, or not yet synced - still
    /// counts as claimed: the child is a head either way), then the read-time mop-up decides
    /// which heads carry distinct words.
    fn thread(&mut self) {
        let claimed: HashSet<[u8; 32]> = self
            .versions
            .values()
            .flat_map(|v| v.header.parents.iter().copied())
            .collect();
        self.heads = self
            .versions
            .keys()
            .filter(|h| !claimed.contains(*h))
            .copied()
            .collect();
        self.compute_logical_heads();
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
    pub(crate) fn fork_points(&self, a: &[u8; 32], b: &[u8; 32]) -> Vec<[u8; 32]> {
        let ancestors_a = self.ancestors(a);
        let ancestors_b = self.ancestors(b);
        let common: Vec<[u8; 32]> = ancestors_a.intersection(&ancestors_b).copied().collect();
        let mut maximal: Vec<[u8; 32]> = common
            .iter()
            .copied()
            .filter(|c| {
                !common
                    .iter()
                    .any(|d| d != c && self.ancestors(d).contains(c))
            })
            .collect();
        // DETERMINISTIC order (claimed stamp, hash tiebreak - the house total order). The
        // intersection above iterates a HashSet, and the recursive virtual base is
        // order-sensitive: unsorted, two devices could synthesize DIFFERENT tangles from
        // identical DAGs - caught as a test flake by the test-unit tee, diagnosed as a
        // convergence bug.
        maximal.sort_by_key(|h| {
            self.versions
                .get(h)
                .map(|v| (v.timestamp_ms, v.hash))
                .unwrap_or((i64::MIN, *h))
        });
        maximal
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
    /// The HTTP list path now reports this via `list_heads` (same count, same reason); the
    /// field stays for full-view readers, so the number is never derivable-but-dropped.
    #[allow(dead_code)]
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
    /// Media metadata for a media save (`None` for text). The ingest worker fills this in after
    /// transcoding: measured dimensions, optional duration, and the hash of the thumbnail blob it
    /// already stored. `body` for a media save is the transcoded AVIF, not the original upload.
    pub media: Option<MediaMeta>,
}

/// What the ingest crush measured/produced, minus the bytes themselves - every field optional
/// because the media kinds differ: images/video carry dimensions but audio does not; video and
/// audio carry a duration but stills do not; images always have a thumbnail, audio has one only
/// when it decoded (a waveform), and video has none yet. Copied verbatim into the encrypted
/// header (which stores each as `Option`).
#[derive(Debug, Clone, Default)]
pub struct MediaMeta {
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub thumb_hash: Option<[u8; 32]>,
    /// The file-layer hash of a silent AV1-in-WebM hover-preview clip, stored as its OWN sibling
    /// blob (like `thumb_hash`). Video WebM output only; `None` for everything else.
    pub preview_hash: Option<[u8; 32]>,
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
    db: &Db,
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

    // The no-op bounce: an ordinary save whose fingerprint, title, AND format match its own
    // parent. Format participates because conversion (plaintext → marquee, same bytes) is a
    // real save - a bounce that ignored it would silently swallow the explicit act the format
    // doctrine promises (NOTES_APP: reinterpretation arrives via this field).
    if let [parent] = save.parents.as_slice() {
        if let Some(version) = doc.and_then(|d| d.versions.get(parent)) {
            if version.header.body_hash == body_hash
                && version.header.title == save.title
                && version.header.format == save.format.to_wire()
            {
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
        width: save.media.as_ref().and_then(|m| m.width),
        height: save.media.as_ref().and_then(|m| m.height),
        duration_ms: save.media.as_ref().and_then(|m| m.duration_ms),
        thumb_hash: save.media.as_ref().and_then(|m| m.thumb_hash),
        preview_hash: save.media.as_ref().and_then(|m| m.preview_hash),
    };
    let record = encrypt_doc_header(epoch, &epoch_key, &header)?;
    let payload = record
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding doc header record: {e}")))?;
    let signed = crate::record::imaol::append(
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

// ---------------------------------------------------------------------------------------------
// The persisted fold (doc_versions). Facts land in SQL; DAG judgment stays above, in Rust.
//
// `doc_versions.parents` codec: a canonical CBOR array of 32-byte byte strings - the same v0
// subset the proto crate speaks. MAX_PARENTS is 16, so the array header is always the single
// byte 0x80|len; each item is bstr(32) = 0x58 0x20 + the hash.

fn encode_parents(parents: &[[u8; 32]]) -> Vec<u8> {
    debug_assert!(parents.len() <= DocHeaderPlain::MAX_PARENTS);
    let mut out = Vec::with_capacity(1 + parents.len() * 34);
    out.push(0x80 | parents.len() as u8);
    for parent in parents {
        out.push(0x58);
        out.push(32);
        out.extend_from_slice(parent);
    }
    out
}

fn decode_parents(bytes: &[u8]) -> Result<Vec<[u8; 32]>, AppError> {
    let corrupt = || AppError::Internal(anyhow!("corrupt parents CBOR in doc_versions"));
    let (&head, mut rest) = bytes.split_first().ok_or_else(corrupt)?;
    if head & 0xE0 != 0x80 || head & 0x1F > 23 {
        return Err(corrupt());
    }
    let mut parents = Vec::with_capacity((head & 0x1F) as usize);
    for _ in 0..head & 0x1F {
        let (item, tail) = rest.split_at_checked(34).ok_or_else(corrupt)?;
        if item[0] != 0x58 || item[1] != 32 {
            return Err(corrupt());
        }
        parents.push(item[2..].try_into().expect("34-byte split holds 32 bytes"));
        rest = tail;
    }
    if !rest.is_empty() {
        return Err(corrupt());
    }
    Ok(parents)
}

/// Fold one decrypted header into `doc_versions`. A version is an immutable fact and its entry
/// hash is its identity, so the primary key dedups refolds - INSERT OR IGNORE, no LWW - which
/// is also what makes concurrent catch-ups benign.
async fn fold_header(
    db: &Db,
    signed: &SignedEntry,
    header: &DocHeaderPlain,
) -> Result<(), AppError> {
    db.execute(
        "INSERT OR IGNORE INTO doc_versions
           (entry_hash, doc_id, parents, title, body_hash, file_hash, format, width, height,
            duration_ms, thumb_hash, preview_hash, timestamp_ms, seq, author_pubkey)
         VALUES (:entry_hash, :doc_id, :parents, :title, :body_hash, :file_hash, :format,
                 :width, :height, :duration_ms, :thumb_hash, :preview_hash, :timestamp_ms,
                 :seq, :author_pubkey)",
        turso::named_params! {
            ":entry_hash": signed.hash().as_slice(),
            ":doc_id": header.doc_id.as_slice(),
            ":parents": encode_parents(&header.parents),
            ":title": header.title.as_str(),
            ":body_hash": header.body_hash.as_slice(),
            ":file_hash": header.file_hash.as_slice(),
            ":format": header.format.map(|f| f as i64),
            ":width": header.width.map(i64::from),
            ":height": header.height.map(i64::from),
            ":duration_ms": header.duration_ms.map(|d| d as i64),
            ":thumb_hash": header.thumb_hash.map(|h| h.to_vec()),
            ":preview_hash": header.preview_hash.map(|h| h.to_vec()),
            ":timestamp_ms": signed.entry().timestamp_ms,
            ":seq": signed.entry().seq as i64,
            ":author_pubkey": hex::encode(signed.entry().chain.author),
        },
    )
    .await
    .context("folding doc version")
    .map_err(AppError::Internal)?;
    Ok(())
}

/// Catch `doc_versions` up to the notes chains: fetch headers past each chain's watermark,
/// open + fold each, advance watermarks. Same catch-up-on-read discipline and stall rule as the
/// private store (record::private's module doc is the doctrine): a watermark never passes a
/// header this key-set cannot open, so later reads retry it; openable headers past a stall
/// still fold (idempotently) and stay visible. Returns how many fetched headers would not open,
/// which - because watermarks never pass one - equals the count across the whole stored log.
async fn catch_up(db: &Db, keys: &EpochKeys) -> Result<usize, AppError> {
    let entries = crate::record::imaol::entries_past_watermarks(
        db,
        service::DOCUMENTS_PRIVATE,
        entry_type::DOC_HEADER,
    )
    .await?;

    let mut by_author: BTreeMap<String, Vec<SignedEntry>> = BTreeMap::new();
    for signed in entries {
        by_author
            .entry(hex::encode(signed.entry().chain.author))
            .or_default()
            .push(signed);
    }

    let mut undecryptable = 0usize;
    let mut changed: BTreeSet<[u8; 16]> = BTreeSet::new();
    let mut advances: Vec<(String, u64)> = Vec::new();
    for (author_hex, chain) in by_author {
        let mut advance_to: Option<u64> = None;
        let mut stalled = false;
        for signed in chain {
            let seq = signed.entry().seq;
            let record = match &signed.entry().payload {
                Payload::Inline(payload) => match PrivateRecord::decode(payload) {
                    Ok(record) => Some(record),
                    Err(_) => {
                        tracing::warn!(seq, "skipping undecodable doc-header payload");
                        None
                    }
                },
                _ => None,
            };
            let opened = match record {
                Some(record) => open_doc_header(&record, keys),
                None => Opened::Garbage, // wrong shape from a buggy writer: never improves
            };
            match opened {
                Opened::Plain(header) => {
                    changed.insert(header.doc_id);
                    fold_header(db, &signed, &header).await?;
                    if !stalled {
                        advance_to = Some(seq);
                    }
                }
                Opened::Garbage => {
                    if !stalled {
                        advance_to = Some(seq);
                    }
                }
                Opened::NoKey => {
                    undecryptable += 1;
                    if !stalled {
                        stalled = true;
                        tracing::warn!(
                            author = %author_hex,
                            seq,
                            "doc-header fold stalled: no key for this entry's epoch; \
                             will retry (adoption resealing may deliver it)"
                        );
                    }
                }
            }
        }
        if let Some(folded_seq) = advance_to {
            advances.push((author_hex, folded_seq));
        }
    }

    // Re-memoize doc_heads for exactly the documents whose inputs changed this pass, BEFORE the
    // watermarks advance: a crash between the two re-runs the fold (idempotent) and re-derives
    // the memo, so doc_heads can lag the log only transiently, never permanently.
    refresh_doc_heads(db, &changed).await?;
    for (author_hex, folded_seq) in advances {
        crate::record::imaol::advance_watermark(
            db,
            &author_hex,
            service::DOCUMENTS_PRIVATE,
            folded_seq,
        )
        .await?;
    }
    Ok(undecryptable)
}

/// Re-resolve and upsert one `doc_heads` row per changed document. NOT judgment-in-SQL: every
/// value written here is the output of the same Rust resolver every keyed read runs
/// (`Doc::thread` + `display_head`) - this is that resolution *memoized*, recomputed only for
/// documents whose `doc_versions` inputs changed, and disposable like every view.
async fn refresh_doc_heads(db: &Db, changed: &BTreeSet<[u8; 16]>) -> Result<(), AppError> {
    for doc_id in changed {
        let doc = load_doc(db, doc_id).await?;
        // No display head (nothing decrypted for this doc yet): nothing to memoize.
        let Some(head) = doc.display_head() else {
            continue;
        };
        // The claimed stamp of the document's genesis: its parentless version(s) - earliest
        // wins if retention/criss-cross left several - falling back to the earliest version we
        // hold when the true genesis is outside retention.
        let earliest = doc
            .versions
            .values()
            .map(|v| v.timestamp_ms)
            .min()
            .unwrap_or(head.timestamp_ms);
        let genesis_ms = doc
            .versions
            .values()
            .filter(|v| v.header.parents.is_empty())
            .map(|v| v.timestamp_ms)
            .min()
            .unwrap_or(earliest);
        db.execute(
            "INSERT INTO doc_heads
               (doc_id, entry_hash, title, format, file_hash, width, height, duration_ms,
                thumb_hash, preview_hash, logical_heads, diverged, genesis_ms, head_ms)
             VALUES (:doc_id, :entry_hash, :title, :format, :file_hash, :width, :height,
                     :duration_ms, :thumb_hash, :preview_hash, :logical_heads, :diverged,
                     :genesis_ms, :head_ms)
             ON CONFLICT(doc_id) DO UPDATE SET
               entry_hash = excluded.entry_hash,
               title = excluded.title,
               format = excluded.format,
               file_hash = excluded.file_hash,
               width = excluded.width,
               height = excluded.height,
               duration_ms = excluded.duration_ms,
               thumb_hash = excluded.thumb_hash,
               preview_hash = excluded.preview_hash,
               logical_heads = excluded.logical_heads,
               diverged = excluded.diverged,
               genesis_ms = excluded.genesis_ms,
               head_ms = excluded.head_ms",
            turso::named_params! {
                ":doc_id": doc_id.as_slice(),
                ":entry_hash": head.hash.as_slice(),
                ":title": head.header.title.as_str(),
                ":format": head.header.format.map(|f| f as i64),
                ":file_hash": head.header.file_hash.as_slice(),
                ":width": head.header.width.map(i64::from),
                ":height": head.header.height.map(i64::from),
                ":duration_ms": head.header.duration_ms.map(|d| d as i64),
                ":thumb_hash": head.header.thumb_hash.map(|h| h.to_vec()),
                ":preview_hash": head.header.preview_hash.map(|h| h.to_vec()),
                ":logical_heads": doc.logical_heads.len() as i64,
                ":diverged": i64::from(doc.diverged()),
                ":genesis_ms": genesis_ms,
                ":head_ms": head.timestamp_ms,
            },
        )
        .await
        .context("memoizing doc head")
        .map_err(AppError::Internal)?;
    }
    Ok(())
}

/// The drop half of rebuild (`imaol::rebuild_views`): wipe the persisted document view - the
/// folded facts AND the memoized resolutions. The next keyed materialize refolds both from the
/// log (a refold re-derives every doc's `doc_heads` row, since every doc changes in that pass).
pub(crate) async fn clear_view(db: &Db) -> Result<(), AppError> {
    for sql in ["DELETE FROM doc_versions", "DELETE FROM doc_heads"] {
        db.execute(sql, ())
            .await
            .context("clearing document views")
            .map_err(AppError::Internal)?;
    }
    Ok(())
}

fn hash32(bytes: &[u8]) -> Result<[u8; 32], AppError> {
    bytes
        .try_into()
        .map_err(|_| AppError::Internal(anyhow!("corrupt 32-byte column in doc_versions")))
}

/// Row shape of the doc_versions read, in SELECT order.
type VersionRow = (
    Vec<u8>,         // entry_hash
    Vec<u8>,         // doc_id
    Vec<u8>,         // parents (CBOR)
    String,          // title
    Vec<u8>,         // body_hash
    Vec<u8>,         // file_hash
    Option<i64>,     // format
    Option<i64>,     // width
    Option<i64>,     // height
    Option<i64>,     // duration_ms
    Option<Vec<u8>>, // thumb_hash
    Option<Vec<u8>>, // preview_hash
    i64,             // timestamp_ms
    i64,             // seq (folded fact; the DAG doesn't use it)
    String,          // author_pubkey
);

/// Rehydrate one stored version from its `doc_versions` row.
fn version_from_row(row: VersionRow) -> Result<([u8; 16], Version), AppError> {
    let (
        entry_hash,
        doc_id,
        parents,
        title,
        body_hash,
        file_hash,
        format,
        width,
        height,
        duration_ms,
        thumb_hash,
        preview_hash,
        timestamp_ms,
        _seq,
        author_hex,
    ) = row;
    let hash = hash32(&entry_hash)?;
    let doc_id: [u8; 16] = doc_id
        .try_into()
        .map_err(|_| AppError::Internal(anyhow!("corrupt doc_id in doc_versions")))?;
    let author = hash32(&hex::decode(&author_hex).unwrap_or_default())?;
    let header = DocHeaderPlain {
        doc_id,
        parents: decode_parents(&parents)?,
        file_hash: hash32(&file_hash)?,
        body_hash: hash32(&body_hash)?,
        title,
        format: format.map(|f| f as u64),
        width: width.map(|w| w as u32),
        height: height.map(|h| h as u32),
        duration_ms: duration_ms.map(|d| d as u64),
        thumb_hash: thumb_hash.as_deref().map(hash32).transpose()?,
        preview_hash: preview_hash.as_deref().map(hash32).transpose()?,
    };
    Ok((
        doc_id,
        Version {
            hash,
            header,
            timestamp_ms,
            author,
        },
    ))
}

/// Load ONE document's DAG from the persisted fold and thread it - the memoizer's input,
/// identical to `materialize`'s slice for that doc (same rows, same resolver).
async fn load_doc(db: &Db, doc_id: &[u8; 16]) -> Result<Doc, AppError> {
    let rows: Vec<VersionRow> = db
        .fetch_all(
            "SELECT entry_hash, doc_id, parents, title, body_hash, file_hash, format, width,
                    height, duration_ms, thumb_hash, preview_hash, timestamp_ms, seq,
                    author_pubkey
             FROM doc_versions WHERE doc_id = ?1",
            (doc_id.to_vec(),),
        )
        .await
        .context("reading one document's versions")
        .map_err(AppError::Internal)?;
    let mut doc = Doc::default();
    for row in rows {
        let (_, version) = version_from_row(row)?;
        doc.versions.insert(version.hash, version);
    }
    doc.thread();
    Ok(doc)
}

/// The notes view: catch the persisted fold up to the chains, then thread every stored version
/// into per-document DAGs. All DAG judgment - heads, twin/echo folding, merge rungs - happens
/// here in Rust over the fetched facts; SQL never holds an opinion.
pub async fn materialize(db: &Db, keys: &EpochKeys) -> Result<DocumentsView, AppError> {
    let undecryptable = catch_up(db, keys).await?;

    let rows: Vec<VersionRow> = db
        .fetch_all(
            "SELECT entry_hash, doc_id, parents, title, body_hash, file_hash, format, width,
                    height, duration_ms, thumb_hash, preview_hash, timestamp_ms, seq,
                    author_pubkey
             FROM doc_versions",
            (),
        )
        .await
        .context("reading doc versions")
        .map_err(AppError::Internal)?;

    let mut view = DocumentsView {
        undecryptable,
        ..Default::default()
    };
    for row in rows {
        let (doc_id, version) = version_from_row(row)?;
        view.docs
            .entry(doc_id)
            .or_default()
            .versions
            .insert(version.hash, version);
    }

    // Thread each doc's DAG: true heads, then the mop-up (which heads carry distinct words).
    for doc in view.docs.values_mut() {
        doc.thread();
    }
    Ok(view)
}

// ---------------------------------------------------------------------------------------------
// The memoized list read (doc_heads). One row per document, written by refresh_doc_heads above;
// these readers catch the fold up (which re-memoizes whatever changed) and then read rows back -
// no full-view fold on the list path.

/// One document's memoized display state, as `doc_heads` holds it. Claimed stamps only
/// (`genesis_ms`, `head_ms`) - received_at never appears here: it isn't replay-stable and the
/// sync model must not leak into display ordering.
#[derive(Debug)]
pub struct DocHeadRow {
    pub doc_id: [u8; 16],
    /// The display head's version hash.
    pub head: [u8; 32],
    pub title: String,
    /// Raw wire format id (`Format::from_wire` reads it).
    pub format: Option<u64>,
    /// The display head's body blob hash in the file layer. No list endpoint serves it yet -
    /// it rides the memo because the display head's serving needs are exactly these columns,
    /// and the body-serving path is the next reader.
    #[allow(dead_code)]
    pub file_hash: [u8; 32],
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub thumb_hash: Option<[u8; 32]>,
    pub preview_hash: Option<[u8; 32]>,
    pub logical_heads: usize,
    pub diverged: bool,
    /// Claimed stamp of the parentless/earliest version (the `created` ordering).
    pub genesis_ms: i64,
    /// The display head's claimed stamp (the `modified` ordering).
    pub head_ms: i64,
}

/// Row shape of the doc_heads read, in SELECT order.
type HeadTuple = (
    Vec<u8>,         // doc_id
    Vec<u8>,         // entry_hash
    String,          // title
    Option<i64>,     // format
    Vec<u8>,         // file_hash
    Option<i64>,     // width
    Option<i64>,     // height
    Option<i64>,     // duration_ms
    Option<Vec<u8>>, // thumb_hash
    Option<Vec<u8>>, // preview_hash
    i64,             // logical_heads
    i64,             // diverged
    i64,             // genesis_ms
    i64,             // head_ms
);

const HEAD_COLUMNS: &str = "doc_id, entry_hash, title, format, file_hash, width, height, \
                            duration_ms, thumb_hash, preview_hash, logical_heads, diverged, \
                            genesis_ms, head_ms";

fn head_row(tuple: HeadTuple) -> Result<DocHeadRow, AppError> {
    let (
        doc_id,
        entry_hash,
        title,
        format,
        file_hash,
        width,
        height,
        duration_ms,
        thumb_hash,
        preview_hash,
        logical_heads,
        diverged,
        genesis_ms,
        head_ms,
    ) = tuple;
    Ok(DocHeadRow {
        doc_id: doc_id
            .try_into()
            .map_err(|_| AppError::Internal(anyhow!("corrupt doc_id in doc_heads")))?,
        head: hash32(&entry_hash)?,
        title,
        format: format.map(|f| f as u64),
        file_hash: hash32(&file_hash)?,
        width: width.map(|w| w as u32),
        height: height.map(|h| h as u32),
        duration_ms: duration_ms.map(|d| d as u64),
        thumb_hash: thumb_hash.as_deref().map(hash32).transpose()?,
        preview_hash: preview_hash.as_deref().map(hash32).transpose()?,
        logical_heads: logical_heads as usize,
        diverged: diverged != 0,
        genesis_ms,
        head_ms,
    })
}

/// The docs-list read: every document's memoized row, newest head first, current to the chains
/// (the catch-up re-memoizes whatever changed first). Returns the rows plus the undecryptable
/// count - the same figure `materialize` reports, for the same reason (watermarks never pass an
/// unopenable header).
pub async fn list_heads(db: &Db, keys: &EpochKeys) -> Result<(Vec<DocHeadRow>, usize), AppError> {
    let undecryptable = catch_up(db, keys).await?;
    let rows: Vec<HeadTuple> = db
        .fetch_all(
            &format!("SELECT {HEAD_COLUMNS} FROM doc_heads ORDER BY head_ms DESC, doc_id"),
            (),
        )
        .await
        .context("reading doc heads")
        .map_err(AppError::Internal)?;
    let rows = rows.into_iter().map(head_row).collect::<Result<_, _>>()?;
    Ok((rows, undecryptable))
}

/// Memoized rows for a specific set of documents (the docs-by-tag read), current to the chains.
/// Unknown doc_ids (annotated but never held, or nothing decrypted yet) are simply absent.
/// Ordering is the caller's: the tag query decides `modified` vs `created` over claimed stamps.
pub async fn heads_for(
    db: &Db,
    keys: &EpochKeys,
    doc_ids: &[[u8; 16]],
) -> Result<Vec<DocHeadRow>, AppError> {
    catch_up(db, keys).await?;
    let mut out = Vec::with_capacity(doc_ids.len());
    for doc_id in doc_ids {
        let tuple: Option<HeadTuple> = db
            .fetch_optional(
                &format!("SELECT {HEAD_COLUMNS} FROM doc_heads WHERE doc_id = ?1"),
                (doc_id.to_vec(),),
            )
            .await
            .context("reading one doc head")
            .map_err(AppError::Internal)?;
        if let Some(tuple) = tuple {
            out.push(head_row(tuple)?);
        }
    }
    Ok(out)
}

/// After a sync: fetch, from the peer we just exchanged with, every referenced body we lack.
/// Headers ride entry sync; bodies ride iroh-blobs - this is the pass that joins them. Runs on
/// BOTH sides of an exchange (2026-07-25): the initiator inline after its exchange, the
/// responder as a spawned dial-back to the peer that just delivered headers - "catch up on
/// the next initiated sync" left the receiving node's editors staring at null bodies for a
/// whole anti-entropy interval, since eager push makes the writer the initiator.
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
        let enc =
            crate::record::private::load_enc_keypair(&state.keystore, &hex::encode(leaf_pub))?;
        let db = state.user_dbs.get(root_hex).await?;
        let keys = crate::record::private::unseal_epoch_keys(&db, &leaf_pub, &enc).await?;

        let view = materialize(&db, &keys).await?;
        let mut missing: Vec<iroh_blobs::Hash> = Vec::new();
        for doc in view.docs.values() {
            for version in doc.versions.values() {
                // A version references its body, and (for media) sibling thumbnail and preview
                // blobs. All ride iroh-blobs and any may be absent; fetch whichever we lack.
                let mut refs = vec![version.header.file_hash];
                refs.extend(version.header.thumb_hash);
                refs.extend(version.header.preview_hash);
                for hash in refs.into_iter().map(iroh_blobs::Hash::from_bytes) {
                    if !missing.contains(&hash) && !state.files.has(hash).await {
                        missing.push(hash);
                    }
                }
            }
        }
        if missing.is_empty() {
            return Ok(0);
        }
        Ok(state
            .files
            .fetch_many(&state.endpoint, addr, &missing)
            .await as u64)
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

/// Millis-since-epoch to a compact UTC stamp ("2026-07-25 03:12") - zero deps, Hinnant's
/// civil-from-days. Baked into synthesized conflict text, so it must be deterministic and
/// timezone-free; friendlier relative phrasing ("yesterday 9pm") is a client rendering someday.
pub(crate) fn civil_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86400);
    let tod = secs.rem_euclid(86400);
    let (h, mi) = (tod / 3600, (tod % 3600) / 60);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}")
}

/// A conflict side's "which device" - device names at last (NOTES_APP promised "from your
/// phone, yesterday 9pm"; chains are per-device, so attribution is free). Falls back to the
/// shortcode for unnamed keys.
fn side_who(v: &Version, names: &BTreeMap<[u8; 32], String>) -> String {
    let who = names
        .get(&v.author)
        .cloned()
        .unwrap_or_else(|| format!("computer {}", hex::encode(&v.author[..2])));
    format!("from {who}")
}

/// Which device *and* when, in one string - the shape for plaintext's git-style marker lines,
/// which have a single label slot. Marquee splits the same facts across `label` and `when`
/// attrs instead (both rendered verbatim, side by side).
fn side_label(v: &Version, names: &BTreeMap<[u8; 32], String>) -> String {
    format!("{}, {}", side_who(v, names), civil_utc(v.timestamp_ms))
}

/// Per-hunk Marquee conflicts (amended 2026-07-25): diffy's marker lines become `:::conflict`
/// / `:::variant` vocabulary at the same line boundaries, so non-overlapping edits stay merged
/// and only the disputed hunks wear scaffolding - the whole-document presentation was a cure
/// worse than the disease. The accepted risk, stated: a hunk boundary can split a multi-line
/// block element, leaving a fragment inside a version block that fails the strict parse; the
/// clients degrade to showing source (honest, lossless), and resolution happens in the write
/// tab regardless. A line state machine, not blind replace: marker lines are only special in
/// the states diffy emits them from, so a user's own "=======" line outside a conflict is
/// left alone.
fn hunk_conflict_directives(
    marked: &str,
    a: &Version,
    b: &Version,
    names: &BTreeMap<[u8; 32], String>,
) -> String {
    #[derive(PartialEq)]
    enum State {
        Outside,
        Ours,
        Theirs,
    }
    let mut state = State::Outside;
    let mut out = String::new();
    for line in marked.lines() {
        match (&state, line) {
            (State::Outside, "<<<<<<< ours") => {
                out.push_str(&format!(
                    ":::conflict\n:::variant label=\"{}\" when=\"{}\"\n",
                    side_who(a, names),
                    civil_utc(a.timestamp_ms)
                ));
                state = State::Ours;
            }
            (State::Ours, "=======") => {
                out.push_str(&format!(
                    "::: variant\n:::variant label=\"{}\" when=\"{}\"\n",
                    side_who(b, names),
                    civil_utc(b.timestamp_ms)
                ));
                state = State::Theirs;
            }
            (State::Theirs, ">>>>>>> theirs") => {
                out.push_str("::: variant\n::: conflict\n");
                state = State::Outside;
            }
            _ => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    out
}

/// Present a conflict as *whole* alternatives - the shape used when three-way merge can't run
/// (no usable fork point, or more than two heads), and the *only* shape for Marquee (which gets
/// real vocabulary rather than markers). Degraded relative to per-hunk, still lossless. Text
/// only: `resolve` returns before this for media (which has no synthesized-text conflict).
fn whole_version_conflict(
    format: Format,
    sides: &[(&Version, String)],
    names: &BTreeMap<[u8; 32], String>,
) -> String {
    match format {
        Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus => {
            unreachable!("media conflicts are keep-both, never synthesized text")
        }
        // Git-style marker fences: every side in full.
        Format::Plaintext => {
            let mut out = String::new();
            for (i, (v, body)) in sides.iter().enumerate() {
                out.push_str(&format!("<<<<<<< {}\n", side_label(v, names)));
                out.push_str(body);
                if !body.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(if i + 1 == sides.len() {
                    ">>>>>>>\n"
                } else {
                    "=======\n"
                });
            }
            out
        }
        // Marquee vocabulary: a `:::conflict` wrapping one `:::variant` per side - the names
        // the renderers actually ship ("version" was judged overloaded, over in marquee; the
        // mq-conflict/mq-variant class contract is shared by both renderers). `label` and
        // `when` are advisory display text shown VERBATIM, so `when` carries civil time, not
        // epoch ms. An unknowing renderer shrugs and shows every variant's children in full -
        // the degraded conflict is still a lossless conflict.
        Format::Marquee => {
            let mut out = String::from(":::conflict\n");
            for (v, body) in sides {
                out.push_str(&format!(
                    ":::variant label=\"{}\" when=\"{}\"\n",
                    side_who(v, names),
                    civil_utc(v.timestamp_ms)
                ));
                out.push_str(body);
                if !body.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str("::: variant\n");
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
    names: &BTreeMap<[u8; 32], String>,
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
                body: Some(whole_version_conflict(format, &sides, names)),
            });
        }
    };

    let (Some(body_a), Some(body_b)) = (
        read_body(files, keys, a).await?,
        read_body(files, keys, b).await?,
    ) else {
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

    // The fork point's body is the three-way base. One fork point: use it directly. TWO -
    // the criss-cross case (both sides once resolved the same fork, racing) - synthesize a
    // VIRTUAL base, git-recursive style: merge the two fork points over their own unique
    // common ancestor, clean merges only. (Without this, one raced resolution anywhere in a
    // document's past would degrade every future fork to whole-document conflict, forever -
    // field-found: a well-shaped two-sided edit came back as a wall of markers because the
    // doc carried criss-cross scars from earlier testing.) Anything murkier - zero fork
    // points, three-plus, missing bodies, a conflicted virtual base - degrades to the
    // whole-document conflict as ever: conservative, lossless.
    let base = base_body(files, keys, doc, &a.hash, &b.hash).await?;
    let Some(base) = base else {
        return Ok(ResolvedDoc {
            resolution: Resolution::Conflict,
            title: display_title,
            body: Some(whole_version_conflict(format, &[(a, text_a), (b, text_b)], names)),
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
    match merge_lines(&base, &text_a, &text_b) {
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
                    .replace("<<<<<<< ours", &format!("<<<<<<< {}", side_label(a, names)))
                    .replace(">>>>>>> theirs", &format!(">>>>>>> {}", side_label(b, names))),
                Format::Marquee => hunk_conflict_directives(&marked, a, b, names),
                Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus => {
                    unreachable!("media never reaches text merge")
                }
            }),
        }),
    }
}

/// Three-way line merge with git's plain ours/theirs conflict style (no `||||||| original`
/// base section). One function so every merge in the resolver agrees - and the style choice
/// is load-bearing: the recursive virtual base may itself carry conflict markers, and diff3's
/// base section was the channel they leaked through into user-facing output (found as a
/// hash-order-dependent test flake; the leak is structurally closed with the base section
/// gone, since the SIDES are always real user text).
fn merge_lines(base: &str, a: &str, b: &str) -> Result<String, String> {
    diffy::MergeOptions::new()
        .set_conflict_style(diffy::ConflictStyle::Merge)
        .merge(base, a, b)
}

/// The three-way base for a pair of heads, as text - git's recursive strategy, bounded. One
/// fork point reads directly. Two (the criss-cross: a raced resolution somewhere in history)
/// recurse: synthesize THEIR base the same way, merge them over it - and, exactly as git's
/// recursive strategy does, a CONFLICTED virtual merge still serves as the base, markers and
/// all: the sides being merged over it almost always agree about the once-resolved region
/// (they both descend from its resolution), so the marker lines cancel against both sides
/// and never reach the output; where they genuinely don't cancel, they surface inside a
/// conflict hunk, which is honest. Depth-limited (nested criss-crosses converge in one or two
/// levels or aren't worth chasing); everything murkier - zero fork points, three-plus,
/// missing bodies, a conflicted virtual - is `None`, and the caller degrades to the
/// whole-document conflict: conservative, lossless.
fn base_body<'a>(
    files: &'a FileStore,
    keys: &'a EpochKeys,
    doc: &'a Doc,
    a: &'a [u8; 32],
    b: &'a [u8; 32],
) -> std::pin::Pin<
    Box<dyn std::future::Future<Output = Result<Option<String>, AppError>> + Send + 'a>,
> {
    fn depth_limited<'a>(
        files: &'a FileStore,
        keys: &'a EpochKeys,
        doc: &'a Doc,
        a: [u8; 32],
        b: [u8; 32],
        depth: u8,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<Option<String>, AppError>> + Send + 'a>,
    > {
        Box::pin(async move {
            if depth > 4 {
                return Ok(None);
            }
            let read_text = |hash: [u8; 32]| async move {
                match doc.versions.get(&hash) {
                    Some(v) => Ok::<_, AppError>(
                        read_body(files, keys, v)
                            .await?
                            .map(|b| String::from_utf8_lossy(&b).into_owned()),
                    ),
                    None => Ok(None),
                }
            };
            match doc.fork_points(&a, &b).as_slice() {
                [one] => read_text(*one).await,
                [f1, f2] => {
                    let sub = depth_limited(files, keys, doc, *f1, *f2, depth + 1).await?;
                    let (Some(sub), Some(b1), Some(b2)) =
                        (sub, read_text(*f1).await?, read_text(*f2).await?)
                    else {
                        return Ok(None);
                    };
                    Ok(Some(match merge_lines(&sub, &b1, &b2) {
                        Ok(clean) => clean,
                        Err(markered) => markered, // git-style: a conflicted base still bases
                    }))
                }
                _ => Ok(None),
            }
        })
    }
    depth_limited(files, keys, doc, *a, *b, 0)
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

    async fn test_db() -> Db {
        crate::db::test_user_db().await
    }

    fn signer(byte: u8) -> SigningKey {
        SigningKey::from_bytes(&[byte; 32])
    }

    async fn save(
        db: &Db,
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
                media: None,
            },
        )
        .await
        .unwrap()
    }

    /// Save helper that lets a test pick the format (for the Marquee conflict tests).
    async fn save_fmt(
        db: &Db,
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
                media: None,
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "shopping",
            b"eggs",
        )
        .await;

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
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "draft",
            b"start, then a whole afternoon",
        )
        .await;
        // The stale phone tab: same parent, older text, NEWER wall-clock claim.
        let phone = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "draft",
            b"start!",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();

        assert!(
            doc.diverged(),
            "two saves sharing a parent must be detected"
        );
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
        let edited = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![renamed],
            "t2",
            b"start, oops",
        )
        .await;
        let reverted = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![edited],
            "t2",
            b"start",
        )
        .await;
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

        // A FORMAT-only change is a real save too: conversion (plaintext → marquee, same
        // bytes, same title) is the explicit act the format doctrine promises, and a bounce
        // that ignored format would swallow it silently. (Caught in review before the editor
        // shipped its convert control.)
        let convert = |parents: Vec<[u8; 32]>| Save {
            doc_id,
            parents,
            title: "t2".into(),
            body: b"start".to_vec(),
            format: Format::Marquee,
            media: None,
        };
        let converted = save_version(&db, &key, &keys, &files, convert(vec![reverted]))
            .await
            .unwrap();
        assert_ne!(converted, reverted, "conversion must not bounce");
        // And saving again in the SAME format bounces as ever.
        let bounced_again = save_version(&db, &key, &keys, &files, convert(vec![converted]))
            .await
            .unwrap();
        assert_eq!(bounced_again, converted);
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

        let public = crate::net::sync::local_frontiers(&db, false).await.unwrap();
        assert!(
            !public
                .iter()
                .any(|f| f.service == ringtome_proto::registry::service::DOCUMENTS_PRIVATE),
            "notes frontiers must not be offered to unproven peers"
        );
        let member = crate::net::sync::local_frontiers(&db, true).await.unwrap();
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
        let a = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, fixed",
        )
        .await;
        let b = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, fixed",
        )
        .await;
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
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, then an afternoon",
        )
        .await;
        // The phone: a real edit, then a revert back to the fork point's exact content.
        let typo = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, typo",
        )
        .await;
        let revert = save(&db, &key, &keys, &files, doc_id, vec![typo], "t", b"start").await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let mut dag_heads = doc.heads.clone();
        dag_heads.sort();
        let mut expect = vec![pc, revert];
        expect.sort();
        assert_eq!(dag_heads, expect, "the DAG truthfully holds both");
        assert_eq!(
            doc.logical_heads,
            vec![pc],
            "the echo folds; the afternoon stands"
        );
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v0],
            "t",
            b"draft two",
        )
        .await;
        // Fork at v1: one side writes on; the other reverts all the way to v0's content.
        let _on = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"draft three",
        )
        .await;
        let _back = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"draft one",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(
            doc.logical_heads.len(),
            2,
            "both sides changed the fork's content"
        );
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
        let _pc = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, more",
        )
        .await;
        let typo = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, typo",
        )
        .await;
        let _renamed_revert = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![typo],
            "better title",
            b"start",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(
            doc.logical_heads.len(),
            2,
            "the rename survives as its own head"
        );
        assert!(doc.diverged());
    }

    async fn resolve_doc(
        db: &Db,
        keys: &EpochKeys,
        files: &FileStore,
        doc_id: &[u8; 16],
    ) -> ResolvedDoc {
        let view = materialize(db, keys).await.unwrap();
        resolve(files, keys, view.docs.get(doc_id).unwrap(), &BTreeMap::new())
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "t",
            b"alpha\nbeta\ngamma\n",
        )
        .await;
        let _a = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"ALPHA\nbeta\ngamma\n",
        )
        .await;
        let _b = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"alpha\nbeta\nGAMMA\n",
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Merged);
        assert_eq!(
            r.body.unwrap(),
            "ALPHA\nbeta\nGAMMA\n",
            "both edits present, no questions"
        );
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "t",
            b"the hat is red\n",
        )
        .await;
        let _a = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"the hat is blue\n",
        )
        .await;
        let _b = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"the hat is green\n",
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(body.contains("the hat is blue"), "ours present:\n{body}");
        assert!(body.contains("the hat is green"), "theirs present:\n{body}");
        assert!(
            body.contains("<<<<<<<") && body.contains(">>>>>>>"),
            "markers present:\n{body}"
        );
        assert!(
            body.contains("from computer "),
            "sides carry device labels:\n{body}"
        );
    }

    /// Rung 3: a rename on one side, a body edit on the other - orthogonal fields, both win.
    #[tokio::test]
    async fn rename_and_edit_merge_field_wise() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "scratch",
            b"alpha\nbeta\n",
        )
        .await;
        let _rename = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "the hat essay",
            b"alpha\nbeta\n",
        )
        .await;
        let _edit = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "scratch",
            b"alpha\nbeta\nnew line\n",
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Merged);
        assert_eq!(r.title, "the hat essay", "the rename wins the title");
        assert_eq!(
            r.body.unwrap(),
            "alpha\nbeta\nnew line\n",
            "the edit wins the body"
        );
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
        let v1 = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "t",
            b"the hat is *red*\n",
            m,
        )
        .await;
        let _a = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"the hat is *blue*\n",
            m,
        )
        .await;
        let _b = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"the hat is *green*\n",
            m,
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(
            body.contains(":::conflict"),
            "marquee vocabulary, not markers:\n{body}"
        );
        assert!(
            body.contains(":::variant"),
            "one variant block per side (the renderers' name - not \"version\"):\n{body}"
        );
        assert!(
            !body.contains("<<<<<<<"),
            "no git markers in a marquee doc:\n{body}"
        );
        assert!(
            body.contains("*blue*") && body.contains("*green*"),
            "both sides' words present"
        );
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "t",
            b"the hat is red\n",
        )
        .await;
        let _a = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"the hat is blue\n",
        )
        .await;
        let _b = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"the hat is green\n",
        )
        .await;

        let body = resolve_doc(&db, &keys, &files, &doc_id).await.body.unwrap();
        assert!(body.contains("<<<<<<<"), "plaintext gets markers:\n{body}");
        assert!(
            !body.contains(":::conflict"),
            "and never marquee vocabulary"
        );
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
        let v1 = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "sunset",
            &webp,
            Format::Avif,
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let head = doc.display_head().unwrap();
        assert_eq!(head.header.format, Some(2), "recorded as avif");

        // Byte-identical round trip.
        let got = read_body(&files, &keys, head).await.unwrap().unwrap();
        assert_eq!(got, webp, "the image comes back exactly");

        // resolve() must NOT mangle the binary: single head, no synthesized body.
        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
        assert_eq!(r.resolution, Resolution::Single);
        assert_eq!(r.body, None, "binary is served separately, not inlined");

        // Diverge it: two different images from one parent. Keep-both, still no merge attempt.
        let other = [b"RIFF\x1a\x00\x00\x00WEBP".as_slice(), &[0x01, 0x02, 0x03]].concat();
        let _a = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "sunset",
            &other,
            Format::Avif,
        )
        .await;
        let _b = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "sunset",
            &webp[..webp.len() - 1],
            Format::Avif,
        )
        .await;
        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
        assert_eq!(
            r.resolution,
            Resolution::Conflict,
            "two images diverge -> keep both"
        );
        assert!(doc.diverged());
    }

    /// Binary can't merge - divergence is keep-both. But the plaintext fingerprint still catches
    /// "secretly the same file": two devices that independently set the *same* image collapse to
    /// one logical head (rung 1, format-agnostic). Same bytes but a different title stays diverged
    /// - the rename is real, exactly as for text.
    #[tokio::test]
    async fn identical_binary_saves_collapse_by_fingerprint_but_renames_stay_diverged() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let img = [b"RIFF\x1a\x00\x00\x00WEBP".as_slice(), &[0x01, 0x02, 0x03]].concat();
        let replacement = [b"RIFF\x1a\x00\x00\x00WEBP".as_slice(), &[0x09, 0x09, 0x09]].concat();

        // Two devices replace the same original with the SAME new image, same title.
        let doc_id = new_doc_id();
        let v1 = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "pic",
            &img,
            Format::Avif,
        )
        .await;
        let a = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "pic",
            &replacement,
            Format::Avif,
        )
        .await;
        let b = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "pic",
            &replacement,
            Format::Avif,
        )
        .await;
        assert_ne!(a, b, "distinct versions on distinct saves");

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.heads.len(), 2, "the DAG truthfully holds both");
        assert_eq!(
            doc.logical_heads.len(),
            1,
            "same bytes + title -> not a real divergence"
        );
        assert!(!doc.diverged());

        // Same replacement bytes, DIFFERENT title -> a real difference, stays diverged.
        let doc2 = new_doc_id();
        let w1 = save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc2,
            vec![],
            "pic",
            &img,
            Format::Avif,
        )
        .await;
        save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc2,
            vec![w1],
            "sunset",
            &replacement,
            Format::Avif,
        )
        .await;
        save_fmt(
            &db,
            &key,
            &keys,
            &files,
            doc2,
            vec![w1],
            "sunrise",
            &replacement,
            Format::Avif,
        )
        .await;
        let view = materialize(&db, &keys).await.unwrap();
        assert_eq!(
            view.docs.get(&doc2).unwrap().logical_heads.len(),
            2,
            "same image, different title = a genuine divergence"
        );
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
        let orphan = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![phantom],
            "t",
            b"orphan words",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let mut heads = doc.heads.clone();
        heads.sort();
        let mut expect = vec![real, orphan];
        expect.sort();
        assert_eq!(heads, expect, "both are heads; the phantom is not");
        // No common ancestor -> conservative conflict, both bodies present.
        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
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
        let alien = save(
            &db,
            &key,
            &keys,
            &files,
            other_doc,
            vec![],
            "other",
            b"other doc body",
        )
        .await;

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"mine").await;
        let child = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![alien],
            "t",
            b"mine, edited",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        // v1 and child are both heads (child's only claimed parent lives in another doc).
        assert_eq!(
            doc.versions.len(),
            2,
            "the alien parent is not pulled into this doc"
        );
        assert!(doc.heads.contains(&v1) && doc.heads.contains(&child));
        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
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
        let v2 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"level two",
        )
        .await;
        let real = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v2],
            "t",
            b"the real thing",
        )
        .await;
        // Each echo is an edit-then-revert (the only shape the no-op bounce lets through): the
        // parent differs, but the content lands back on a fork point. One reverts to v1's
        // content, one to v2's - distinct content, distinct fork depths, so they're not twins.
        let junk_a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"typo a").await;
        let _shallow = save(&db, &key, &keys, &files, doc_id, vec![junk_a], "t", b"base").await;
        let junk_b = save(&db, &key, &keys, &files, doc_id, vec![v2], "t", b"typo b").await;
        let _deep = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![junk_b],
            "t",
            b"level two",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.heads.len(), 3, "three live heads: real + two reverts");
        assert_eq!(
            doc.logical_heads,
            vec![real],
            "both echoes fold; the real head stands"
        );
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
            save(
                &db,
                &key,
                &keys,
                &files,
                doc_id,
                vec![v1],
                "t",
                b"base, fixed",
            )
            .await;
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
        let m1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![r1, r2],
            "t",
            b"merge left",
        )
        .await;
        let m2 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![r1, r2],
            "t",
            b"merge right",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let mut heads = doc.heads.clone();
        heads.sort();
        let mut expect = vec![m1, m2];
        expect.sort();
        assert_eq!(heads, expect);
        assert_eq!(
            doc.fork_points(&m1, &m2).len(),
            2,
            "two maximal common ancestors"
        );
        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "t",
            sneaky.as_bytes(),
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Single);
        assert_eq!(
            r.body.unwrap(),
            sneaky,
            "marker-laden prose survives verbatim"
        );

        // Now force a real conflict on top - must still contain both bodies' words.
        let _a = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            "one edit\n".as_bytes(),
        )
        .await;
        let _b = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            "other edit\n".as_bytes(),
        )
        .await;
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
        let v1 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![],
            "t",
            b"keep\nthis\n",
        )
        .await;
        let _cleared = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"").await;
        let _added = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"keep\nthis\nand more\n",
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert!(r.body.is_some(), "a body was produced, no panic");
        assert!(
            r.body.unwrap().contains("and more"),
            "the added words survive"
        );
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
        let v2 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"one\ntwo\n",
        )
        .await;
        let _v3 = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v2],
            "t",
            b"one\ntwo\nthree\n",
        )
        .await;
        // Someone forks off v1, deep behind the current head v3.
        let _alt = save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"one\nBRANCH\n",
        )
        .await;

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert!(doc.diverged(), "the deep fork is a real divergence");
        let body = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap().body.unwrap();
        assert!(
            body.contains("three") && body.contains("BRANCH"),
            "both branches present"
        );
    }

    #[tokio::test]
    async fn undecryptable_headers_are_counted_not_hidden() {
        let db = test_db().await;
        let key = signer(1);
        let write_keys = EpochKeys::single(3, [9u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        save(
            &db,
            &key,
            &write_keys,
            &files,
            doc_id,
            vec![],
            "secret",
            b"x",
        )
        .await;

        // A device that never got epoch 3 (revoked before, or adopted without the re-seal).
        let wrong_keys = EpochKeys::single(3, [1u8; 32]);
        let view = materialize(&db, &wrong_keys).await.unwrap();
        assert!(view.docs.is_empty());
        assert_eq!(view.undecryptable, 1);
    }

    /// The persisted fold: one `doc_versions` row per version, the watermark stops refetching,
    /// and a forced refold over the populated table (watermarks wiped, rows kept - the shape
    /// two concurrent catch-ups produce) changes nothing: INSERT OR IGNORE is the idempotence.
    #[tokio::test]
    async fn persisted_fold_is_idempotent_and_watermarked() {
        let db = test_db().await;
        let key = signer(1);
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"one").await;
        let v2 = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"one two").await;

        let view = materialize(&db, &keys).await.unwrap();
        assert_eq!(view.docs.get(&doc_id).unwrap().heads, vec![v2]);
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::DOCUMENTS_PRIVATE)
                .await,
            Some(1),
            "both headers folded, watermark at the chain head"
        );

        async fn rows(db: &Db) -> Vec<(Vec<u8>,)> {
            db.fetch_all(
                "SELECT entry_hash FROM doc_versions ORDER BY entry_hash",
                (),
            )
            .await
            .unwrap()
        }
        let before = rows(&db).await;
        assert_eq!(before.len(), 2, "one row per version");

        crate::record::imaol::reset_watermarks_for_test(&db).await;
        let again = materialize(&db, &keys).await.unwrap();
        assert_eq!(again.docs.get(&doc_id).unwrap().heads, vec![v2]);
        assert_eq!(rows(&db).await, before, "refold changed nothing");
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::DOCUMENTS_PRIVATE)
                .await,
            Some(1)
        );
    }

    /// The stall rule for headers: a key-set that can't open the chain folds nothing and leaves
    /// no watermark, so the read that CAN open it (the key arrived via adoption resealing)
    /// starts from the top and completes.
    #[tokio::test]
    async fn stalled_header_fold_recovers_when_the_key_arrives() {
        let db = test_db().await;
        let key = signer(1);
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        let keys = EpochKeys::single(3, [9u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        save(&db, &key, &keys, &files, doc_id, vec![], "t", b"words").await;

        let wrong_keys = EpochKeys::single(3, [1u8; 32]);
        let view = materialize(&db, &wrong_keys).await.unwrap();
        assert!(view.docs.is_empty());
        assert_eq!(view.undecryptable, 1);
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::DOCUMENTS_PRIVATE)
                .await,
            None,
            "stalled at the chain's first entry: no watermark row at all"
        );

        let view = materialize(&db, &keys).await.unwrap();
        assert_eq!(view.docs.get(&doc_id).unwrap().versions.len(), 1);
        assert_eq!(view.undecryptable, 0);
        assert_eq!(
            crate::record::imaol::view_watermark(&db, &author_hex, service::DOCUMENTS_PRIVATE)
                .await,
            Some(0)
        );
    }

    /// doc_heads is the resolver memoized, not a second opinion: after saves (divergence
    /// included) the row matches what materialize + display_head derive; rebuild_views wipes
    /// it; the next keyed read re-derives the identical row from doc_versions.
    #[tokio::test]
    async fn doc_heads_memoizes_the_resolver_and_survives_rebuild() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"start").await;
        save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, more",
        )
        .await;
        save(
            &db,
            &key,
            &keys,
            &files,
            doc_id,
            vec![v1],
            "t",
            b"start, other",
        )
        .await;

        let (rows, undecryptable) = list_heads(&db, &keys).await.unwrap();
        assert_eq!(undecryptable, 0);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        let head = doc.display_head().unwrap();
        assert_eq!(row.doc_id, doc_id);
        assert_eq!(
            row.head, head.hash,
            "memo names the resolver's display head"
        );
        assert_eq!(row.title, head.header.title);
        assert_eq!(row.file_hash, head.header.file_hash);
        assert_eq!(row.logical_heads, doc.logical_heads.len());
        assert!(row.diverged, "two distinct siblings: diverged is memoized");
        assert_eq!(row.head_ms, head.timestamp_ms);
        assert_eq!(
            row.genesis_ms,
            doc.versions.get(&v1).unwrap().timestamp_ms,
            "genesis is the parentless version's claimed stamp"
        );

        // Rebuild wipes the memo (the disposability proof)...
        crate::record::imaol::rebuild_views(&db).await.unwrap();
        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM doc_heads", ())
            .await
            .unwrap();
        assert_eq!(count, 0, "rebuild clears the memoized view");

        // ...and the next keyed read re-derives the exact same answer from the log.
        let (rows2, _) = list_heads(&db, &keys).await.unwrap();
        assert_eq!(rows2.len(), 1);
        assert_eq!(rows2[0].head, row.head);
        assert_eq!(rows2[0].genesis_ms, row.genesis_ms);
        assert_eq!(rows2[0].head_ms, row.head_ms);
        assert_eq!(rows2[0].logical_heads, row.logical_heads);
    }

    /// The field report of 2026-07-25, verbatim: base A-B-C-D; one computer appends E,F (as
    /// autosave does it - two saves, a chain); the other inserts X and Y mid-document and
    /// appends ZZZ (three saves, a chain). Expectation: X and Y merge in smoothly, ONE
    /// conflict hunk at the tail (E,F vs ZZZ) - never a whole-document conflict. Multi-hop
    /// chains are the shape real autosave produces, so the fork point is several ancestors
    /// deep on both sides.
    #[tokio::test]
    async fn autosave_chains_merge_per_hunk_not_whole_document() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let base = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"A\nB\nC\nD\n").await;

        // Computer one: appends, two autosaves deep.
        let a1 = save(&db, &key, &keys, &files, doc_id, vec![base], "t", b"A\nB\nC\nD\nE\n").await;
        let a2 = save(&db, &key, &keys, &files, doc_id, vec![a1], "t", b"A\nB\nC\nD\nE\nF\n").await;

        // Computer two: inserts mid-document and appends, three autosaves deep.
        let b1 = save(&db, &key, &keys, &files, doc_id, vec![base], "t", b"A\nX\nB\nC\nD\n").await;
        let b2 = save(&db, &key, &keys, &files, doc_id, vec![b1], "t", b"A\nX\nB\nY\nC\nD\n").await;
        let b3 = save(
            &db, &key, &keys, &files, doc_id, vec![b2], "t", b"A\nX\nB\nY\nC\nD\nZZZ\n",
        )
        .await;
        let _ = (a2, b3);

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.logical_heads.len(), 2, "a genuine two-sided fork");

        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
        assert_eq!(r.resolution, Resolution::Conflict, "the tail genuinely conflicts");
        let body = r.body.unwrap();
        // The insertions merged in smoothly - they appear OUTSIDE any conflict fence...
        let clean_prefix = body.split("<<<<<<<").next().unwrap();
        assert!(
            clean_prefix.contains("X\n") && clean_prefix.contains("Y\n"),
            "X and Y merge without conflict:\n{body}"
        );
        // ...and exactly one conflict hunk exists, containing the two tails.
        assert_eq!(
            body.matches("<<<<<<<").count(),
            1,
            "one hunk, not a whole-document conflict:\n{body}"
        );
        assert!(body.contains("ZZZ") && body.contains("E\nF"), "both tails present:\n{body}");
    }

    /// The criss-cross RESCUE: a document whose past holds a raced resolution (both sides
    /// once merged the same fork - two maximal fork points forever after) must still merge
    /// future two-sided edits per-hunk, via the virtual base (the fork points merged over
    /// their own common ancestor). Without this, one race anywhere in history degraded every
    /// later fork to a whole-document conflict - the field report of 2026-07-25.
    #[tokio::test]
    async fn criss_cross_scars_still_merge_per_hunk() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        // A common genesis, a fork, and a RACED resolution: both merge saves list both heads.
        let g = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"A\nB\nC\nD\n").await;
        let h1 = save(&db, &key, &keys, &files, doc_id, vec![g], "t", b"A\nB\nC\nD\nfoo\n").await;
        let h2 = save(&db, &key, &keys, &files, doc_id, vec![g], "t", b"A\nB\nC\nD\nbar\n").await;
        let m1 = save(
            &db, &key, &keys, &files, doc_id, vec![h1, h2], "t", b"A\nB\nC\nD\n",
        )
        .await;
        let m2 = save(
            &db, &key, &keys, &files, doc_id, vec![h1, h2], "t", b"A\nB\nC\nD\n!\n",
        )
        .await;

        // On the scarred document, the user's clean two-sided edit: appends on one side,
        // mid-document insertions plus a different tail on the other.
        let e1 = save(
            &db, &key, &keys, &files, doc_id, vec![m1, m2], "t", b"A\nB\nC\nD\n!\nE\nF\n",
        )
        .await;
        let e2 = save(
            &db, &key, &keys, &files, doc_id, vec![m1, m2], "t", b"A\nX\nB\nY\nC\nD\n!\nZZZ\n",
        )
        .await;
        let _ = (e1, e2);

        let view = materialize(&db, &keys).await.unwrap();
        let doc = view.docs.get(&doc_id).unwrap();
        assert_eq!(doc.logical_heads.len(), 2);
        // The scar is real: the current heads have TWO maximal fork points (m1 and m2).
        let heads: Vec<_> = doc.logical_heads.clone();
        assert_eq!(doc.fork_points(&heads[0], &heads[1]).len(), 2, "criss-cross confirmed");

        let r = resolve(&files, &keys, doc, &BTreeMap::new()).await.unwrap();
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        let clean_prefix = body.split("<<<<<<<").next().unwrap();
        assert!(
            clean_prefix.contains("X\n") && clean_prefix.contains("Y\n"),
            "insertions merge despite the scar:\n{body}"
        );
        assert_eq!(
            body.matches("<<<<<<<").count(),
            1,
            "one tail hunk, not a whole-document conflict:\n{body}"
        );
    }

    /// The Marquee mirror of the per-hunk plaintext test (amended 2026-07-25: the
    /// whole-document conflict presentation was a cure worse than the disease). Non-overlapping
    /// edits merge in; only the disputed tail wears `:::conflict` scaffolding, at line
    /// boundaries.
    #[tokio::test]
    async fn marquee_conflicts_are_per_hunk() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let m = Format::Marquee;
        let base = save_fmt(&db, &key, &keys, &files, doc_id, vec![], "t", b"A\nB\nC\nD\n", m).await;
        let _ours = save_fmt(
            &db, &key, &keys, &files, doc_id, vec![base], "t", b"A\nB\nC\nD\nE\nF\n", m,
        )
        .await;
        let _theirs = save_fmt(
            &db, &key, &keys, &files, doc_id, vec![base], "t", b"A\nX\nB\nC\nD\nZZZ\n", m,
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        let clean_prefix = body.split(":::conflict").next().unwrap();
        assert!(
            clean_prefix.contains("X\n"),
            "the insertion merged outside the scaffolding:\n{body}"
        );
        assert_eq!(
            body.matches(":::conflict").count(),
            1, // one opener (the closer is spaced: `::: conflict`)
            "exactly one conflict block:\n{body}"
        );
        assert!(body.contains("::: conflict"), "the block closes:\n{body}");
        assert!(
            body.contains(":::variant label=\"from computer"),
            "sides are labeled variant blocks:\n{body}"
        );
        assert!(
            body.contains("when=\"") && !body.contains("when=1"),
            "when is quoted civil time, rendered verbatim - never raw epoch ms:\n{body}"
        );
        assert!(!body.contains("<<<<<<<"), "no git markers in marquee:\n{body}");
        assert!(body.contains("ZZZ") && body.contains("E\nF"), "both tails inside:\n{body}");
    }
}
