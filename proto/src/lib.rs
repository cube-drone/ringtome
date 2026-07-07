//! ringtome-proto: the Ringtome protocol layer.
//!
//! Canonical bytes, hashing, signing, and chain validation for the Identity-Managed Append-Only
//! Log (IM-AOL). This crate is the conformance boundary: everything a second implementation must
//! reproduce bit-for-bit lives here, and nothing else does. It is deliberately free of async
//! runtimes, storage, HTTP, and clocks - every function is values in, `Result` out. Keep it that
//! way: if entry validation ever depends on node state, independent implementations stop being
//! possible.
//!
//! The companion artifacts are the published test vectors in `spec/test-vectors/` - "this logical
//! entry MUST produce exactly these bytes, this hash, this signature." They are the conformance
//! boundary for other implementations and the regression tripwire for this one.

mod cbor;
mod chain;
mod entry;
mod error;
pub mod keytree;
pub mod registry;

pub use chain::validate_next;
pub use entry::{
    ChainId, Entry, Payload, SignedEntry, DOMAIN_ENTRY, ENTRY_VERSION, HASH_LEN, MAX_ENTRY_BYTES,
    MAX_INLINE_PAYLOAD, SIG_LEN, ZERO_HASH,
};
pub use error::ProtoError;
pub use keytree::{Ceiling, KeyStatus, KeyTree};
pub use registry::{Anchor, Authorize, Disposition, ProfileSet, Revoke};

// Re-export the key types the public API takes, so consumers use the exact same ed25519-dalek
// the signatures were made with.
pub use ed25519_dalek::{SigningKey, VerifyingKey};
