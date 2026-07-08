//! Chain-link validation: the rules that make a sequence of entries an append-only log.
//!
//! Within a chain, order is cryptographic fact: dense sequence numbers, each entry's signature
//! covering the hash of its predecessor's exact bytes. This module validates one link at a time
//! so callers can stream - replay a stored log, or admit entries arriving over sync - without
//! materializing whole chains.

use crate::entry::{SignedEntry, ZERO_HASH};
use crate::error::ProtoError;

/// Validate `next` as the successor of `prev` on one chain (`prev = None` validates a genesis
/// entry). Checks the signature, the chain identity, the dense sequence, and the hash link.
pub fn validate_next(prev: Option<&SignedEntry>, next: &SignedEntry) -> Result<(), ProtoError> {
    next.verify()?;
    match prev {
        None => {
            if next.entry().seq != 0 {
                return Err(ProtoError::ChainViolation("genesis entry must have seq 0"));
            }
            if next.entry().prev_hash != ZERO_HASH {
                return Err(ProtoError::ChainViolation(
                    "genesis entry must have a zero prev_hash",
                ));
            }
        }
        Some(prev) => {
            if prev.entry().chain != next.entry().chain {
                return Err(ProtoError::ChainViolation(
                    "entry belongs to a different chain",
                ));
            }
            if next.entry().seq != prev.entry().seq + 1 {
                return Err(ProtoError::ChainViolation("sequence gap or duplicate"));
            }
            if next.entry().prev_hash != *prev.hash() {
                return Err(ProtoError::ChainViolation(
                    "prev_hash does not match predecessor",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{ChainId, Entry, Payload, ENTRY_VERSION};
    use crate::registry::{entry_type, service};
    use ed25519_dalek::SigningKey;

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[42u8; 32])
    }

    fn make(seq: u64, prev_hash: [u8; 32], k: &SigningKey) -> SignedEntry {
        let entry = Entry {
            v: ENTRY_VERSION,
            entry_type: entry_type::PROFILE_SET,
            chain: ChainId {
                author: k.verifying_key().to_bytes(),
                service: service::PROFILE,
            },
            seq,
            prev_hash,
            timestamp_ms: 1_700_000_000_000 + seq as i64,
            payload: Payload::Inline(vec![0xa0]),
        };
        SignedEntry::create(&entry, k).unwrap()
    }

    #[test]
    fn a_well_formed_chain_validates_link_by_link() {
        let k = key();
        let e0 = make(0, ZERO_HASH, &k);
        let e1 = make(1, *e0.hash(), &k);
        let e2 = make(2, *e1.hash(), &k);

        validate_next(None, &e0).unwrap();
        validate_next(Some(&e0), &e1).unwrap();
        validate_next(Some(&e1), &e2).unwrap();
    }

    #[test]
    fn genesis_rules_are_enforced() {
        let k = key();
        let e1_as_genesis = make(1, ZERO_HASH, &k);
        assert_eq!(
            validate_next(None, &e1_as_genesis),
            Err(ProtoError::ChainViolation("genesis entry must have seq 0"))
        );

        let bad_prev = make(0, [1u8; 32], &k);
        assert_eq!(
            validate_next(None, &bad_prev),
            Err(ProtoError::ChainViolation(
                "genesis entry must have a zero prev_hash"
            ))
        );
    }

    #[test]
    fn sequence_gaps_and_duplicates_are_rejected() {
        let k = key();
        let e0 = make(0, ZERO_HASH, &k);
        let e2 = make(2, *e0.hash(), &k); // gap: skips seq 1
        assert_eq!(
            validate_next(Some(&e0), &e2),
            Err(ProtoError::ChainViolation("sequence gap or duplicate"))
        );

        let dup = make(0, ZERO_HASH, &k); // duplicate genesis after e0
        assert_eq!(
            validate_next(Some(&e0), &dup),
            Err(ProtoError::ChainViolation("sequence gap or duplicate"))
        );
    }

    #[test]
    fn a_broken_hash_link_is_rejected() {
        let k = key();
        let e0 = make(0, ZERO_HASH, &k);
        let forged = make(1, [0xffu8; 32], &k);
        assert_eq!(
            validate_next(Some(&e0), &forged),
            Err(ProtoError::ChainViolation(
                "prev_hash does not match predecessor"
            ))
        );
    }

    #[test]
    fn cross_chain_confusion_is_rejected() {
        let k = key();
        let e0 = make(0, ZERO_HASH, &k);

        // Same author, different service = different chain.
        let other_chain = {
            let entry = Entry {
                v: ENTRY_VERSION,
                entry_type: entry_type::POST,
                chain: ChainId {
                    author: k.verifying_key().to_bytes(),
                    service: service::POSTS,
                },
                seq: 1,
                prev_hash: *e0.hash(),
                timestamp_ms: 1,
                payload: Payload::Inline(vec![0xa0]),
            };
            SignedEntry::create(&entry, &k).unwrap()
        };
        assert_eq!(
            validate_next(Some(&e0), &other_chain),
            Err(ProtoError::ChainViolation(
                "entry belongs to a different chain"
            ))
        );
    }
}
