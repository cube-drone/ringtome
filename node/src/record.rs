//! The record: how a user's data is written, encrypted, versioned, and read back.
//!
//!   - [`imaol`]: the substrate - per-key, per-service signed hash chains (the IM-AOL).
//!   - [`private`]: the encryption seam - epoch keys, sealed boxes, private records.
//!   - [`documents`]: versioned documents on top - the merge DAG, twins/echoes, diff3.
//!   - [`store`]: the per-identity facade the HTTP layer talks to.

pub mod documents;
pub mod imaol;
pub mod private;
pub mod store;
