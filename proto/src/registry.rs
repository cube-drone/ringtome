//! The v0 type registry: service ids (which chain), entry-type ids (what statement), and the
//! payload codecs for the types this crate understands.
//!
//! Ids are added additively and never removed or repurposed. Old readers skip entry types they
//! don't know; the ids here are the vocabulary the version tag governs.

use crate::cbor::{Reader, Writer};
use crate::error::ProtoError;

/// Service ids: one chain per (key, service).
pub mod service {
    pub const IDENTITY_PUBLIC: u32 = 0;
    pub const IDENTITY_PRIVATE: u32 = 1;
    pub const PROFILE: u32 = 2;
    pub const POSTS: u32 = 3;
    pub const PUBLIC_FOLLOWS: u32 = 4;
    pub const PRIVATE: u32 = 5;

    pub fn name(id: u32) -> &'static str {
        match id {
            IDENTITY_PUBLIC => "identity-public",
            IDENTITY_PRIVATE => "identity-private",
            PROFILE => "profile",
            POSTS => "posts",
            PUBLIC_FOLLOWS => "public-follows",
            PRIVATE => "private",
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
    /// [`PrivatePlain`], readable only by members holding the epoch key).
    pub const PRIVATE_RECORD: u32 = 6;

    pub fn name(id: u32) -> &'static str {
        match id {
            AUTHORIZE => "authorize",
            REVOKE => "revoke",
            PROFILE_SET => "profile-set",
            POST => "post",
            KEY_EPOCH => "key-epoch",
            PRIVATE_RECORD => "private-record",
            _ => "unknown-type",
        }
    }
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
        let n = r.map()?;
        let mut last_key: Option<u64> = None;
        let mut child: Option<[u8; 32]> = None;
        let mut usurpers: Option<Vec<[u8; 32]>> = None;
        let mut enc_pubkey: Option<[u8; 32]> = None;
        for _ in 0..n {
            let key = r.uint()?;
            if let Some(prev) = last_key {
                if key <= prev {
                    return Err(ProtoError::NonCanonical("map keys not in ascending order"));
                }
            }
            last_key = Some(key);
            match key {
                0 => child = Some(r.bytes_fixed::<32>()?),
                1 => {
                    let len = r.array()?;
                    if len > Self::MAX_USURPERS as u64 {
                        return Err(ProtoError::BadEntry("usurper list too long"));
                    }
                    let mut list = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        list.push(r.bytes_fixed::<32>()?);
                    }
                    usurpers = Some(list);
                }
                2 => enc_pubkey = Some(r.bytes_fixed::<32>()?),
                _ => r.skip_value()?,
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
        let n = r.map()?;
        let mut last_key: Option<u64> = None;
        let mut epoch: Option<u64> = None;
        let mut recipients: Option<Vec<EpochRecipient>> = None;
        for _ in 0..n {
            let key = r.uint()?;
            if let Some(prev) = last_key {
                if key <= prev {
                    return Err(ProtoError::NonCanonical("map keys not in ascending order"));
                }
            }
            last_key = Some(key);
            match key {
                0 => epoch = Some(r.uint()?),
                1 => {
                    let len = r.array()?;
                    if len > Self::MAX_RECIPIENTS as u64 {
                        return Err(ProtoError::BadEntry("too many epoch recipients"));
                    }
                    let mut list = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        if r.array()? != 3 {
                            return Err(ProtoError::BadEntry(
                                "epoch recipient must be [leaf, enc_pub, box]",
                            ));
                        }
                        let leaf = r.bytes_fixed::<32>()?;
                        let enc_pub = r.bytes_fixed::<32>()?;
                        let sealed = r.bytes()?;
                        if sealed.len() > Self::MAX_BOX_BYTES {
                            return Err(ProtoError::BadEntry("epoch box too large"));
                        }
                        list.push((leaf, enc_pub, sealed.to_vec()));
                    }
                    recipients = Some(list);
                }
                _ => r.skip_value()?,
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
        let n = r.map()?;
        let mut last_key: Option<u64> = None;
        let (mut epoch, mut nonce, mut ciphertext) = (None, None, None);
        for _ in 0..n {
            let key = r.uint()?;
            if let Some(prev) = last_key {
                if key <= prev {
                    return Err(ProtoError::NonCanonical("map keys not in ascending order"));
                }
            }
            last_key = Some(key);
            match key {
                0 => epoch = Some(r.uint()?),
                1 => nonce = Some(r.bytes_fixed::<24>()?),
                2 => {
                    let ct = r.bytes()?;
                    if ct.len() > Self::MAX_CIPHERTEXT {
                        return Err(ProtoError::BadEntry("private record too large"));
                    }
                    ciphertext = Some(ct.to_vec());
                }
                _ => r.skip_value()?,
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
        let n = r.map()?;
        let mut last_key: Option<u64> = None;
        let (mut kind, mut collection, mut key_f, mut value) = (None, None, None, None);
        for _ in 0..n {
            let key = r.uint()?;
            if let Some(prev) = last_key {
                if key <= prev {
                    return Err(ProtoError::NonCanonical("map keys not in ascending order"));
                }
            }
            last_key = Some(key);
            match key {
                0 => {
                    kind = Some(match r.uint()? {
                        0 => PrivateKind::Register,
                        1 => PrivateKind::SetAdd,
                        2 => PrivateKind::SetRemove,
                        _ => return Err(ProtoError::BadEntry("unknown private record kind")),
                    })
                }
                1 => collection = Some(r.text()?.to_string()),
                2 => key_f = Some(r.text()?.to_string()),
                3 => value = Some(r.text()?.to_string()),
                _ => r.skip_value()?,
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
        let n = r.map()?;
        let mut last_key: Option<u64> = None;
        let mut target: Option<[u8; 32]> = None;
        let mut disposition: Option<Disposition> = None;
        let mut anchors: Option<Vec<Anchor>> = None;
        for _ in 0..n {
            let key = r.uint()?;
            if let Some(prev) = last_key {
                if key <= prev {
                    return Err(ProtoError::NonCanonical("map keys not in ascending order"));
                }
            }
            last_key = Some(key);
            match key {
                0 => target = Some(r.bytes_fixed::<32>()?),
                1 => {
                    disposition = Some(match r.uint()? {
                        0 => Disposition::Retirement,
                        1 => Disposition::Repudiation,
                        _ => return Err(ProtoError::BadEntry("unknown revocation disposition")),
                    })
                }
                2 => {
                    let len = r.array()?;
                    if len > Self::MAX_ANCHORS as u64 {
                        return Err(ProtoError::BadEntry("anchor list too long"));
                    }
                    let mut list = Vec::with_capacity(len as usize);
                    for _ in 0..len {
                        if r.array()? != 3 {
                            return Err(ProtoError::BadEntry(
                                "anchor must be [service, seq, head_hash]",
                            ));
                        }
                        let service = u32::try_from(r.uint()?)
                            .map_err(|_| ProtoError::BadEntry("service id out of range"))?;
                        let seq = r.uint()?;
                        let head_hash = r.bytes_fixed::<32>()?;
                        list.push(Anchor {
                            service,
                            seq,
                            head_hash,
                        });
                    }
                    anchors = Some(list);
                }
                _ => r.skip_value()?,
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
        let n = r.map()?;
        let mut last_key: Option<u64> = None;
        let mut field: Option<String> = None;
        let mut value: Option<String> = None;
        for _ in 0..n {
            let key = r.uint()?;
            if let Some(prev) = last_key {
                if key <= prev {
                    return Err(ProtoError::NonCanonical("map keys not in ascending order"));
                }
            }
            last_key = Some(key);
            match key {
                0 => field = Some(r.text()?.to_string()),
                1 => value = Some(r.text()?.to_string()),
                _ => r.skip_value()?,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(service::name(service::PROFILE), "profile");
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
                        service: service::PROFILE,
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
