//! The wire: how nodes find each other and move records and blobs between themselves.
//!
//!   - [`p2p`]: the iroh endpoint - transport identity, ALPNs, the accept loop.
//!   - [`sync`]: chain exchange between nodes agenting the same identity.
//!   - [`demand`]: who has asked this node about which persona - the fan-out address list.
//!   - [`frontier`]: the node's map of what it holds of each persona's PUBLIC lane, as one
//!     fingerprint per (persona, service) - the sweep behind fan-out.
//!   - [`subscriptions`]: the node's memo of who follows and (publicly) trusts whom, derived
//!     from the personas' own contact ledgers - what routing needs, asked across personas.
//!   - [`resync`]: when to run that exchange unprompted - eager push + anti-entropy.
//!   - [`discovery`]: publish/resolve of serving + endpoint records (off / local / mainline DHT).
//!   - [`unfurl`]: outbound OpenGraph fetches for the browser's turbolinks (SSRF-guarded,
//!     globally rate-limited, cached).

/// A network wait a person may be sitting through (2026-10-03): past a second, it is named in the
/// log - what was asked for, of whom, how long, and how it ended (`outcome` reads the answer) -
/// so a slow page that waited on the network is not mistaken for one that waited on the
/// database. Background work uses it too; the line says which by what it asked for.
pub(crate) async fn waited<T>(
    what: &'static str,
    whom: &str,
    work: impl std::future::Future<Output = T>,
    outcome: impl FnOnce(&T) -> &'static str,
) -> T {
    let started = std::time::Instant::now();
    let answer = work.await;
    let took = started.elapsed();
    if took >= std::time::Duration::from_secs(1) {
        tracing::info!(
            what,
            whom,
            took_ms = took.as_millis() as u64,
            outcome = outcome(&answer),
            "slow network wait"
        );
    }
    answer
}

pub mod admission;
pub mod adopt;
pub mod bodies;
pub mod deliver;
pub mod demand;
pub mod discovery;
pub mod fragment;
pub mod frontier;
pub mod p2p;
pub mod resync;
pub mod subscriptions;
pub mod sync;
pub mod unfurl;
