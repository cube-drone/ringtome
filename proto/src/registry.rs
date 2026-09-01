//! The v0 type registry: service ids (which chain), entry-type ids (what statement), and the
//! payload codecs for the types this crate understands.
//!
//! Ids are added additively and never removed or repurposed. Old readers skip entry types they
//! don't know; the ids here are the vocabulary the version tag governs.

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;

/// Service ids: one chain per (key, service). Visibility is a per-chain property (a chain is
/// entirely public or entirely member-only encrypted), so every service is named `AREA_PUBLIC`
/// or `AREA_PRIVATE`. Ids are append-only and never repurposed; a public/private sibling is
/// added with the next free id when a feature grows a second half - numeric adjacency is not
/// required (the name carries the pairing).
pub mod service {
    pub const IDENTITY_PUBLIC: u32 = 0;
    pub const IDENTITY_PRIVATE: u32 = 1;
    /// The public self-claim: name, bio (LWW register).
    pub const PROFILE_PUBLIC: u32 = 2;
    /// (Reserved for the public-document model that supersedes it; see PROJECT_PLAN.) Today an
    /// append-only public log - not yet a live consumer.
    pub const POSTS: u32 = 3;
    /// The published relationships: `public-edge` statements minted from the ledger's
    /// `edges_public` consent (PROJECT_PLAN, Edge-Endpoint Visibility: the Publish tier), LWW
    /// per subject. Serving-follow statements land here too when fronting's ceremony exists.
    pub const FOLLOWS_PUBLIC: u32 = 4;
    /// The **general** private store: small member-only LWW facts (contact names, quiet follows,
    /// trust edges, settings), multiplexed by `collection`. Domain-less by design - features
    /// scribble here until one earns its own chain (as documents did). "General" names its role;
    /// the merge model (LWW) and access style (private) are properties, not its identity.
    pub const GENERAL_PRIVATE: u32 = 5;
    /// Private versioned documents (the notes app first): encrypted doc-header entries whose
    /// bodies live in the file layer. Its own chain so save cadence never interleaves with the
    /// small-fact traffic on `general-private`.
    pub const DOCUMENTS_PRIVATE: u32 = 6;
    /// The inbox, trusted tier: notices transcribed from senders the recipient has an edge to.
    /// Two tiers rather than one because retention and sync depth are **per-chain** policy -
    /// the stranger tier is meant to be small and forgettable, and welding it to the tier you
    /// keep is how retention becomes impossible (PROJECT_PLAN, Tiered inbox chains).
    pub const INBOX_TRUSTED: u32 = 8;
    /// The inbox, stranger tier: notices from senders with no edge to the recipient. Bounded,
    /// prunable, and the only tier a flood can ever evict from.
    pub const INBOX_STRANGER: u32 = 9;
    /// The inbox, murmurs tier (2026-08-25): low-stakes KINDS - "shared your post" today -
    /// whoever sent them. Kind outranks sender for tier placement, because the stranger
    /// pool is the flood surface and a follow notice is the highest-value thing it holds:
    /// share-noise spending those slots let a burst of shares evict a stranger's follow.
    /// Its own chain, its own keep - the only thing a murmur can drown is another murmur.
    pub const INBOX_MURMURS: u32 = 11;
    /// Public annotations (ANNOTATIONS.md, 2026-08-29): what a post is said to be, by whom.
    /// LWW statements on the SPEAKER's chain keyed (target author, target doc, key, value) -
    /// the author's own labels replicated at publish, anyone else's about anyone's post.
    /// Public and whole, like rebroadcasts: a reader holding only the tail would mis-fold a
    /// retraction whose statement fell off the front.
    pub const ANNOTATIONS_PUBLIC: u32 = 12;
    /// Rebroadcasts: signed pointers at other people's documents (PROJECT_PLAN, Rebroadcast:
    /// Pointer Plus Pinned Replica), LWW per `(author, doc_id)`.
    ///
    /// **Its own chain rather than an entry type on `posts`**, for two reasons that both bite.
    /// A view watermark is per `(author, service)`, so two folds sharing a service fight over
    /// one cursor. And the separation is the *feature*: a reader's rebroadcast band is a
    /// different dial from their interest band, so "I want your recommendations but not your
    /// musings" has to be expressible - and with two chains it eventually becomes expressible
    /// at the sync layer too, where the posts are never fetched at all rather than fetched and
    /// hidden.
    pub const REBROADCASTS: u32 = 10;
    /// Private facts *about* documents (PROJECT_PLAN, Annotations): per-doc human assertions
    /// (`description`, `artist`, ...) as LWW registers, tags as LWW set-elements, everything
    /// about one document grouped in its `annot:<root>/<doc_id>` collection. Its own chain,
    /// **pre-graduated** off `general-private` - the scribble phase is skipped when the cadence
    /// is forecastable, and here it is twice over: annotation volume scales with library size
    /// (a bulk import writes tens of thousands of registers in an afternoon), and on an
    /// encrypted chain `service` is the only cleartext partition key, so co-located annotations
    /// would tax every small-fact read with decrypt-everything, forever.
    pub const DOC_META_PRIVATE: u32 = 7;

    pub fn name(id: u32) -> &'static str {
        match id {
            IDENTITY_PUBLIC => "identity-public",
            IDENTITY_PRIVATE => "identity-private",
            PROFILE_PUBLIC => "profile-public",
            POSTS => "posts",
            FOLLOWS_PUBLIC => "follows-public",
            INBOX_TRUSTED => "inbox-trusted",
            INBOX_STRANGER => "inbox-stranger",
            INBOX_MURMURS => "inbox-murmurs",
            ANNOTATIONS_PUBLIC => "annotations-public",
            REBROADCASTS => "rebroadcasts",
            GENERAL_PRIVATE => "general-private",
            DOCUMENTS_PRIVATE => "documents-private",
            DOC_META_PRIVATE => "doc-meta-private",
            _ => "unknown-service",
        }
    }
}

/// Entry-type ids. 0 is reserved.
pub mod entry_type {
    pub const AUTHORIZE: u32 = 1;
    pub const REVOKE: u32 = 2;
    pub const PROFILE_SET: u32 = 3;
    pub const POST: u32 = 4;
    /// Epoch rotation for private-chain encryption: fresh symmetric key sealed to each remaining
    /// member. Lives on the identity-public chain (membership metadata correlates with public
    /// revocations anyway; the boxes are opaque).
    pub const KEY_EPOCH: u32 = 5;
    /// An encrypted private-chain record (outer: epoch + nonce + ciphertext; inner:
    /// [`PrivatePlain`], readable only by members holding the epoch key). Rides the
    /// general-private chain and, since annotations, the doc-meta-private chain too - same
    /// codec, same LWW semantics, different chain (each chain's AAD binds its ciphertexts to
    /// its own domain, node-side).
    pub const PRIVATE_RECORD: u32 = 6;
    /// One version of a versioned document (outer: the same epoch + nonce + ciphertext envelope
    /// as `private-record`, under its own AAD; inner: [`DocHeaderPlain`]). The entry's own hash
    /// is the version's identity; the body lives in the file layer.
    pub const DOC_HEADER: u32 = 7;
    /// The published form of one relationship ([`PublicEdge`]): the bands its author consented
    /// to share about one subject. The follows-public chain's first citizen.
    pub const PUBLIC_EDGE: u32 = 8;
    /// A transcribed notice on an inbox chain: the same `{epoch, nonce, ciphertext}` envelope
    /// as `private-record`, under its own AAD, whose plaintext is a delivered
    /// [`crate::deliver::SignedEnvelope`] **verbatim** - so the recipient's other nodes verify
    /// the sender themselves instead of trusting whichever node answered the door.
    pub const INBOX_NOTICE: u32 = 9;
    /// A signed pointer at someone else's document ([`Rebroadcast`]) - the durable half of a
    /// share. The content itself is never copied here; the rebroadcaster's node pins a replica
    /// of the author's own signed entry and body instead.
    pub const REBROADCAST: u32 = 10;
    /// A public document withdrawn ([`PostRetraction`]) - the tombstone that makes deletion
    /// *speech*. Content-free by construction: sixteen bytes of doc id and nothing else, which
    /// is what lets every node remember it forever without remembering what it withdrew.
    pub const POST_RETRACT: u32 = 11;
    /// One public annotation statement (`PublicAnnotation`), on `ANNOTATIONS_PUBLIC`.
    pub const PUBLIC_ANNOTATION: u32 = 12;

    pub fn name(id: u32) -> &'static str {
        match id {
            AUTHORIZE => "authorize",
            REVOKE => "revoke",
            PROFILE_SET => "profile-set",
            POST => "post",
            KEY_EPOCH => "key-epoch",
            PRIVATE_RECORD => "private-record",
            DOC_HEADER => "doc-header",
            REBROADCAST => "rebroadcast",
            POST_RETRACT => "post-retract",
            PUBLIC_ANNOTATION => "public-annotation",
            PUBLIC_EDGE => "public-edge",
            INBOX_NOTICE => "inbox-notice",
            _ => "unknown-type",
        }
    }
}

/// Document body formats: the `format` field of a doc header. **Plaintext is the *absence* of a
/// format** (the default, forever), so it has no id; other formats are a closed, additively-grown
/// enum. The declared format is enforced by the renderer, never trusted (Allowlist Beats
/// Blocklist): an unknown id degrades to plaintext (source shown, never mis-rendered).
pub mod doc_format {
    /// Marquee markup.
    pub const MARQUEE: u64 = 1;
    /// An AVIF image - the canonical *stored* image format. Every bitmap upload (png, jpeg, gif,
    /// webp, ...) is transcoded once, at ingest, into AVIF (AV1 intra); what lands here and syncs
    /// is always already-crunched AVIF. Opaque bytes, not mergeable text. Media validation
    /// (Media-Type Admission Test) splits by threat: *scanning* and stranger-liability are
    /// public-only, but **sandboxed decoding and don't-trust-the-declared-type apply to private
    /// media too** - a compromised-not-yet-revoked member is an adversary inside the membrane, so
    /// the render path treats even "our own" bytes as hostile (Doctrine: Every Byte From The
    /// Network Is Hostile). The ingest transcode strips EXIF for free (decode-to-pixels drops it),
    /// covering the publication-boundary concern (don't leak GPS outward) as a side effect.
    pub const AVIF: u64 = 2;
    /// Animated PNG - the canonical form for animated images that are TRANSPARENT and silent (a
    /// transparent sticker, an under-construction sign). Alpha survives and every browser renders
    /// APNG-alpha in an `<img>`; alpha-in-video has no universal playback path, so transparency
    /// stays in the image lane. Opaque or audio-bearing animation routes to `WEBM_AV1` instead.
    pub const APNG: u64 = 3;
    /// AV1-in-WebM (+ Opus when the source has audio) - the canonical form for video and for
    /// opaque animation. The browser normalizes the input codec zoo into a closed set; the node
    /// re-decodes (rav1d) and re-encodes (rav1e) to launder, so only our own bytes ever distribute.
    pub const WEBM_AV1: u64 = 4;
    /// Ogg Opus - the canonical audio form. Wild input formats (mp3/aac/flac/wav/vorbis) are
    /// decoded in memory-safe Rust and re-encoded to a fit-to-cap Opus; in-spec Opus passes through.
    pub const OGG_OPUS: u64 = 5;
}

/// Payload of an `authorize` entry: the signer (parent) grants `child` membership in the key
/// tree, stamping it with the cumulative **usurper list** - everyone senior to the child at
/// signing time: the parent's own usurpers, the parent, and the parent's previously-signed
/// children, in that order (PROJECT_PLAN, key-tree rule 3). The stamp is the child's portable,
/// self-incriminating credential; validators independently recompute the expected list from the
/// parent's chain history and reject a mismatch, so a truncated-lineage forgery cannot validate.
///
/// Encoding: integer-keyed map `{0: bstr(32) child, 1: array<bstr(32)> usurpers,
/// 2?: bstr(32) enc_pubkey}`. Field 2 (added with private chains) is the child's X25519
/// encryption public key, parent-attested from birth so epoch keys can be sealed to the member
/// without an announcement round-trip. Additive and ignorable: a reader that skips it merely
/// cannot seal to that member - privacy features fail closed, ranking is untouched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorize {
    pub child: [u8; 32],
    pub usurpers: Vec<[u8; 32]>,
    pub enc_pubkey: Option<[u8; 32]>,
}

impl Authorize {
    /// Ceiling on tree depth-times-breadth a single stamp may claim. Honest trees are tiny
    /// (design center: 2-5 keys); a thousand-entry usurper list is an attack or a bug.
    pub const MAX_USURPERS: usize = 256;

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.usurpers.len() > Self::MAX_USURPERS {
            return Err(ProtoError::BadEntry("usurper list too long"));
        }
        let mut w = Writer::new();
        w.map(if self.enc_pubkey.is_some() { 3 } else { 2 });
        w.uint(0);
        w.bytes(&self.child);
        w.uint(1);
        w.array(self.usurpers.len() as u64);
        for u in &self.usurpers {
            w.bytes(u);
        }
        if let Some(enc) = &self.enc_pubkey {
            w.uint(2);
            w.bytes(enc);
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut child: Option<[u8; 32]> = None;
        let mut usurpers: Option<Vec<[u8; 32]>> = None;
        let mut enc_pubkey: Option<[u8; 32]> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => child = Some(map.bytes_fixed::<32>()?),
                1 => {
                    let len = map.array()?;
                    if len > Self::MAX_USURPERS as u64 {
                        return Err(ProtoError::BadEntry("usurper list too long"));
                    }
                    let mut list = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        list.push(map.bytes_fixed::<32>()?);
                    }
                    usurpers = Some(list);
                }
                2 => enc_pubkey = Some(map.bytes_fixed::<32>()?),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        Ok(Self {
            child: child.ok_or(ProtoError::BadEntry("authorize missing child"))?,
            usurpers: usurpers.ok_or(ProtoError::BadEntry("authorize missing usurper list"))?,
            enc_pubkey,
        })
    }
}

/// One epoch recipient: (leaf signing pubkey, X25519 enc pubkey, sealed box holding the epoch
/// key).
pub type EpochRecipient = ([u8; 32], [u8; 32], Vec<u8>);

/// Payload of a `key-epoch` entry: a fresh private-chain encryption key, sealed to every
/// remaining member (and always the recovery key). Old members hold old epochs and can read
/// their era forever; they cannot open the new boxes - that is the whole mechanism of
/// "revoked keys see everything-before, nothing-after."
///
/// Encoding: `{0: uint epoch, 1: array<[bstr(32) leaf, bstr(32) enc_pub, bstr box]>}`. The
/// recipient list carries each member's enc pubkey so future rotators learn the roster from the
/// chain itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEpoch {
    pub epoch: u64,
    pub recipients: Vec<EpochRecipient>,
}

impl KeyEpoch {
    pub const MAX_RECIPIENTS: usize = 256;
    /// Sealed-box overhead is ~48 bytes over the 32-byte key; leave headroom.
    pub const MAX_BOX_BYTES: usize = 256;

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.recipients.len() > Self::MAX_RECIPIENTS {
            return Err(ProtoError::BadEntry("too many epoch recipients"));
        }
        let mut w = Writer::new();
        w.map(2);
        w.uint(0);
        w.uint(self.epoch);
        w.uint(1);
        w.array(self.recipients.len() as u64);
        for (leaf, enc_pub, sealed) in &self.recipients {
            if sealed.len() > Self::MAX_BOX_BYTES {
                return Err(ProtoError::BadEntry("epoch box too large"));
            }
            w.array(3);
            w.bytes(leaf);
            w.bytes(enc_pub);
            w.bytes(sealed);
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut epoch: Option<u64> = None;
        let mut recipients: Option<Vec<EpochRecipient>> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => epoch = Some(map.uint()?),
                1 => {
                    let len = map.array()?;
                    if len > Self::MAX_RECIPIENTS as u64 {
                        return Err(ProtoError::BadEntry("too many epoch recipients"));
                    }
                    let mut list = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        if map.array()? != 3 {
                            return Err(ProtoError::BadEntry(
                                "epoch recipient must be [leaf, enc_pub, box]",
                            ));
                        }
                        let leaf = map.bytes_fixed::<32>()?;
                        let enc_pub = map.bytes_fixed::<32>()?;
                        let sealed = map.bytes()?;
                        if sealed.len() > Self::MAX_BOX_BYTES {
                            return Err(ProtoError::BadEntry("epoch box too large"));
                        }
                        list.push((leaf, enc_pub, sealed.to_vec()));
                    }
                    recipients = Some(list);
                }
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        Ok(Self {
            epoch: epoch.ok_or(ProtoError::BadEntry("key-epoch missing epoch"))?,
            recipients: recipients.ok_or(ProtoError::BadEntry("key-epoch missing recipients"))?,
        })
    }
}

/// Outer payload of a `private-record` entry: which epoch key opens it, plus the ciphertext.
/// Structure is visible to members and strangers alike (though strangers never receive private
/// chains at all - the sync gate refuses them without a member proof); content is not.
///
/// Encoding: `{0: uint epoch, 1: bstr(24) nonce, 2: bstr ciphertext}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivateRecord {
    pub epoch: u64,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}

impl PrivateRecord {
    pub const MAX_CIPHERTEXT: usize = 6 * 1024;

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.ciphertext.len() > Self::MAX_CIPHERTEXT {
            return Err(ProtoError::BadEntry("private record too large"));
        }
        let mut w = Writer::new();
        w.map(3);
        w.uint(0);
        w.uint(self.epoch);
        w.uint(1);
        w.bytes(&self.nonce);
        w.uint(2);
        w.bytes(&self.ciphertext);
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let (mut epoch, mut nonce, mut ciphertext) = (None, None, None);
        while let Some(key) = map.next_key()? {
            match key {
                0 => epoch = Some(map.uint()?),
                1 => nonce = Some(map.bytes_fixed::<24>()?),
                2 => {
                    let ct = map.bytes()?;
                    if ct.len() > Self::MAX_CIPHERTEXT {
                        return Err(ProtoError::BadEntry("private record too large"));
                    }
                    ciphertext = Some(ct.to_vec());
                }
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        Ok(Self {
            epoch: epoch.ok_or(ProtoError::BadEntry("private record missing epoch"))?,
            nonce: nonce.ok_or(ProtoError::BadEntry("private record missing nonce"))?,
            ciphertext: ciphertext
                .ok_or(ProtoError::BadEntry("private record missing ciphertext"))?,
        })
    }
}

/// The *decrypted* content of a private record - what members see. Three kinds make both merge
/// disciplines explicit in the format: `Register` is LWW per (collection, key); `SetAdd` /
/// `SetRemove` form an LWW-element-set per (collection, element), which is how follows and links
/// converge as lists (one entry per element, never a list in one value - see the links lesson).
///
/// Encoding: `{0: uint kind, 1: text collection, 2: text key, 3?: text value}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateKind {
    Register = 0,
    SetAdd = 1,
    SetRemove = 2,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrivatePlain {
    pub kind: PrivateKind,
    pub collection: String,
    pub key: String,
    /// Present for registers (the value) and optionally for set-adds (element metadata);
    /// meaningless for removes.
    pub value: Option<String>,
}

impl PrivatePlain {
    pub const MAX_NAME_LEN: usize = 128;
    pub const MAX_VALUE_LEN: usize = 4096;

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.collection.is_empty() || self.collection.len() > Self::MAX_NAME_LEN {
            return Err(ProtoError::BadEntry("collection name length out of range"));
        }
        if self.key.is_empty() || self.key.len() > Self::MAX_NAME_LEN {
            return Err(ProtoError::BadEntry("key length out of range"));
        }
        if self
            .value
            .as_ref()
            .is_some_and(|v| v.len() > Self::MAX_VALUE_LEN)
        {
            return Err(ProtoError::BadEntry("value too long"));
        }
        let mut w = Writer::new();
        w.map(if self.value.is_some() { 4 } else { 3 });
        w.uint(0);
        w.uint(self.kind as u64);
        w.uint(1);
        w.text(&self.collection);
        w.uint(2);
        w.text(&self.key);
        if let Some(v) = &self.value {
            w.uint(3);
            w.text(v);
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let (mut kind, mut collection, mut key_f, mut value) = (None, None, None, None);
        while let Some(key) = map.next_key()? {
            match key {
                0 => {
                    kind = Some(match map.uint()? {
                        0 => PrivateKind::Register,
                        1 => PrivateKind::SetAdd,
                        2 => PrivateKind::SetRemove,
                        _ => return Err(ProtoError::BadEntry("unknown private record kind")),
                    })
                }
                1 => collection = Some(map.text()?.to_string()),
                2 => key_f = Some(map.text()?.to_string()),
                3 => value = Some(map.text()?.to_string()),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        let out = Self {
            kind: kind.ok_or(ProtoError::BadEntry("private record missing kind"))?,
            collection: collection
                .ok_or(ProtoError::BadEntry("private record missing collection"))?,
            key: key_f.ok_or(ProtoError::BadEntry("private record missing key"))?,
            value,
        };
        if out.collection.is_empty() || out.collection.len() > Self::MAX_NAME_LEN {
            return Err(ProtoError::BadEntry("collection name length out of range"));
        }
        if out.key.is_empty() || out.key.len() > Self::MAX_NAME_LEN {
            return Err(ProtoError::BadEntry("key length out of range"));
        }
        if out
            .value
            .as_ref()
            .is_some_and(|v| v.len() > Self::MAX_VALUE_LEN)
        {
            return Err(ProtoError::BadEntry("value too long"));
        }
        Ok(out)
    }
}

/// The *decrypted* content of a `doc-header` entry: one version of a versioned document
/// (PROJECT_PLAN, Versioned Documents). The version's identity is the entry's own hash;
/// `parents` holds the entry hashes this version was edited from (empty at a document's genesis,
/// one for an ordinary save, two-plus for a merge - the git-commit model, a list from day one so
/// reconvergence needs no format change). `file_hash` names the body in the file layer, by
/// ciphertext hash; `body_hash` fingerprints the *plaintext* body (keyed - see [`Self::body_hash`])
/// so equality checks never need the body bytes. `format` absent means plaintext; the closed
/// enum grows additively.
///
/// Encoding: `{0: bstr(16) doc_id, 1: array<bstr(32)> parents, 2: bstr(32) file_hash,
/// 3: bstr(32) body_hash, 4: text title, 5?: uint format, ..., 11?: array<bstr(16)> refs}`.
/// `refs` was reserved here as a future additive key from the start and realized 2026-08-14 -
/// readers that predate it skip unknown keys, so old and new entries decode either way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocHeaderPlain {
    /// The document's stable identity across all its versions - what taxonomies and publication
    /// reference. 16 random bytes, minted once at document creation.
    pub doc_id: [u8; 16],
    pub parents: Vec<[u8; 32]>,
    pub file_hash: [u8; 32],
    /// Keyed BLAKE3 of the plaintext body. Rides inside the encrypted header, so it is a
    /// member-secret exactly like the body itself; never expose it on a plaintext surface.
    pub body_hash: [u8; 32],
    pub title: String,
    pub format: Option<u64>,
    /// Media metadata, all absent for text. Populated by the ingest transcode: pixel dimensions
    /// (a layout hint - authentic, since it's signed in the author's chain, but never a safety
    /// input; the decoder enforces its own limits regardless of what these claim), an optional
    /// duration for time-based media (audio/video, `None` for stills), and `thumb_hash` - the
    /// file-layer hash of a small AVIF thumbnail stored as its OWN sibling blob (never inline: a
    /// thumbnail in the header would bloat every chain entry and turn a big directory's sync into
    /// a nightmare). All ride inside the encrypted header, member-secret like `body_hash`.
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration_ms: Option<u64>,
    pub thumb_hash: Option<[u8; 32]>,
    /// `preview_hash` - the file-layer hash of a silent AV1-in-WebM hover-preview clip, stored as
    /// its OWN sibling blob exactly like `thumb_hash` (video only, `None` for everything else).
    pub preview_hash: Option<[u8; 32]>,
    /// The post's FIRST publication, as its author claims it - the edit window's anchor
    /// (2026-08-15), carried so a fragment holder with no chain knows when the words freeze.
    /// Public posts only; absent elsewhere. Advisory like every claimed stamp, and
    /// self-defeating to forge: chain holders derive the true genesis from the chain and
    /// ignore this claim, frozen holders never re-ask, so a forward-dated rewrite is a repost
    /// the established network declines to carry (Curtis, 2026-08-15).
    pub genesis_ms: Option<i64>,
    /// The documents this body embeds, derived at authoring time by the SAME parse that bakes
    /// media - the reserved additive key, realized 2026-08-14. In the header so the set is
    /// knowable from the entry alone: a fragment names its media before its body arrives, a
    /// sharer's pin has a checkable shape, and no fold or sweep ever parses foreign Marquee.
    /// Self-scoped like every header claim: an over-claim obliges the author's own sharers
    /// (budget-capped), an under-claim breaks the author's own images past hop one. Empty is
    /// absent on the wire. Capped at [`Self::MAX_REFS`] - a document embedding more is not a
    /// document, it is a Taxonomy wearing one's clothes (the media-budget argument, counted).
    pub refs: Vec<[u8; 16]>,
    /// This post replies to another (PROJECT_PLAN's Replies, 2026-08-26): the parent's author root and
    /// doc id, the author's own signed claim - no relay can mint, alter, or re-parent a
    /// reply. On the header rather than the rebroadcast pointer because the link must
    /// travel with every fragment and share, resolvable offline (the `refs` precedent),
    /// and because the comment stays an ordinary post - tombstones, the edit window and
    /// freezing apply with zero new cases. Carried forward verbatim on re-publication,
    /// like `genesis_ms`.
    pub reply_to: Option<([u8; 32], [u8; 16])>,
    /// The thread's root - equal to `reply_to` when replying to a top-level post, copied
    /// from the parent's own claim otherwise, so a depth-N reply pins parent-plus-root and
    /// never the ancestor path. A lied-about root is self-scoped: the reply renders under
    /// the wrong thread, and any holder of the parent sees the mismatch. Requires
    /// `reply_to`: a root claim without a parent is not a shape this codec carries.
    pub thread_root: Option<([u8; 32], [u8; 16])>,
    /// The author settled this post (VISIBILITY.md, 2026-09-01): no rebroadcasts, no
    /// replies - a wish every honest surface honors, carried in the SIGNED header so any
    /// holder can check it offline. Malicious clients and screenshots exist; from this
    /// network's own point of view a settled post is settled. Absent on the wire when
    /// false. Carried forward on re-publication like `genesis_ms`.
    pub settled: bool,
}

impl DocHeaderPlain {
    pub const MAX_TITLE_LEN: usize = 1024;
    /// A merge of more heads than this is not a document any more.
    pub const MAX_PARENTS: usize = 16;
    /// A body embedding more documents than this is not a post - it is a collection wearing a
    /// post's clothes, and collections are Taxonomies. Set well above any honest page (fifty
    /// distinct embedded documents is already an album) and well below where a refchain
    /// becomes a lever: every ref is a fetch obligation for every sharer, and the count is the
    /// cheap half of the bound the media budget prices in bytes.
    pub const MAX_REFS: usize = 50;

    /// The body fingerprint: BLAKE3 keyed by a document-scoped key. Keying by `doc_id` kills
    /// global rainbow tables - a dictionary attack against a low-entropy body must be mounted
    /// per-document, by someone already holding the epoch keys. (For key-holders the residual
    /// is inherent: deleted content stays *confirmable* - never recoverable - as long as its
    /// header survives. NOTES_APP records the asterisk.)
    pub fn body_hash(doc_id: &[u8; 16], body: &[u8]) -> [u8; 32] {
        let key = blake3::derive_key("ringtome-v0/body-hash", doc_id);
        *blake3::keyed_hash(&key, body).as_bytes()
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.title.len() > Self::MAX_TITLE_LEN {
            return Err(ProtoError::BadEntry("title too long"));
        }
        if self.parents.len() > Self::MAX_PARENTS {
            return Err(ProtoError::BadEntry("too many parents"));
        }
        if self.refs.len() > Self::MAX_REFS {
            return Err(ProtoError::BadEntry("too many embedded documents"));
        }
        let mut w = Writer::new();
        // Base 5 fields (0..4) plus whichever optionals are present. Keys stay in ascending
        // order, so the map is canonical.
        let n = 5
            + self.format.is_some() as u64
            + self.width.is_some() as u64
            + self.height.is_some() as u64
            + self.duration_ms.is_some() as u64
            + self.thumb_hash.is_some() as u64
            + self.preview_hash.is_some() as u64
            + !self.refs.is_empty() as u64
            + self.genesis_ms.is_some() as u64
            + self.reply_to.is_some() as u64
            + self.thread_root.is_some() as u64
            + self.settled as u64;
        if self.thread_root.is_some() && self.reply_to.is_none() {
            return Err(ProtoError::BadEntry("a thread root without a parent"));
        }
        w.map(n);
        w.uint(0);
        w.bytes(&self.doc_id);
        w.uint(1);
        w.array(self.parents.len() as u64);
        for p in &self.parents {
            w.bytes(p);
        }
        w.uint(2);
        w.bytes(&self.file_hash);
        w.uint(3);
        w.bytes(&self.body_hash);
        w.uint(4);
        w.text(&self.title);
        if let Some(f) = self.format {
            w.uint(5);
            w.uint(f);
        }
        if let Some(x) = self.width {
            w.uint(6);
            w.uint(x as u64);
        }
        if let Some(x) = self.height {
            w.uint(7);
            w.uint(x as u64);
        }
        if let Some(d) = self.duration_ms {
            w.uint(8);
            w.uint(d);
        }
        if let Some(t) = &self.thumb_hash {
            w.uint(9);
            w.bytes(t);
        }
        if let Some(p) = &self.preview_hash {
            w.uint(10);
            w.bytes(p);
        }
        if !self.refs.is_empty() {
            w.uint(11);
            w.array(self.refs.len() as u64);
            for r in &self.refs {
                w.bytes(r);
            }
        }
        if let Some(g) = self.genesis_ms {
            if g < 0 {
                return Err(ProtoError::BadEntry("genesis before the epoch"));
            }
            w.uint(12);
            w.uint(g as u64);
        }
        if let Some((author, doc)) = &self.reply_to {
            w.uint(13);
            w.array(2);
            w.bytes(author);
            w.bytes(doc);
        }
        if let Some((author, doc)) = &self.thread_root {
            w.uint(14);
            w.array(2);
            w.bytes(author);
            w.bytes(doc);
        }
        if self.settled {
            w.uint(15);
            w.uint(1);
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let (mut doc_id, mut parents, mut file_hash, mut body_hash, mut title, mut format) =
            (None, None, None, None, None, None);
        let (mut width, mut height, mut duration_ms, mut thumb_hash, mut preview_hash) =
            (None, None, None, None, None);
        let mut refs: Vec<[u8; 16]> = Vec::new();
        let mut genesis_ms: Option<i64> = None;
        let mut reply_to: Option<([u8; 32], [u8; 16])> = None;
        let mut thread_root: Option<([u8; 32], [u8; 16])> = None;
        let mut settled = false;
        while let Some(key) = map.next_key()? {
            match key {
                0 => doc_id = Some(map.bytes_fixed::<16>()?),
                1 => {
                    let n = map.array()?;
                    if n as usize > Self::MAX_PARENTS {
                        return Err(ProtoError::BadEntry("too many parents"));
                    }
                    let mut v = Vec::with_capacity(n as usize);
                    for _ in 0..n {
                        v.push(map.bytes_fixed::<32>()?);
                    }
                    parents = Some(v);
                }
                2 => file_hash = Some(map.bytes_fixed::<32>()?),
                3 => body_hash = Some(map.bytes_fixed::<32>()?),
                4 => title = Some(map.text()?.to_string()),
                5 => format = Some(map.uint()?),
                6 => {
                    width = Some(
                        u32::try_from(map.uint()?)
                            .map_err(|_| ProtoError::BadEntry("width out of range"))?,
                    )
                }
                7 => {
                    height = Some(
                        u32::try_from(map.uint()?)
                            .map_err(|_| ProtoError::BadEntry("height out of range"))?,
                    )
                }
                8 => duration_ms = Some(map.uint()?),
                9 => thumb_hash = Some(map.bytes_fixed::<32>()?),
                10 => preview_hash = Some(map.bytes_fixed::<32>()?),
                12 => {
                    let g = map.uint()?;
                    genesis_ms = Some(
                        i64::try_from(g)
                            .map_err(|_| ProtoError::BadEntry("genesis out of range"))?,
                    );
                }
                11 => {
                    let n = map.array()?;
                    if n as usize > Self::MAX_REFS {
                        return Err(ProtoError::BadEntry("too many embedded documents"));
                    }
                    for _ in 0..n {
                        refs.push(map.bytes_fixed::<16>()?);
                    }
                }
                13 => {
                    if map.array()? != 2 {
                        return Err(ProtoError::BadEntry("reply_to must be [author, doc]"));
                    }
                    reply_to = Some((map.bytes_fixed::<32>()?, map.bytes_fixed::<16>()?));
                }
                14 => {
                    if map.array()? != 2 {
                        return Err(ProtoError::BadEntry("thread_root must be [author, doc]"));
                    }
                    thread_root = Some((map.bytes_fixed::<32>()?, map.bytes_fixed::<16>()?));
                }
                15 => settled = map.uint()? != 0,
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        let out = Self {
            doc_id: doc_id.ok_or(ProtoError::BadEntry("doc header missing doc_id"))?,
            parents: parents.ok_or(ProtoError::BadEntry("doc header missing parents"))?,
            file_hash: file_hash.ok_or(ProtoError::BadEntry("doc header missing file_hash"))?,
            body_hash: body_hash.ok_or(ProtoError::BadEntry("doc header missing body_hash"))?,
            title: title.ok_or(ProtoError::BadEntry("doc header missing title"))?,
            format,
            width,
            height,
            duration_ms,
            thumb_hash,
            preview_hash,
            refs,
            genesis_ms,
            reply_to,
            thread_root,
            settled,
        };
        if out.title.len() > Self::MAX_TITLE_LEN {
            return Err(ProtoError::BadEntry("title too long"));
        }
        if out.thread_root.is_some() && out.reply_to.is_none() {
            return Err(ProtoError::BadEntry("a thread root without a parent"));
        }
        Ok(out)
    }
}

/// What a revocation asserts about the revoked key's already-signed history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// "This key is closed, no prejudice": all history through the anchored heads is honored,
    /// the subtree lives. Self-issuable (or by any senior).
    Retirement = 0,
    /// "This key is hostile, quarantine it": everything beyond the anchored prefixes is
    /// distrusted and the subtree dies. Issuable only by a strictly senior key.
    Repudiation = 1,
}

/// One anchored chain head of the revoked key: `(service, seq, head_hash)`. The hash - not just
/// the seq - is load-bearing: it pins the exact entry and, transitively, the whole prefix, so an
/// attacker cannot backdate around the seal (PROJECT_PLAN, Anchored Revocations). The chain's
/// author is implicitly the revocation's target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Anchor {
    pub service: u32,
    pub seq: u64,
    pub head_hash: [u8; 32],
}

/// Payload of a `revoke` entry.
///
/// Encoding: integer-keyed map
/// `{0: bstr(32) target, 1: uint disposition, 2: array<[uint service, uint seq, bstr(32) head]>}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Revoke {
    pub target: [u8; 32],
    pub disposition: Disposition,
    pub anchors: Vec<Anchor>,
}

impl Revoke {
    /// One anchor per (key, service) chain; the service registry is small.
    pub const MAX_ANCHORS: usize = 64;

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.anchors.len() > Self::MAX_ANCHORS {
            return Err(ProtoError::BadEntry("anchor list too long"));
        }
        let mut w = Writer::new();
        w.map(3);
        w.uint(0);
        w.bytes(&self.target);
        w.uint(1);
        w.uint(self.disposition as u64);
        w.uint(2);
        w.array(self.anchors.len() as u64);
        for a in &self.anchors {
            w.array(3);
            w.uint(u64::from(a.service));
            w.uint(a.seq);
            w.bytes(&a.head_hash);
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut target: Option<[u8; 32]> = None;
        let mut disposition: Option<Disposition> = None;
        let mut anchors: Option<Vec<Anchor>> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => target = Some(map.bytes_fixed::<32>()?),
                1 => {
                    disposition = Some(match map.uint()? {
                        0 => Disposition::Retirement,
                        1 => Disposition::Repudiation,
                        _ => return Err(ProtoError::BadEntry("unknown revocation disposition")),
                    })
                }
                2 => {
                    let len = map.array()?;
                    if len > Self::MAX_ANCHORS as u64 {
                        return Err(ProtoError::BadEntry("anchor list too long"));
                    }
                    let mut list = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        if map.array()? != 3 {
                            return Err(ProtoError::BadEntry(
                                "anchor must be [service, seq, head_hash]",
                            ));
                        }
                        let service = u32::try_from(map.uint()?)
                            .map_err(|_| ProtoError::BadEntry("service id out of range"))?;
                        let seq = map.uint()?;
                        let head_hash = map.bytes_fixed::<32>()?;
                        list.push(Anchor {
                            service,
                            seq,
                            head_hash,
                        });
                    }
                    anchors = Some(list);
                }
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        Ok(Self {
            target: target.ok_or(ProtoError::BadEntry("revoke missing target"))?,
            disposition: disposition.ok_or(ProtoError::BadEntry("revoke missing disposition"))?,
            anchors: anchors.ok_or(ProtoError::BadEntry("revoke missing anchors"))?,
        })
    }
}

/// Payload of a `profile-set` entry: one field of the identity's public profile, LWW-merged by
/// claimed timestamp at the materialization layer.
///
/// Encoding: integer-keyed map `{0: text field, 1: text value}`, canonical rules throughout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileSet {
    pub field: String,
    pub value: String,
}

impl ProfileSet {
    /// Byte length caps (after NFC normalization these are byte, not char, limits).
    pub const MAX_FIELD_LEN: usize = 64;
    pub const MAX_VALUE_LEN: usize = 4096;

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        if self.field.is_empty() || self.field.len() > Self::MAX_FIELD_LEN {
            return Err(ProtoError::BadEntry(
                "profile field name length out of range",
            ));
        }
        if self.value.len() > Self::MAX_VALUE_LEN {
            return Err(ProtoError::BadEntry("profile value too long"));
        }
        let mut w = Writer::new();
        w.map(2);
        w.uint(0);
        w.text(&self.field);
        w.uint(1);
        w.text(&self.value);
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut field: Option<String> = None;
        let mut value: Option<String> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => field = Some(map.text()?.to_string()),
                1 => value = Some(map.text()?.to_string()),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;

        let out = Self {
            field: field.ok_or(ProtoError::BadEntry("profile-set missing field name"))?,
            value: value.ok_or(ProtoError::BadEntry("profile-set missing value"))?,
        };
        if out.field.is_empty() || out.field.len() > Self::MAX_FIELD_LEN {
            return Err(ProtoError::BadEntry(
                "profile field name length out of range",
            ));
        }
        if out.value.len() > Self::MAX_VALUE_LEN {
            return Err(ProtoError::BadEntry("profile value too long"));
        }
        Ok(out)
    }
}

/// Payload of a `public-edge` entry: the published form of one relationship - the bands its
/// author consented to share about one subject (PROJECT_PLAN: The Vouch Dissolved into the
/// Ledger; Edge-Endpoint Visibility, the Publish tier). Publication is per-subject LWW across
/// the author's follows-public chains: the latest statement about a subject IS the published
/// relationship, and a statement with no bands is the retraction - nothing published any more.
/// Both cross-key ordering and the retraction-as-a-write shape are The Ordering Contract's
/// standard LWW, nothing bespoke.
///
/// Encoding: integer-keyed map `{0: bstr(32) subject, 1?: text trust, 2?: text interest}`.
/// Band values are the five words of the shared ladder (PROJECT_PLAN, Bands Not Numbers) -
/// text rather than ordinals, so the wire is self-describing and `inspect` reads naturally.
/// Absent means "no opinion published"; `"none"` is an opinion. Unknown band words are
/// rejected at decode - the fold layer treats an undecodable payload as skippable, so
/// strictness here cannot poison chain admission (validation is signatures and hashes only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicEdge {
    pub subject: [u8; 32],
    pub trust: Option<String>,
    pub interest: Option<String>,
}

impl PublicEdge {
    /// The five bands, weakest first - the one ladder every dial climbs (mirrors
    /// `node/js/pure/contact.js::BANDS`).
    pub const BANDS: [&'static str; 5] = ["none", "low", "medium", "high", "max"];

    fn check_band(value: &Option<String>, which: &'static str) -> Result<(), ProtoError> {
        match value {
            None => Ok(()),
            Some(b) if Self::BANDS.contains(&b.as_str()) => Ok(()),
            Some(_) => Err(ProtoError::BadEntry(which)),
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        Self::check_band(&self.trust, "public-edge trust is not a band")?;
        Self::check_band(&self.interest, "public-edge interest is not a band")?;
        let fields = 1 + u64::from(self.trust.is_some()) + u64::from(self.interest.is_some());
        let mut w = Writer::new();
        w.map(fields);
        w.uint(0);
        w.bytes(&self.subject);
        if let Some(trust) = &self.trust {
            w.uint(1);
            w.text(trust);
        }
        if let Some(interest) = &self.interest {
            w.uint(2);
            w.text(interest);
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut subject: Option<[u8; 32]> = None;
        let mut trust: Option<String> = None;
        let mut interest: Option<String> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => subject = Some(map.bytes_fixed::<32>()?),
                1 => trust = Some(map.text()?.to_string()),
                2 => interest = Some(map.text()?.to_string()),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        let out = Self {
            subject: subject.ok_or(ProtoError::BadEntry("public-edge missing subject"))?,
            trust,
            interest,
        };
        Self::check_band(&out.trust, "public-edge trust is not a band")?;
        Self::check_band(&out.interest, "public-edge interest is not a band")?;
        Ok(out)
    }
}

/// Payload of a `post-retract` entry: one public document, withdrawn.
///
/// **Deletion has to be speech** (PROJECT_PLAN, Retraction, edits, and what a node must remember
/// forever). Deleting a document writes a tombstone on the doc-meta chain, which is private and
/// epoch-encrypted - so it reaches the author's own devices and nobody else, and every follower
/// and every rebroadcaster keeps serving a post its author took down. This entry is the public
/// half: it rides the POSTS chain with the documents it withdraws, so it travels wherever they
/// travelled.
///
/// **Content-free on purpose, and that is the whole storage argument.** A retraction carries a
/// doc id and nothing else - no title, no body, no reason - so a node can remember every
/// retraction it has ever seen without remembering anything about what was retracted. That is
/// what makes "deletes are memoized forever, edits are not" affordable: one bit per document
/// ever published, summarizable into a filter, versus an ever-growing index of content.
///
/// LWW per document, so a retraction and a later re-publication resolve on the standard stamp
/// rather than by arrival order. There is deliberately no un-retract *payload*: republishing is
/// a new version of the document, which is a `doc-header` and wins on its own merits.
///
/// Encoding: integer-keyed map `{0: bstr(16) doc_id}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostRetraction {
    pub doc_id: [u8; 16],
}

impl PostRetraction {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.map(1);
        w.uint(0);
        w.bytes(&self.doc_id);
        w.into_bytes()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut doc_id: Option<[u8; 16]> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => doc_id = Some(map.bytes_fixed::<16>()?),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        Ok(Self {
            doc_id: doc_id.ok_or(ProtoError::BadEntry("post-retract missing doc id"))?,
        })
    }
}

/// Payload of a `rebroadcast` entry: a signed pointer at someone else's document
/// (PROJECT_PLAN, Rebroadcast: Pointer Plus Pinned Replica). **The content is never here.** The
/// rebroadcaster's node pins a replica of the author's own signed entry and body, exact bytes,
/// signature intact - so the original stays self-authenticating, no hop can launder provenance,
/// and the author's later retraction still reaches every copy.
///
/// LWW per `(author, doc_id)`: re-sharing a document you already shared updates the pointer
/// rather than stacking another one, and a pointer with **no version is the retraction** - the
/// same shape as [`PublicEdge`], for the same reason (LWW needs a write; silence cannot un-say).
///
/// `version` is the version hash the rebroadcaster **saw when they shared**. Readers are shown
/// the author's *current* head, because edits belong to the author - but recording what was
/// endorsed is what lets a reader be told "edited since rebroadcast", which is the whole answer
/// to the rug-pull (share something benign, author rewrites it into something vile, your
/// endorsement now fronts words you never read).
///
/// Encoding: integer-keyed map `{0: bstr(32) author, 1: bstr(16) doc_id, 2?: bstr(32) version}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rebroadcast {
    /// Root pubkey of the document's author - never the rebroadcaster, who is the entry's own
    /// chain author.
    pub author: [u8; 32],
    /// Which document of theirs.
    pub doc_id: [u8; 16],
    /// The version hash seen at the moment of sharing. `None` retracts.
    pub version: Option<[u8; 32]>,
}

impl Rebroadcast {
    /// Is this the retraction rather than a share?
    pub fn is_retraction(&self) -> bool {
        self.version.is_none()
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        w.map(2 + u64::from(self.version.is_some()));
        w.uint(0);
        w.bytes(&self.author);
        w.uint(1);
        w.bytes(&self.doc_id);
        if let Some(version) = &self.version {
            w.uint(2);
            w.bytes(version);
        }
        w.into_bytes()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut author: Option<[u8; 32]> = None;
        let mut doc_id: Option<[u8; 16]> = None;
        let mut version: Option<[u8; 32]> = None;
        while let Some(key) = map.next_key()? {
            match key {
                0 => author = Some(map.bytes_fixed::<32>()?),
                1 => doc_id = Some(map.bytes_fixed::<16>()?),
                2 => version = Some(map.bytes_fixed::<32>()?),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        Ok(Self {
            author: author.ok_or(ProtoError::BadEntry("rebroadcast missing author"))?,
            doc_id: doc_id.ok_or(ProtoError::BadEntry("rebroadcast missing doc id"))?,
            version,
        })
    }
}

/// One public annotation: a statement that `target` carries `key = value`, or - `present`
/// false - that it no longer does. LWW per (target, key, value) on the speaker's chain, so a
/// tag is its own statement (`tag=saucy`), retracted by restating it absent; single-valued
/// keys (`description`, `bucket`, `display_date`) are just keys whose newest present
/// statement wins at read. Caps are the codec's: a decoder refuses what a well-behaved
/// speaker could not have minted, so a relay cannot be made to carry a novel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicAnnotation {
    /// The annotated post's author - never the speaker, who is the entry's chain author.
    pub target_author: [u8; 32],
    pub target_doc: [u8; 16],
    pub key: String,
    pub value: String,
    pub present: bool,
}

impl PublicAnnotation {
    pub const MAX_KEY_LEN: usize = 64;
    pub const MAX_VALUE_LEN: usize = 1024;
    /// A tag is a word or a few (Curtis, 2026-08-31: 32 characters): short enough that a
    /// post can carry many inside the fragment's proof budget, and long enough for
    /// "north-american-birds". Descriptions keep the wire's full value cap.
    pub const MAX_TAG_CHARS: usize = 32;
    pub const TAG_KEY: &'static str = "tag";

    fn well_formed(&self) -> Result<(), ProtoError> {
        if self.key.len() > Self::MAX_KEY_LEN || self.key.is_empty() {
            return Err(ProtoError::BadEntry("annotation key length"));
        }
        if self.value.len() > Self::MAX_VALUE_LEN {
            return Err(ProtoError::BadEntry("annotation value length"));
        }
        if self.key == Self::TAG_KEY && self.value.chars().count() > Self::MAX_TAG_CHARS {
            return Err(ProtoError::BadEntry("tag length"));
        }
        Ok(())
    }

    pub fn is_retraction(&self) -> bool {
        !self.present
    }

    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        self.well_formed()?;
        let mut w = Writer::new();
        w.map(5);
        w.uint(0);
        w.bytes(&self.target_author);
        w.uint(1);
        w.bytes(&self.target_doc);
        w.uint(2);
        w.text(&self.key);
        w.uint(3);
        w.text(&self.value);
        w.uint(4);
        w.uint(u64::from(self.present));
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        let mut r = Reader::new(bytes);
        let mut map = r.int_map()?;
        let mut target_author: Option<[u8; 32]> = None;
        let mut target_doc: Option<[u8; 16]> = None;
        let mut key: Option<String> = None;
        let mut value: Option<String> = None;
        let mut present: Option<bool> = None;
        while let Some(k) = map.next_key()? {
            match k {
                0 => target_author = Some(map.bytes_fixed::<32>()?),
                1 => target_doc = Some(map.bytes_fixed::<16>()?),
                2 => key = Some(map.text()?.to_string()),
                3 => value = Some(map.text()?.to_string()),
                4 => present = Some(map.uint()? != 0),
                _ => map.skip_value()?,
            }
        }
        r.finish()?;
        let out = Self {
            target_author: target_author.ok_or(ProtoError::BadEntry("annotation missing target author"))?,
            target_doc: target_doc.ok_or(ProtoError::BadEntry("annotation missing target doc"))?,
            key: key.ok_or(ProtoError::BadEntry("annotation missing key"))?,
            value: value.ok_or(ProtoError::BadEntry("annotation missing value"))?,
            present: present.ok_or(ProtoError::BadEntry("annotation missing presence"))?,
        };
        out.well_formed()?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// ANNOTATIONS.md slice 1: the statement round-trips, a retraction is the same shape
    /// absent, and the codec refuses what no well-behaved speaker could have minted.
    /// VISIBILITY.md slice 1: the settled wish rides the signed header (key 15), absent
    /// when false, and round-trips.
    #[test]
    fn a_settled_header_round_trips_and_absence_means_open() {
        let mut h = DocHeaderPlain {
            doc_id: [1u8; 16],
            parents: vec![],
            file_hash: [2u8; 32],
            body_hash: [3u8; 32],
            title: "quiet words".into(),
            format: None,
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: vec![],
            genesis_ms: Some(1_700_000_000_000),
            reply_to: None,
            thread_root: None,
            settled: true,
        };
        let settled = DocHeaderPlain::decode(&h.encode().unwrap()).unwrap();
        assert!(settled.settled, "the wish survives the wire");
        h.settled = false;
        let open_bytes = h.encode().unwrap();
        assert!(!DocHeaderPlain::decode(&open_bytes).unwrap().settled);
        let short = h.encode().unwrap();
        assert_eq!(open_bytes, short, "false is absence, not a zero");
    }

    #[test]
    fn a_public_annotation_round_trips_and_keeps_its_caps() {
        let a = PublicAnnotation {
            target_author: [1u8; 32],
            target_doc: [2u8; 16],
            key: "tag".into(),
            value: "saucy".into(),
            present: true,
        };
        assert_eq!(PublicAnnotation::decode(&a.encode().unwrap()).unwrap(), a);
        let gone = PublicAnnotation { present: false, ..a.clone() };
        assert!(PublicAnnotation::decode(&gone.encode().unwrap()).unwrap().is_retraction());
        let novel = PublicAnnotation { value: "x".repeat(PublicAnnotation::MAX_VALUE_LEN + 1), ..a.clone() };
        assert!(novel.encode().is_err(), "a value past the cap does not mint");
        let nameless = PublicAnnotation { key: String::new(), ..a.clone() };
        assert!(nameless.encode().is_err(), "an empty key is not a statement");
        let long_tag = PublicAnnotation { value: "x".repeat(33), ..a.clone() };
        assert!(long_tag.encode().is_err(), "a tag is 32 characters at most (2026-08-31)");
        let long_desc = PublicAnnotation { key: "description".into(), value: "x".repeat(600), ..a };
        assert!(long_desc.encode().is_ok(), "a description keeps the wire's full cap");
    }

    #[test]
    fn a_post_retraction_is_sixteen_bytes_of_regret() {
        let t = PostRetraction { doc_id: [5u8; 16] };
        assert_eq!(PostRetraction::decode(&t.encode()).unwrap(), t);
        // The storage argument, asserted: a tombstone a node keeps forever must stay tiny, and
        // there must be nowhere in it to smuggle content.
        assert!(t.encode().len() < 32, "a tombstone carries no content");
    }

    #[test]
    fn a_retraction_of_nothing_is_rejected() {
        let mut w = Writer::new();
        w.map(0);
        assert!(PostRetraction::decode(&w.into_bytes()).is_err());
    }

    #[test]
    fn rebroadcast_round_trips_and_retracts() {
        let share = Rebroadcast {
            author: [7u8; 32],
            doc_id: [9u8; 16],
            version: Some([11u8; 32]),
        };
        assert_eq!(Rebroadcast::decode(&share.encode()).unwrap(), share);
        assert!(!share.is_retraction());

        let withdrawn = Rebroadcast {
            version: None,
            ..share
        };
        assert_eq!(Rebroadcast::decode(&withdrawn.encode()).unwrap(), withdrawn);
        assert!(withdrawn.is_retraction());
    }

    /// The pointer names the ORIGINAL author, and the entry's chain names the rebroadcaster.
    /// Nothing in the payload can claim authorship of the content - which is what keeps a
    /// rebroadcast from being a copy wearing a citation.
    #[test]
    fn a_rebroadcast_cannot_claim_the_content() {
        let bytes = Rebroadcast {
            author: [1u8; 32],
            doc_id: [2u8; 16],
            version: Some([3u8; 32]),
        }
        .encode();
        // Every field is a reference; there is no body, title, or text slot to smuggle one in.
        assert!(bytes.len() < 128, "a pointer is small by construction");
    }

    #[test]
    fn a_rebroadcast_missing_its_subject_is_rejected() {
        let mut w = Writer::new();
        w.map(1);
        w.uint(0);
        w.bytes(&[4u8; 32]);
        assert!(
            Rebroadcast::decode(&w.into_bytes()).is_err(),
            "a pointer at no document is not a pointer"
        );
    }

    #[test]
    fn public_edge_round_trips() {
        let full = PublicEdge {
            subject: [3u8; 32],
            trust: Some("max".into()),
            interest: Some("high".into()),
        };
        assert_eq!(PublicEdge::decode(&full.encode().unwrap()).unwrap(), full);

        // The retraction: subject alone, nothing published. Legal and byte-minimal.
        let retraction = PublicEdge {
            subject: [3u8; 32],
            trust: None,
            interest: None,
        };
        assert_eq!(
            PublicEdge::decode(&retraction.encode().unwrap()).unwrap(),
            retraction
        );
    }

    #[test]
    fn public_edge_rejects_non_bands() {
        let bad = PublicEdge {
            subject: [3u8; 32],
            trust: Some("95".into()), // the retired numeric scale is not a band
            interest: None,
        };
        assert!(bad.encode().is_err());

        // And strictness holds on the read side too, against hand-rolled bytes.
        let mut w = Writer::new();
        w.map(2);
        w.uint(0);
        w.bytes(&[3u8; 32]);
        w.uint(2);
        w.text("quite a lot");
        assert!(PublicEdge::decode(&w.into_bytes()).is_err());
    }

    #[test]
    fn profile_set_round_trips() {
        let ps = ProfileSet {
            field: "name".into(),
            value: "Corff Burblepunk".into(),
        };
        let bytes = ps.encode().unwrap();
        assert_eq!(ProfileSet::decode(&bytes).unwrap(), ps);
    }

    #[test]
    fn profile_set_normalizes_unicode() {
        // Decomposed input normalizes on encode, so round-trip returns the composed form.
        let ps = ProfileSet {
            field: "name".into(),
            value: "Zoe\u{0308}".into(), // Zoë with combining diaeresis
        };
        let bytes = ps.encode().unwrap();
        assert_eq!(ProfileSet::decode(&bytes).unwrap().value, "Zo\u{eb}");
    }

    #[test]
    fn profile_set_enforces_length_caps() {
        let too_long_field = ProfileSet {
            field: "f".repeat(ProfileSet::MAX_FIELD_LEN + 1),
            value: "v".into(),
        };
        assert!(too_long_field.encode().is_err());

        let too_long_value = ProfileSet {
            field: "bio".into(),
            value: "v".repeat(ProfileSet::MAX_VALUE_LEN + 1),
        };
        assert!(too_long_value.encode().is_err());
    }

    #[test]
    fn registry_names_cover_known_ids() {
        assert_eq!(service::name(service::PROFILE_PUBLIC), "profile-public");
        assert_eq!(service::name(service::DOC_META_PRIVATE), "doc-meta-private");
        assert_eq!(entry_type::name(entry_type::PROFILE_SET), "profile-set");
        assert_eq!(service::name(999), "unknown-service");
    }

    #[test]
    fn authorize_round_trips() {
        let a = Authorize {
            child: [2u8; 32],
            usurpers: vec![[0u8; 32], [1u8; 32]],
            enc_pubkey: None,
        };
        let bytes = a.encode().unwrap();
        assert_eq!(Authorize::decode(&bytes).unwrap(), a);

        // With an encryption pubkey (the private-chains addition): still round-trips, and the
        // no-enc-key encoding is byte-identical to the pre-field format (additive evolution).
        let c = Authorize {
            child: [2u8; 32],
            usurpers: vec![[0u8; 32]],
            enc_pubkey: Some([5u8; 32]),
        };
        assert_eq!(Authorize::decode(&c.encode().unwrap()).unwrap(), c);

        // Empty usurper list (a root's first child carries [root]; but the encoding itself
        // permits empty - semantics are the tree's job).
        let b = Authorize {
            child: [9u8; 32],
            usurpers: vec![],
            enc_pubkey: None,
        };
        assert_eq!(Authorize::decode(&b.encode().unwrap()).unwrap(), b);
    }

    #[test]
    fn revoke_round_trips_both_dispositions() {
        for disposition in [Disposition::Retirement, Disposition::Repudiation] {
            let r = Revoke {
                target: [7u8; 32],
                disposition,
                anchors: vec![
                    Anchor {
                        service: service::IDENTITY_PUBLIC,
                        seq: 4,
                        head_hash: [0xaa; 32],
                    },
                    Anchor {
                        service: service::PROFILE_PUBLIC,
                        seq: 17,
                        head_hash: [0xbb; 32],
                    },
                ],
            };
            let bytes = r.encode().unwrap();
            assert_eq!(Revoke::decode(&bytes).unwrap(), r);
        }
    }

    #[test]
    fn revoke_rejects_unknown_disposition() {
        // Hand-build {0: target, 1: 2, 2: []} - disposition 2 doesn't exist.
        let mut w = Writer::new();
        w.map(3);
        w.uint(0);
        w.bytes(&[7u8; 32]);
        w.uint(1);
        w.uint(2);
        w.uint(2);
        w.array(0);
        assert_eq!(
            Revoke::decode(&w.into_bytes()),
            Err(ProtoError::BadEntry("unknown revocation disposition"))
        );
    }

    #[test]
    fn oversized_lists_are_rejected() {
        let a = Authorize {
            child: [1u8; 32],
            usurpers: vec![[0u8; 32]; Authorize::MAX_USURPERS + 1],
            enc_pubkey: None,
        };
        assert!(a.encode().is_err());
    }

    #[test]
    fn key_epoch_round_trips() {
        let key_epoch = KeyEpoch {
            epoch: 3,
            recipients: vec![
                ([1u8; 32], [2u8; 32], vec![0xAA; 80]),
                ([3u8; 32], [4u8; 32], vec![0xBB; 80]),
            ],
        };
        let bytes = key_epoch.encode().unwrap();
        assert_eq!(KeyEpoch::decode(&bytes).unwrap(), key_epoch);
    }

    #[test]
    fn private_record_round_trips() {
        let pr = PrivateRecord {
            epoch: 1,
            nonce: [7u8; 24],
            ciphertext: vec![0xCC; 100],
        };
        assert_eq!(PrivateRecord::decode(&pr.encode().unwrap()).unwrap(), pr);
    }

    /// The realized reserved key: refs round-trip, empty stays absent on the wire (byte-equal
    /// to a pre-refs encoding), and the cap refuses at BOTH doors - an encoder cannot mint an
    /// over-count header and a decoder refuses one minted by other code.
    /// PROJECT_PLAN's Replies slice 1: the thread links ride the header, round-trip, are wire-absent
    /// for a non-reply (pre-reply readers and entries agree byte for byte), and a root
    /// claim without a parent is not a shape this codec carries - either way round.
    #[test]
    fn doc_header_reply_links_round_trip_and_pair() {
        let base = DocHeaderPlain {
            settled: false,
            doc_id: [9u8; 16],
            parents: vec![[1u8; 32]],
            file_hash: [3u8; 32],
            body_hash: [4u8; 32],
            title: "a reply".into(),
            format: None,
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: Vec::new(),
            genesis_ms: Some(7),
            reply_to: None,
            thread_root: None,
        };
        let reply = DocHeaderPlain {
            settled: false,
            reply_to: Some(([5u8; 32], [6u8; 16])),
            thread_root: Some(([7u8; 32], [8u8; 16])),
            ..base.clone()
        };
        assert_eq!(DocHeaderPlain::decode(&reply.encode().unwrap()).unwrap(), reply);

        let plain = DocHeaderPlain::decode(&base.encode().unwrap()).unwrap();
        assert_eq!(plain.reply_to, None);
        assert_eq!(plain.thread_root, None);

        let orphan = DocHeaderPlain {
            settled: false,
            thread_root: Some(([7u8; 32], [8u8; 16])),
            ..base
        };
        assert_eq!(
            orphan.encode(),
            Err(ProtoError::BadEntry("a thread root without a parent"))
        );
    }

    #[test]
    fn doc_header_refs_round_trip_and_cap() {
        let base = DocHeaderPlain {
            settled: false,
            doc_id: [9u8; 16],
            parents: vec![[1u8; 32]],
            file_hash: [3u8; 32],
            body_hash: [4u8; 32],
            title: "album".into(),
            format: Some(1),
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: vec![[7u8; 16], [8u8; 16]],
            genesis_ms: None,
            reply_to: None,
            thread_root: None,
        };
        assert_eq!(DocHeaderPlain::decode(&base.encode().unwrap()).unwrap(), base);

        let empty = DocHeaderPlain {
            settled: false,
            refs: Vec::new(),
            ..base.clone()
        };
        let bytes = empty.encode().unwrap();
        assert_eq!(
            DocHeaderPlain::decode(&bytes).unwrap().refs,
            Vec::<[u8; 16]>::new(),
            "no refs is wire-absence, so pre-refs readers and entries agree byte-for-byte"
        );

        let over = DocHeaderPlain {
            settled: false,
            refs: vec![[7u8; 16]; DocHeaderPlain::MAX_REFS + 1],
            ..base.clone()
        };
        assert!(over.encode().is_err(), "the encoder refuses an over-count header");

        let mut w = Writer::new();
        w.map(6);
        w.uint(0);
        w.bytes(&base.doc_id);
        w.uint(1);
        w.array(0);
        w.uint(2);
        w.bytes(&base.file_hash);
        w.uint(3);
        w.bytes(&base.body_hash);
        w.uint(4);
        w.text("smuggled");
        w.uint(11);
        w.array((DocHeaderPlain::MAX_REFS + 1) as u64);
        for _ in 0..=DocHeaderPlain::MAX_REFS {
            w.bytes(&[7u8; 16]);
        }
        assert!(
            DocHeaderPlain::decode(&w.into_bytes()).is_err(),
            "and the decoder refuses one minted by somebody else's encoder"
        );
    }

    #[test]
    fn doc_header_round_trips_genesis_save_and_merge() {
        // The three parent shapes: genesis (none), ordinary save (one), merge (two).
        for parents in [vec![], vec![[1u8; 32]], vec![[1u8; 32], [2u8; 32]]] {
            let h = DocHeaderPlain {
                settled: false,
                doc_id: [9u8; 16],
                parents,
                file_hash: [3u8; 32],
                body_hash: [4u8; 32],
                title: "grocery plans".into(),
                format: None,
                width: None,
                height: None,
                duration_ms: None,
                thumb_hash: None,
                preview_hash: None,
                refs: Vec::new(),
                genesis_ms: None,
                reply_to: None,
                thread_root: None,
            };
            assert_eq!(DocHeaderPlain::decode(&h.encode().unwrap()).unwrap(), h);
        }
        // format present survives the trip too
        let h = DocHeaderPlain {
            settled: false,
            doc_id: [9u8; 16],
            parents: vec![[1u8; 32]],
            file_hash: [3u8; 32],
            body_hash: [4u8; 32],
            title: "essay".into(),
            format: Some(1),
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: Vec::new(),
            genesis_ms: None,
            reply_to: None,
            thread_root: None,
        };
        assert_eq!(DocHeaderPlain::decode(&h.encode().unwrap()).unwrap(), h);
        // A media header: format + dimensions + thumb_hash all present, duration absent (a still).
        let img = DocHeaderPlain {
            settled: false,
            doc_id: [9u8; 16],
            parents: vec![],
            file_hash: [3u8; 32],
            body_hash: [4u8; 32],
            title: "sunset".into(),
            format: Some(super::doc_format::AVIF),
            width: Some(800),
            height: Some(533),
            duration_ms: None,
            thumb_hash: Some([7u8; 32]),
            preview_hash: None,
            refs: Vec::new(),
            genesis_ms: None,
            reply_to: None,
            thread_root: None,
        };
        assert_eq!(DocHeaderPlain::decode(&img.encode().unwrap()).unwrap(), img);
        // A video header: dimensions + duration + BOTH sibling-blob hashes (poster + preview).
        let vid = DocHeaderPlain {
            settled: false,
            doc_id: [9u8; 16],
            parents: vec![[1u8; 32]],
            file_hash: [3u8; 32],
            body_hash: [4u8; 32],
            title: "clip".into(),
            format: Some(super::doc_format::WEBM_AV1),
            width: Some(320),
            height: Some(180),
            duration_ms: Some(20_149),
            thumb_hash: Some([7u8; 32]),
            preview_hash: Some([8u8; 32]),
            refs: Vec::new(),
            genesis_ms: None,
            reply_to: None,
            thread_root: None,
        };
        assert_eq!(DocHeaderPlain::decode(&vid.encode().unwrap()).unwrap(), vid);
    }

    #[test]
    fn doc_header_enforces_caps() {
        let base = DocHeaderPlain {
            settled: false,
            doc_id: [0u8; 16],
            parents: vec![],
            file_hash: [0u8; 32],
            body_hash: [0u8; 32],
            title: "x".repeat(DocHeaderPlain::MAX_TITLE_LEN + 1),
            format: None,
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: Vec::new(),
            genesis_ms: None,
            reply_to: None,
            thread_root: None,
        };
        assert!(base.encode().is_err());
        let too_many = DocHeaderPlain {
            settled: false,
            parents: vec![[0u8; 32]; DocHeaderPlain::MAX_PARENTS + 1],
            title: "ok".into(),
            ..base
        };
        assert!(too_many.encode().is_err());
    }

    #[test]
    fn body_hash_is_deterministic_and_document_scoped() {
        let body = b"the words";
        // Same document, same body: same fingerprint - the whole point.
        assert_eq!(
            DocHeaderPlain::body_hash(&[1u8; 16], body),
            DocHeaderPlain::body_hash(&[1u8; 16], body)
        );
        // A different document keys differently: no cross-document (or cross-identity) rainbow
        // tables over common short texts.
        assert_ne!(
            DocHeaderPlain::body_hash(&[1u8; 16], body),
            DocHeaderPlain::body_hash(&[2u8; 16], body)
        );
        // And it is not the bare BLAKE3 of the body.
        assert_ne!(
            DocHeaderPlain::body_hash(&[1u8; 16], body),
            *blake3::hash(body).as_bytes()
        );
    }

    #[test]
    fn private_plain_covers_registers_and_sets() {
        // A config register, a follow (set element), and a removal - the three shapes the
        // private store speaks. Registers carry values; removes don't need them.
        let cases = [
            PrivatePlain {
                kind: PrivateKind::Register,
                collection: "config".into(),
                key: "theme".into(),
                value: Some("hotdog-stand".into()),
            },
            PrivatePlain {
                kind: PrivateKind::SetAdd,
                collection: "follows".into(),
                key: "aabbccdd".into(),
                value: None,
            },
            PrivatePlain {
                kind: PrivateKind::SetRemove,
                collection: "follows".into(),
                key: "aabbccdd".into(),
                value: None,
            },
        ];
        for case in cases {
            assert_eq!(PrivatePlain::decode(&case.encode().unwrap()).unwrap(), case);
        }
    }

    #[test]
    fn private_plain_rejects_unknown_kinds_and_bad_lengths() {
        // Hand-build kind 3.
        let mut w = Writer::new();
        w.map(3);
        w.uint(0);
        w.uint(3);
        w.uint(1);
        w.text("c");
        w.uint(2);
        w.text("k");
        assert_eq!(
            PrivatePlain::decode(&w.into_bytes()),
            Err(ProtoError::BadEntry("unknown private record kind"))
        );

        let too_long = PrivatePlain {
            kind: PrivateKind::Register,
            collection: "c".into(),
            key: "k".into(),
            value: Some("v".repeat(PrivatePlain::MAX_VALUE_LEN + 1)),
        };
        assert!(too_long.encode().is_err());
    }
}
