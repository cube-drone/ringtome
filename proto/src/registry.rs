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

    pub fn name(id: u32) -> &'static str {
        match id {
            AUTHORIZE => "authorize",
            REVOKE => "revoke",
            PROFILE_SET => "profile-set",
            POST => "post",
            _ => "unknown-type",
        }
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
}
