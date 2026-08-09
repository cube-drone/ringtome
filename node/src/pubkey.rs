//! Hex-encoded 32-byte public keys - the form every key takes in URLs, JSON bodies, and
//! database columns - parsed back into the `[u8; 32]` the proto layer speaks.
//!
//! Two entry points for two failure contexts: [`decode`] for callers that own their error
//! (a corrupt storage row is not a bad request), [`require`] for request boundaries, where
//! rejection is a uniform `bad {what}` naming the offending field.

use crate::error::AppError;

/// Parse 64 hex chars into a 32-byte key. `None` on anything else.
pub fn decode(hex_str: &str) -> Option<[u8; 32]> {
    hex::decode(hex_str).ok()?.try_into().ok()
}

/// Parse a key arriving at a request boundary, rejecting with a uniform message naming the
/// offending field ("bad root pubkey", "bad leaf pubkey in request code", ...).
pub fn require(hex_str: &str, what: &str) -> Result<[u8; 32], AppError> {
    decode(hex_str).ok_or_else(|| AppError::BadRequest(crate::msg!("pubkey.bad-what", "bad {what}", what = what)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_exactly_32_hex_bytes() {
        let good = "ab".repeat(32);
        assert_eq!(decode(&good), Some([0xab; 32]));

        for bad in ["", "abcd", &"ab".repeat(33), &"zz".repeat(32)] {
            assert_eq!(decode(bad), None, "should reject {bad:?}");
        }
    }

    #[test]
    fn require_names_the_field() {
        let err = require("nope", "target pubkey").unwrap_err();
        assert!(matches!(err, AppError::BadRequest(m) if m.english == "bad target pubkey"));
    }
}
