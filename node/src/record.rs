//! The record: how a user's data is written, encrypted, versioned, and read back.
//!
//!   - [`imaol`]: the substrate - per-key, per-service signed hash chains (the IM-AOL).
//!   - [`journal`]: the append-only raw-entry file that makes the whole database derived state.
//!   - [`private`]: the encryption seam - epoch keys, sealed boxes, private records.
//!   - [`documents`]: versioned documents on top - the merge DAG, twins/echoes, diff3.
//!   - [`store`]: the per-identity facade the HTTP layer talks to.

pub mod bake;
pub mod documents;
pub mod heads;
pub mod imaol;
pub mod journal;
pub mod private;
pub mod rank;
pub mod store;
