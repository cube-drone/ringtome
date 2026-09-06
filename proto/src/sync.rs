//! Sync protocol v1: the wire messages.
//!
//! Ringtome sync is a pull: the requester sends `Hello` describing what it holds (per-chain
//! `[floor..head]` ranges - ranges, not high-water marks, because content chains may be held
//! shallow; see PROJECT_PLAN, Shallow Sync), the responder streams `Entry` frames the requester
//! lacks - **identity chains strictly first**, so the authority context always precedes the
//! content it validates - and finishes with `Done`. A bidirectional sync is two pulls.
//!
//! This module is messages only - encode/decode over the canonical CBOR core, strict in both
//! directions. Transport (iroh streams, length-prefix framing) and the validation gate live in
//! the node; a message decoding successfully says nothing about whether its contents should be
//! believed.
//!
//! Wire shape: each message is a canonical CBOR array `[tag, ...fields]`:
//!
//! | tag | message | fields                                                        |
//! |-----|---------|---------------------------------------------------------------|
//! | 0   | Hello   | bstr(32) root, array of [bstr(32) author, uint service, uint floor, uint head] |
//! | 1   | Entry   | bstr envelope bytes (opaque; the author's exact bytes)        |
//! | 2   | Done    | -                                                             |
//!
//! Protocol *version* lives in the ALPN ([`SYNC_ALPN`]), not in the messages: two endpoints that
//! negotiate the ALPN agree on this whole table, and a future v2 is a new ALPN string.

use crate::cbor::{Reader, Writer};
use crate::entry::MAX_ENTRY_BYTES;
use crate::error::ProtoError;

/// ALPN for sync connections. The trailing `/0` is the protocol version.
pub const SYNC_ALPN: &[u8] = b"ringtome/sync/0";

/// Hard cap on one framed message. Entries are capped at 16 KiB; a Hello for an absurdly
/// key-rich identity still fits comfortably.
pub const MAX_SYNC_FRAME_BYTES: usize = 256 * 1024;

/// Hard cap on frontier count in one Hello (chains per identity = keys x services; the design
/// center is single digits).
pub const MAX_FRONTIERS: usize = 4096;

/// Cap on a Hello's `wanted` service list - generous against the registry's real size
/// (single digits), tight against a frame stuffed with garbage.
pub const MAX_WANTED_SERVICES: usize = 32;

const TAG_HELLO: u64 = 0;
const TAG_ENTRY: u64 = 1;
const TAG_DONE: u64 = 2;

/// One chain's held range: this peer holds entries `floor..=head` of `(author, service)`.
/// v1 nodes always hold full chains (`floor == 0`); the wire carries the floor anyway because
/// retrofitting shallowness into a dense-from-zero format would be a protocol break.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Frontier {
    pub author: [u8; 32],
    pub service: u32,
    pub floor: u64,
    pub head: u64,
    /// The entry hash AT `head`. Seq says how far a chain goes; this says which chain it is.
    ///
    /// Two chains that forked carry the same `head` and different entries, so a peer comparing
    /// ranges alone sees agreement where there is a divergence. Carrying the anchor makes the
    /// advertised frontier a thing the receiver can fingerprint and compare against its own
    /// (`net::frontier`), rather than a number it can only subtract. Canon's own name for the
    /// tuple is `(chain, seq, head_hash)`.
    pub head_hash: [u8; 32],
}

/// Domain tag for member proofs.
pub const DOMAIN_MEMBER_PROOF: &[u8] = b"ringtome-v0/member-proof";

/// Proof that the sender of a Hello is one of the identity's own nodes: its leaf key signs a
/// statement **channel-bound** to this exact connection (both endpoint ids are in the preimage,
/// and iroh's transport authenticates them), so the proof cannot be replayed elsewhere. Private
/// chains are exchanged only with peers whose proof verifies against an Active leaf in the
/// verifier's own tree - the plan's "the transport identity IS the authorization," implemented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberProof {
    pub leaf: [u8; 32],
    pub sig: [u8; 64],
}

fn member_proof_preimage(
    root: &[u8; 32],
    prover_endpoint: &[u8; 32],
    verifier_endpoint: &[u8; 32],
) -> Vec<u8> {
    let mut p = DOMAIN_MEMBER_PROOF.to_vec();
    p.extend_from_slice(root);
    p.extend_from_slice(prover_endpoint);
    p.extend_from_slice(verifier_endpoint);
    p
}

impl MemberProof {
    pub fn create(
        root: &[u8; 32],
        prover_endpoint: &[u8; 32],
        verifier_endpoint: &[u8; 32],
        leaf_key: &ed25519_dalek::SigningKey,
    ) -> Self {
        use ed25519_dalek::Signer;
        let preimage = member_proof_preimage(root, prover_endpoint, verifier_endpoint);
        Self {
            leaf: leaf_key.verifying_key().to_bytes(),
            sig: leaf_key.sign(&preimage).to_bytes(),
        }
    }

    /// Verify the signature binds (root, this connection). Says nothing about whether `leaf` is
    /// actually in the tree - the caller checks that against its own Crown, which is the part
    /// that makes it authorization.
    pub fn verify(
        &self,
        root: &[u8; 32],
        prover_endpoint: &[u8; 32],
        verifier_endpoint: &[u8; 32],
    ) -> Result<(), ProtoError> {
        let vk = ed25519_dalek::VerifyingKey::from_bytes(&self.leaf)
            .map_err(|_| ProtoError::BadEntry("member proof leaf is not a valid key"))?;
        let preimage = member_proof_preimage(root, prover_endpoint, verifier_endpoint);
        vk.verify_strict(&preimage, &ed25519_dalek::Signature::from_bytes(&self.sig))
            .map_err(|_| ProtoError::BadSignature)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncMessage {
    /// "Here is the identity I want, what I already hold, and (optionally) proof that I am one
    /// of its own nodes." Without a valid proof the exchange covers public chains only.
    Hello {
        root: [u8; 32],
        frontiers: Vec<Frontier>,
        proof: Option<MemberProof>,
        /// The scope: which services this EXCHANGE is about (2026-08-25, the scoped sync
        /// Hello - PROJECT_PLAN's Discovery's headers depth). Empty means every service, which is both
        /// the pre-scoping wire shape (arity-4 Hellos decode to empty) and the ordinary
        /// full sync. Non-empty scopes the whole exchange, both directions: each side
        /// serves and claims only the named services - scoping only ever NARROWS what the
        /// unscoped exchange would have carried, never widens it.
        wanted: Vec<u32>,
        /// The depth slot (PEEK.md slice 5, the follow ceiling). `ceiling`: for a content
        /// chain the requester holds nothing of, send at most this many NEWEST entries - a
        /// suffix, whose oldest entry's `prev_hash` commits to the prefix. `below`: for a
        /// chain the requester holds from a floor above zero, also send up to this many
        /// entries directly beneath that floor - scrollback's backfill. Zero is "whole", the
        /// pre-ceiling shape (arity-5 Hellos decode to zeros).
        ceiling: u64,
        below: u64,
    },
    /// One signed envelope, byte-exact. Opaque at this layer.
    Entry(Vec<u8>),
    /// End of this direction's stream.
    Done,
}

impl SyncMessage {
    pub fn encode(&self) -> Result<Vec<u8>, ProtoError> {
        let mut w = Writer::new();
        match self {
            SyncMessage::Hello {
                root,
                frontiers,
                proof,
                wanted,
                ceiling,
                below,
            } => {
                if frontiers.len() > MAX_FRONTIERS {
                    return Err(ProtoError::BadEntry("too many frontiers"));
                }
                if wanted.len() > MAX_WANTED_SERVICES {
                    return Err(ProtoError::BadEntry("too many wanted services"));
                }
                w.array(6);
                w.uint(TAG_HELLO);
                w.bytes(root);
                w.array(frontiers.len() as u64);
                for f in frontiers {
                    if f.floor > f.head {
                        return Err(ProtoError::BadEntry("frontier floor above head"));
                    }
                    w.array(5);
                    w.bytes(&f.author);
                    w.uint(u64::from(f.service));
                    w.uint(f.floor);
                    w.uint(f.head);
                    w.bytes(&f.head_hash);
                }
                // Proof slot: empty array = anonymous, [leaf, sig] = member claim.
                match proof {
                    None => w.array(0),
                    Some(p) => {
                        w.array(2);
                        w.bytes(&p.leaf);
                        w.bytes(&p.sig);
                    }
                }
                // The scope slot: empty array = every service (the proof slot's idiom).
                w.array(wanted.len() as u64);
                for service in wanted {
                    w.uint(u64::from(*service));
                }
                // The depth slot: [ceiling, below].
                w.array(2);
                w.uint(*ceiling);
                w.uint(*below);
            }
            SyncMessage::Entry(bytes) => {
                if bytes.len() > MAX_ENTRY_BYTES {
                    return Err(ProtoError::BadEntry("entry exceeds size limit"));
                }
                w.array(2);
                w.uint(TAG_ENTRY);
                w.bytes(bytes);
            }
            SyncMessage::Done => {
                w.array(1);
                w.uint(TAG_DONE);
            }
        }
        Ok(w.into_bytes())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() > MAX_SYNC_FRAME_BYTES {
            return Err(ProtoError::BadEntry("sync frame exceeds size limit"));
        }
        let mut r = Reader::new(bytes);
        let arity = r.array()?;
        let msg = match (r.uint()?, arity) {
            (TAG_HELLO, arity @ 4..=6) => {
                let root = r.bytes_fixed::<32>()?;
                let n = r.array()?;
                if n > MAX_FRONTIERS as u64 {
                    return Err(ProtoError::BadEntry("too many frontiers"));
                }
                let mut frontiers = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    if r.array()? != 5 {
                        return Err(ProtoError::BadEntry(
                            "frontier must be [author, service, floor, head, head_hash]",
                        ));
                    }
                    let author = r.bytes_fixed::<32>()?;
                    let service = u32::try_from(r.uint()?)
                        .map_err(|_| ProtoError::BadEntry("service id out of range"))?;
                    let floor = r.uint()?;
                    let head = r.uint()?;
                    if floor > head {
                        return Err(ProtoError::BadEntry("frontier floor above head"));
                    }
                    let head_hash = r.bytes_fixed::<32>()?;
                    frontiers.push(Frontier {
                        author,
                        service,
                        floor,
                        head,
                        head_hash,
                    });
                }
                let proof = match r.array()? {
                    0 => None,
                    2 => Some(MemberProof {
                        leaf: r.bytes_fixed::<32>()?,
                        sig: r.bytes_fixed::<64>()?,
                    }),
                    _ => return Err(ProtoError::BadEntry("proof must be [] or [leaf, sig]")),
                };
                // Arity 4 is the pre-scoping shape: an unscoped Hello. Kept decodable so
                // old frames and captures still read; encode always writes arity 5.
                let wanted = if arity >= 5 {
                    let n = r.array()?;
                    if n > MAX_WANTED_SERVICES as u64 {
                        return Err(ProtoError::BadEntry("too many wanted services"));
                    }
                    let mut wanted = Vec::with_capacity(n as usize);
                    for _ in 0..n {
                        wanted.push(
                            u32::try_from(r.uint()?)
                                .map_err(|_| ProtoError::BadEntry("service id out of range"))?,
                        );
                    }
                    wanted
                } else {
                    Vec::new()
                };
                // Arity 6 carries the depth slot; older shapes mean "whole".
                let (ceiling, below) = if arity == 6 {
                    if r.array()? != 2 {
                        return Err(ProtoError::BadEntry("depth must be [ceiling, below]"));
                    }
                    (r.uint()?, r.uint()?)
                } else {
                    (0, 0)
                };
                SyncMessage::Hello {
                    root,
                    frontiers,
                    proof,
                    wanted,
                    ceiling,
                    below,
                }
            }
            (TAG_ENTRY, 2) => {
                let b = r.bytes()?;
                if b.len() > MAX_ENTRY_BYTES {
                    return Err(ProtoError::BadEntry("entry exceeds size limit"));
                }
                SyncMessage::Entry(b.to_vec())
            }
            (TAG_DONE, 1) => SyncMessage::Done,
            _ => return Err(ProtoError::BadEntry("unknown sync message")),
        };
        r.finish()?;
        Ok(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_messages_round_trip() {
        let hello = SyncMessage::Hello {
            root: [7u8; 32],
            frontiers: vec![
                Frontier {
                    author: [7u8; 32],
                    service: 0,
                    floor: 0,
                    head: 4,
                    head_hash: [70u8; 32],
                },
                Frontier {
                    author: [8u8; 32],
                    service: 2,
                    floor: 3,
                    head: 17,
                    head_hash: [80u8; 32],
                },
            ],
            proof: None,
            wanted: vec![],
            ceiling: 0,
            below: 0,
        };
        let proven = SyncMessage::Hello {
            root: [7u8; 32],
            frontiers: vec![],
            proof: Some(MemberProof {
                leaf: [9u8; 32],
                sig: [1u8; 64],
            }),
            wanted: vec![],
            ceiling: 0,
            below: 0,
        };
        let scoped = SyncMessage::Hello {
            root: [7u8; 32],
            frontiers: vec![],
            proof: None,
            wanted: vec![0, 2],
            ceiling: 0,
            below: 0,
        };
        let entry = SyncMessage::Entry(vec![0x82, 0x41, 0x00, 0x41, 0x00]);
        let done = SyncMessage::Done;

        for msg in [hello, proven, scoped, entry, done] {
            let bytes = msg.encode().unwrap();
            assert_eq!(SyncMessage::decode(&bytes).unwrap(), msg);
        }
    }

    /// The pre-scoping Hello (arity 4, no wanted slot) still decodes - as unscoped, which
    /// is exactly what it always meant. Encode now always writes arity 5.
    #[test]
    fn an_arity_four_hello_decodes_as_unscoped() {
        let mut w = Writer::new();
        w.array(4);
        w.uint(0); // TAG_HELLO
        w.bytes(&[7u8; 32]);
        w.array(0); // no frontiers
        w.array(0); // anonymous
        let msg = SyncMessage::decode(&w.into_bytes()).unwrap();
        assert_eq!(
            msg,
            SyncMessage::Hello {
                root: [7u8; 32],
                frontiers: vec![],
                proof: None,
                wanted: vec![],
                ceiling: 0,
                below: 0,
            }
        );
    }

    #[test]
    fn a_stuffed_wanted_list_is_rejected() {
        let msg = SyncMessage::Hello {
            root: [7u8; 32],
            frontiers: vec![],
            proof: None,
            wanted: (0..(MAX_WANTED_SERVICES as u32 + 1)).collect(),
            ceiling: 0,
            below: 0,
        };
        assert_eq!(
            msg.encode(),
            Err(ProtoError::BadEntry("too many wanted services"))
        );
    }

    #[test]
    fn unknown_tags_and_arities_are_rejected() {
        // Tag 9 doesn't exist.
        let mut w = Writer::new();
        w.array(1);
        w.uint(9);
        assert_eq!(
            SyncMessage::decode(&w.into_bytes()),
            Err(ProtoError::BadEntry("unknown sync message"))
        );

        // Done with a stray extra field.
        let mut w = Writer::new();
        w.array(2);
        w.uint(TAG_DONE);
        w.uint(0);
        assert!(SyncMessage::decode(&w.into_bytes()).is_err());
    }

    #[test]
    fn inverted_frontiers_are_rejected_both_ways() {
        let bad = SyncMessage::Hello {
            root: [1u8; 32],
            frontiers: vec![Frontier {
                author: [1u8; 32],
                service: 0,
                floor: 5,
                head: 2,
                head_hash: [0u8; 32],
            }],
            proof: None,
            wanted: vec![],
            ceiling: 0,
            below: 0,
        };
        assert!(bad.encode().is_err());

        // Hand-encode the same inversion and confirm the reader refuses it too.
        let mut w = Writer::new();
        w.array(4);
        w.uint(TAG_HELLO);
        w.bytes(&[1u8; 32]);
        w.array(1);
        w.array(5);
        w.bytes(&[1u8; 32]);
        w.uint(0);
        w.uint(5);
        w.uint(2);
        w.bytes(&[0u8; 32]);
        w.array(0); // empty proof slot
        assert_eq!(
            SyncMessage::decode(&w.into_bytes()),
            Err(ProtoError::BadEntry("frontier floor above head"))
        );
    }

    #[test]
    fn member_proofs_are_channel_bound() {
        let leaf = ed25519_dalek::SigningKey::from_bytes(&[4u8; 32]);
        let (root, us, them) = ([1u8; 32], [2u8; 32], [3u8; 32]);

        let proof = MemberProof::create(&root, &us, &them, &leaf);
        proof.verify(&root, &us, &them).unwrap();

        // Any element of the binding changing kills the proof: different connection endpoints,
        // different identity, or swapped roles.
        assert!(proof.verify(&root, &us, &[9u8; 32]).is_err());
        assert!(proof.verify(&[9u8; 32], &us, &them).is_err());
        assert!(proof.verify(&root, &them, &us).is_err());
    }

    #[test]
    fn oversized_entries_are_rejected() {
        let too_big = SyncMessage::Entry(vec![0; MAX_ENTRY_BYTES + 1]);
        assert!(too_big.encode().is_err());
    }
}
