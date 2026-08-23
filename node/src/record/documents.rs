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

/// How long after first publication a public post's words may still change (Curtis,
/// 2026-08-15: one day - "a day to fix your words, after which what you said is what you
/// said"). After it, edits are admitted and ignored, the author's own publish refuses, and
/// every fragment holder stops paying edit-revalidation for the document forever. Deletion is
/// the one act that stays open.
const EDIT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;

/// The window in force. LOCAL_TEST may shrink it at boot (`RINGTOME_TEST_EDIT_WINDOW_MS`) or
/// at runtime (`/test/edit-window`, the `/test/revalidation` idiom) - a suite cannot wait a
/// day to watch a freeze. 0 in the atomic means "no runtime override".
pub fn edit_window_ms() -> i64 {
    let runtime = EDIT_WINDOW_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed);
    if runtime > 0 {
        return runtime;
    }
    if std::env::var("RINGTOME_LOCAL_TEST").is_ok() {
        if let Some(ms) = std::env::var("RINGTOME_TEST_EDIT_WINDOW_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
        {
            return ms;
        }
    }
    EDIT_WINDOW_MS
}

/// See [`edit_window_ms`]. Written only by the LOCAL_TEST endpoint.
pub static EDIT_WINDOW_OVERRIDE: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(0);

/// One document: every decryptable version, threaded into a DAG.
#[derive(Debug, Default, Clone)]
pub struct Doc {
    /// Which world this document lives in: 'private' (encrypted, member-only) or 'public'
    /// (the POSTS lane, plaintext). One lane per document, whole; crossing is a copy.
    pub lane: String,
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

    /// The edit window's honor rule, chain side (PROJECT_PLAN: enforced in the FOLD, never at
    /// chain admission - a late edit is an entry that is admitted and ignored). Public lane
    /// only; genesis is the chain's own parentless-minimum, NEVER the header's carried claim,
    /// because a field the resolver can derive is a field it must not trust. Deterministic on
    /// every node forever: both stamps are the author's own claims, no local clock anywhere.
    fn drop_late_public_edits(&mut self) {
        if self.lane != "public" {
            return;
        }
        let genesis = self
            .versions
            .values()
            .filter(|v| v.header.parents.is_empty())
            .map(|v| v.timestamp_ms)
            .min()
            .or_else(|| self.versions.values().map(|v| v.timestamp_ms).min());
        let Some(genesis) = genesis else { return };
        let deadline = genesis.saturating_add(edit_window_ms());
        let late: Vec<[u8; 32]> = self
            .versions
            .values()
            .filter(|v| v.timestamp_ms > deadline)
            .map(|v| v.hash)
            .collect();
        for hash in late {
            self.versions.remove(&hash);
        }
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
        self.fork_points_of_heads(&[*a, *b])
    }

    /// The same question for a whole head SET: the maximal common ancestors of every listed
    /// head at once. This is what the N-way merge pivots on - three devices editing the same
    /// paragraph simultaneously fork three ways from ONE version, and that version is the
    /// base all three diffs align against.
    pub(crate) fn fork_points_of_heads(&self, heads: &[[u8; 32]]) -> Vec<[u8; 32]> {
        let Some((first, rest)) = heads.split_first() else {
            return Vec::new();
        };
        let mut common_set = self.ancestors(first);
        for h in rest {
            let anc = self.ancestors(h);
            common_set.retain(|c| anc.contains(c));
        }
        let common: Vec<[u8; 32]> = common_set.into_iter().collect();
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
    /// The documents this body embeds - derived, never client-asserted: `Store::save` computes
    /// it from the body with the same parser the bake uses (own private docs only, external
    /// links excluded - a URL is not a document), so callers pass `Vec::new()` and the store
    /// overwrites. In the header it makes "which media does this note hold?" a field read
    /// instead of a decrypt-and-parse of every body - the unreferenced-media question, cheap.
    pub refs: Vec<[u8; 16]>,
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

    // ONE document, not the corpus (2026-08-10). This used to `materialize` every version of
    // every document and thread all of their DAGs to look at one - so saving a note paid for
    // resolving the whole notebook, on the path a human is waiting on. `load_doc` reads the
    // same rows through `doc_versions_by_doc` and runs the same resolver; the fold itself
    // (`catch_up`) is watermarked and incremental either way.
    catch_up(db, keys).await?;
    let doc = load_doc(db, &save.doc_id).await?;
    // An unknown document loads EMPTY rather than absent, which answers every lookup below
    // exactly as the old `Option<&Doc>` did - a genesis save has no parent to bounce against
    // and no history to reuse a blob from.
    let doc = (!doc.versions.is_empty()).then_some(&doc);

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
        refs: save.refs,
        genesis_ms: None, // the edit window is a PUBLIC posture; private notes edit forever
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

/// Retitle a document without touching its words or media: a new version whose header copies
/// the display head's content pointers verbatim - no bytes are read, re-encrypted, or stored
/// (blob reuse by construction) - under the new title, parented on every logical head (a
/// diverged doc settles into the retitle, the display head's content winning: the same shape a
/// manual merge-save takes). Exists for renaming a PROCESSED upload - the JSON save route
/// writes a text body and would clobber a media document into text; this path can't - but it
/// is equally sound for text docs.
pub async fn retitle(
    db: &Db,
    signer: &SigningKey,
    keys: &EpochKeys,
    doc_id: [u8; 16],
    title: &str,
) -> Result<[u8; 32], AppError> {
    let (epoch, epoch_key) = keys
        .current()
        .ok_or_else(|| AppError::Internal(anyhow!("no epoch key to write under")))?;
    // One document's DAG, not the corpus's (see save_version's twin note). Retitle genuinely
    // needs the threading: `doc_heads` memoizes the resolved head and how MANY logical heads
    // there are, but the new version must parent on every logical head by hash, and only the
    // resolver knows those.
    catch_up(db, keys).await?;
    let doc = load_doc(db, &doc_id).await?;
    if doc.versions.is_empty() {
        return Err(AppError::NotFound(crate::msg!(
            "record.documents.no-such-document",
            "no such document"
        )));
    }
    let head = doc.display_head().ok_or_else(|| {
        AppError::NotFound(crate::msg!("record.documents.the-document-has-no-version", "the document has no version yet (still processing?)"))
    })?;
    // The retitle no-op bounce: same name, nothing diverged to settle - the chain doesn't grow.
    if head.header.title == title && doc.logical_heads.len() == 1 {
        return Ok(head.hash);
    }
    let header = DocHeaderPlain {
        doc_id,
        parents: doc.logical_heads.clone(),
        file_hash: head.header.file_hash,
        body_hash: head.header.body_hash,
        title: title.to_string(),
        format: head.header.format,
        width: head.header.width,
        height: head.header.height,
        duration_ms: head.header.duration_ms,
        thumb_hash: head.header.thumb_hash,
        preview_hash: head.header.preview_hash,
        refs: head.header.refs.clone(),
        genesis_ms: head.header.genesis_ms,
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

/// Save a BORN-PUBLIC media document: crushed bytes to the public blob store, plaintext
/// header onto the POSTS lane. Tenant zero is the avatar; posts' prose follows the full
/// publication mint later (drafts are notes; this path is for things whose upload IS the
/// deliberate public act). No epoch, no encryption, no parents (v1: replace-by-new-doc; the
/// version DAG is there when public edits earn it).
pub async fn save_public_media(
    db: &Db,
    signer: &SigningKey,
    files: &crate::files::FileStore,
    title: &str,
    ingested: crate::media::Ingested,
) -> Result<[u8; 16], AppError> {
    let doc_id = new_doc_id();
    let body_hash = files
        .put_public(&ingested.body)
        .await
        .map_err(AppError::Internal)?;
    let mut thumb_hash = None;
    if let Some(thumb) = &ingested.thumb_avif {
        thumb_hash = Some(
            *files
                .put_public(thumb)
                .await
                .map_err(AppError::Internal)?
                .as_bytes(),
        );
    }
    let header = DocHeaderPlain {
        doc_id,
        parents: vec![],
        file_hash: *body_hash.as_bytes(),
        // Public bodies are plaintext and content-addressed: the file hash IS the body's
        // honest fingerprint (the private lane's keyed member-secret hash has no public
        // meaning to protect here).
        body_hash: *body_hash.as_bytes(),
        title: title.to_string(),
        format: ingested.format.to_wire(),
        width: ingested.width,
        height: ingested.height,
        duration_ms: ingested.duration_ms,
        thumb_hash,
        preview_hash: None,
        refs: Vec::new(), // media documents are leaves - they embed nothing
        genesis_ms: None, // and they never edit: absent genesis IS frozen-from-birth
    };
    let payload = header
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding public doc header: {e}")))?;
    crate::record::imaol::append(
        db,
        signer,
        service::POSTS,
        entry_type::DOC_HEADER,
        Payload::Inline(payload),
    )
    .await?;
    Ok(doc_id)
}

/// Publish TEXT to the public lane: the body as a plaintext public blob, a header on POSTS.
/// The publication act's second half (the first is deciding to - see `publish`), and the
/// copy-don't-flip crossing itself: this MINTS a new artifact rather than moving one, so
/// nothing about a private note can become public by a flag going wrong.
///
/// `doc_id` and `parents` are the re-publish path: absent, the post is born (public history
/// of one); present, this is a further version of a post already published, parented on its
/// current head exactly like an ordinary save.
pub struct PublicText<'a> {
    /// Absent mints a new post (a public history of one); present re-publishes onto an
    /// existing one, parented on its head.
    pub onto: Option<([u8; 16], Vec<[u8; 32]>)>,
    pub title: &'a str,
    pub body: &'a str,
    pub format: Format,
    /// The public media documents this body embeds - the baked twin set, derived post-rewrite
    /// by the publish pre-pass (record::bake), so it names what a reader's renderer will
    /// actually ask for. In the SIGNED header so a fragment names its media from the entry
    /// alone, and no sweep ever parses foreign Marquee.
    pub refs: Vec<[u8; 16]>,
}

pub async fn save_public_text(
    db: &Db,
    signer: &SigningKey,
    files: &crate::files::FileStore,
    text: PublicText<'_>,
) -> Result<[u8; 16], AppError> {
    let PublicText { onto, title, body, format, refs } = text;
    // The edit window's anchor, carried in the SIGNED header so a fragment holder with no
    // chain knows when this document freezes. A mint anchors at its own moment; a further
    // version carries the post's memoized genesis forward unchanged - an honest author's
    // genesis never moves.
    let (doc_id, parents, genesis_ms) = match onto {
        Some((id, parents)) => {
            // CARRIED from the previous header's own claim, never re-derived: the mint's
            // claim and the entry's stamp are minted milliseconds apart, so a re-derivation
            // (the chain's parentless minimum) would differ from the claim by those
            // milliseconds - and the shelf's drift check would then refuse every honest
            // edit as "genesis moved" (caught by five cascade tests on this slice's first
            // run). A header that predates the anchor starts one from the chain's value.
            let carried = match public_header_entry(db, &id).await? {
                Some(entry) => match &entry.entry().payload {
                    ringtome_proto::Payload::Inline(payload) => {
                        DocHeaderPlain::decode(payload)
                            .ok()
                            .and_then(|h| h.genesis_ms)
                    }
                    _ => None,
                },
                None => None,
            };
            let genesis = match carried {
                Some(g) => g,
                None => public_genesis(db, &id).await?.unwrap_or_else(crate::clock::now_ms),
            };
            (id, parents, genesis)
        }
        None => (new_doc_id(), vec![], crate::clock::now_ms()),
    };
    let file_hash = files
        .put_public(body.as_bytes())
        .await
        .map_err(AppError::Internal)?;
    let header = DocHeaderPlain {
        doc_id,
        parents,
        file_hash: *file_hash.as_bytes(),
        // Public bodies are plaintext and content-addressed: the file hash IS the body's
        // honest fingerprint (the private lane's keyed member-secret hash has no public
        // meaning to protect here).
        body_hash: *file_hash.as_bytes(),
        title: title.to_string(),
        format: format.to_wire(),
        width: None,
        height: None,
        duration_ms: None,
        thumb_hash: None,
        preview_hash: None,
        refs,
        genesis_ms: Some(genesis_ms),
    };
    let payload = header
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding public doc header: {e}")))?;
    crate::record::imaol::append(
        db,
        signer,
        service::POSTS,
        entry_type::DOC_HEADER,
        Payload::Inline(payload),
    )
    .await?;
    Ok(doc_id)
}

/// One public document, as the serving surfaces list it. Public-lane facts only - there is
/// no such thing as a private fact here, by construction.
pub struct PublicDoc {
    pub doc_id: [u8; 16],
    pub title: String,
    pub format: Option<u64>,
    /// When it was FIRST said: the earliest version's claimed stamp. The shelf's order, and
    /// the post's date - a re-publication is the same post with better words, not a new one,
    /// and it does not move.
    pub genesis_ms: i64,
    /// When it last changed. Reported, never sorted by.
    pub head_ms: i64,
    pub thumb_hash: Option<[u8; 32]>,
}

/// Everything this identity has published, newest first. Keyless: the anonymous face and the
/// stranger's JSON both read it without an epoch key in sight.
/// One page of the public shelf, newest first.
///
/// KEYSET, not offset: the cursor is the last row you were shown, `(genesis_ms, doc_id)`, and
/// the page starts strictly after it in the same order the query sorts by. A shelf that grows
/// at the head while someone reads down it is the ordinary case here - posting is the whole
/// point of the lane - and an offset would quietly skip a row for every arrival.
///
/// Ordered by GENESIS, not by head: a post is dated when it was first said, and editing it is
/// not saying it again. That is the display rule, and it pays a second time here - the sort key
/// is now immutable, so a re-publication mid-read can no longer shuffle a row across a page
/// boundary. The reader still dedupes, which costs nothing and covers the remaining honest
/// case: a post published while the reader was between pages.
///
/// TEXT ONLY: the shelf lists posts, and a post is something written. Published media
/// documents live in the same lane - baking mints them there so posts can embed them - but
/// they are ingredients, linked into posts and served as bytes, never listed as posts
/// themselves (a feed row of raw AVIF bytes rendered as text was the field version of this
/// mistake). The filter is here, at the query, rather than in each display: this one shelf
/// feeds the /id posts view, its pager, AND fanout's journaling into readers' feeds - and
/// filtering in SQL keeps keyset pages full instead of mysteriously short. An unknown future
/// format is hidden too: better absent than binary shown as text.
/// Every blob hash this identity's documents reference, both lanes - the reaper's mark for one
/// held database. Reads the FOLD (`doc_versions`), which the chain keeps for every version
/// forever, so an author's own history protects its bytes for exactly as long as the rows
/// stand. STRICT like its shelf twin: a malformed hash aborts the caller's whole run.
pub async fn blob_refs(db: &Db, keys: Option<&EpochKeys>) -> Result<Vec<[u8; 32]>, AppError> {
    // FOLD FIRST, or the mark lies: a save puts its blob and appends its entry, and the
    // doc_versions row only materializes on the next read - a window in which the blob has no
    // row to protect it. Seven integration tests found this inside one CI run when the reaper
    // first went live (2026-08-14): fresh posts' bodies reaped out from under the publish.
    // Public lane keylessly for every held chain; the private lane wherever this node holds
    // the keys (elsewhere, private bodies are never fetched keyless, so there is nothing of
    // theirs in the store to protect).
    catch_up_public_lane(db).await?;
    if let Some(keys) = keys {
        catch_up(db, keys).await?;
    }
    // The edit window's storage dividend (2026-08-15): a FROZEN public post's superseded
    // versions can never be displayed again - the head cannot move - so their bytes are pure
    // archaeology and only the display head's blobs stay protected. Young public posts and
    // the whole private lane keep every version's blobs (private notes edit forever, and
    // history-walking is their feature). Local clock, storage posture only - never the honor
    // rule.
    type Row = (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>);
    let frozen_before = crate::clock::now_ms() - edit_window_ms();
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT v.file_hash, v.thumb_hash, v.preview_hash
             FROM doc_versions v
             LEFT JOIN doc_heads h ON h.doc_id = v.doc_id AND h.lane = 'public'
             WHERE v.lane != 'public'
                OR h.entry_hash IS NULL
                OR h.genesis_ms > ?1
                OR v.entry_hash = h.entry_hash",
            (frozen_before,),
        )
        .await
        .context("reading a held identity's blob references")
        .map_err(AppError::Internal)?;
    let mut out = Vec::new();
    for (file, thumb, preview) in rows {
        for bytes in [Some(file), thumb, preview].into_iter().flatten() {
            out.push(hash32(&bytes)?);
        }
    }
    Ok(out)
}

pub async fn public_docs(
    db: &Db,
    after: Option<(i64, [u8; 16])>,
    limit: i64,
) -> Result<Vec<PublicDoc>, AppError> {
    catch_up_public_lane(db).await?;
    if quarantined(db).await? {
        return Ok(Vec::new());
    }
    // NULL is plaintext (absent on the wire); the only other text format is marquee.
    let text_only = format!("(format IS NULL OR format = {})", doc_format::MARQUEE);
    // Retracted documents leave THIS shelf too (2026-08-14). `public_doc_ids` had the filter
    // from the day tombstones landed, and every feed reconciliation inherited it - but this
    // query is what the anonymous /id surfaces actually page, so a takedown vanished from
    // every reader's feed while remaining listed on the author's own public page. In SQL
    // rather than post-filtered, per this file's own doctrine: keyset pages stay full.
    let not_retracted = "doc_id NOT IN (SELECT doc_id FROM public_retractions)";
    type Row = (Vec<u8>, String, Option<i64>, i64, i64, Option<Vec<u8>>);
    let rows: Vec<Row> = match after {
        None => db
            .fetch_all(
                &format!(
                    "SELECT doc_id, title, format, genesis_ms, head_ms, thumb_hash FROM doc_heads
                     WHERE lane = 'public' AND {text_only} AND {not_retracted}
                     ORDER BY genesis_ms DESC, doc_id LIMIT ?"
                ),
                (limit,),
            )
            .await,
        Some((ms, doc)) => db
            .fetch_all(
                &format!(
                    "SELECT doc_id, title, format, genesis_ms, head_ms, thumb_hash FROM doc_heads
                     WHERE lane = 'public' AND {text_only} AND {not_retracted}
                       AND (genesis_ms < ? OR (genesis_ms = ? AND doc_id > ?))
                     ORDER BY genesis_ms DESC, doc_id LIMIT ?"
                ),
                (ms, ms, doc.to_vec(), limit),
            )
            .await,
    }
    .context("listing public documents")
    .map_err(AppError::Internal)?;
    let mut out = Vec::with_capacity(rows.len());
    for (doc_id, title, format, genesis_ms, head_ms, thumb_hash) in rows {
        out.push(PublicDoc {
            doc_id: doc_id
                .try_into()
                .map_err(|_| AppError::Internal(anyhow!("corrupt doc_id in doc_heads")))?,
            title,
            format: format.map(|f| f as u64),
            genesis_ms,
            head_ms,
            thumb_hash: match thumb_hash {
                Some(t) => Some(hash32(&t)?),
                None => None,
            },
        });
    }
    Ok(out)
}

/// Every public document's id, as the fold currently knows them - hex, because the one
/// consumer (feed retraction) compares against journal rows that store hex.
///
/// This is the reference set for reconciling DERIVED state after an eviction: a repudiation's
/// genesis cut deletes the disproven entries and `rebuild_views` refolds this table, so a
/// document that "was never them" simply isn't here anymore. The feed journal is NOT a view
/// over the log - it's a delivery memo - so it must be checked against this set instead of
/// healing itself.
pub async fn public_doc_ids(db: &Db) -> Result<std::collections::HashSet<String>, AppError> {
    catch_up_public_lane(db).await?;
    if quarantined(db).await? {
        return Ok(Default::default());
    }
    // Retracted documents leave the shelf, and this is the chokepoint that makes deletion
    // travel: `fanout::retract_vanished` reconciles every reader's journal against exactly this
    // set, so a withdrawn post disappears from followers' feeds on the next public move - and a
    // rebroadcaster's pin sees it the same way. Before the public tombstone existed, deleting a
    // post was a private fact and this set never changed.
    let retracted = retracted_doc_ids(db).await?;
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all("SELECT doc_id FROM doc_heads WHERE lane = 'public'", ())
        .await
        .context("listing public document ids")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(|(id,)| hex::encode(id))
        .filter(|id| !retracted.contains(id))
        .collect())
}

/// Which public documents are withdrawn, as hex - the shelf's filter.
///
/// **A tombstone is final for its document id**, with no stamp comparison against the versions.
/// That is not a shortcut, it is the model: re-publishing after a delete mints a NEW document
/// id (PROJECT_PLAN - "the record is the record", and the recourse for a typo is
/// delete-and-repost), so "retracted, then published again under the same id" is not a state the
/// system produces. Finality also buys order-independence for free: whether a node folds the
/// header first or the tombstone first, both orders settle to withdrawn, forever.
pub(crate) async fn retracted_doc_ids(
    db: &Db,
) -> Result<std::collections::HashSet<String>, AppError> {
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all("SELECT doc_id FROM public_retractions", ())
        .await
        .context("reading public retractions")
        .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(id,)| hex::encode(id)).collect())
}

/// The equivocation quarantine, at the one chokepoint every public listing shares: while this
/// persona's store holds unresolved proof that a key double-signed a public chain (net::sync,
/// `equivocations`), the shelf presents NOTHING - neither branch is presented as
/// uncomplicated truth, and everything downstream follows for free: the /id posts view and
/// pager go empty, fan-out journals nothing new, and the feed retraction sweeps the rows
/// already delivered (they are a delivery memo; the vindicated page re-journals after the
/// crown adjudicates). Individual bodies stay fetchable by exact id - the quarantine is
/// about presentation, and the evidence handling needs the bytes to remain resolvable.
async fn quarantined(db: &Db) -> Result<bool, AppError> {
    crate::net::sync::has_public_equivocation(db)
        .await
        .map_err(AppError::Internal)
}

/// A public document's display facts, for the anonymous serving routes: format and blob
/// hashes, lane-checked - a private doc_id asked for through the public door is a 404, never
/// a leak. Runs the fold first, keys only for the private half it may catch up alongside.
/// What `public_head` answers with: the display head's identity, format and blob hashes -
/// enough to serve its bytes, to parent a re-publication onto it, and to notice that a
/// re-publication would say nothing new.
pub struct PublicHead {
    pub head: [u8; 32],
    pub format: Option<u64>,
    pub file_hash: [u8; 32],
    pub thumb_hash: Option<[u8; 32]>,
    pub title: String,
}

type PublicHeadRow = (Vec<u8>, Option<i64>, Vec<u8>, Option<Vec<u8>>, String);

/// A public post's memoized genesis claim - the edit window's anchor, as `refresh_doc_heads`
/// derived it from the chain's parentless versions. `None` when the doc has no public head row.
pub async fn public_genesis(db: &Db, doc_id: &[u8; 16]) -> Result<Option<i64>, AppError> {
    catch_up_public_lane(db).await?;
    let row: Option<(i64,)> = db
        .fetch_optional(
            "SELECT genesis_ms FROM doc_heads WHERE doc_id = ?1 AND lane = 'public'",
            (doc_id.to_vec(),),
        )
        .await
        .context("reading a post's genesis")
        .map_err(AppError::Internal)?;
    Ok(row.map(|(g,)| g))
}

pub async fn public_head(
    db: &Db,
    doc_id: &[u8; 16],
) -> Result<Option<PublicHead>, AppError> {
    catch_up_public_lane(db).await?;
    // A retracted document has no public head, full stop (filter added 2026-08-14, when the
    // take-it-down button became reachable and its first real use showed the gap): the head
    // row survives in doc_heads because the chain is the chain, but every caller here is
    // asking "what does this author currently say in public?" - the anonymous body route, the
    // share resolver, publish's re-parent, the fragment door - and for all of them a buried
    // post must answer as absence. Before this filter, a takedown cleared every feed on the
    // network while the author's own node kept serving the words to anyone at the direct URL.
    let row: Option<PublicHeadRow> = db
        .fetch_optional(
            "SELECT entry_hash, format, file_hash, thumb_hash, title FROM doc_heads
             WHERE doc_id = ?1 AND lane = 'public'
               AND doc_id NOT IN (SELECT doc_id FROM public_retractions)",
            (doc_id.to_vec(),),
        )
        .await
        .context("reading public doc head")
        .map_err(AppError::Internal)?;
    let Some((head, format, file_hash, thumb_hash, title)) = row else {
        return Ok(None);
    };
    let file = hash32(&file_hash)?;
    let thumb = match thumb_hash {
        Some(t) => Some(hash32(&t)?),
        None => None,
    };
    Ok(Some(PublicHead {
        head: hash32(&head)?,
        format: format.map(|f| f as u64),
        file_hash: file,
        thumb_hash: thumb,
        title,
    }))
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

/// Refs as a column: plain concatenation of 16-byte ids. Never a protocol - this value is
/// read only by its own decoder below, exactly like `fragments.auth_path`'s packing.
fn encode_refs(refs: &[[u8; 16]]) -> Vec<u8> {
    refs.concat()
}

/// Truncation degrades to fewer refs, never a panic: the bytes come off disk.
fn decode_refs(bytes: &[u8]) -> Vec<[u8; 16]> {
    bytes.as_chunks::<16>().0.to_vec()
}

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
    lane: &str,
) -> Result<(), AppError> {
    db.execute(
        "INSERT OR IGNORE INTO doc_versions
           (entry_hash, doc_id, parents, title, body_hash, file_hash, format, width, height,
            duration_ms, thumb_hash, preview_hash, refs, timestamp_ms, seq, author_pubkey, lane)
         VALUES (:entry_hash, :doc_id, :parents, :title, :body_hash, :file_hash, :format,
                 :width, :height, :duration_ms, :thumb_hash, :preview_hash, :refs,
                 :timestamp_ms, :seq, :author_pubkey, :lane)",
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
            ":refs": encode_refs(&header.refs),
            ":timestamp_ms": signed.entry().timestamp_ms,
            ":seq": signed.entry().seq as i64,
            ":author_pubkey": hex::encode(signed.entry().chain.author),
            ":lane": lane,
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
                    fold_header(db, &signed, &header, "private").await?;
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

    // The PUBLIC lane's sweep rides along (its own fn: the anonymous serving routes run it
    // without any epoch keys in hand).
    let public_changed = catch_up_public_lane(db).await?;
    changed.extend(public_changed);

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

/// The public lane's half of the fold: service POSTS, headers plain on the wire (no epoch,
/// no stall state - an undecodable public header is garbage, never NoKey). One document
/// model, two lanes; crossing between them is a copy, never a flip. Keyless on purpose:
/// the anonymous /id serving routes catch up through this without touching the private
/// half, and it advances its own watermarks + memoizes its own changed heads.
pub(crate) async fn catch_up_public_lane(db: &Db) -> Result<BTreeSet<[u8; 16]>, AppError> {
    // **Both public entry types in ONE pass**, because a view watermark is per (author,
    // service) and two folds sharing a service would fight over one cursor - a retraction
    // folded by a pass that then advanced past headers, or the reverse, loses entries silently.
    // (This is the same constraint that put rebroadcasts on their own chain; here the two types
    // genuinely belong on one chain, so the fold is what has to widen.)
    let mut public_entries = crate::record::imaol::entries_past_watermarks(
        db,
        service::POSTS,
        entry_type::DOC_HEADER,
    )
    .await?;
    public_entries.extend(
        crate::record::imaol::entries_past_watermarks(
            db,
            service::POSTS,
            entry_type::POST_RETRACT,
        )
        .await?,
    );
    let mut by_author: BTreeMap<String, Vec<SignedEntry>> = BTreeMap::new();
    for signed in public_entries {
        by_author
            .entry(hex::encode(signed.entry().chain.author))
            .or_default()
            .push(signed);
    }
    let mut changed: BTreeSet<[u8; 16]> = BTreeSet::new();
    let mut advances: Vec<(String, u64)> = Vec::new();
    for (author_hex, mut chain) in by_author {
        // Two type-filtered reads concatenated are not in seq order; the watermark and the LWW
        // comparisons both assume they are.
        chain.sort_by_key(|s| s.entry().seq);
        let mut advance_to: Option<u64> = None;
        for signed in chain {
            if let Payload::Inline(payload) = &signed.entry().payload {
                match signed.entry().entry_type {
                    entry_type::POST_RETRACT => match ringtome_proto::PostRetraction::decode(payload)
                    {
                        Ok(tombstone) => {
                            changed.insert(tombstone.doc_id);
                            fold_retraction(db, &signed, &tombstone).await?;
                        }
                        Err(_) => tracing::warn!(
                            seq = signed.entry().seq,
                            "skipping undecodable post retraction"
                        ),
                    },
                    _ => match ringtome_proto::DocHeaderPlain::decode(payload) {
                        Ok(header) => {
                            changed.insert(header.doc_id);
                            fold_header(db, &signed, &header, "public").await?;
                        }
                        Err(_) => tracing::warn!(
                            seq = signed.entry().seq,
                            "skipping undecodable public doc header"
                        ),
                    },
                }
            }
            advance_to = Some(signed.entry().seq);
        }
        if let Some(folded_seq) = advance_to {
            advances.push((author_hex, folded_seq));
        }
    }
    refresh_doc_heads(db, &changed).await?;
    for (author_hex, folded_seq) in advances {
        crate::record::imaol::advance_watermark(db, &author_hex, service::POSTS, folded_seq)
            .await?;
    }
    Ok(changed)
}

/// One public document's header entry, as its author signed it.
///
/// The exact bytes, never re-encoded: a fragment travels as the author's own signature over the
/// author's own bytes, and re-serializing would break the one property that makes a relay
/// harmless (`net::fragment`).
pub async fn public_header_entry(
    db: &Db,
    doc_id: &[u8; 16],
) -> Result<Option<SignedEntry>, AppError> {
    let Some(head) = public_head(db, doc_id).await? else {
        return Ok(None);
    };
    crate::record::imaol::entry_by_hash(db, &head.head).await
}

/// The `authorize` entries proving `entry`'s signer speaks for `root`, root first.
///
/// The same walk `outbox::auth_path` assembles for a delivered notice, from the same identity
/// chain - a fragment has to carry it for the same reason an envelope does: the recipient has
/// no copy of this author's key tree and must verify from the bytes in hand.
pub async fn auth_path_for(
    db: &Db,
    root_hex: &str,
    entry: &SignedEntry,
) -> Result<Vec<Vec<u8>>, AppError> {
    let Some(root) = crate::pubkey::decode(root_hex) else {
        return Ok(Vec::new());
    };
    crate::outbox::auth_path_from(db, &root, &entry.entry().chain.author)
        .await
        .map_err(AppError::Internal)
}

/// The proof behind a `Gone`: this author's signed `post-retract` for one document, with the
/// delegation path a stranger needs to verify it (net::fragment serves it; the asker checks it
/// with `verify_retraction`, offline, exactly as a fragment is checked).
///
/// `None` when no retraction entry exists - and the callers turn that into `Unknown`, never a
/// bare `Gone`, which is a correctness rule and not a shrug: a document can be off the shelf
/// without being retracted (the equivocation quarantine presents an empty shelf), and before
/// proofs, that case answered `Gone` to every fragment asker - a quarantine reading as a
/// deletion, permanently, to everyone downstream. What cannot be proven is not asserted.
pub async fn retraction_proof(
    db: &Db,
    author_hex: &str,
    doc_id: &[u8; 16],
) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>, AppError> {
    let row: Option<(Vec<u8>,)> = db
        .fetch_optional(
            "SELECT entry_hash FROM public_retractions WHERE doc_id = ?1",
            (doc_id.to_vec(),),
        )
        .await
        .context("reading a retraction's identity")
        .map_err(AppError::Internal)?;
    let Some((hash_bytes,)) = row else {
        return Ok(None);
    };
    let hash = hash32(&hash_bytes)?;
    let Some(entry) = crate::record::imaol::entry_by_hash(db, &hash).await? else {
        // The fold knows a hash the chain no longer holds - a repudiation's genesis cut can do
        // this. Unprovable is unsayable, same rule as above.
        return Ok(None);
    };
    let auth_path = auth_path_for(db, author_hex, &entry).await?;
    Ok(Some((entry.bytes().to_vec(), auth_path)))
}

/// Withdraw one public document: append the tombstone to the persona's POSTS chain.
///
/// Public, unlike `Documents::delete`, which writes an epoch-encrypted set-add on the doc-meta
/// chain and therefore reaches only the author's own devices. Both exist and mean different
/// things: the private one hides a document from its author's own lists, the public one tells
/// the network it is gone. Publishing something and then deleting it needs both, which is why
/// the route below writes both.
pub async fn retract_public(
    db: &Db,
    key: &ringtome_proto::SigningKey,
    doc_id: &[u8; 16],
) -> Result<SignedEntry, AppError> {
    let payload = ringtome_proto::PostRetraction { doc_id: *doc_id }.encode();
    crate::record::imaol::append(
        db,
        key,
        service::POSTS,
        entry_type::POST_RETRACT,
        Payload::Inline(payload),
    )
    .await
}

/// Fold one `post-retract` tombstone: the document is withdrawn.
///
/// The LWW stamp below settles retractions against OTHER RETRACTIONS - re-retracting is
/// idempotent (see the route), and two of this author's computers doing it at once must land on
/// one row rather than flapping. It does not weigh a retraction against a publication, and there
/// is no rule here that could: **withdrawal is final for the document id**, which
/// `retracted_doc_ids` states and the whole share tree relies on.
///
/// Said plainly because the comment this replaces claimed the opposite - that a retraction
/// "does not win by arriving late" against "a later re-publication", and cited a `retracted_after`
/// that has never existed in this tree. Prose describing a function nobody wrote outranked the
/// code for as long as anyone was reading instead of grepping (2026-08-13, after it was quoted
/// back as canon in an argument for a protocol change the model did not need).
async fn fold_retraction(
    db: &Db,
    signed: &SignedEntry,
    tombstone: &ringtome_proto::PostRetraction,
) -> Result<(), AppError> {
    db.execute(
        "INSERT INTO public_retractions
           (doc_id, timestamp_ms, seq, entry_hash, received_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(doc_id) DO UPDATE SET
           timestamp_ms = excluded.timestamp_ms,
           seq = excluded.seq,
           entry_hash = excluded.entry_hash,
           received_at_ms = excluded.received_at_ms
         WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
             > (public_retractions.timestamp_ms, public_retractions.seq,
                public_retractions.entry_hash)",
        (
            tombstone.doc_id.as_slice(),
            signed.entry().timestamp_ms,
            signed.entry().seq as i64,
            signed.hash().as_slice(),
            crate::clock::now_ms(),
        ),
    )
    .await
    .context("folding a post retraction")
    .map_err(AppError::Internal)?;
    Ok(())
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
        // The logical-head SET, as one comparable value plus its bodies' hashes - the search
        // index's staleness inputs, computed here where the set is already in hand. Sorted:
        // the set has no inherent order and the fingerprint must not invent one.
        let mut sorted_heads = doc.logical_heads.clone();
        sorted_heads.sort();
        let mut heads_hasher = blake3::Hasher::new();
        let mut head_bodies: Vec<[u8; 32]> = Vec::new();
        for h in &sorted_heads {
            heads_hasher.update(h);
            if let Some(v) = doc.versions.get(h) {
                head_bodies.push(v.header.file_hash);
            }
        }
        head_bodies.sort();
        let head_bodies: Vec<u8> = head_bodies.into_iter().flatten().collect();
        db.execute(
            "INSERT INTO doc_heads
               (doc_id, lane, entry_hash, title, format, file_hash, width, height, duration_ms,
                thumb_hash, preview_hash, logical_heads, diverged, genesis_ms, head_ms,
                heads_fp, head_bodies)
             VALUES (:doc_id, :lane, :entry_hash, :title, :format, :file_hash, :width, :height,
                     :duration_ms, :thumb_hash, :preview_hash, :logical_heads, :diverged,
                     :genesis_ms, :head_ms, :heads_fp, :head_bodies)
             ON CONFLICT(doc_id) DO UPDATE SET
               lane = excluded.lane,
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
               head_ms = excluded.head_ms,
               heads_fp = excluded.heads_fp,
               head_bodies = excluded.head_bodies",
            turso::named_params! {
                ":heads_fp": heads_hasher.finalize().as_bytes().to_vec(),
                ":head_bodies": head_bodies,
                ":doc_id": doc_id.as_slice(),
                ":lane": doc.lane.as_str(),
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
    for sql in [
        "DELETE FROM doc_versions",
        "DELETE FROM doc_heads",
        "DELETE FROM doc_search",
    ] {
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
    Vec<u8>,         // refs (concatenated 16-byte doc ids; empty = none)
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
        refs,
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
        refs: decode_refs(&refs),
        // Not persisted in doc_versions, deliberately: on a chain-holding node the resolver
        // derives genesis from the parentless versions (the chain's own truth) and must never
        // consult a header CLAIM it can compute - the rug-forger's field is ignored here.
        genesis_ms: None,
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
                    height, duration_ms, thumb_hash, preview_hash, refs, timestamp_ms, seq,
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
    // Lane BEFORE threading (moved 2026-08-15): the window's honor rule needs to know it is
    // looking at the public lane before it decides which versions exist to thread.
    if let Some((lane,)) = db
        .fetch_optional::<(String,)>(
            "SELECT lane FROM doc_versions WHERE doc_id = ?1 LIMIT 1",
            (doc_id.to_vec(),),
        )
        .await
        .context("reading one document's lane")
        .map_err(AppError::Internal)?
    {
        doc.lane = lane;
    }
    doc.drop_late_public_edits();
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
                    height, duration_ms, thumb_hash, preview_hash, refs, timestamp_ms, seq,
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

    // Lanes ride beside the versions (one per doc, whole): a separate cheap map keeps
    // VersionRow untouched. Fetched BEFORE threading (2026-08-15) so the edit window's honor
    // rule knows which docs are public while deciding which versions exist to thread.
    let lanes: Vec<(Vec<u8>, String)> = db
        .fetch_all("SELECT DISTINCT doc_id, lane FROM doc_versions", ())
        .await
        .context("reading doc lanes")
        .map_err(AppError::Internal)?;
    for (doc_id, lane) in lanes {
        if let Ok(id) = <[u8; 16]>::try_from(doc_id.as_slice()) {
            if let Some(doc) = view.docs.get_mut(&id) {
                doc.lane = lane;
            }
        }
    }

    // Thread each doc's DAG - true heads, then the mop-up - with the edit window's honor rule
    // running first, now that lanes are known.
    for doc in view.docs.values_mut() {
        doc.drop_late_public_edits();
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
            // The list surface is the PRIVATE workspace (notes, buckets, All): public-lane
            // documents have their own doors (the /id serving routes) and never appear here.
            &format!(
                "SELECT {HEAD_COLUMNS} FROM doc_heads WHERE lane = 'private'                  ORDER BY head_ms DESC, doc_id"
            ),
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

// ---------------------------------------------------------------------------------------------
// The search index: doc_search, a token-bag materialized view.

/// One document's search row: the unique normalized words of its title, resolved body, and
/// annotation text, space-joined. The browser mirror holds these and queries them locally
/// (NEXT_STEPS, Where search lives - settled 2026-07-25).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SearchRow {
    pub doc_id: String,
    pub tokens: String,
}

/// Normalize text into the bag: lowercase alphanumeric runs, 2..=32 chars. Unicode-aware
/// (`char::is_alphanumeric`), so accented words and CJK runs index as written.
fn tokenize_into(text: &str, out: &mut std::collections::BTreeSet<String>) {
    for run in text.split(|c: char| !c.is_alphanumeric()) {
        if run.is_empty() {
            continue;
        }
        let token = run.to_lowercase();
        let len = token.chars().count();
        if (2..=32).contains(&len) {
            out.insert(token);
        }
    }
}

/// Current search rows for every document, refreshing stale ones first - the same
/// catch-up-on-read discipline as every view. Staleness is a fingerprint over exactly the
/// inputs that change a doc's tokens: the logical-head set (`heads_fp` - the SET, not the
/// count: raced resolutions rotate it invisibly otherwise), which head bodies are locally
/// present (a body arriving by backfill must re-index - headers travel ahead of bodies), the
/// title, and the annotation text. Only stale docs pay for materialization and body reads;
/// a clean pass is one query and some hashing.
pub async fn search_rows(
    db: &Db,
    keys: &EpochKeys,
    files: &FileStore,
    annots: &BTreeMap<[u8; 16], String>,
) -> Result<Vec<SearchRow>, AppError> {
    catch_up(db, keys).await?;
    // (doc_id, title, heads_fp, head_bodies) - the search index's staleness inputs per doc.
    type SearchHead = (Vec<u8>, String, Vec<u8>, Vec<u8>);
    let heads: Vec<SearchHead> = db
        .fetch_all("SELECT doc_id, title, heads_fp, head_bodies FROM doc_heads", ())
        .await
        .context("reading heads for search")
        .map_err(AppError::Internal)?;
    let cached: BTreeMap<Vec<u8>, (Vec<u8>, String)> = db
        .fetch_all::<(Vec<u8>, Vec<u8>, String)>("SELECT doc_id, fp, tokens FROM doc_search", ())
        .await
        .context("reading search rows")
        .map_err(AppError::Internal)?
        .into_iter()
        .map(|(id, fp, tokens)| (id, (fp, tokens)))
        .collect();

    let mut out = Vec::new();
    let mut stale: Vec<([u8; 16], Vec<u8>, String)> = Vec::new(); // (id, fp, title)
    for (doc_id, title, heads_fp, head_bodies) in heads {
        let id: [u8; 16] = doc_id
            .as_slice()
            .try_into()
            .map_err(|_| AppError::Internal(anyhow!("corrupt doc_id in doc_heads")))?;
        let annot_text = annots.get(&id).map(String::as_str).unwrap_or("");
        let mut hasher = blake3::Hasher::new();
        hasher.update(&heads_fp);
        for chunk in head_bodies.chunks(32) {
            let present = match <[u8; 32]>::try_from(chunk) {
                Ok(h) => files.has(iroh_blobs::Hash::from_bytes(h)).await,
                Err(_) => false,
            };
            hasher.update(&[present as u8]);
        }
        hasher.update(title.as_bytes());
        hasher.update(&[0xff]); // title/annot seam: "ab"+"c" must not equal "a"+"bc"
        hasher.update(annot_text.as_bytes());
        let fp = hasher.finalize().as_bytes().to_vec();
        match cached.get(&doc_id) {
            Some((have, tokens)) if *have == fp => out.push(SearchRow {
                doc_id: hex::encode(id),
                tokens: tokens.clone(),
            }),
            _ => stale.push((id, fp, title)),
        }
    }

    if !stale.is_empty() {
        // Per STALE document rather than the whole corpus: the loop already pays a body
        // decrypt per document (`resolve`), so the threading may as well be scoped the same
        // way - and a re-index of two changed notes stops threading two thousand unchanged
        // ones. `catch_up` ran above via the `doc_heads` read that produced `stale`.
        for (id, fp, title) in stale {
            let mut tokens = std::collections::BTreeSet::new();
            tokenize_into(&title, &mut tokens);
            if let Some(annot_text) = annots.get(&id) {
                tokenize_into(annot_text, &mut tokens);
            }
            let doc = load_doc(db, &id).await?;
            if !doc.versions.is_empty() {
                // Empty device-name map: conflict labels' device names are presentation,
                // not content - close enough for an index either way.
                let resolved = resolve(files, keys, &doc, &BTreeMap::new()).await?;
                if let Some(body) = &resolved.body {
                    tokenize_into(body, &mut tokens);
                }
            }
            let tokens = tokens.into_iter().collect::<Vec<_>>().join(" ");
            db.execute(
                "INSERT INTO doc_search (doc_id, fp, tokens) VALUES (?1, ?2, ?3)
                 ON CONFLICT(doc_id) DO UPDATE SET fp = excluded.fp, tokens = excluded.tokens",
                (id.to_vec(), fp, tokens.clone()),
            )
            .await
            .context("writing search row")
            .map_err(AppError::Internal)?;
            out.push(SearchRow {
                doc_id: hex::encode(id),
                tokens,
            });
        }
    }
    out.sort_by(|a, b| a.doc_id.cmp(&b.doc_id));
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
    // Test-only, LOCAL_TEST-gated: hold the body lane open for a beat so the multi-hop race
    // (headers pushed onward before their bodies arrive here) can be made deterministic
    // instead of lucky - the fanout probe sets this on the middle node. Production ignores it.
    if state.config.local_test {
        if let Some(ms) = std::env::var("RINGTOME_TEST_BODY_LAG_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
    }
    let result: anyhow::Result<u64> = async {
        let db = state.user_dbs.held(root_hex).await?;
        let mut missing: Vec<iroh_blobs::Hash> = Vec::new();

        // The PUBLIC lane first, KEYLESS: any node holding public headers may fetch the
        // bytes they name - the blobs are plaintext-public and the hash is the capability.
        // This is what carries a foreign persona's avatar across on fetch-and-serve; the
        // old key-gated bail sat above this walk and starved it (field-found 2026-08-03:
        // names crossed, faces didn't).
        catch_up_public_lane(&db).await?;
        type BodyRefs = (Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>);
        let public_rows: Vec<BodyRefs> = db
            .fetch_all(
                "SELECT file_hash, thumb_hash, preview_hash FROM doc_versions
                 WHERE lane = 'public'",
                (),
            )
            .await
            .context("reading public body refs")?;
        for (file, thumb, preview) in public_rows {
            for bytes in [Some(file), thumb, preview].into_iter().flatten() {
                if let Ok(h) = <[u8; 32]>::try_from(bytes.as_slice()) {
                    let hash = iroh_blobs::Hash::from_bytes(h);
                    if !missing.contains(&hash) && !state.files.has(hash).await {
                        missing.push(hash);
                    }
                }
            }
        }

        // The PRIVATE lane needs this node's own keys to even read which bodies exist -
        // agented identities only.
        if let Some(leaf) =
            crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, root_hex).await?
        {
            let leaf_pub = leaf.verifying_key().to_bytes();
            let enc =
                crate::record::private::load_enc_keypair(&state.keystore, &hex::encode(leaf_pub))?;
            let keys = crate::record::private::unseal_epoch_keys(&db, &leaf_pub, &enc).await?;
            let view = materialize(&db, &keys).await?;
            for doc in view.docs.values() {
                for version in doc.versions.values() {
                    // A version references its body, and (for media) sibling thumbnail and
                    // preview blobs. All ride iroh-blobs and any may be absent; fetch
                    // whichever we lack.
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
        }
        let fetched = if missing.is_empty() {
            0u64
        } else {
            state.files.fetch_many(&state.endpoint, addr, &missing).await as u64
        };

        // The gravedigger's ledger (net::bodies): whatever is STILL absent after this attempt
        // is recorded, and whatever landed - here or by any other path - clears. This is the
        // one write that turns the walk's throwaway computation into recoverable knowledge;
        // without it, a follower that lost the multi-hop race and then missed the poke stayed
        // bodiless until the author's next post.
        let mut still: Vec<[u8; 32]> = Vec::new();
        for hash in &missing {
            if !state.files.has(*hash).await {
                still.push(*hash.as_bytes());
            }
        }
        crate::net::bodies::reconcile(&state.node_db, root_hex, &still).await?;
        Ok(fetched)
    }
    .await;

    match result {
        Ok(n) => {
            if n > 0 {
                // Bodies arrived without any frontier moving - tell the views' listeners
                // (the live-cache stream cursor mixes this in; the search index re-checks
                // body presence on the refresh it triggers).
                state.view_epochs.bump(root_hex);
            }
            n
        }
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

/// The opening line of one Marquee variant - the attr shape is the renderers' contract:
/// `label` and `when` are advisory display text shown verbatim, so `when` is civil time.
fn variant_open(v: &Version, names: &BTreeMap<[u8; 32], String>) -> String {
    format!(
        ":::variant label=\"{}\" when=\"{}\"\n",
        side_who(v, names),
        civil_utc(v.timestamp_ms)
    )
}

/// One stretch of an N-way merge: lines every head agrees on, or a region where two-plus
/// heads propose different text.
enum Segment {
    Agreed(Vec<String>),
    /// Distinct proposals in house order, deduped by text - two heads that wrote the same
    /// words for a region agree, and their proposal folds to one variant labeled by the
    /// earliest head carrying it (the same logical-folding spirit as twin heads). The index
    /// is into the resolver's sorted head list.
    Disputed(Vec<(usize, Vec<String>)>),
}

/// The edit runs of one side against the base: contiguous stretches of non-context patch
/// lines, as (base_start, base_end, replacement_lines). Half-open 0-indexed base ranges; a
/// pure insertion is the empty range at its insertion point.
fn edit_runs(base: &str, side: &str) -> Vec<(usize, usize, Vec<String>)> {
    let patch = diffy::create_patch(base, side);
    let mut runs = Vec::new();
    for hunk in patch.hunks() {
        // Unified-diff ranges are 1-indexed; the 0-start form only appears for an empty
        // base, where 0 is already the right 0-indexed position.
        let mut ix = hunk.old_range().start().saturating_sub(1);
        let mut run: Option<(usize, usize, Vec<String>)> = None;
        for line in hunk.lines() {
            match line {
                diffy::Line::Context(_) => {
                    if let Some(r) = run.take() {
                        runs.push(r);
                    }
                    ix += 1;
                }
                diffy::Line::Delete(_) => {
                    let r = run.get_or_insert((ix, ix, Vec::new()));
                    ix += 1;
                    r.1 = ix;
                }
                diffy::Line::Insert(t) => {
                    run.get_or_insert((ix, ix, Vec::new()))
                        .2
                        .push(t.strip_suffix('\n').unwrap_or(t).to_string());
                }
            }
        }
        if let Some(r) = run.take() {
            runs.push(r);
        }
    }
    runs
}

/// One side's text for a base region, reconstructed by splicing its edit runs into the base
/// slice. A side with no runs in the region returns the base slice itself - "left it alone".
fn splice(
    base_lines: &[&str],
    runs: &[(usize, usize, Vec<String>)],
    rs: usize,
    re: usize,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut cursor = rs;
    for (s, e, repl) in runs.iter().filter(|(s, e, _)| rs <= *s && *e <= re) {
        out.extend(base_lines[cursor..*s].iter().map(|l| l.to_string()));
        out.extend(repl.iter().cloned());
        cursor = *e;
    }
    out.extend(base_lines[cursor..re].iter().map(|l| l.to_string()));
    out
}

/// Line-level N-way merge over a single shared base - what three-plus devices editing the
/// same document simultaneously produce when they all forked from one version (amended
/// 2026-07-25; before this, three-plus heads *always* degraded to the whole-document
/// conflict, field-reported when three computers changed one paragraph and got walls).
/// Each head is diffed against the base independently; edit runs whose base ranges overlap
/// or *touch* are grouped into one disputed region (touching is deliberate: adjacent edits
/// have no agreed line between them to anchor a seam, so they conflict, as in git);
/// everywhere else the heads merge clean - including fully clean when all edits are
/// disjoint, a case the old degradation falsely conflicted. Deterministic: heads arrive in
/// house order and diffy is deterministic over its inputs.
fn align_heads(base: &str, sides: &[&str]) -> Vec<Segment> {
    let base_lines: Vec<&str> = base.lines().collect();
    let per_side: Vec<Vec<(usize, usize, Vec<String>)>> =
        sides.iter().map(|s| edit_runs(base, s)).collect();

    let mut all: Vec<(usize, usize)> = per_side
        .iter()
        .flat_map(|runs| runs.iter().map(|(s, e, _)| (*s, *e)))
        .collect();
    all.sort_unstable();
    let mut groups: Vec<(usize, usize)> = Vec::new();
    for (s, e) in all {
        match groups.last_mut() {
            Some((_, ge)) if s <= *ge => *ge = (*ge).max(e),
            _ => groups.push((s, e)),
        }
    }

    let owned = |lines: &[&str]| lines.iter().map(|l| l.to_string()).collect::<Vec<_>>();
    let mut segments = Vec::new();
    let mut cursor = 0;
    for (rs, re) in groups {
        if rs > cursor {
            segments.push(Segment::Agreed(owned(&base_lines[cursor..rs])));
        }
        let base_slice = owned(&base_lines[rs..re]);
        let mut distinct: Vec<(usize, Vec<String>)> = Vec::new();
        for (side, runs) in per_side.iter().enumerate() {
            let prop = splice(&base_lines, runs, rs, re);
            if prop == base_slice || distinct.iter().any(|(_, p)| *p == prop) {
                continue;
            }
            distinct.push((side, prop));
        }
        segments.push(match distinct.len() {
            0 => Segment::Agreed(base_slice), // unreachable: a group implies an edit
            1 => Segment::Agreed(distinct.pop().map(|(_, p)| p).unwrap_or(base_slice)),
            _ => Segment::Disputed(distinct),
        });
        cursor = re;
    }
    if cursor < base_lines.len() {
        segments.push(Segment::Agreed(owned(&base_lines[cursor..])));
    }
    segments
}

/// The N-way merge's presentation, format-dispatched exactly like the two-head forms:
/// disputed regions wear plaintext's marker chain (one `<<<<<<<` per side, the house shape
/// from the whole-document form) or Marquee's `:::conflict`/`:::variant` scaffolding.
fn render_segments(
    format: Format,
    segments: &[Segment],
    heads: &[&Version],
    names: &BTreeMap<[u8; 32], String>,
) -> String {
    let mut out = String::new();
    let push_lines = |out: &mut String, lines: &[String]| {
        for l in lines {
            out.push_str(l);
            out.push('\n');
        }
    };
    for seg in segments {
        match seg {
            Segment::Agreed(lines) => push_lines(&mut out, lines),
            Segment::Disputed(props) => match format {
                Format::Plaintext => {
                    for (i, (side, lines)) in props.iter().enumerate() {
                        out.push_str(&format!("<<<<<<< {}\n", side_label(heads[*side], names)));
                        push_lines(&mut out, lines);
                        out.push_str(if i + 1 == props.len() {
                            ">>>>>>>\n"
                        } else {
                            "=======\n"
                        });
                    }
                }
                Format::Marquee => {
                    out.push_str(":::conflict\n");
                    for (side, lines) in props {
                        out.push_str(&variant_open(heads[*side], names));
                        push_lines(&mut out, lines);
                        out.push_str("::: variant\n");
                    }
                    out.push_str("::: conflict\n");
                }
                Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus => {
                    unreachable!("media never reaches text merge")
                }
            },
        }
    }
    out
}

/// Present a conflict as *whole* alternatives - the degraded shape used when a merge can't
/// run: no single fork point for the head set (criss-cross among three-plus heads), or a
/// missing body. Lossless as ever. Text only: `resolve` returns before this for media
/// (which has no synthesized-text conflict).
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
                out.push_str(&variant_open(v, names));
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
        // Three-plus logical heads. When the whole head set forked from ONE version (three
        // computers changing the same document simultaneously - field-reported when it came
        // back as a wall of whole-document conflict), that version is the base and the N-way
        // alignment merges per-hunk: disjoint edits weave clean, only genuinely disputed
        // regions wear scaffolding, one variant per distinct proposal. Murkier shapes - no
        // single fork point for the set (criss-cross among three-plus), a missing base body
        // - degrade to the whole-document conflict as ever: conservative, lossless.
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
            let head_hashes: Vec<[u8; 32]> = many.iter().map(|v| v.hash).collect();
            let forks = doc.fork_points_of_heads(&head_hashes);
            let fork_version = match forks.as_slice() {
                [fork] => doc.versions.get(fork),
                _ => None,
            };
            if let Some(fv) = fork_version {
                if let Some(base) = read_body(files, keys, fv).await? {
                    let base = String::from_utf8_lossy(&base).into_owned();
                    let texts: Vec<&str> = sides.iter().map(|(_, t)| t.as_str()).collect();
                    let segments = align_heads(&base, &texts);
                    let disputed = segments.iter().any(|s| matches!(s, Segment::Disputed(_)));
                    // Rung 3 generalizes: exactly one head renamed (relative to the fork)
                    // → the rename wins; otherwise the display head's title stands.
                    let renamed: Vec<&&Version> = many
                        .iter()
                        .filter(|v| v.header.title != fv.header.title)
                        .collect();
                    let title = match renamed.as_slice() {
                        [one] => one.header.title.clone(),
                        _ => display_title,
                    };
                    return Ok(ResolvedDoc {
                        resolution: if disputed {
                            Resolution::Conflict
                        } else {
                            Resolution::Merged
                        },
                        title,
                        body: Some(render_segments(format, &segments, many, names)),
                    });
                }
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
    // conflict per-hunk - inline markers for plaintext, `:::conflict`/`:::variant` vocabulary
    // for Marquee (its markers-are-vocabulary is the whole reason we split the formats).
    //
    // The Marquee presentation is built from merge STRUCTURE (align_heads segments - the same
    // engine the N-way path trusts), never by re-parsing diffy's marked text: a content line
    // that LOOKS like a marker inside a disputed hunk (the user's own "=======", or markers a
    // criss-cross virtual base let surface) is undecidable from the text, and the old line-
    // state-machine translation switched sides at the lookalike, leaving half the conflict in
    // git dialect (field-found 2026-08-01). Plaintext keeps diffy's marked output verbatim -
    // markers ARE its vocabulary, and the same ambiguity is git's own native hazard there.
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
                Format::Marquee => {
                    let segments = align_heads(&base, &[text_a.as_str(), text_b.as_str()]);
                    render_segments(format, &segments, &[a, b], names)
                }
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
    /// Append a public doc header straight to the POSTS chain. The real publish path needs a
    /// FileStore for the body; the fold under test only reads the header, so this stays a unit
    /// test instead of an integration one.
    async fn mint_public_header(
        db: &Db,
        key: &ringtome_proto::SigningKey,
        doc_id: &[u8; 16],
        title: &str,
    ) {
        let header = DocHeaderPlain {
            doc_id: *doc_id,
            parents: Vec::new(),
            file_hash: [1u8; 32],
            body_hash: [1u8; 32],
            title: title.to_string(),
            format: None,
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: Vec::new(),
            genesis_ms: None,
        };
        crate::record::imaol::append(
            db,
            key,
            service::POSTS,
            entry_type::DOC_HEADER,
            Payload::Inline(header.encode().unwrap()),
        )
        .await
        .unwrap();
    }


    /// The gap this whole slice exists to close: before the public tombstone, a deleted post
    /// stayed on the shelf forever from every other node's point of view, because the only
    /// record of the deletion was an epoch-encrypted fact on a private chain.
    #[tokio::test]
    async fn a_public_retraction_takes_a_document_off_the_shelf() {
        let db = crate::db::test_user_db().await;
        let key = ringtome_proto::SigningKey::from_bytes(&[7u8; 32]);

        let doc = [3u8; 16];
        mint_public_header(&db, &key, &doc, "a post worth regretting").await;
        assert!(
            public_doc_ids(&db).await.unwrap().contains(&hex::encode(doc)),
            "precondition: it is on the shelf"
        );

        retract_public(&db, &key, &doc).await.unwrap();
        assert!(
            !public_doc_ids(&db).await.unwrap().contains(&hex::encode(doc)),
            "a withdrawn document leaves the shelf - which is what fanout::retract_vanished \
             reconciles every reader's journal against"
        );
    }

    /// Order-independence, which finality buys: a node that folds the tombstone before the
    /// header it withdraws must settle the same as one that folds them the other way round.
    #[tokio::test]
    async fn a_retraction_that_arrives_first_still_wins() {
        let db = crate::db::test_user_db().await;
        let key = ringtome_proto::SigningKey::from_bytes(&[8u8; 32]);
        let doc = [4u8; 16];

        // The tombstone is minted first, then the header - the out-of-order arrival, which is
        // ordinary on a network where entries stream in whatever order a peer had them.
        retract_public(&db, &key, &doc).await.unwrap();
        mint_public_header(&db, &key, &doc, "posted after the tombstone").await;

        assert!(
            !public_doc_ids(&db).await.unwrap().contains(&hex::encode(doc)),
            "a tombstone is final for its document id, whichever order the fold saw them in"
        );
    }

    /// Both public entry types share one chain and therefore one watermark. If the fold ever
    /// advanced past one type while reading only the other, entries would be skipped in
    /// silence - so: interleave them and check nothing is lost.
    #[tokio::test]
    async fn headers_and_tombstones_interleave_without_losing_either() {
        let db = crate::db::test_user_db().await;
        let key = ringtome_proto::SigningKey::from_bytes(&[9u8; 32]);
        let (kept, withdrawn) = ([5u8; 16], [6u8; 16]);

        mint_public_header(&db, &key, &kept, "stays").await;
        retract_public(&db, &key, &withdrawn).await.unwrap();
        mint_public_header(&db, &key, &withdrawn, "goes").await;
        retract_public(&db, &key, &kept).await.unwrap();
        mint_public_header(&db, &key, &kept, "stays, edited").await;

        let shelf = public_doc_ids(&db).await.unwrap();
        assert!(
            !shelf.contains(&hex::encode(withdrawn)),
            "the withdrawn document is gone"
        );
        assert!(
            !shelf.contains(&hex::encode(kept)),
            "and so is the other one - both tombstones folded, neither skipped by the shared \
             watermark"
        );
    }

    use super::*;

    async fn test_db() -> Db {
        crate::db::test_user_db().await
    }

    fn signer(byte: u8) -> SigningKey {
        SigningKey::from_bytes(&[byte; 32])
    }

    // The two save helpers below take the `Save` struct's fields positionally on purpose:
    // being a terse shorthand for a struct literal IS their job, at ~40 call sites, and
    // giving them a struct parameter would just restore the thing they exist to avoid. The
    // arity lint is right about production signatures and wrong about this.
    #[allow(clippy::too_many_arguments)]
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
                refs: Vec::new(),
            },
        )
        .await
        .unwrap()
    }

    /// Save helper that lets a test pick the format (for the Marquee conflict tests).
    #[allow(clippy::too_many_arguments)]
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
                refs: Vec::new(),
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

    /// The swap's correctness claim, pinned (2026-08-10): reading ONE document must give the
    /// same DAG the whole-corpus materializer would have handed back for it. Save and retitle
    /// took the corpus path until this test existed to make the narrow path's equivalence
    /// checkable, so any future divergence between the two resolvers fails here rather than
    /// silently changing what a save is parented on.
    #[tokio::test]
    async fn one_document_loads_exactly_what_the_whole_view_would_hold() {
        let db = test_db().await;
        let key = signer(1);
        let other = signer(2);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        // Two documents, so "the corpus" is genuinely bigger than "this document" - and the
        // one under test is diverged across two devices, which is where the resolver does its
        // interesting work (twins, echoes, logical heads).
        let quiet = new_doc_id();
        save(&db, &key, &keys, &files, quiet, vec![], "quiet", b"unrelated").await;

        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"one").await;
        let a = save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"one two").await;
        let b = save(&db, &other, &keys, &files, doc_id, vec![v1], "t", b"one three").await;

        let view = materialize(&db, &keys).await.unwrap();
        let from_view = view.docs.get(&doc_id).unwrap();
        let alone = load_doc(&db, &doc_id).await.unwrap();

        assert!(from_view.diverged(), "the fixture actually forks");
        assert_eq!(alone.lane, from_view.lane);
        assert_eq!(
            alone.versions.keys().collect::<Vec<_>>(),
            from_view.versions.keys().collect::<Vec<_>>(),
            "same versions"
        );
        let mut mine = alone.heads.clone();
        let mut theirs = from_view.heads.clone();
        mine.sort();
        theirs.sort();
        assert_eq!(mine, theirs, "same DAG heads");
        assert_eq!(
            alone.logical_heads, from_view.logical_heads,
            "same logical heads - what a retitle parents on"
        );
        assert_eq!(
            alone.display_head().map(|v| v.hash),
            from_view.display_head().map(|v| v.hash),
            "same display head"
        );
        assert!(alone.heads.contains(&a) && alone.heads.contains(&b));

        // And a document nobody has written loads EMPTY rather than erroring - the shape the
        // genesis save relies on now that it no longer asks the corpus.
        let unknown = load_doc(&db, &new_doc_id()).await.unwrap();
        assert!(unknown.versions.is_empty());
        assert!(unknown.display_head().is_none());
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
            refs: Vec::new(),
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

    /// The mixed-dialect trap (field-found 2026-08-01: "the first half of the conflict wore
    /// `:::conflict`, the second half wore `=======`/`>>>>>>>`"): a content line that LOOKS
    /// like a marker, sitting inside a disputed hunk, is undecidable from diffy's marked TEXT
    /// - a `=======` of the user's own in the ours side reads exactly like the separator, the
    /// translation switches sides early, and the real separator then falls through as
    /// literal git syntax. The presentation must therefore be built from merge STRUCTURE,
    /// never re-parsed from marker text. Both sides carry the trap so the assertion holds
    /// whichever side house order makes "ours".
    #[tokio::test]
    async fn marker_lookalike_content_inside_a_hunk_stays_content() {
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
            b"intro\nalpha\ntail\n",
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
            b"intro\nTitle A\n=======\nchanged A\ntail\n",
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
            b"intro\nTitle B\n=======\nchanged B\ntail\n",
            m,
        )
        .await;

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert!(body.contains(":::conflict"), "marquee vocabulary:\n{body}");
        assert!(
            !body.contains("<<<<<<<") && !body.contains(">>>>>>>"),
            "no git markers in a marquee doc:\n{body}"
        );
        // The discriminator: each side's heading, lookalike line, and edit stay TOGETHER in
        // one variant - no directive seam may split them, which is exactly what the old
        // text-reparsing translation did at the lookalike.
        for side in ["A", "B"] {
            let start = body.find(&format!("Title {side}")).unwrap();
            let end = body.find(&format!("changed {side}")).unwrap();
            assert!(
                start < end && !body[start..end].contains(":::"),
                "side {side}'s lines were split across variants:\n{body}"
            );
        }
        assert_eq!(
            body.matches("=======").count(),
            2,
            "both lookalike lines survive as content, none consumed, none synthesized:\n{body}"
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

    /// The 2026-07-25 field report, reproduced: THREE computers changing the same section
    /// simultaneously fork three ways from one version - and got the whole-document wall,
    /// because three-plus heads skipped merging entirely. Now: one conflict block holding
    /// the three proposals, everything else woven clean outside it.
    #[tokio::test]
    async fn three_way_fork_conflicts_per_hunk_not_whole_document() {
        let db = test_db().await;
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let m = Format::Marquee;
        let base_body = b"### One\nA\n\n### Two\nB\n\n### Five\nE\n";
        let key_a = signer(1);
        let base = save_fmt(&db, &key_a, &keys, &files, doc_id, vec![], "t", base_body, m).await;
        for (byte, one) in [(1u8, "1111111"), (2, "2222222"), (3, "33333333")] {
            let body = format!("### One\n{one}\n\n### Two\nB\n\n### Five\nE\n");
            save_fmt(
                &db,
                &signer(byte),
                &keys,
                &files,
                doc_id,
                vec![base],
                "t",
                body.as_bytes(),
                m,
            )
            .await;
        }

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert_eq!(
            body.matches(":::conflict").count(),
            1,
            "one disputed region, not a whole-document conflict:\n{body}"
        );
        assert_eq!(
            body.matches(":::variant").count(),
            3,
            "three proposals inside it:\n{body}"
        );
        for one in ["1111111", "2222222", "33333333"] {
            assert!(body.contains(one), "every proposal present:\n{body}");
        }
        let tail = body.rsplit("::: conflict").next().unwrap();
        assert!(
            tail.contains("### Two\nB") && tail.contains("### Five\nE"),
            "the agreed sections live OUTSIDE the scaffolding:\n{body}"
        );
    }

    /// Three heads whose edits don't touch merge fully clean - a case the old always-degrade
    /// rule falsely presented as a conflict.
    #[tokio::test]
    async fn three_heads_with_disjoint_edits_merge_clean() {
        let db = test_db().await;
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let base_body = b"### One\nA\n\n### Two\nB\n\n### Five\nE\n";
        let base = save(&db, &signer(1), &keys, &files, doc_id, vec![], "t", base_body).await;
        let edits: [&[u8]; 3] = [
            b"### One\nAAAA\n\n### Two\nB\n\n### Five\nE\n",
            b"### One\nA\n\n### Two\nBBBB\n\n### Five\nE\n",
            b"### One\nA\n\n### Two\nB\n\n### Five\nEEEE\n",
        ];
        for (byte, body) in edits.iter().enumerate() {
            save(&db, &signer(byte as u8 + 1), &keys, &files, doc_id, vec![base], "t", body).await;
        }

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Merged, "disjoint edits weave clean");
        let body = r.body.unwrap();
        assert_eq!(
            body,
            "### One\nAAAA\n\n### Two\nBBBB\n\n### Five\nEEEE\n",
            "all three edits present, no scaffolding"
        );
    }

    /// The plaintext mirror of the three-way field case: one marker region (the house chain,
    /// one `<<<<<<<` per side), agreed text outside it.
    #[tokio::test]
    async fn three_way_plaintext_conflicts_per_hunk() {
        let db = test_db().await;
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let base = save(&db, &signer(1), &keys, &files, doc_id, vec![], "t", b"A\nB\nC\n").await;
        for (byte, first) in [(1u8, "X"), (2, "Y"), (3, "Z")] {
            let body = format!("{first}\nB\nC\n");
            save(&db, &signer(byte), &keys, &files, doc_id, vec![base], "t", body.as_bytes())
                .await;
        }

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert_eq!(body.matches("<<<<<<<").count(), 3, "one opener per side:\n{body}");
        assert_eq!(body.matches(">>>>>>>").count(), 1, "one disputed region:\n{body}");
        assert!(
            body.ends_with(">>>>>>>\nB\nC\n"),
            "the agreed tail lives outside the markers:\n{body}"
        );
    }

    /// Three-plus heads WITHOUT a single shared fork point (a criss-cross among them) still
    /// degrade to the whole-document conflict - the N-way alignment needs one base to stand
    /// on, and when history can't name one, conservative-and-lossless wins as ever.
    #[tokio::test]
    async fn three_heads_with_crisscross_history_degrade_to_whole_document() {
        let db = test_db().await;
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();

        let doc_id = new_doc_id();
        let m = Format::Marquee;
        let root = save_fmt(&db, &signer(1), &keys, &files, doc_id, vec![], "t", b"SHARED\n", m)
            .await;
        let v1 =
            save_fmt(&db, &signer(1), &keys, &files, doc_id, vec![root], "t", b"SHARED\nv1\n", m)
                .await;
        let v2 =
            save_fmt(&db, &signer(2), &keys, &files, doc_id, vec![root], "t", b"SHARED\nv2\n", m)
                .await;
        // Three racing resolutions of the same fork: every head descends from BOTH v1 and
        // v2, so the maximal common ancestors are {v1, v2} - no single base.
        for (byte, text) in [(1u8, "m1"), (2, "m2"), (3, "m3")] {
            let body = format!("SHARED\n{text}\n");
            save_fmt(
                &db,
                &signer(byte),
                &keys,
                &files,
                doc_id,
                vec![v1, v2],
                "t",
                body.as_bytes(),
                m,
            )
            .await;
        }

        let r = resolve_doc(&db, &keys, &files, &doc_id).await;
        assert_eq!(r.resolution, Resolution::Conflict);
        let body = r.body.unwrap();
        assert_eq!(
            body.matches("SHARED").count(),
            3,
            "whole-document form: every side in full:\n{body}"
        );
    }

    fn tokens_of(rows: &[SearchRow], doc_id: &[u8; 16]) -> Vec<String> {
        let hex = hex::encode(doc_id);
        rows.iter()
            .find(|r| r.doc_id == hex)
            .map(|r| r.tokens.split(' ').map(str::to_string).collect())
            .unwrap_or_default()
    }

    /// The index reads title + body, normalized: lowercased unique words, punctuation split,
    /// the 2..=32 length band applied (so "a" and a 40-char noise run don't index).
    #[tokio::test]
    async fn search_index_tokenizes_title_and_body() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();
        let doc_id = new_doc_id();
        save(
            &db, &key, &keys, &files, doc_id, vec![], "Quick Fox",
            b"The QUICK brown fox. A x!",
        )
        .await;

        let rows = search_rows(&db, &keys, &files, &BTreeMap::new()).await.unwrap();
        let tokens = tokens_of(&rows, &doc_id);
        for want in ["quick", "fox", "brown", "the"] {
            assert!(tokens.contains(&want.to_string()), "has {want}: {tokens:?}");
        }
        assert!(!tokens.contains(&"a".to_string()), "single letters dropped");
        assert!(!tokens.contains(&"x".to_string()), "single letters dropped");
        // "QUICK" and "quick" fold to one token.
        assert_eq!(tokens.iter().filter(|t| *t == "quick").count(), 1);
    }

    /// Annotation text (a long description, tags) is indexed alongside the body - the whole
    /// point of folding annotations into the doc's row rather than a separate kind.
    #[tokio::test]
    async fn search_index_includes_annotation_text() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();
        let doc_id = new_doc_id();
        save(&db, &key, &keys, &files, doc_id, vec![], "t", b"body words").await;

        let mut annots = BTreeMap::new();
        annots.insert(doc_id, "marzipan confectionery\ndessert".to_string());
        let rows = search_rows(&db, &keys, &files, &annots).await.unwrap();
        let tokens = tokens_of(&rows, &doc_id);
        for want in ["marzipan", "confectionery", "dessert", "body", "words"] {
            assert!(tokens.contains(&want.to_string()), "has {want}: {tokens:?}");
        }
    }

    /// The staleness fingerprint: an unchanged doc is served from the cached row (no rewrite),
    /// an edited body re-indexes, and a changed annotation re-indexes even with the body fixed.
    #[tokio::test]
    async fn search_rows_refresh_only_when_inputs_change() {
        let db = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let files = FileStore::memory();
        let doc_id = new_doc_id();
        let v1 = save(&db, &key, &keys, &files, doc_id, vec![], "t", b"alpha").await;

        async fn fp(db: &Db, doc_id: &[u8; 16]) -> Vec<u8> {
            db.fetch_one::<(Vec<u8>,)>(
                "SELECT fp FROM doc_search WHERE doc_id = ?1",
                (doc_id.to_vec(),),
            )
            .await
            .unwrap()
            .0
        }

        let rows = search_rows(&db, &keys, &files, &BTreeMap::new()).await.unwrap();
        assert!(tokens_of(&rows, &doc_id).contains(&"alpha".to_string()));
        let fp1 = fp(&db, &doc_id).await;

        // Re-run, nothing changed: same fingerprint (served from cache).
        search_rows(&db, &keys, &files, &BTreeMap::new()).await.unwrap();
        assert_eq!(fp(&db, &doc_id).await, fp1, "unchanged doc keeps its row");

        // Edit the body: new head, new tokens, new fingerprint.
        save(&db, &key, &keys, &files, doc_id, vec![v1], "t", b"beta").await;
        let rows = search_rows(&db, &keys, &files, &BTreeMap::new()).await.unwrap();
        let tokens = tokens_of(&rows, &doc_id);
        assert!(tokens.contains(&"beta".to_string()), "re-indexed: {tokens:?}");
        assert!(!tokens.contains(&"alpha".to_string()), "old body gone: {tokens:?}");
        let fp2 = fp(&db, &doc_id).await;
        assert_ne!(fp2, fp1, "an edit moves the fingerprint");

        // Change only the annotation (body fixed): still re-indexes.
        let mut annots = BTreeMap::new();
        annots.insert(doc_id, "gamma".to_string());
        let rows = search_rows(&db, &keys, &files, &annots).await.unwrap();
        assert!(tokens_of(&rows, &doc_id).contains(&"gamma".to_string()));
        assert_ne!(fp(&db, &doc_id).await, fp2, "an annotation change re-indexes");
    }

    /// A body header without its blob (the cross-node reality: headers travel ahead of bodies)
    /// indexes the title now and the body when the blob lands - proven by driving the two
    /// blob-presence states directly, since the fingerprint folds in per-head blob presence.
    #[tokio::test]
    async fn search_reindexes_when_a_body_blob_arrives() {
        let writer = test_db().await;
        let reader = test_db().await;
        let key = signer(1);
        let keys = EpochKeys::single(0, [5u8; 32]);
        let with_blob = FileStore::memory();
        let no_blob = FileStore::memory(); // the reader's store before backfill

        let doc_id = new_doc_id();
        save(&writer, &key, &keys, &with_blob, doc_id, vec![], "Title Here", b"secret body word")
            .await;

        // Deliver the writer's header entries into the reader's log (what sync sends), leaving
        // the body blob behind in the writer's store - exactly the headers-ahead-of-bodies gap.
        let (raw, _) =
            crate::record::imaol::entry_bytes_page(&writer, crate::record::imaol::BACKFILL_BATCH, None)
                .await
                .unwrap();
        let root = key.verifying_key().to_bytes();
        crate::net::sync::ingest_batch(&reader, root, raw, true)
            .await
            .unwrap();

        // Before the blob (reader's own empty store): title indexes, body doesn't.
        let rows = search_rows(&reader, &keys, &no_blob, &BTreeMap::new()).await.unwrap();
        let tokens = tokens_of(&rows, &doc_id);
        assert!(tokens.contains(&"title".to_string()), "title indexed: {tokens:?}");
        assert!(!tokens.contains(&"secret".to_string()), "body not here yet: {tokens:?}");

        // The blob arrives (backfill) - the writer's store now stands in as the reader's, blob
        // present. Same log, no chain change: the fingerprint moves on body presence alone.
        let rows = search_rows(&reader, &keys, &with_blob, &BTreeMap::new()).await.unwrap();
        let tokens = tokens_of(&rows, &doc_id);
        assert!(tokens.contains(&"secret".to_string()), "body now indexed: {tokens:?}");
    }

    /// The edit window's honor rule, chain side: a version claiming to postdate its own
    /// genesis by more than the window is not part of the document - admitted to the chain,
    /// ignored by the resolver, deterministically on every node (both stamps are the author's
    /// own claims; no local clock is consulted).
    #[test]
    fn a_late_public_edit_is_admitted_and_ignored() {
        let day = 24 * 60 * 60 * 1000;
        let version = |hash: u8, t: i64, parents: Vec<[u8; 32]>| Version {
            hash: [hash; 32],
            timestamp_ms: t,
            author: [0u8; 32],
            header: DocHeaderPlain {
                doc_id: [1u8; 16],
                parents,
                file_hash: [hash; 32],
                body_hash: [hash; 32],
                title: format!("v{hash}"),
                format: None,
                width: None,
                height: None,
                duration_ms: None,
                thumb_hash: None,
                preview_hash: None,
                refs: Vec::new(),
                genesis_ms: None,
            },
        };
        let build = |lane: &str, edit_at: i64| {
            let mut doc = Doc {
                lane: lane.to_string(),
                ..Doc::default()
            };
            let v1 = version(1, 1_000, vec![]);
            let v2 = version(2, edit_at, vec![v1.hash]);
            doc.versions.insert(v1.hash, v1);
            doc.versions.insert(v2.hash, v2);
            doc.drop_late_public_edits();
            doc.thread();
            doc
        };

        // In-window: the edit is the head.
        let doc = build("public", 1_000 + day - 1);
        assert_eq!(doc.display_head().unwrap().header.title, "v2");

        // Past the window: the edit does not exist to the resolver; v1 stands.
        let doc = build("public", 1_000 + day + 1);
        assert_eq!(
            doc.display_head().unwrap().header.title,
            "v1",
            "a late edit is admitted and ignored"
        );

        // Private notes edit forever - the window is a PUBLIC posture.
        let doc = build("private", 1_000 + day * 400);
        assert_eq!(doc.display_head().unwrap().header.title, "v2");
    }
}
