//! The speakable identicon (PROJECT_PLAN, Naming): a root pubkey rendered for human
//! transport - `sway-broke-AwTy…` - two checksum words from the key's blake3, then the key
//! in base58btc. Twin of `js/pure/speakable.js`; the shared goldens (here and in
//! `integration/test/pure/speakable.cjs`) pin both languages to identical output, the entry
//! format's vector discipline at miniature scale. The wordlist (`wordlist/eff_short_1.txt`)
//! is a WIRE FORMAT - words are addressed by index; never reorder, never remove.
//!
//! The words are recognition and checksum, never authority: grinding a colliding pair costs
//! an attacker minutes, so nothing may ever trust them for more than "did this paste arrive
//! whole" and "is this the friend I remember".

use std::sync::LazyLock;

const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

static WORDS: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let words: Vec<&'static str> = include_str!("../wordlist/eff_short_1.txt")
        .split_ascii_whitespace()
        .collect();
    assert_eq!(words.len(), 1296, "the pinned wordlist is exactly the EFF short list");
    words
});

/// The two checksum words: the hash's first two 4-byte windows, big-endian, mod the list
/// (32-bit windows so the bias over 1296 is a rounding error).
fn words_for(root: &[u8; 32]) -> (&'static str, &'static str) {
    let h = blake3::hash(root);
    let h = h.as_bytes();
    let pick = |o: usize| {
        let n = u32::from_be_bytes([h[o], h[o + 1], h[o + 2], h[o + 3]]);
        WORDS[(n as usize) % WORDS.len()]
    };
    (pick(0), pick(4))
}

/// 32 bytes to base58btc - leading zero bytes become leading '1's, per the convention.
fn to_base58(bytes: &[u8; 32]) -> String {
    let mut digits: Vec<u8> = Vec::new(); // little-endian base58 digits
    for &byte in bytes {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|&&b| b == 0).count();
    let mut out = String::with_capacity(zeros + digits.len());
    out.extend(std::iter::repeat_n('1', zeros));
    out.extend(digits.iter().rev().map(|&d| B58[d as usize] as char));
    out
}

/// The canonical mint: `word-word-<base58>`.
pub fn speakable(root: &[u8; 32]) -> String {
    let (a, b) = words_for(root);
    format!("{a}-{b}-{}", to_base58(root))
}

/// What a candidate `/id/` segment turned out to be.
#[derive(Debug, PartialEq)]
pub enum Parsed {
    /// A root, by any accepted spelling (worded-and-verified, bare base58, or hex).
    Ok([u8; 32]),
    /// The key decoded but the words LIED: refused, with the true words in hand so the
    /// refusal can say "did you mean". The root is what the key claims - never to be used
    /// without the loud warning.
    Mismatch { root: [u8; 32], expected: String },
}

/// Lowercase-hex-64 to 32 bytes, or None.
fn decode_hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// A node endpoint key dressed for a URL: base58 (44 chars against hex's 64). Node keys get
/// the denser coat but no words - their audience is nodes, and URL length is the only human
/// cost (the `?via=` list widened to ten keys for exactly this reason, 2026-08-02).
pub fn node_key_b58(hex: &str) -> Option<String> {
    decode_hex32(hex).map(|b| to_base58(&b))
}

/// A `?via=` element back to the hex form iroh parses - base58, or the hex escape hatch
/// (older minted URLs and hand-typed keys keep working forever).
pub fn node_key_from_via(s: &str) -> Option<String> {
    let s = s.trim();
    if decode_hex32(s).is_some() {
        return Some(s.to_string());
    }
    from_base58(s).map(hex::encode)
}

/// Parse an `/id/` path segment: worded form (checksum VERIFIED - a mismatch refuses rather
/// than shrugging, or the words train everyone to ignore them), bare base58, or the hex
/// escape hatch. None: not an address in any spelling.
pub fn parse(segment: &str) -> Option<Parsed> {
    let s = segment.trim();
    if let Some(root) = decode_hex32(s) {
        return Some(Parsed::Ok(root));
    }
    let parts: Vec<&str> = s.split('-').collect();
    match parts.as_slice() {
        [bare] => key_from_base58(bare).map(Parsed::Ok),
        [a, b, key] => {
            let root = key_from_base58(key)?;
            let (ea, eb) = words_for(&root);
            if *a == ea && *b == eb {
                Some(Parsed::Ok(root))
            } else {
                Some(Parsed::Mismatch {
                    root,
                    expected: format!("{ea}-{eb}"),
                })
            }
        }
        _ => None,
    }
}

/// A base58 KEY, strictly: it must round-trip - decode then re-encode equals the input -
/// because an address's key is only ever minted by `to_base58`, so anything canonical
/// round-trips and anything partial cannot. `from_base58` below stays a faithful, lenient
/// decoder (the `?via=` hint path keeps it - hints are dirty by doctrine and the resolution
/// ladder validates them), but an ADDRESS left-padded from a fragment is a phantom: the JS
/// twin's People lookup teleported a single typed "y" to the near-zero root
/// apple-fifth-1111…1y (found live, 2026-08-24), and this door is the same door.
fn key_from_base58(s: &str) -> Option<[u8; 32]> {
    let root = from_base58(s)?;
    (to_base58(&root) == s).then_some(root)
}

/// Base58 back to 32 bytes, or None if the string isn't clean base58 for exactly that size.
fn from_base58(s: &str) -> Option<[u8; 32]> {
    if s.is_empty() || s.len() > 45 {
        return None;
    }
    let mut bytes: Vec<u8> = Vec::new(); // little-endian value bytes
    for c in s.bytes() {
        let v = B58.iter().position(|&b| b == c)? as u32;
        let mut carry = v;
        for byte in bytes.iter_mut() {
            carry += (*byte as u32) * 58;
            *byte = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&b| b == b'1').count();
    bytes.extend(std::iter::repeat_n(0u8, zeros));
    // Exactly thirty-two bytes, leading '1's counted as the zero bytes they encode - never
    // padded up from a short string (2026-09-05: the word "undefined", every character of
    // it a base58 digit, decoded to a bogus key that a page then minted into addresses).
    if bytes.len() != 32 {
        return None;
    }
    bytes.reverse();
    Some(bytes.try_into().expect("resized to 32"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_short_base58_string_is_not_a_key() {
        assert!(from_base58("undefined").is_none(), "padding a short string up to a key is a forgery of a key");
        assert!(from_base58("").is_none());
        let key = [0x11u8; 32];
        assert_eq!(from_base58(&to_base58(&key)), Some(key), "a real key still round-trips");
        let mut leading = [0u8; 32];
        leading[31] = 7;
        assert_eq!(from_base58(&to_base58(&leading)), Some(leading), "leading zero bytes ride as '1's");
    }

    use super::*;

    /// The cross-language goldens - identical strings pinned in
    /// integration/test/pure/speakable.cjs. Drift on either side fails before an address does.
    const GOLDENS: [(&str, &str); 3] = [
        (
            "93ad0ddd9dd2022bf2ac21664b386965e0eeffecaff6e49b71039db5f1cf53f3",
            "sway-broke-AwTyvw9SPjfiJ4xvMfwDKZeHQH6N1mw3LQtoYtJNPfqU",
        ),
        (
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "tulip-brick-CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB",
        ),
        (
            "0000000000000000000000000000000000000000000000000000000000000001",
            "goal-sneak-11111111111111111111111111111112",
        ),
    ];

    fn root(hex: &str) -> [u8; 32] {
        let mut out = [0u8; 32];
        for (i, byte) in out.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    #[test]
    fn mints_the_goldens_exactly() {
        for (hex, addr) in GOLDENS {
            assert_eq!(speakable(&root(hex)), addr, "golden for {hex}");
        }
    }

    #[test]
    fn base58_round_trips_including_leading_zeros() {
        for (hex, addr) in GOLDENS {
            let key = addr.rsplit('-').next().unwrap();
            assert_eq!(from_base58(key), Some(root(hex)));
        }
        assert_eq!(from_base58("0OIl"), None, "confusables are not in the alphabet");
        assert_eq!(from_base58(&"z".repeat(60)), None, "overlong refuses");
    }

    /// The strict key rule, in lockstep with the JS twin's spec (pure/speakable.cjs): a
    /// partial base58 string is typing, not an address - `from_base58` left-pads, so "y"
    /// decoded as the near-zero root until parse demanded the round-trip.
    #[test]
    fn a_partial_key_is_typing_not_an_address() {
        assert!(parse("y").is_none());
        assert!(parse("yy").is_none());
        assert!(parse("apple-fifth-y").is_none(), "a short key never earns 'did you mean'");
        let root = [0xab; 32];
        let key = to_base58(&root);
        assert!(matches!(parse(&key), Some(Parsed::Ok(r)) if r == root));
        assert!(
            matches!(parse(&format!("wrong-words-{key}")), Some(Parsed::Mismatch { root: r, .. }) if r == root),
            "lying words over a full key still get the truth"
        );
    }

    #[test]
    fn parses_every_spelling_and_refuses_the_lie() {
        let (hex, addr) = GOLDENS[0];
        let r = root(hex);
        assert_eq!(parse(addr), Some(Parsed::Ok(r)), "worded");
        assert_eq!(parse(addr.rsplit('-').next().unwrap()), Some(Parsed::Ok(r)), "bare base58");
        assert_eq!(parse(hex), Some(Parsed::Ok(r)), "the hex escape hatch");
        let key = addr.rsplit('-').next().unwrap();
        assert_eq!(
            parse(&format!("pagoda-dimension-{key}")),
            Some(Parsed::Mismatch { root: r, expected: "sway-broke".into() }),
            "wrong words refuse, with the truth in hand"
        );
        assert_eq!(parse("pagoda-dimension"), None, "words with no key");
        assert_eq!(parse("a-b-c-d"), None, "too many parts");
        assert_eq!(parse(""), None);
    }

    #[test]
    fn the_wordlist_is_pinned() {
        assert_eq!(WORDS.len(), 1296);
        assert_eq!(WORDS[1285], "yonder", "the yo-yo slot's amendment");
        assert!(WORDS.iter().all(|w| w.bytes().all(|b| b.is_ascii_lowercase())));
    }
}
