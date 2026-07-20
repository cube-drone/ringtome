//! The wire: how nodes find each other and move records and blobs between themselves.
//!
//!   - [`p2p`]: the iroh endpoint - transport identity, ALPNs, the accept loop.
//!   - [`sync`]: chain exchange between nodes agenting the same identity.
//!   - [`discovery`]: publish/resolve of serving + endpoint records (off / local / mainline DHT).

pub mod discovery;
pub mod p2p;
pub mod sync;
