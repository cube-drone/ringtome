//! Deterministic CBOR: a strict, minimal subset of RFC 8949.
//!
//! Ringtome entries are encoded in the deterministic profile of CBOR (RFC 8949 §4.2):
//! shortest-form integer heads, definite lengths only, map keys in ascending order,
//! NFC-normalized text. This module is hand-rolled rather than a library binding, deliberately:
//!
//! - **The encoder is the spec.** The published test vectors promise exact bytes; hiding byte
//!   layout inside a dependency's derive macro would make the spec "whatever the library does."
//! - **The reader is strict.** Off-the-shelf decoders accept non-canonical input; we *reject* it,
//!   so a logical value has exactly one accepted byte representation. Entries are hostile input
//!   from the network - two byte-different encodings of "the same" entry are two different entry
//!   hashes, and a lenient reader is how that becomes a forgery or split-brain bug.
//!
//! The v0 subset: unsigned integers (major 0), byte strings (major 2), text strings (major 3),
//! arrays (major 4), maps (major 5). Negative integers are tolerated when skipping unknown
//! fields; tags, floats, and simple values (majors 6-7) are rejected outright. Nesting is
//! depth-limited because hostile input gets no benefit of the doubt.
//!
//! This module is only the byte grammar. The types built on it narrow *value domains* further -
//! timestamps must fit in `i64`, payloads and lists have size caps - and those rules live with
//! the consuming type (`entry`, `registry`, ...). A conforming implementation applies both
//! layers; passing the byte grammar alone does not make an entry acceptable.

use unicode_normalization::{is_nfc, UnicodeNormalization};

use crate::error::ProtoError;

/// Maximum nesting depth the reader will follow while skipping unknown values. Entries are
/// shallow (envelope -> body -> payload); anything deeper is an attack or a bug.
const MAX_DEPTH: u32 = 16;

const MAJOR_UINT: u8 = 0;
const MAJOR_NEGINT: u8 = 1;
const MAJOR_BYTES: u8 = 2;
const MAJOR_TEXT: u8 = 3;
const MAJOR_ARRAY: u8 = 4;
const MAJOR_MAP: u8 = 5;

// ------------------------------------------------------------------------------------------
// Writer

/// Canonical CBOR writer. Every emit is shortest-form and definite-length by construction.
#[derive(Default)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    /// Emit a head: 3-bit major type + shortest-form argument (RFC 8949 §4.2.1).
    fn head(&mut self, major: u8, arg: u64) {
        let m = major << 5;
        if arg < 24 {
            self.buf.push(m | arg as u8);
        } else if arg <= 0xff {
            self.buf.push(m | 24);
            self.buf.push(arg as u8);
        } else if arg <= 0xffff {
            self.buf.push(m | 25);
            self.buf.extend_from_slice(&(arg as u16).to_be_bytes());
        } else if arg <= 0xffff_ffff {
            self.buf.push(m | 26);
            self.buf.extend_from_slice(&(arg as u32).to_be_bytes());
        } else {
            self.buf.push(m | 27);
            self.buf.extend_from_slice(&arg.to_be_bytes());
        }
    }

    pub fn uint(&mut self, v: u64) {
        self.head(MAJOR_UINT, v);
    }

    pub fn bytes(&mut self, b: &[u8]) {
        self.head(MAJOR_BYTES, b.len() as u64);
        self.buf.extend_from_slice(b);
    }

    /// Text is NFC-normalized before encoding, so "the same" string is never two different byte
    /// sequences (see PROJECT_PLAN, Canonical Encoding).
    pub fn text(&mut self, s: &str) {
        if is_nfc(s) {
            self.head(MAJOR_TEXT, s.len() as u64);
            self.buf.extend_from_slice(s.as_bytes());
        } else {
            let normalized: String = s.nfc().collect();
            self.head(MAJOR_TEXT, normalized.len() as u64);
            self.buf.extend_from_slice(normalized.as_bytes());
        }
    }

    pub fn array(&mut self, len: u64) {
        self.head(MAJOR_ARRAY, len);
    }

    pub fn map(&mut self, len: u64) {
        self.head(MAJOR_MAP, len);
    }
}

// ------------------------------------------------------------------------------------------
// Reader

/// Strict canonical reader: rejects any byte sequence the `Writer` could not have produced.
pub struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    /// Current offset into the input. Used by callers that need the byte range of a value they
    /// just read (e.g. locating the signed body inside an envelope).
    pub fn position(&self) -> usize {
        self.pos
    }

    fn byte(&mut self) -> Result<u8, ProtoError> {
        let b = *self.data.get(self.pos).ok_or(ProtoError::Truncated)?;
        self.pos += 1;
        Ok(b)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], ProtoError> {
        let end = self.pos.checked_add(n).ok_or(ProtoError::Truncated)?;
        if end > self.data.len() {
            return Err(ProtoError::Truncated);
        }
        let s = &self.data[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    /// Read a head, enforcing shortest-form arguments and definite lengths.
    fn head(&mut self) -> Result<(u8, u64), ProtoError> {
        let b = self.byte()?;
        let major = b >> 5;
        let ai = b & 0x1f;
        let arg = match ai {
            0..=23 => u64::from(ai),
            24 => {
                let v = u64::from(self.byte()?);
                if v < 24 {
                    return Err(ProtoError::NonCanonical("non-minimal integer head"));
                }
                v
            }
            25 => {
                let v = u64::from(u16::from_be_bytes(self.take(2)?.try_into().unwrap()));
                if v <= 0xff {
                    return Err(ProtoError::NonCanonical("non-minimal integer head"));
                }
                v
            }
            26 => {
                let v = u64::from(u32::from_be_bytes(self.take(4)?.try_into().unwrap()));
                if v <= 0xffff {
                    return Err(ProtoError::NonCanonical("non-minimal integer head"));
                }
                v
            }
            27 => {
                let v = u64::from_be_bytes(self.take(8)?.try_into().unwrap());
                if v <= 0xffff_ffff {
                    return Err(ProtoError::NonCanonical("non-minimal integer head"));
                }
                v
            }
            28..=30 => return Err(ProtoError::Malformed("reserved additional-info value")),
            _ => return Err(ProtoError::NonCanonical("indefinite-length item")),
        };
        Ok((major, arg))
    }

    fn expect(&mut self, major: u8, what: &'static str) -> Result<u64, ProtoError> {
        let (m, arg) = self.head()?;
        if m != major {
            return Err(ProtoError::Malformed(what));
        }
        Ok(arg)
    }

    pub fn uint(&mut self) -> Result<u64, ProtoError> {
        self.expect(MAJOR_UINT, "expected unsigned integer")
    }

    pub fn bytes(&mut self) -> Result<&'a [u8], ProtoError> {
        let len = self.expect(MAJOR_BYTES, "expected byte string")?;
        self.take(usize::try_from(len).map_err(|_| ProtoError::Truncated)?)
    }

    pub fn bytes_fixed<const N: usize>(&mut self) -> Result<[u8; N], ProtoError> {
        let b = self.bytes()?;
        b.try_into()
            .map_err(|_| ProtoError::Malformed("byte string of unexpected length"))
    }

    pub fn text(&mut self) -> Result<&'a str, ProtoError> {
        let len = self.expect(MAJOR_TEXT, "expected text string")?;
        let raw = self.take(usize::try_from(len).map_err(|_| ProtoError::Truncated)?)?;
        Self::check_text(raw)
    }

    fn check_text(raw: &[u8]) -> Result<&str, ProtoError> {
        let s = core::str::from_utf8(raw).map_err(|_| ProtoError::Malformed("invalid UTF-8"))?;
        if !is_nfc(s) {
            return Err(ProtoError::NonCanonical("text is not NFC-normalized"));
        }
        Ok(s)
    }

    pub fn array(&mut self) -> Result<u64, ProtoError> {
        self.expect(MAJOR_ARRAY, "expected array")
    }

    pub fn map(&mut self) -> Result<u64, ProtoError> {
        self.expect(MAJOR_MAP, "expected map")
    }

    /// Skip one value of any supported shape - this is what makes unknown-field carry-through
    /// safe. Canonicality is still enforced along the way (including ascending map-key order in
    /// nested maps), so "unknown" never becomes a loophole for non-canonical bytes.
    pub fn skip_value(&mut self) -> Result<(), ProtoError> {
        self.skip_at_depth(0)
    }

    fn skip_at_depth(&mut self, depth: u32) -> Result<(), ProtoError> {
        if depth > MAX_DEPTH {
            return Err(ProtoError::TooDeep);
        }
        let (major, arg) = self.head()?;
        match major {
            MAJOR_UINT | MAJOR_NEGINT => Ok(()),
            MAJOR_BYTES => {
                self.take(usize::try_from(arg).map_err(|_| ProtoError::Truncated)?)?;
                Ok(())
            }
            MAJOR_TEXT => {
                let raw = self.take(usize::try_from(arg).map_err(|_| ProtoError::Truncated)?)?;
                Self::check_text(raw)?;
                Ok(())
            }
            MAJOR_ARRAY => {
                for _ in 0..arg {
                    self.skip_at_depth(depth + 1)?;
                }
                Ok(())
            }
            MAJOR_MAP => {
                let data = self.data;
                let mut prev_key: Option<&[u8]> = None;
                for _ in 0..arg {
                    // Canonical order is bytewise-lexicographic over the *encoded* keys
                    // (RFC 8949 §4.2.1); for shortest-form uints that coincides with numeric
                    // order.
                    let key_start = self.pos;
                    self.skip_at_depth(depth + 1)?;
                    let key = &data[key_start..self.pos];
                    if let Some(prev) = prev_key {
                        if key <= prev {
                            return Err(ProtoError::NonCanonical(
                                "map keys not in ascending order",
                            ));
                        }
                    }
                    prev_key = Some(key);
                    self.skip_at_depth(depth + 1)?;
                }
                Ok(())
            }
            _ => Err(ProtoError::Malformed(
                "tags, floats, and simple values are outside the v0 subset",
            )),
        }
    }

    /// Assert the input is fully consumed - a value with trailing bytes is not that value.
    pub fn finish(self) -> Result<(), ProtoError> {
        if self.pos == self.data.len() {
            Ok(())
        } else {
            Err(ProtoError::TrailingBytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_uint(v: u64) -> Vec<u8> {
        let mut w = Writer::new();
        w.uint(v);
        w.into_bytes()
    }

    #[test]
    fn uint_heads_are_shortest_form_at_boundaries() {
        assert_eq!(write_uint(0), [0x00]);
        assert_eq!(write_uint(23), [0x17]);
        assert_eq!(write_uint(24), [0x18, 24]);
        assert_eq!(write_uint(255), [0x18, 0xff]);
        assert_eq!(write_uint(256), [0x19, 0x01, 0x00]);
        assert_eq!(write_uint(65535), [0x19, 0xff, 0xff]);
        assert_eq!(write_uint(65536), [0x1a, 0x00, 0x01, 0x00, 0x00]);
        assert_eq!(write_uint(u64::from(u32::MAX)).len(), 5);
        assert_eq!(write_uint(u64::from(u32::MAX) + 1).len(), 9);
    }

    #[test]
    fn round_trips() {
        for v in [
            0u64,
            23,
            24,
            255,
            256,
            65535,
            65536,
            u64::from(u32::MAX) + 1,
            u64::MAX,
        ] {
            let bytes = write_uint(v);
            let mut r = Reader::new(&bytes);
            assert_eq!(r.uint().unwrap(), v);
            r.finish().unwrap();
        }
    }

    #[test]
    fn rejects_non_minimal_heads() {
        // 23 encoded with a one-byte argument instead of packed into the head.
        let mut r = Reader::new(&[0x18, 0x17]);
        assert_eq!(
            r.uint(),
            Err(ProtoError::NonCanonical("non-minimal integer head"))
        );
        // 255 encoded as two bytes.
        let mut r = Reader::new(&[0x19, 0x00, 0xff]);
        assert_eq!(
            r.uint(),
            Err(ProtoError::NonCanonical("non-minimal integer head"))
        );
        // 65535 encoded as four bytes.
        let mut r = Reader::new(&[0x1a, 0x00, 0x00, 0xff, 0xff]);
        assert_eq!(
            r.uint(),
            Err(ProtoError::NonCanonical("non-minimal integer head"))
        );
    }

    #[test]
    fn rejects_indefinite_lengths() {
        let mut r = Reader::new(&[0x5f]); // indefinite-length byte string
        assert_eq!(
            r.bytes(),
            Err(ProtoError::NonCanonical("indefinite-length item"))
        );
        let mut r = Reader::new(&[0x9f]); // indefinite-length array
        assert_eq!(
            r.array(),
            Err(ProtoError::NonCanonical("indefinite-length item"))
        );
    }

    #[test]
    fn rejects_majors_outside_subset() {
        let mut r = Reader::new(&[0xc0, 0x00]); // tag 0
        assert!(matches!(r.skip_value(), Err(ProtoError::Malformed(_))));
        let mut r = Reader::new(&[0xf9, 0x3c, 0x00]); // float16 1.0
        assert!(matches!(r.skip_value(), Err(ProtoError::Malformed(_))));
        let mut r = Reader::new(&[0xf5]); // simple value `true`
        assert!(matches!(r.skip_value(), Err(ProtoError::Malformed(_))));
    }

    #[test]
    fn text_is_nfc_normalized_on_write_and_enforced_on_read() {
        // "é" decomposed (e + combining acute) normalizes to the composed form on write.
        let mut w = Writer::new();
        w.text("e\u{0301}");
        let bytes = w.into_bytes();
        assert_eq!(bytes, [0x62, 0xc3, 0xa9]); // text(2) "é" composed

        let mut r = Reader::new(&bytes);
        assert_eq!(r.text().unwrap(), "\u{e9}");

        // The decomposed encoding itself is rejected on read.
        let decomposed = [0x63, 0x65, 0xcc, 0x81];
        let mut r = Reader::new(&decomposed);
        assert_eq!(
            r.text(),
            Err(ProtoError::NonCanonical("text is not NFC-normalized"))
        );
    }

    #[test]
    fn rejects_trailing_bytes() {
        let r = {
            let mut r = Reader::new(&[0x01, 0x02]);
            r.uint().unwrap();
            r
        };
        assert_eq!(r.finish(), Err(ProtoError::TrailingBytes));
    }

    #[test]
    fn skip_enforces_nested_map_key_order() {
        // {1: 0, 0: 0} - keys out of order inside a skipped value.
        let bad = [0xa2, 0x01, 0x00, 0x00, 0x00];
        let mut r = Reader::new(&bad);
        assert_eq!(
            r.skip_value(),
            Err(ProtoError::NonCanonical("map keys not in ascending order"))
        );
        // Duplicate keys are equally non-canonical.
        let dup = [0xa2, 0x00, 0x00, 0x00, 0x01];
        let mut r = Reader::new(&dup);
        assert_eq!(
            r.skip_value(),
            Err(ProtoError::NonCanonical("map keys not in ascending order"))
        );
    }

    #[test]
    fn skip_depth_is_bounded() {
        // 40 nested single-element arrays.
        let mut bytes = vec![0x81u8; 40];
        bytes.push(0x00);
        let mut r = Reader::new(&bytes);
        assert_eq!(r.skip_value(), Err(ProtoError::TooDeep));
    }

    #[test]
    fn truncated_inputs_error_cleanly() {
        for bad in [
            &[0x18][..],
            &[0x19, 0x01][..],
            &[0x58, 0x05, 0x01][..],
            &[0x82, 0x00][..],
        ] {
            let mut r = Reader::new(bad);
            assert!(r.skip_value().is_err());
        }
    }
}
