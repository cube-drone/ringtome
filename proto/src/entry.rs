//! The entry: Ringtome's atomic unit of signed history.
//!
//! ## Envelope shape
//!
//! An entry on the wire is a two-element CBOR array: `[body: bstr, sig: bstr(64)]`. The body is
//! itself canonical CBOR (an integer-keyed map), but it travels and is signed *as bytes*. The
//! signature covers `DOMAIN_ENTRY || body-bytes`, so verification slices the received bytes and
//! never re-serializes anything - the COSE trick. Re-encoding during verification is exactly
//! where canonical-encoding bugs become forgery bugs; this layout makes the plan's
//! store-the-original-bytes rule structural rather than disciplinary.
//!
//! ## Body layout (v0)
//!
//! An integer-keyed map, keys ascending; unknown keys above 6 are skipped (additive evolution),
//! keys 0-6 are required:
//!
//! | key | field       | encoding                                              |
//! |-----|-------------|-------------------------------------------------------|
//! | 0   | v           | uint (must be 0)                                      |
//! | 1   | type        | uint (type registry id)                               |
//! | 2   | chain       | [bstr(32) author pubkey, uint service id]             |
//! | 3   | seq         | uint, dense per chain                                 |
//! | 4   | prev_hash   | bstr(32); BLAKE3 of prior envelope, zero for seq 0    |
//! | 5   | timestamp   | uint ≤ i64::MAX, claimed ms since epoch; ADVISORY     |
//! | 6   | payload     | [0, bstr inline] or [1, bstr(32) blob hash]           |
//!
//! The **entry hash** - what `prev_hash` links and revocation anchors pin - is BLAKE3-256 over
//! the entire envelope bytes exactly as the author produced them.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;

pub const ENTRY_VERSION: u16 = 0;
/// Domain-separation tag for entry signatures: a signature over an entry body is valid in
/// exactly this context and no other.
pub const DOMAIN_ENTRY: &[u8] = b"ringtome-v0/entry";
pub const HASH_LEN: usize = 32;
pub const SIG_LEN: usize = 64;
/// `prev_hash` of the genesis entry (seq 0) of every chain.
pub const ZERO_HASH: [u8; HASH_LEN] = [0u8; HASH_LEN];
/// Hard cap on a whole envelope. Entries are headers; content lives in blobs.
pub const MAX_ENTRY_BYTES: usize = 16 * 1024;
/// Hard cap on an inline payload. Anything bigger must be a blob reference.
pub const MAX_INLINE_PAYLOAD: usize = 8 * 1024;

// Body map keys.
const K_VERSION: u64 = 0;
const K_TYPE: u64 = 1;
const K_CHAIN: u64 = 2;
const K_SEQ: u64 = 3;
const K_PREV_HASH: u64 = 4;
const K_TIMESTAMP: u64 = 5;
const K_PAYLOAD: u64 = 6;

// Payload discriminants.
const PAYLOAD_INLINE: u64 = 0;
const PAYLOAD_BLOB: u64 = 1;

/// Which chain an entry belongs to: one author key, one service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainId {
    /// The author's ed25519 public key. Only this key may append to this chain.
    pub author: [u8; 32],
    /// Service id from the registry (profile, posts, ...).
    pub service: u32,
}

/// Header-vs-blob split, per entry: small values ride inline, large content is a droppable,
/// content-addressed blob (deletion drops the blob; the signed header survives).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Payload {
    /// Type-specific body, itself canonical CBOR, opaque at this layer.
    Inline(Vec<u8>),
    /// BLAKE3-256 of an external blob.
    Blob([u8; HASH_LEN]),
}

/// The logical entry - what you build in order to sign, and what you read after verification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub v: u16,
    pub entry_type: u32,
    pub chain: ChainId,
    pub seq: u64,
    pub prev_hash: [u8; HASH_LEN],
    /// Author's claimed wall-clock, ms since epoch. ADVISORY: display interleaving and LWW of
    /// cosmetic fields only - never a security input. `i64` (like every clock in the system);
    /// the wire encoding is a CBOR uint, so the representable range is `0..=i64::MAX` - the
    /// writer refuses negatives and the reader refuses the astronomical upper half.
    pub timestamp_ms: i64,
    pub payload: Payload,
}

fn encode_body(entry: &Entry) -> Vec<u8> {
    let mut w = Writer::new();
    w.map(7);
    w.uint(K_VERSION);
    w.uint(u64::from(entry.v));
    w.uint(K_TYPE);
    w.uint(u64::from(entry.entry_type));
    w.uint(K_CHAIN);
    w.array(2);
    w.bytes(&entry.chain.author);
    w.uint(u64::from(entry.chain.service));
    w.uint(K_SEQ);
    w.uint(entry.seq);
    w.uint(K_PREV_HASH);
    w.bytes(&entry.prev_hash);
    w.uint(K_TIMESTAMP);
    w.uint(entry.timestamp_ms as u64); // non-negative: checked in `create`
    w.uint(K_PAYLOAD);
    match &entry.payload {
        Payload::Inline(b) => {
            w.array(2);
            w.uint(PAYLOAD_INLINE);
            w.bytes(b);
        }
        Payload::Blob(h) => {
            w.array(2);
            w.uint(PAYLOAD_BLOB);
            w.bytes(h);
        }
    }
    w.into_bytes()
}

fn decode_body(body: &[u8]) -> Result<Entry, ProtoError> {
    let mut r = Reader::new(body);
    let n = r.map()?;

    let mut last_key: Option<u64> = None;
    let mut v: Option<u64> = None;
    let mut entry_type: Option<u64> = None;
    let mut chain: Option<ChainId> = None;
    let mut seq: Option<u64> = None;
    let mut prev_hash: Option<[u8; HASH_LEN]> = None;
    let mut timestamp_ms: Option<i64> = None;
    let mut payload: Option<Payload> = None;

    for _ in 0..n {
        let key = r.uint()?;
        if let Some(prev) = last_key {
            if key <= prev {
                return Err(ProtoError::NonCanonical("map keys not in ascending order"));
            }
        }
        last_key = Some(key);
        match key {
            K_VERSION => v = Some(r.uint()?),
            K_TYPE => entry_type = Some(r.uint()?),
            K_CHAIN => {
                if r.array()? != 2 {
                    return Err(ProtoError::BadEntry("chain id must be [author, service]"));
                }
                let author = r.bytes_fixed::<32>()?;
                let service = r.uint()?;
                let service = u32::try_from(service)
                    .map_err(|_| ProtoError::BadEntry("service id out of range"))?;
                chain = Some(ChainId { author, service });
            }
            K_SEQ => seq = Some(r.uint()?),
            K_PREV_HASH => prev_hash = Some(r.bytes_fixed::<HASH_LEN>()?),
            K_TIMESTAMP => {
                timestamp_ms = Some(
                    i64::try_from(r.uint()?)
                        .map_err(|_| ProtoError::BadEntry("timestamp out of range"))?,
                )
            }
            K_PAYLOAD => {
                if r.array()? != 2 {
                    return Err(ProtoError::BadEntry("payload must be [kind, value]"));
                }
                payload = Some(match r.uint()? {
                    PAYLOAD_INLINE => {
                        let b = r.bytes()?;
                        if b.len() > MAX_INLINE_PAYLOAD {
                            return Err(ProtoError::BadEntry("inline payload exceeds size limit"));
                        }
                        Payload::Inline(b.to_vec())
                    }
                    PAYLOAD_BLOB => Payload::Blob(r.bytes_fixed::<HASH_LEN>()?),
                    _ => return Err(ProtoError::BadEntry("unknown payload kind")),
                });
            }
            // Forward compatibility: a newer dialect's extra fields are skipped (and, because
            // the envelope stores original bytes, carried through intact when forwarded).
            _ => r.skip_value()?,
        }
    }
    r.finish()?;

    let v = v.ok_or(ProtoError::BadEntry("missing version"))?;
    if v != u64::from(ENTRY_VERSION) {
        return Err(ProtoError::UnsupportedVersion(v));
    }
    let entry_type = entry_type.ok_or(ProtoError::BadEntry("missing type"))?;
    let entry_type =
        u32::try_from(entry_type).map_err(|_| ProtoError::BadEntry("type id out of range"))?;

    Ok(Entry {
        v: ENTRY_VERSION,
        entry_type,
        chain: chain.ok_or(ProtoError::BadEntry("missing chain id"))?,
        seq: seq.ok_or(ProtoError::BadEntry("missing seq"))?,
        prev_hash: prev_hash.ok_or(ProtoError::BadEntry("missing prev_hash"))?,
        timestamp_ms: timestamp_ms.ok_or(ProtoError::BadEntry("missing timestamp"))?,
        payload: payload.ok_or(ProtoError::BadEntry("missing payload"))?,
    })
}

/// A decoded envelope: the author's exact bytes plus the parsed view of them.
///
/// The bytes are the authoritative artifact - they are what gets hashed, stored, and forwarded.
/// `decode` performs strict structural validation only; call [`SignedEntry::verify`] before
/// trusting authorship.
#[derive(Debug, Clone)]
pub struct SignedEntry {
    bytes: Vec<u8>,
    body_start: usize,
    body_len: usize,
    sig: [u8; SIG_LEN],
    hash: [u8; HASH_LEN],
    entry: Entry,
}

impl PartialEq for SignedEntry {
    fn eq(&self, other: &Self) -> bool {
        self.bytes == other.bytes
    }
}
impl Eq for SignedEntry {}

impl SignedEntry {
    /// Sign `entry` with `key` and produce the canonical envelope. Fails if the key does not
    /// match the chain's author - an entry signed by the wrong key should be unrepresentable.
    pub fn create(entry: &Entry, key: &SigningKey) -> Result<Self, ProtoError> {
        if entry.v != ENTRY_VERSION {
            return Err(ProtoError::UnsupportedVersion(u64::from(entry.v)));
        }
        if entry.chain.author != key.verifying_key().to_bytes() {
            return Err(ProtoError::BadEntry(
                "signing key does not match chain author",
            ));
        }
        if entry.timestamp_ms < 0 {
            return Err(ProtoError::BadEntry("negative timestamp"));
        }
        if let Payload::Inline(b) = &entry.payload {
            if b.len() > MAX_INLINE_PAYLOAD {
                return Err(ProtoError::BadEntry("inline payload exceeds size limit"));
            }
        }

        let body = encode_body(entry);
        let mut preimage = Vec::with_capacity(DOMAIN_ENTRY.len() + body.len());
        preimage.extend_from_slice(DOMAIN_ENTRY);
        preimage.extend_from_slice(&body);
        let sig = key.sign(&preimage).to_bytes();

        let mut w = Writer::new();
        w.array(2);
        w.bytes(&body);
        w.bytes(&sig);
        let envelope = w.into_bytes();

        // Decode our own output: a free round-trip self-check, and it derives the hash and body
        // range the same way every other holder of these bytes will.
        Self::decode(&envelope)
    }

    /// Strictly parse an envelope. Rejects non-canonical bytes outright; does NOT check the
    /// signature (see [`SignedEntry::verify`]).
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() > MAX_ENTRY_BYTES {
            return Err(ProtoError::BadEntry("entry exceeds size limit"));
        }
        let mut r = Reader::new(bytes);
        if r.array()? != 2 {
            return Err(ProtoError::BadEntry("envelope must be [body, sig]"));
        }
        let body = r.bytes()?;
        let body_len = body.len();
        let body_start = r.position() - body_len;
        let entry = decode_body(body)?;
        let sig = r.bytes_fixed::<SIG_LEN>()?;
        r.finish()?;

        Ok(Self {
            hash: *blake3::hash(bytes).as_bytes(),
            bytes: bytes.to_vec(),
            body_start,
            body_len,
            sig,
            entry,
        })
    }

    /// Verify the signature against the chain's author key, over the domain-separated preimage.
    /// Slices the received bytes; never re-serializes.
    pub fn verify(&self) -> Result<(), ProtoError> {
        let vk = VerifyingKey::from_bytes(&self.entry.chain.author)
            .map_err(|_| ProtoError::BadEntry("author is not a valid ed25519 public key"))?;
        let body = &self.bytes[self.body_start..self.body_start + self.body_len];
        let mut preimage = Vec::with_capacity(DOMAIN_ENTRY.len() + body.len());
        preimage.extend_from_slice(DOMAIN_ENTRY);
        preimage.extend_from_slice(body);
        vk.verify_strict(&preimage, &Signature::from_bytes(&self.sig))
            .map_err(|_| ProtoError::BadSignature)
    }

    pub fn entry(&self) -> &Entry {
        &self.entry
    }

    /// BLAKE3-256 of the envelope bytes: the hash that `prev_hash` links and anchors pin.
    pub fn hash(&self) -> &[u8; HASH_LEN] {
        &self.hash
    }

    /// The author's exact bytes - what gets stored and forwarded, never re-encoded.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn sig(&self) -> &[u8; SIG_LEN] {
        &self.sig
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::{entry_type, service};

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    fn test_entry(key: &SigningKey) -> Entry {
        Entry {
            v: ENTRY_VERSION,
            entry_type: entry_type::PROFILE_SET,
            chain: ChainId {
                author: key.verifying_key().to_bytes(),
                service: service::PROFILE,
            },
            seq: 0,
            prev_hash: ZERO_HASH,
            timestamp_ms: 1_700_000_000_000,
            payload: Payload::Inline(vec![0xa0]), // empty CBOR map
        }
    }

    #[test]
    fn create_decode_verify_round_trip() {
        let key = test_key();
        let entry = test_entry(&key);
        let signed = SignedEntry::create(&entry, &key).unwrap();

        let decoded = SignedEntry::decode(signed.bytes()).unwrap();
        assert_eq!(decoded.entry(), &entry);
        assert_eq!(decoded.hash(), signed.hash());
        decoded.verify().unwrap();
    }

    #[test]
    fn creation_is_deterministic() {
        let key = test_key();
        let entry = test_entry(&key);
        let a = SignedEntry::create(&entry, &key).unwrap();
        let b = SignedEntry::create(&entry, &key).unwrap();
        assert_eq!(a.bytes(), b.bytes());
        assert_eq!(a.hash(), b.hash());
    }

    #[test]
    fn tampered_payload_fails_verification() {
        let key = test_key();
        let mut entry = test_entry(&key);
        entry.payload = Payload::Inline(vec![0x44, 0xde, 0xad, 0xbe, 0xef]); // bstr(4) deadbeef
        let signed = SignedEntry::create(&entry, &key).unwrap();

        // Flip one payload byte in place; the envelope still parses (it's inside a bstr) but the
        // signature must fail.
        let mut bytes = signed.bytes().to_vec();
        let idx = bytes
            .windows(4)
            .position(|w| w == [0xde, 0xad, 0xbe, 0xef])
            .expect("payload bytes present");
        bytes[idx] ^= 0x01;

        let tampered = SignedEntry::decode(&bytes).unwrap();
        assert_eq!(tampered.verify(), Err(ProtoError::BadSignature));
        assert_ne!(
            tampered.hash(),
            signed.hash(),
            "hash must move with the bytes"
        );
    }

    #[test]
    fn signing_key_must_match_author() {
        let key = test_key();
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let mut entry = test_entry(&key);
        entry.chain.author = other.verifying_key().to_bytes();
        assert_eq!(
            SignedEntry::create(&entry, &key),
            Err(ProtoError::BadEntry(
                "signing key does not match chain author"
            ))
        );
    }

    #[test]
    fn unknown_body_keys_are_tolerated_and_signed() {
        // A "future" dialect adds key 7. Hand-assemble the body, sign it properly, and confirm a
        // v0 reader accepts the entry (skipping the field) and verifies the signature over the
        // original bytes.
        let key = test_key();
        let entry = test_entry(&key);

        let mut w = Writer::new();
        w.map(8);
        w.uint(0);
        w.uint(u64::from(entry.v));
        w.uint(1);
        w.uint(u64::from(entry.entry_type));
        w.uint(2);
        w.array(2);
        w.bytes(&entry.chain.author);
        w.uint(u64::from(entry.chain.service));
        w.uint(3);
        w.uint(entry.seq);
        w.uint(4);
        w.bytes(&entry.prev_hash);
        w.uint(5);
        w.uint(entry.timestamp_ms as u64);
        w.uint(6);
        w.array(2);
        w.uint(0);
        w.bytes(&[0xa0]);
        w.uint(7); // future field
        w.text("from the future");
        let body = w.into_bytes();

        let mut preimage = DOMAIN_ENTRY.to_vec();
        preimage.extend_from_slice(&body);
        let sig = key.sign(&preimage).to_bytes();

        let mut w = Writer::new();
        w.array(2);
        w.bytes(&body);
        w.bytes(&sig);
        let envelope = w.into_bytes();

        let decoded = SignedEntry::decode(&envelope).unwrap();
        assert_eq!(decoded.entry(), &entry);
        decoded.verify().unwrap();
    }

    #[test]
    fn out_of_order_body_keys_are_rejected() {
        // Same construction but keys 1 and 0 swapped.
        let key = test_key();
        let mut w = Writer::new();
        w.map(7);
        w.uint(1);
        w.uint(u64::from(entry_type::PROFILE_SET));
        w.uint(0);
        w.uint(0);
        // (remaining fields don't matter; the reader must bail at the order violation)
        let body = w.into_bytes();

        let mut wenv = Writer::new();
        wenv.array(2);
        wenv.bytes(&body);
        wenv.bytes(&[0u8; SIG_LEN]);
        let envelope = wenv.into_bytes();
        let _ = key;

        assert_eq!(
            SignedEntry::decode(&envelope),
            Err(ProtoError::NonCanonical("map keys not in ascending order"))
        );
    }

    #[test]
    fn unsupported_version_is_rejected() {
        let key = test_key();
        let mut entry = test_entry(&key);
        entry.v = 1;
        assert_eq!(
            SignedEntry::create(&entry, &key),
            Err(ProtoError::UnsupportedVersion(1))
        );
    }

    #[test]
    fn oversized_inline_payload_is_rejected() {
        let key = test_key();
        let mut entry = test_entry(&key);
        entry.payload = Payload::Inline(vec![0; MAX_INLINE_PAYLOAD + 1]);
        assert!(matches!(
            SignedEntry::create(&entry, &key),
            Err(ProtoError::BadEntry(_))
        ));
    }

    #[test]
    fn absurd_timestamps_are_rejected_on_decode() {
        // Hand-encode a body whose timestamp needs the full u64: the wire allows it, the entry
        // layer does not (every clock in the system is i64 ms - see the field doc).
        let key = test_key();
        let entry = test_entry(&key);
        let mut w = Writer::new();
        w.map(7);
        w.uint(0);
        w.uint(u64::from(entry.v));
        w.uint(1);
        w.uint(u64::from(entry.entry_type));
        w.uint(2);
        w.array(2);
        w.bytes(&entry.chain.author);
        w.uint(u64::from(entry.chain.service));
        w.uint(3);
        w.uint(entry.seq);
        w.uint(4);
        w.bytes(&entry.prev_hash);
        w.uint(5);
        w.uint(u64::MAX); // December 4, 292'277'026'596 is not a real deadline
        w.uint(6);
        w.array(2);
        w.uint(0);
        w.bytes(&[0xa0]);
        let body = w.into_bytes();

        let mut wenv = Writer::new();
        wenv.array(2);
        wenv.bytes(&body);
        wenv.bytes(&[0u8; SIG_LEN]);
        assert_eq!(
            SignedEntry::decode(&wenv.into_bytes()),
            Err(ProtoError::BadEntry("timestamp out of range"))
        );
    }

    #[test]
    fn negative_timestamps_are_unsignable() {
        let key = test_key();
        let mut entry = test_entry(&key);
        entry.timestamp_ms = -1;
        assert_eq!(
            SignedEntry::create(&entry, &key),
            Err(ProtoError::BadEntry("negative timestamp"))
        );
    }

    #[test]
    fn blob_payload_round_trips() {
        let key = test_key();
        let mut entry = test_entry(&key);
        entry.payload = Payload::Blob(*blake3::hash(b"some big content").as_bytes());
        let signed = SignedEntry::create(&entry, &key).unwrap();
        let decoded = SignedEntry::decode(signed.bytes()).unwrap();
        assert_eq!(decoded.entry().payload, entry.payload);
        decoded.verify().unwrap();
    }
}
