use thiserror::Error;

/// Everything that can go wrong between bytes and a validated entry. `PartialEq` so tests can
/// assert on exact failure modes - for a strict parser, *which* rejection fired is part of the
/// contract.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum ProtoError {
    /// Structurally invalid input (wrong major type, bad UTF-8, reserved values, subset
    /// violations like tags or floats).
    #[error("malformed input: {0}")]
    Malformed(&'static str),

    /// Well-formed CBOR that is not the one canonical encoding of its value (non-minimal heads,
    /// indefinite lengths, unsorted map keys, non-NFC text). Rejected outright: one logical
    /// value, exactly one accepted byte encoding.
    #[error("non-canonical encoding: {0}")]
    NonCanonical(&'static str),

    #[error("truncated input")]
    Truncated,

    #[error("trailing bytes after value")]
    TrailingBytes,

    #[error("nesting too deep")]
    TooDeep,

    /// The entry's version tag selects layout and algorithms; a version we don't know is a
    /// version we can't validate.
    #[error("unsupported entry version {0}")]
    UnsupportedVersion(u64),

    #[error("invalid signature")]
    BadSignature,

    /// Semantically invalid entry (bad field values, size limits, author/key mismatch).
    #[error("invalid entry: {0}")]
    BadEntry(&'static str),

    /// Valid entry, wrong place: sequence gaps, hash-link mismatches, cross-chain confusion.
    #[error("chain violation: {0}")]
    ChainViolation(&'static str),
}
