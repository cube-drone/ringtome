//! Serving records: the discovery layer's protocol surface.
//!
//! A serving record is a small signed statement - "**this leaf key serves identity `root`,
//! reachable at iroh endpoint `endpoint_id`**" - published under the leaf key (pkarr on the
//! Mainline DHT in production; a shared-folder directory in local/test mode). It is a *pointer,
//! not an authority*: trust comes from the chain-to-root check at sync time, never from the
//! record (PROJECT_PLAN, Discovery Flow), so a stale or forged record costs a wasted connection
//! attempt, never a wrong answer. Records are deliberately tiny - pkarr budgets ~1000 bytes per
//! packet.
//!
//! Same envelope discipline as entries: `[body: bstr, sig: bstr(64)]`, signature over
//! `DOMAIN_SERVING_RECORD || body-bytes` by the leaf key named *inside* the body (key 2), so a
//! record is self-describing and verification never re-encodes. Body (integer-keyed map, keys
//! ascending, unknown keys above 4 skipped):
//!
//! | key | field       | encoding                                             |
//! |-----|-------------|------------------------------------------------------|
//! | 0   | v           | uint (= 0)                                           |
//! | 1   | root        | bstr(32) - the identity this record points at        |
//! | 2   | node_key    | bstr(32) - the signing leaf key (the record's owner) |
//! | 3   | endpoint_id | bstr(32) - iroh endpoint to dial                     |
//! | 4   | timestamp   | uint ms; freshness/replacement hint, ADVISORY        |

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;

pub const DOMAIN_SERVING_RECORD: &[u8] = b"ringtome-v0/serving-record";
pub const RECORD_VERSION: u16 = 0;
/// Hard cap well under pkarr's packet budget.
pub const MAX_RECORD_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServingRecord {
    pub v: u16,
    /// The identity being served.
    pub root: [u8; 32],
    /// The leaf key serving it - also the signer, and the key the record is published under.
    pub node_key: [u8; 32],
    /// The iroh endpoint to dial (transport identity; resolved to addresses by iroh's own
    /// discovery, or by an endpoint record in local mode).
    pub endpoint_id: [u8; 32],
    /// Publication time, ms since epoch. Replacement/freshness hint only - never a security
    /// input. (pkarr's own packet timestamps govern DHT replacement; this survives transports
    /// that lack one.)
    pub timestamp_ms: u64,
}

/// A serving record plus its exact signed bytes - what gets published and what gets verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedServingRecord {
    bytes: Vec<u8>,
    record: ServingRecord,
}

fn encode_body(r: &ServingRecord) -> Vec<u8> {
    let mut w = Writer::new();
    w.map(5);
    w.uint(0);
    w.uint(u64::from(r.v));
    w.uint(1);
    w.bytes(&r.root);
    w.uint(2);
    w.bytes(&r.node_key);
    w.uint(3);
    w.bytes(&r.endpoint_id);
    w.uint(4);
    w.uint(r.timestamp_ms);
    w.into_bytes()
}

fn decode_body(body: &[u8]) -> Result<ServingRecord, ProtoError> {
    let mut r = Reader::new(body);
    let n = r.map()?;
    let mut last_key: Option<u64> = None;
    let (mut v, mut root, mut node_key, mut endpoint_id, mut ts) = (None, None, None, None, None);
    for _ in 0..n {
        let key = r.uint()?;
        if let Some(prev) = last_key {
            if key <= prev {
                return Err(ProtoError::NonCanonical("map keys not in ascending order"));
            }
        }
        last_key = Some(key);
        match key {
            0 => v = Some(r.uint()?),
            1 => root = Some(r.bytes_fixed::<32>()?),
            2 => node_key = Some(r.bytes_fixed::<32>()?),
            3 => endpoint_id = Some(r.bytes_fixed::<32>()?),
            4 => ts = Some(r.uint()?),
            _ => r.skip_value()?,
        }
    }
    r.finish()?;

    let v = v.ok_or(ProtoError::BadEntry("missing version"))?;
    if v != u64::from(RECORD_VERSION) {
        return Err(ProtoError::UnsupportedVersion(v));
    }
    Ok(ServingRecord {
        v: RECORD_VERSION,
        root: root.ok_or(ProtoError::BadEntry("missing root"))?,
        node_key: node_key.ok_or(ProtoError::BadEntry("missing node key"))?,
        endpoint_id: endpoint_id.ok_or(ProtoError::BadEntry("missing endpoint id"))?,
        timestamp_ms: ts.ok_or(ProtoError::BadEntry("missing timestamp"))?,
    })
}

impl SignedServingRecord {
    /// Sign a record. The signing key must be the `node_key` named inside it.
    pub fn create(record: &ServingRecord, key: &SigningKey) -> Result<Self, ProtoError> {
        if record.v != RECORD_VERSION {
            return Err(ProtoError::UnsupportedVersion(u64::from(record.v)));
        }
        if record.node_key != key.verifying_key().to_bytes() {
            return Err(ProtoError::BadEntry(
                "signing key does not match record node_key",
            ));
        }
        let body = encode_body(record);
        let mut preimage = DOMAIN_SERVING_RECORD.to_vec();
        preimage.extend_from_slice(&body);
        let sig = key.sign(&preimage).to_bytes();

        let mut w = Writer::new();
        w.array(2);
        w.bytes(&body);
        w.bytes(&sig);
        Self::decode(&w.into_bytes())
    }

    /// Strict parse + signature verification in one step. Unlike entries (where structural
    /// admission and trust are separate questions), a record with a bad signature has no
    /// non-hostile interpretation, so decoding *is* verifying.
    pub fn decode(bytes: &[u8]) -> Result<Self, ProtoError> {
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(ProtoError::BadEntry("serving record exceeds size limit"));
        }
        let mut r = Reader::new(bytes);
        if r.array()? != 2 {
            return Err(ProtoError::BadEntry("record envelope must be [body, sig]"));
        }
        let body = r.bytes()?;
        let record = decode_body(body)?;
        let sig = r.bytes_fixed::<64>()?;
        r.finish()?;

        let vk = VerifyingKey::from_bytes(&record.node_key)
            .map_err(|_| ProtoError::BadEntry("node key is not a valid ed25519 public key"))?;
        let mut preimage = DOMAIN_SERVING_RECORD.to_vec();
        preimage.extend_from_slice(body);
        vk.verify_strict(&preimage, &Signature::from_bytes(&sig))
            .map_err(|_| ProtoError::BadSignature)?;

        Ok(Self {
            bytes: bytes.to_vec(),
            record,
        })
    }

    pub fn record(&self) -> &ServingRecord {
        &self.record
    }

    /// The exact signed bytes - what gets published, byte-for-byte.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(key: &SigningKey) -> ServingRecord {
        ServingRecord {
            v: RECORD_VERSION,
            root: [1u8; 32],
            node_key: key.verifying_key().to_bytes(),
            endpoint_id: [3u8; 32],
            timestamp_ms: 1_700_000_300_000,
        }
    }

    #[test]
    fn round_trips_and_verifies() {
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let record = sample(&key);
        let signed = SignedServingRecord::create(&record, &key).unwrap();
        let decoded = SignedServingRecord::decode(signed.bytes()).unwrap();
        assert_eq!(decoded.record(), &record);
        assert!(signed.bytes().len() < MAX_RECORD_BYTES);
    }

    #[test]
    fn wrong_signer_is_unrepresentable_and_tampering_is_caught() {
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let other = SigningKey::from_bytes(&[10u8; 32]);
        let record = sample(&key);
        assert!(SignedServingRecord::create(&record, &other).is_err());

        let signed = SignedServingRecord::create(&record, &key).unwrap();
        let mut bytes = signed.bytes().to_vec();
        // Flip a bit inside the root field (find its constant-filled run).
        let idx = bytes.windows(4).position(|w| w == [1, 1, 1, 1]).unwrap();
        bytes[idx] ^= 0xff;
        assert_eq!(
            SignedServingRecord::decode(&bytes),
            Err(ProtoError::BadSignature)
        );
    }

    #[test]
    fn unknown_future_fields_are_skipped() {
        // Hand-build a body with an extra key 5, sign it, and confirm a v0 reader accepts it.
        let key = SigningKey::from_bytes(&[9u8; 32]);
        let record = sample(&key);
        let mut w = Writer::new();
        w.map(6);
        w.uint(0);
        w.uint(0);
        w.uint(1);
        w.bytes(&record.root);
        w.uint(2);
        w.bytes(&record.node_key);
        w.uint(3);
        w.bytes(&record.endpoint_id);
        w.uint(4);
        w.uint(record.timestamp_ms);
        w.uint(5);
        w.text("future");
        let body = w.into_bytes();

        let mut preimage = DOMAIN_SERVING_RECORD.to_vec();
        preimage.extend_from_slice(&body);
        let sig = key.sign(&preimage).to_bytes();
        let mut env = Writer::new();
        env.array(2);
        env.bytes(&body);
        env.bytes(&sig);

        let decoded = SignedServingRecord::decode(&env.into_bytes()).unwrap();
        assert_eq!(decoded.record(), &record);
    }
}
