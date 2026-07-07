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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncMessage {
    /// "Here is the identity I want and what I already hold."
    Hello {
        root: [u8; 32],
        frontiers: Vec<Frontier>,
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
            SyncMessage::Hello { root, frontiers } => {
                if frontiers.len() > MAX_FRONTIERS {
                    return Err(ProtoError::BadEntry("too many frontiers"));
                }
                w.array(3);
                w.uint(TAG_HELLO);
                w.bytes(root);
                w.array(frontiers.len() as u64);
                for f in frontiers {
                    if f.floor > f.head {
                        return Err(ProtoError::BadEntry("frontier floor above head"));
                    }
                    w.array(4);
                    w.bytes(&f.author);
                    w.uint(u64::from(f.service));
                    w.uint(f.floor);
                    w.uint(f.head);
                }
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
            (TAG_HELLO, 3) => {
                let root = r.bytes_fixed::<32>()?;
                let n = r.array()?;
                if n > MAX_FRONTIERS as u64 {
                    return Err(ProtoError::BadEntry("too many frontiers"));
                }
                let mut frontiers = Vec::with_capacity(n as usize);
                for _ in 0..n {
                    if r.array()? != 4 {
                        return Err(ProtoError::BadEntry(
                            "frontier must be [author, service, floor, head]",
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
                    frontiers.push(Frontier {
                        author,
                        service,
                        floor,
                        head,
                    });
                }
                SyncMessage::Hello { root, frontiers }
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
                },
                Frontier {
                    author: [8u8; 32],
                    service: 2,
                    floor: 3,
                    head: 17,
                },
            ],
        };
        let entry = SyncMessage::Entry(vec![0x82, 0x41, 0x00, 0x41, 0x00]);
        let done = SyncMessage::Done;

        for msg in [hello, entry, done] {
            let bytes = msg.encode().unwrap();
            assert_eq!(SyncMessage::decode(&bytes).unwrap(), msg);
        }
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
            }],
        };
        assert!(bad.encode().is_err());

        // Hand-encode the same inversion and confirm the reader refuses it too.
        let mut w = Writer::new();
        w.array(3);
        w.uint(TAG_HELLO);
        w.bytes(&[1u8; 32]);
        w.array(1);
        w.array(4);
        w.bytes(&[1u8; 32]);
        w.uint(0);
        w.uint(5);
        w.uint(2);
        assert_eq!(
            SyncMessage::decode(&w.into_bytes()),
            Err(ProtoError::BadEntry("frontier floor above head"))
        );
    }

    #[test]
    fn oversized_entries_are_rejected() {
        let too_big = SyncMessage::Entry(vec![0; MAX_ENTRY_BYTES + 1]);
        assert!(too_big.encode().is_err());
    }
}
