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
///
/// [`Gone`](Self::Gone) and [`Unknown`](Self::Unknown) are deliberately different answers.
/// *Gone* is a fact about the document - it was withdrawn, and the reader should drop it. *Unknown*
/// is a fact about this node - it does not carry that document, so ask somebody else. Collapsing
/// them would make "I never had it" indistinguishable from "the author took it back", and a
/// reader would delete a live share every time it asked the wrong node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FragmentMessage {
    Want { author: [u8; 32], doc_id: [u8; 16] },
    Have { entry: Vec<u8>, auth_path: Vec<Vec<u8>> },
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
}

const TAG_WANT: u64 = 0;
const TAG_HAVE: u64 = 1;
const TAG_GONE: u64 = 2;
const TAG_UNKNOWN: u64 = 3;

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
            Self::Have { entry, auth_path } => {
                w.array(3);
                w.uint(TAG_HAVE);
                w.bytes(entry);
                w.array(auth_path.len() as u64);
                for rung in auth_path {
                    w.bytes(rung);
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
            (TAG_HAVE, 3) => {
                let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                Self::Have { entry, auth_path }
            }
            (TAG_GONE, 3) => {
                let (entry, auth_path) = Self::entry_and_path(&mut r)?;
                Self::Gone { entry, auth_path }
            }
            (TAG_UNKNOWN, 1) => Self::Unknown,
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
            },
            FragmentMessage::Have {
                entry: vec![9],
                auth_path: Vec::new(),
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
        ] {
            assert_eq!(
                FragmentMessage::decode(&message.encode()).unwrap(),
                message
            );
        }
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
