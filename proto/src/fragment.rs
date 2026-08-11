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
/// | 2   | Gone    | - |
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
    Gone,
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
            Self::Gone => {
                w.array(1);
                w.uint(TAG_GONE);
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
                let entry = r.bytes()?.to_vec();
                let rungs = r.array()?;
                if rungs > crate::deliver::MAX_AUTH_PATH as u64 {
                    return Err(ProtoError::BadEntry("authorization path too deep"));
                }
                let mut auth_path = Vec::new();
                for _ in 0..rungs {
                    auth_path.push(r.bytes()?.to_vec());
                }
                Self::Have { entry, auth_path }
            }
            (TAG_GONE, 1) => Self::Gone,
            (TAG_UNKNOWN, 1) => Self::Unknown,
            _ => return Err(ProtoError::BadEntry("unknown fragment message")),
        };
        r.finish()?;
        Ok(out)
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
            FragmentMessage::Gone,
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
            FragmentMessage::Gone.encode(),
            FragmentMessage::Unknown.encode()
        );
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
