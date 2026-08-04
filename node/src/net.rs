//! The wire: how nodes find each other and move records and blobs between themselves.
//!
//!   - [`p2p`]: the iroh endpoint - transport identity, ALPNs, the accept loop.
//!   - [`sync`]: chain exchange between nodes agenting the same identity.
//!   - [`frontier`]: the node's map of what it holds of each persona's PUBLIC lane, as one
//!     fingerprint per (persona, service) - the sweep behind fan-out.
//!   - [`resync`]: when to run that exchange unprompted - eager push + anti-entropy.
//!   - [`discovery`]: publish/resolve of serving + endpoint records (off / local / mainline DHT).
//!   - [`unfurl`]: outbound OpenGraph fetches for the browser's turbolinks (SSRF-guarded,
//!     globally rate-limited, cached).

pub mod adopt;
pub mod discovery;
pub mod frontier;
pub mod p2p;
pub mod resync;
pub mod sync;
pub mod unfurl;
