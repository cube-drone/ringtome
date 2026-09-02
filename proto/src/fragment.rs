//! Fragments: fetching one shared document without subscribing to its author.
//!
//! The transport for the reader's half of a rebroadcast (PROJECT_PLAN, *What travels with a
//! share*). A reader following a sharer holds their pointer - "B shared A's document D" - and
//! needs D's words. What they must NOT do is start syncing A: **a chain pin never propagates
//! with viewing**, because in a dense network everyone eventually sees everything once, and a
//! subscription created by looking would degrade to every public persona synced to every
//! computer.
//!
//! So this asks for one document and gets one document.
//!
//! ## Asked of the ORIGIN, not the author
//!
//! The reader asks whoever handed them the pointer, and that is the load-bearing choice. Every
//! edge in a share tree already exists and already syncs, so retraction cascades down it -
//! author tombstones, the sharer's pin sees it, the sharer answers [`Gone`](FragmentMessage::Gone),
//! the reader drops, and anyone who fetched from *that* reader hears the same on their next
//! revalidation. Density adds no new edges. Asking the author instead would mean discovering
//! and dialling a stranger for every shared document, which is the fan-out this design exists
//! to avoid.
//!
//! `Gone` is therefore not an error - it is the retraction signal, arriving by the ordinary path.
//!
//! ## What a fragment proves on its own
//!
//! The response carries the author's **exact signed entry**, plus the authorization path from
//! the author's root down to the leaf that signed it. Together those prove the document is the
//! author's own words, with no fetch and no trust in the node that handed them over: a relay
//! holding a signed entry is an honest post office, and it cannot alter a byte without breaking
//! a signature it does not have the key for. Provenance survives every hop.
//!
//! The honest limits, the same two the delivered path accepts: the path cannot prove the leaf
//! was not revoked afterwards, and holding an entry is not proof the author still serves it -
//! which is exactly what revalidation against the origin is for.

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;
use crate::registry::{entry_type, service};
use crate::{DocHeaderPlain, Payload, SignedEntry};

/// ALPN for fragment fetches. The trailing `/0` is the protocol version.
pub const FRAGMENT_ALPN: &[u8] = b"ringtome/fragment/0";

/// Hard cap on one framed fragment message: a doc header plus an authorization path, with room
/// to spare. Bodies never travel here - they are content-addressed blobs, fetched by hash over
/// iroh-blobs once this response has named them.
pub const MAX_FRAGMENT_FRAME_BYTES: usize = 16 * 1024;

/// The messages on a fragment connection: one request, one answer.
///
/// | tag | message | fields |
/// |-----|---------|--------|
/// | 0   | Want    | bstr(32) author, bstr(16) doc_id |
/// | 1   | Have    | bstr entry bytes, array of bstr auth-path rungs |
/// | 2   | Gone    | bstr entry bytes, array of bstr auth-path rungs |
/// | 3   | Unknown | - |
/// | 4   | WantDeaths | uint since |
/// | 5   | Deaths  | array of [bstr(32) author, bstr(16) doc_id, bstr entry, array rungs], uint cursor |
///
/// [`Gone`](Self::Gone) and [`Unknown`](Self::Unknown) are deliberately different answers.
/// *Gone* is a fact about the document - it was withdrawn, and the reader should drop it. *Unknown*
/// is a fact about this node - it does not carry that document, so ask somebody else. Collapsing
/// them would make "I never had it" indistinguishable from "the author took it back", and a
/// reader would delete a live share every time it asked the wrong node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FragmentMessage {
    /// A trusted-only post's per-post key, asked node-to-node (VISIBILITY.md slice 2b:
    /// the body is ciphertext anywhere it travels; THIS is the gated thing). Only nodes
    /// holding the key can answer, and they answer only dialers whose endpoint resolves -
    /// through signed serving records - to a persona the author publishes trust for.
    WantKey { author: [u8; 32], doc_id: [u8; 16] },
    /// The answer: 32 key bytes, or empty for "not here" and "not for you" alike - a
    /// refusal deliberately indistinguishable from absence.
    Key { key: Vec<u8> },
    Want { author: [u8; 32], doc_id: [u8; 16] },
    /// The words' proof - and, riding beside it, every annotation proof the answering node
    /// chose to attach (ANNOTATIONS.md slice 3): the author's labels and third parties'
    /// alike, each the ANNOTATOR's own signed statement with its delegation path, verified
    /// at the receiving edge against its annotator. The label set is best-effort and
    /// budget-capped - a fragment with no labels is still the fragment.
    Have { entry: Vec<u8>, auth_path: Vec<Vec<u8>>, annotations: Vec<AnnotationProof> },
    /// The author took it back - and here is the author SAYING so (added 2026-08-13). A bare
    /// `Gone` was the one unauthenticated word in the protocol: `Have` proves itself with the
    /// author's signature, while its opposite was taken on the answering node's word - so any
    /// origin could kill, permanently under tombstone finality, every document it had ever
    /// served. Now `Gone` travels as the author's own signed `post-retract` entry plus the
    /// delegation path that ties its signing key to their root, verified offline exactly as a
    /// fragment is: deletion becomes as unforgeable as content, at every hop, however far from
    /// the author it is relayed.
    Gone { entry: Vec<u8>, auth_path: Vec<Vec<u8>> },
    Unknown,
    /// The batch question (added 2026-08-13, the retraction-cursor slice): everything you have
    /// heard die since `since`, which is YOUR log's cursor - opaque to the asker, monotonic to
    /// you. The steady-state answer is an empty page, which is the whole argument for cursors
    /// over summaries: "nothing happened" costs one round trip and zero bytes of payload.
    WantDeaths { since: u64 },
    /// One page of deaths, each carrying the same proof a single `Gone` does - the author's own
    /// signed retraction plus its delegation path, verified per-proof at the receiving edge. The
    /// page names its authors explicitly because a log mixes them: an origin relays every death
    /// it has heard, and each one proves itself against ITS author, not against the origin.
    /// `cursor` is where the next ask resumes; a page shorter than the server's page size means
    /// the log is drained.
    Deaths { proofs: Vec<DeathProof>, cursor: u64 },
    /// The author's thread door (PROJECT_PLAN's Replies slice 6): every reply anywhere announces
    /// itself to its parent's author - by sync or by envelope - so the author's node is
    /// structurally the best-informed about the thread, and serves a reply INDEX to anyone
    /// who asks. The death-cursor idiom verbatim: `since` is the SERVER's opaque monotonic
    /// cursor, and the steady-state answer is an empty page.
    WantReplies { author: [u8; 32], doc_id: [u8; 16], since: u64 },
    /// One page of the index: the repliers' own SIGNED evidence - each proof is the
    /// replier's doc-header entry naming the parent, with the delegation path that ties its
    /// signer to their root, verifiable offline exactly as a fragment is. Claims, never
    /// words: the asker fetches the words through the ordinary `Want` machinery. A page
    /// shorter than the server's page size means the index is drained.
    Replies { proofs: Vec<ReplyProof>, cursor: u64 },
}

/// One death in a batch: whose document, which document, and the author's signed word for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeathProof {
    pub author: [u8; 32],
    pub doc_id: [u8; 16],
    pub entry: Vec<u8>,
    pub auth_path: Vec<Vec<u8>>,
}

/// One annotation riding a fragment: who said it, and their signed word for it. The
/// statement's target, key, and value live INSIDE the entry - the proof carries nothing
/// the signature does not cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnotationProof {
    pub annotator: [u8; 32],
    pub entry: Vec<u8>,
    pub auth_path: Vec<Vec<u8>>,
}

/// Cap on annotation proofs per fragment, enforced at decode; the server budgets by BYTES
/// well under the frame cap, so this is the refusal for what no honest server sends.
pub const MAX_ANNOTATIONS_PER_FRAGMENT: usize = 24;

/// One reply in the index: who answered, and their signed word for it. The reply's own
/// doc id and stamp live INSIDE the entry - the proof carries nothing the signature does
/// not cover.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplyProof {
    pub replier: [u8; 32],
    pub entry: Vec<u8>,
    pub auth_path: Vec<Vec<u8>>,
}

/// Cap on reply proofs per page, the deaths cap's twin.
pub const MAX_REPLIES_PER_PAGE: usize = 32;

/// Cap on proofs per page, enforced at decode. The encoder pages far below this (frame budget);
/// the decoder refuses anything a well-behaved encoder could not have sent.
pub const MAX_DEATHS_PER_PAGE: usize = 32;

const TAG_WANT: u64 = 0;
const TAG_HAVE: u64 = 1;
const TAG_GONE: u64 = 2;
const TAG_UNKNOWN: u64 = 3;
const TAG_WANT_DEATHS: u64 = 4;
const TAG_DEATHS: u64 = 5;
const TAG_WANT_REPLIES: u64 = 6;
const TAG_REPLIES: u64 = 7;
const TAG_WANT_KEY: u64 = 8;
const TAG_KEY: u64 = 9;

impl FragmentMessage {
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::new();
        match self {
            Self::Want { author, doc_id } => {
                w.array(3);
                w.uint(TAG_WANT);
                w.bytes(author);
                w.bytes(doc_id);
            }
            Self::Have { entry, auth_path, annotations } => {
                w.array(4);
                w.uint(TAG_HAVE);
                w.bytes(entry);
                w.array(auth_path.len() as u64);
                for rung in auth_path {
                    w.bytes(rung);
                }
                w.array(annotations.len() as u64);
                for a in annotations {
                    w.array(3);
                    w.bytes(&a.annotator);
                    w.bytes(&a.entry);
                    w.array(a.auth_path.len() as u64);
                    for rung in &a.auth_path {
                        w.bytes(rung);
                    }
                }
            }
            Self::Gone { entry, auth_path } => {
                w.array(3);
                w.uint(TAG_GONE);
                w.bytes(entry);
                w.array(auth_path.len() as u64);
                for rung in auth_path {
                    w.bytes(rung);
                }
            }
            Self::Unknown => {
                w.array(1);
                w.uint(TAG_UNKNOWN);
            }
            Self::WantDeaths { since } => {
                w.array(2);
                w.uint(TAG_WANT_DEATHS);
                w.uint(*since);
            }
            Self::Deaths { proofs, cursor } => {
                w.array(3);
                w.uint(TAG_DEATHS);
                w.array(proofs.len() as u64);
                for p in proofs {
                    w.array(4);
                    w.bytes(&p.author);
                    w.bytes(&p.doc_id);
                    w.bytes(&p.entry);
                    w.array(p.auth_path.len() as u64);
                    for rung in &p.auth_path {
                        w.bytes(rung);
                    }
                }
                w.uint(*cursor);
            }
            Self::WantReplies { author, doc_id, since } => {
                w.array(4);
                w.uint(TAG_WANT_REPLIES);
                w.bytes(author);
                w.bytes(doc_id);
                w.uint(*since);
            }
            Self::WantKey { author, doc_id } => {
                w.array(3);
                w.uint(TAG_WANT_KEY);
                w.bytes(author);
                w.bytes(doc_id);
            }
            Self::Key { key } => {
                w.array(2);
                w.uint(TAG_KEY);
                w.bytes(key);
            }
            Self::Replies { proofs, cursor } => {
                w.array(3);
                w.uint(TAG_REPLIES);
                w.array(proofs.len() as u64);
                for p in proofs {
                    w.array(3);
                    w.bytes(&p.replier);
                    w.bytes(&p.entry);
                    w.array(p.auth_path.len() as u64);
                    for rung in &p.auth_path {
                        w.bytes(rung);
                    }
                }
                w.uint(*cursor);
            }
        }
        w.into_bytes()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() > MAX_FRAGMENT_FRAME_BYTES {
            return Err(ProtoError::BadEntry("fragment frame exceeds size limit"));
        }
        let mut r = Reader::new(bytes);
        let len = r.array()?;
        if len == 0 {
            return Err(ProtoError::BadEntry("empty fragment message"));
        }
        let tag = r.uint()?;
        let out = match (tag, len) {
            (TAG_WANT, 3) => Self::Want {
                author: r.bytes_fixed::<32>()?,
                doc_id: r.bytes_fixed::<16>()?,
            },
            (TAG_HAVE, 4) => {
                let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                let count = r.array()?;
                if count > MAX_ANNOTATIONS_PER_FRAGMENT as u64 {
                    return Err(ProtoError::BadEntry("fragment annotations too many"));
                }
                let mut annotations = Vec::new();
                for _ in 0..count {
                    if r.array()? != 3 {
                        return Err(ProtoError::BadEntry("malformed annotation proof"));
                    }
                    let annotator = r.bytes_fixed::<32>()?;
                    let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                    annotations.push(AnnotationProof {
                        annotator,
                        entry,
                        auth_path,
                    });
                }
                Self::Have {
                    entry,
                    auth_path,
                    annotations,
                }
            }
            (TAG_GONE, 3) => {
                let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                Self::Gone { entry, auth_path }
            }
            (TAG_UNKNOWN, 1) => Self::Unknown,
            (TAG_WANT_DEATHS, 2) => Self::WantDeaths { since: r.uint()? },
            (TAG_DEATHS, 3) => {
                let count = r.array()?;
                if count > MAX_DEATHS_PER_PAGE as u64 {
                    return Err(ProtoError::BadEntry("deaths page too large"));
                }
                let mut proofs = Vec::new();
                for _ in 0..count {
                    if r.array()? != 4 {
                        return Err(ProtoError::BadEntry("malformed death proof"));
                    }
                    let author = r.bytes_fixed::<32>()?;
                    let doc_id = r.bytes_fixed::<16>()?;
                    let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                    proofs.push(DeathProof {
                        author,
                        doc_id,
                        entry,
                        auth_path,
                    });
                }
                Self::Deaths {
                    proofs,
                    cursor: r.uint()?,
                }
            }
            (TAG_WANT_KEY, 3) => Self::WantKey {
                author: r.bytes_fixed::<32>()?,
                doc_id: r.bytes_fixed::<16>()?,
            },
            (TAG_KEY, 2) => {
                let key = r.bytes()?.to_vec();
                if key.len() > 32 {
                    return Err(ProtoError::BadEntry("a post key is 32 bytes or absent"));
                }
                Self::Key { key }
            }
            (TAG_WANT_REPLIES, 4) => Self::WantReplies {
                author: r.bytes_fixed::<32>()?,
                doc_id: r.bytes_fixed::<16>()?,
                since: r.uint()?,
            },
            (TAG_REPLIES, 3) => {
                let count = r.array()?;
                if count > MAX_REPLIES_PER_PAGE as u64 {
                    return Err(ProtoError::BadEntry("replies page too large"));
                }
                let mut proofs = Vec::new();
                for _ in 0..count {
                    if r.array()? != 3 {
                        return Err(ProtoError::BadEntry("malformed reply proof"));
                    }
                    let replier = r.bytes_fixed::<32>()?;
                    let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                    proofs.push(ReplyProof {
                        replier,
                        entry,
                        auth_path,
                    });
                }
                Self::Replies {
                    proofs,
                    cursor: r.uint()?,
                }
            }
            _ => return Err(ProtoError::BadEntry("unknown fragment message")),
        };
        r.finish()?;
        Ok(out)
    }

    /// The shared tail of `Have` and `Gone`: an entry and its delegation path. The same shape
    /// on purpose - both answers are the author's own signed word, one saying "here it is" and
    /// the other "I took it back", and both prove themselves the same way.
    fn entry_and_path(r: &mut Reader) -> Result<(Vec<u8>, Vec<Vec<u8>>), ProtoError> {
        let entry = r.bytes()?.to_vec();
        let rungs = r.array()?;
        if rungs > crate::deliver::MAX_AUTH_PATH as u64 {
            return Err(ProtoError::BadEntry("authorization path too deep"));
        }
        let mut auth_path = Vec::new();
        for _ in 0..rungs {
            auth_path.push(r.bytes()?.to_vec());
        }
        Ok((entry, auth_path))
    }
}

/// A fragment that proved itself: the author's own document, verified offline.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedFragment {
    /// The document's stable id.
    pub doc_id: [u8; 16],
    /// The version's identity - this entry's hash, which is what a rebroadcast pointer endorses.
    pub version: [u8; 32],
    /// The version's claimed stamp, off the verified entry - what the edit window's honor rule
    /// compares against the header's `genesis_ms` (both the author's own numbers).
    pub timestamp_ms: i64,
    /// The decoded header: title, format, and the blob hashes the body lives at.
    pub header: DocHeaderPlain,
}

/// Verify a fragment against the author it claims, offline, from its own bytes.
///
/// Checks, in order and all of them: the entry decodes and its signature holds; it is a public
/// document header (`doc-header` on the posts chain, never a private one, and never some other
/// entry type wearing the name); it is the document that was asked for; and the key that signed
/// it is authorized by the claimed author's root through the path supplied.
///
/// The doc-id check is what stops a hostile origin from answering a request for one document
/// with a different one - genuinely signed by the same author, and not what the reader's pointer
/// endorsed. Without it "fetch what B shared" becomes "fetch whatever B feels like".
pub fn verify_fragment(
    author: [u8; 32],
    doc_id: [u8; 16],
    entry_bytes: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<VerifiedFragment, ProtoError> {
    let signed = SignedEntry::decode(entry_bytes)?;
    signed.verify()?;
    let entry = signed.entry();

    if entry.chain.service != service::POSTS || entry.entry_type != entry_type::DOC_HEADER {
        return Err(ProtoError::ChainViolation(
            "a fragment must be a public document header",
        ));
    }
    // The chain's author is the identity's root only for a root-signed chain; in general the
    // chain author IS the signing leaf, and the path below is what ties it to the root.
    crate::deliver::walk_auth_path(author, auth_path, entry.chain.author)?;

    let Payload::Inline(payload) = &entry.payload else {
        return Err(ProtoError::BadEntry("document header must be inline"));
    };
    let header = DocHeaderPlain::decode(payload)?;
    if header.doc_id != doc_id {
        return Err(ProtoError::ChainViolation(
            "the fragment is a different document than the one requested",
        ));
    }

    Ok(VerifiedFragment {
        doc_id,
        version: *signed.hash(),
        timestamp_ms: entry.timestamp_ms,
        header,
    })
}

/// Verify a retraction the same way: the author's own signed `post-retract`, offline, from its
/// own bytes. The mirror of [`verify_fragment`], because `Gone` is the mirror of `Have` - the
/// same author speaking about the same document, saying the opposite thing.
///
/// The doc-id check carries the same weight as the fragment one, in the darker direction: an
/// author's retraction of document X must not bury document Y. Without it, one genuine deletion
/// in hand would let a hostile origin kill any OTHER document by the same author - signed
/// speech, wrong subject.
///
/// What this cannot prove, said plainly because tombstones are forever: that the retraction is
/// the author's LAST word. It proves "the author retracted this document", which under
/// retraction finality (*Retraction, edits, and what a node must remember forever*: a tombstone
/// is final for its doc_id, republishing mints a new one) is the whole question.
/// Verify one reply proof offline: the entry is a real doc header, signed by a key the
/// delegation path ties to `replier`, and its own `reply_to` names exactly the parent that
/// was asked about. Returns the reply's doc id and claimed stamp - both read from INSIDE
/// the signature, never from the wire's framing. The door's twin of [`verify_retraction`]:
/// the author serves claims, and every claim proves itself against ITS author.
/// Verify one annotation proof offline: a real statement on the annotator's own chain,
/// signed by a key the delegation path ties to them, and TARGETING exactly the post it
/// arrived with - a relay can withhold a label but never re-target one. Returns the
/// statement whole (key, value, present): a retraction rides like anything else, and the
/// receiver folds it as the chain would.
pub fn verify_annotation(
    annotator: [u8; 32],
    target_author: [u8; 32],
    target_doc: [u8; 16],
    entry_bytes: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<crate::registry::PublicAnnotation, ProtoError> {
    let signed = SignedEntry::decode(entry_bytes)?;
    signed.verify()?;
    let entry = signed.entry();
    if entry.chain.service != service::ANNOTATIONS_PUBLIC
        || entry.entry_type != entry_type::PUBLIC_ANNOTATION
    {
        return Err(ProtoError::ChainViolation(
            "an annotation proof must be a public annotation",
        ));
    }
    crate::deliver::walk_auth_path(annotator, auth_path, entry.chain.author)?;
    let Payload::Inline(payload) = &entry.payload else {
        return Err(ProtoError::BadEntry("an annotation must be inline"));
    };
    let a = crate::registry::PublicAnnotation::decode(payload)?;
    if a.target_author != target_author || a.target_doc != target_doc {
        return Err(ProtoError::ChainViolation(
            "the annotation labels a different post than the one it rode with",
        ));
    }
    Ok(a)
}

pub fn verify_reply(
    replier: [u8; 32],
    parent_author: [u8; 32],
    parent_doc: [u8; 16],
    entry_bytes: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<([u8; 16], i64), ProtoError> {
    let signed = SignedEntry::decode(entry_bytes)?;
    signed.verify()?;
    let entry = signed.entry();

    if entry.chain.service != service::POSTS || entry.entry_type != entry_type::DOC_HEADER {
        return Err(ProtoError::ChainViolation(
            "a reply proof must be a doc header",
        ));
    }
    crate::deliver::walk_auth_path(replier, auth_path, entry.chain.author)?;

    let Payload::Inline(payload) = &entry.payload else {
        return Err(ProtoError::BadEntry("a reply header must be inline"));
    };
    let header = crate::registry::DocHeaderPlain::decode(payload)?;
    let Some((pa, pd)) = header.reply_to else {
        return Err(ProtoError::ChainViolation("the proof's header is not a reply"));
    };
    if (pa, pd) != (parent_author, parent_doc) {
        return Err(ProtoError::ChainViolation(
            "the reply answers a different post than the one asked about",
        ));
    }
    Ok((header.doc_id, entry.timestamp_ms))
}

pub fn verify_retraction(
    author: [u8; 32],
    doc_id: [u8; 16],
    entry_bytes: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<(), ProtoError> {
    let signed = SignedEntry::decode(entry_bytes)?;
    signed.verify()?;
    let entry = signed.entry();

    if entry.chain.service != service::POSTS || entry.entry_type != entry_type::POST_RETRACT {
        return Err(ProtoError::ChainViolation(
            "a gone-proof must be a post retraction",
        ));
    }
    crate::deliver::walk_auth_path(author, auth_path, entry.chain.author)?;

    let Payload::Inline(payload) = &entry.payload else {
        return Err(ProtoError::BadEntry("a retraction must be inline"));
    };
    let tombstone = crate::PostRetraction::decode(payload)?;
    if tombstone.doc_id != doc_id {
        return Err(ProtoError::ChainViolation(
            "the retraction is for a different document than the one requested",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_round_trip() {
        for message in [
            FragmentMessage::Want {
                author: [1u8; 32],
                doc_id: [2u8; 16],
            },
            FragmentMessage::Have {
                entry: vec![3, 4, 5],
                auth_path: vec![vec![6, 7], vec![8]],
                annotations: vec![AnnotationProof {
                    annotator: [4u8; 32],
                    entry: vec![5, 6],
                    auth_path: vec![vec![7]],
                }],
            },
            FragmentMessage::Have {
                entry: vec![9],
                auth_path: Vec::new(),
                annotations: Vec::new(),
            },
            FragmentMessage::Gone {
                entry: vec![10, 11],
                auth_path: vec![vec![12]],
            },
            FragmentMessage::Gone {
                entry: Vec::new(),
                auth_path: Vec::new(),
            },
            FragmentMessage::Unknown,
            FragmentMessage::WantReplies {
                author: [1u8; 32],
                doc_id: [2u8; 16],
                since: 99,
            },
            FragmentMessage::Replies {
                proofs: vec![ReplyProof {
                    replier: [3u8; 32],
                    entry: vec![4, 5],
                    auth_path: vec![vec![6]],
                }],
                cursor: 12,
            },
            FragmentMessage::Replies {
                proofs: Vec::new(),
                cursor: 0,
            },
            FragmentMessage::WantDeaths { since: 0 },
            FragmentMessage::WantDeaths { since: 4_321 },
            FragmentMessage::Deaths {
                proofs: Vec::new(),
                cursor: 7,
            },
            FragmentMessage::Deaths {
                proofs: vec![
                    DeathProof {
                        author: [1u8; 32],
                        doc_id: [2u8; 16],
                        entry: vec![3, 4],
                        auth_path: vec![vec![5], vec![6, 7]],
                    },
                    DeathProof {
                        author: [8u8; 32],
                        doc_id: [9u8; 16],
                        entry: Vec::new(),
                        auth_path: Vec::new(),
                    },
                ],
                cursor: 99,
            },
        ] {
            assert_eq!(
                FragmentMessage::decode(&message.encode()).unwrap(),
                message
            );
        }
    }

    /// The decode cap is the door's bouncer: a page no honest encoder would send is refused
    /// before a byte of it is believed, same posture as the frame cap and the path-depth cap.
    #[test]
    fn an_oversized_deaths_page_is_refused() {
        let proofs = (0..MAX_DEATHS_PER_PAGE + 1)
            .map(|_| DeathProof {
                author: [1u8; 32],
                doc_id: [2u8; 16],
                entry: vec![3],
                auth_path: Vec::new(),
            })
            .collect();
        let bytes = FragmentMessage::Deaths { proofs, cursor: 0 }.encode();
        assert!(FragmentMessage::decode(&bytes).is_err());
    }

    /// "The author took it back" and "I don't have it" must never collapse into one answer: a
    /// reader that cannot tell them apart deletes live shares every time it asks the wrong node.
    #[test]
    fn gone_and_unknown_are_different_on_the_wire() {
        assert_ne!(
            FragmentMessage::Gone {
                entry: Vec::new(),
                auth_path: Vec::new(),
            }
            .encode(),
            FragmentMessage::Unknown.encode()
        );
    }

    /// A bare `Gone` - the pre-proof wire shape, one tag and nothing else - must not decode.
    /// It is not a compatibility case, it is the attack: an answer that asserts deletion
    /// without carrying the author's word for it.
    #[test]
    fn a_gone_without_its_proof_is_not_a_message() {
        let mut w = Writer::new();
        w.array(1);
        w.uint(TAG_GONE);
        assert!(FragmentMessage::decode(&w.into_bytes()).is_err());
    }

    fn author_key() -> crate::SigningKey {
        crate::SigningKey::from_bytes(&[7u8; 32])
    }

    /// A root-signed retraction: the simplest honest proof (empty path - the signer IS the root).
    fn retraction_entry(key: &crate::SigningKey, doc_id: [u8; 16]) -> Vec<u8> {
        let entry = crate::Entry {
            v: crate::ENTRY_VERSION,
            entry_type: entry_type::POST_RETRACT,
            chain: crate::ChainId {
                author: key.verifying_key().to_bytes(),
                service: service::POSTS,
            },
            seq: 4,
            prev_hash: crate::ZERO_HASH,
            timestamp_ms: 1_700_000_000_000,
            payload: Payload::Inline(crate::PostRetraction { doc_id }.encode()),
        };
        SignedEntry::create(&entry, key).unwrap().bytes().to_vec()
    }

    /// A root-signed reply header (empty path): the door's proof in miniature.
    fn reply_entry(
        key: &crate::SigningKey,
        doc_id: [u8; 16],
        reply_to: Option<([u8; 32], [u8; 16])>,
    ) -> Vec<u8> {
        let header = crate::registry::DocHeaderPlain {
            trusted_only: false,
            settled: false,
            doc_id,
            parents: vec![[1u8; 32]],
            file_hash: [3u8; 32],
            body_hash: [4u8; 32],
            title: "an answer".into(),
            format: None,
            width: None,
            height: None,
            duration_ms: None,
            thumb_hash: None,
            preview_hash: None,
            refs: Vec::new(),
            genesis_ms: Some(9),
            reply_to,
            thread_root: reply_to,
        };
        let entry = crate::Entry {
            v: crate::ENTRY_VERSION,
            entry_type: entry_type::DOC_HEADER,
            chain: crate::ChainId {
                author: key.verifying_key().to_bytes(),
                service: service::POSTS,
            },
            seq: 5,
            prev_hash: crate::ZERO_HASH,
            timestamp_ms: 1_700_000_111_000,
            payload: Payload::Inline(header.encode().unwrap()),
        };
        SignedEntry::create(&entry, key).unwrap().bytes().to_vec()
    }

    /// One annotation entry on `signer`'s chain, targeting a post.
    fn annotation_entry(
        signer: &crate::SigningKey,
        target: ([u8; 32], [u8; 16]),
        value: &str,
        present: bool,
    ) -> Vec<u8> {
        let payload = crate::registry::PublicAnnotation {
            target_author: target.0,
            target_doc: target.1,
            key: "tag".into(),
            value: value.into(),
            present,
        }
        .encode()
        .unwrap();
        let entry = crate::Entry {
            v: crate::ENTRY_VERSION,
            entry_type: entry_type::PUBLIC_ANNOTATION,
            chain: crate::ChainId {
                author: signer.verifying_key().to_bytes(),
                service: service::ANNOTATIONS_PUBLIC,
            },
            seq: 3,
            prev_hash: crate::ZERO_HASH,
            timestamp_ms: 1_700_000_222_000,
            payload: Payload::Inline(payload),
        };
        SignedEntry::create(&entry, signer).unwrap().bytes().to_vec()
    }

    /// ANNOTATIONS.md slice 3: an annotation proof verifies against exactly the post it
    /// rode with, carries retractions like anything else, and refuses the re-target and
    /// the stranger's signature.
    #[test]
    fn an_annotation_proof_verifies_and_cannot_be_retargeted() {
        let key = author_key();
        let annotator = key.verifying_key().to_bytes();
        let target = ([2u8; 32], [3u8; 16]);
        let entry = annotation_entry(&key, target, "goopy", true);
        let a = verify_annotation(annotator, target.0, target.1, &entry, &[]).unwrap();
        assert_eq!((a.key.as_str(), a.value.as_str(), a.present), ("tag", "goopy", true));
        let gone = annotation_entry(&key, target, "goopy", false);
        assert!(!verify_annotation(annotator, target.0, target.1, &gone, &[]).unwrap().present);
        assert!(
            verify_annotation(annotator, [9u8; 32], target.1, &entry, &[]).is_err(),
            "a different target author refuses"
        );
        let stranger = crate::SigningKey::from_bytes(&[9u8; 32]);
        let forged = annotation_entry(&stranger, target, "goopy", true);
        assert!(
            verify_annotation(annotator, target.0, target.1, &forged, &[]).is_err(),
            "signed by a key the path does not tie to the annotator"
        );
    }

    /// PROJECT_PLAN's Replies slice 6: a reply proof verifies offline against the exact parent asked
    /// about, yields the reply's identity from inside the signature, and refuses both the
    /// mis-parented claim and the header that is not a reply at all.
    #[test]
    fn a_reply_proof_verifies_against_its_parent_and_only_its_parent() {
        let key = author_key();
        let replier = key.verifying_key().to_bytes();
        let parent = ([2u8; 32], [3u8; 16]);
        let entry = reply_entry(&key, [8u8; 16], Some(parent));
        let (doc, stamp) = verify_reply(replier, parent.0, parent.1, &entry, &[]).unwrap();
        assert_eq!(doc, [8u8; 16], "the reply's identity, off the signed header");
        assert_eq!(stamp, 1_700_000_111_000);

        assert!(
            verify_reply(replier, [9u8; 32], parent.1, &entry, &[]).is_err(),
            "a different parent author refuses"
        );
        assert!(
            verify_reply(replier, parent.0, [9u8; 16], &entry, &[]).is_err(),
            "a different parent doc refuses"
        );
        let bare = reply_entry(&key, [8u8; 16], None);
        assert!(
            verify_reply(replier, parent.0, parent.1, &bare, &[]).is_err(),
            "a header that is not a reply proves nothing"
        );
        let stranger = crate::SigningKey::from_bytes(&[9u8; 32]);
        let forged = reply_entry(&stranger, [8u8; 16], Some(parent));
        assert!(
            verify_reply(replier, parent.0, parent.1, &forged, &[]).is_err(),
            "signed by a key the path does not tie to the replier"
        );
    }

    #[test]
    fn a_real_retraction_verifies() {
        let key = author_key();
        let author = key.verifying_key().to_bytes();
        let proof = retraction_entry(&key, [3u8; 16]);
        assert!(verify_retraction(author, [3u8; 16], &proof, &[]).is_ok());
    }

    /// One genuine deletion in hand must not become a skeleton key for the author's whole
    /// shelf: a proof for document X is refused as an answer about document Y.
    #[test]
    fn a_retraction_of_one_document_cannot_bury_another() {
        let key = author_key();
        let author = key.verifying_key().to_bytes();
        let proof = retraction_entry(&key, [3u8; 16]);
        assert!(verify_retraction(author, [4u8; 16], &proof, &[]).is_err());
    }

    /// Signed speech of the wrong KIND is refused: a doc-header - genuine, signed, on the posts
    /// chain - is the author saying "here it is", and must not be accepted as "I took it back".
    #[test]
    fn a_document_header_is_not_a_retraction() {
        let key = author_key();
        let author = key.verifying_key().to_bytes();
        let entry = crate::Entry {
            v: crate::ENTRY_VERSION,
            entry_type: entry_type::DOC_HEADER,
            chain: crate::ChainId {
                author,
                service: service::POSTS,
            },
            seq: 4,
            prev_hash: crate::ZERO_HASH,
            timestamp_ms: 1_700_000_000_000,
            payload: Payload::Inline(crate::PostRetraction { doc_id: [3u8; 16] }.encode()),
        };
        let proof = SignedEntry::create(&entry, &key).unwrap().bytes().to_vec();
        assert!(verify_retraction(author, [3u8; 16], &proof, &[]).is_err());
    }

    /// Somebody ELSE'S genuine retraction is refused: the signer must tie back to the claimed
    /// author's root, or any node could bury your documents by deleting its own.
    #[test]
    fn another_authors_retraction_does_not_speak_for_this_one() {
        let key = author_key();
        let stranger = crate::SigningKey::from_bytes(&[9u8; 32]);
        let proof = retraction_entry(&key, [3u8; 16]);
        assert!(verify_retraction(
            stranger.verifying_key().to_bytes(),
            [3u8; 16],
            &proof,
            &[]
        )
        .is_err());
    }

    #[test]
    fn a_path_deeper_than_a_key_tree_is_refused_at_decode() {
        let mut w = Writer::new();
        w.array(3);
        w.uint(TAG_HAVE);
        w.bytes(&[1, 2, 3]);
        w.array((crate::deliver::MAX_AUTH_PATH + 1) as u64);
        for _ in 0..=crate::deliver::MAX_AUTH_PATH {
            w.bytes(&[0u8; 8]);
        }
        assert!(FragmentMessage::decode(&w.into_bytes()).is_err());
    }

    #[test]
    fn a_frame_over_the_cap_dies_before_it_is_parsed() {
        assert!(FragmentMessage::decode(&vec![0u8; MAX_FRAGMENT_FRAME_BYTES + 1]).is_err());
    }
}
