//! Admission and budgets (PROJECT_PLAN's Peeks, slice 1): the bounds an exchange assumes.
//!
//! Before this module the accept loop spawned a task per incoming connection with no gate,
//! the serve side awaited its first frame with no deadline, and an admitted exchange ran to
//! Done however long Done took - the frame cap bounded a message and the blob cap a body,
//! never a stream. A reviewer named it (2026-09-05); Curtis's infinite-chain pitch is the
//! same gap seen from the wire. Four bounds live here, every one a dial and every one
//! refusing rather than queueing:
//!
//!   * **`Admission`** - how many incoming connections at once, how many of those may still
//!     be UNPROVEN (no membership shown, no served persona named), and how many one peer
//!     may hold. Over any ceiling the connection is closed at accept, never parked on a
//!     permit: a queue of waiting tasks is the resource the flood was after.
//!   * **`Budget`** - entries and bytes one direction of one exchange may carry. Both sides
//!     hold one per direction; the requester stops reading at its budget and the responder
//!     stops sending at its, and either cut leaves the requester provably behind - which is
//!     a mark, not a fault (`Behind`): the next pass continues from the frontier, and an
//!     honest decade arrives over passes.
//!   * **`Behind`** - the in-memory set of personas whose last exchange ended short. The
//!     wake pass treats a behind persona as stale whatever its freshness stamp says, and
//!     the fetch ladder continues a bounded number of passes on the spot.
//!
//! Deadlines (the first frame, the exchange wall clock) are dials read here and applied
//! in `sync.rs`, which owns the streams they bound.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

/// The admission ceilings, read once from config.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_connections: usize,
    pub max_unproven: usize,
    pub max_per_peer: usize,
    pub budget_entries: u64,
    pub budget_bytes: u64,
    pub first_frame: std::time::Duration,
    pub exchange_wall_clock: std::time::Duration,
}

impl Default for Limits {
    /// The config defaults, for tests that build an `AppState` by hand.
    fn default() -> Self {
        Self {
            max_connections: 512,
            max_unproven: 256,
            max_per_peer: 128,
            budget_entries: 5_000,
            budget_bytes: 64 * 1024 * 1024,
            first_frame: std::time::Duration::from_secs(10),
            exchange_wall_clock: std::time::Duration::from_secs(600),
        }
    }
}

#[derive(Default)]
struct Counts {
    total: usize,
    unproven: usize,
    per_peer: HashMap<[u8; 32], usize>,
}

/// The gate at accept. Cheap to clone; one per node.
#[derive(Clone)]
pub struct Admission {
    limits: Limits,
    counts: Arc<Mutex<Counts>>,
}

impl Admission {
    pub fn new(limits: Limits) -> Self {
        Self { limits, counts: Arc::new(Mutex::new(Counts::default())) }
    }

    pub fn from_config(config: &crate::config::Config) -> Self {
        Self::new(Limits {
            max_connections: config.admit_max_connections,
            max_unproven: config.admit_max_unproven,
            max_per_peer: config.admit_max_per_peer,
            budget_entries: config.sync_budget_entries,
            budget_bytes: config.sync_budget_bytes,
            first_frame: std::time::Duration::from_millis(config.sync_first_frame_ms),
            exchange_wall_clock: std::time::Duration::from_millis(config.sync_exchange_max_ms),
        })
    }

    pub fn limits(&self) -> Limits {
        self.limits
    }

    /// A fresh one-direction budget for an exchange.
    pub fn budget(&self) -> Budget {
        Budget::new(self.limits.budget_entries, self.limits.budget_bytes)
    }

    /// Admit a connection from `peer`, or refuse it. `proven_at_birth` is for protocols whose
    /// mere use proves nothing and risks nothing (the blob ALPN: hash-capability, public
    /// bytes) - they count against the total and the per-peer cap but never the unproven
    /// pool. Everything else starts unproven and is promoted by its handler (`Permit::prove`)
    /// once membership is shown or a served persona is named.
    pub fn try_admit(&self, peer: [u8; 32], proven_at_birth: bool) -> Option<Permit> {
        let mut c = self.counts.lock().expect("admission counts poisoned");
        if c.total >= self.limits.max_connections {
            return None;
        }
        if !proven_at_birth && c.unproven >= self.limits.max_unproven {
            return None;
        }
        let mine = c.per_peer.get(&peer).copied().unwrap_or(0);
        if mine >= self.limits.max_per_peer {
            return None;
        }
        c.total += 1;
        if !proven_at_birth {
            c.unproven += 1;
        }
        c.per_peer.insert(peer, mine + 1);
        Some(Permit { admission: self.clone(), peer, unproven: !proven_at_birth })
    }

    /// What is held right now: `(total, unproven)`.
    pub fn held(&self) -> (usize, usize) {
        let c = self.counts.lock().expect("admission counts poisoned");
        (c.total, c.unproven)
    }

    fn release(&self, peer: [u8; 32], unproven: bool) {
        let mut c = self.counts.lock().expect("admission counts poisoned");
        c.total = c.total.saturating_sub(1);
        if unproven {
            c.unproven = c.unproven.saturating_sub(1);
        }
        match c.per_peer.get_mut(&peer) {
            Some(n) if *n > 1 => *n -= 1,
            _ => {
                c.per_peer.remove(&peer);
            }
        }
    }

    fn promote(&self) {
        let mut c = self.counts.lock().expect("admission counts poisoned");
        c.unproven = c.unproven.saturating_sub(1);
    }
}

/// One admitted connection's seat. Dropping it releases everything it holds.
pub struct Permit {
    admission: Admission,
    peer: [u8; 32],
    unproven: bool,
}

impl Permit {
    /// The connection showed membership or named a persona this node serves: leave the
    /// unproven pool (idempotent).
    pub fn prove(&mut self) {
        if self.unproven {
            self.unproven = false;
            self.admission.promote();
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.admission.release(self.peer, self.unproven);
    }
}

/// One direction of one exchange: how many entries and bytes it may still carry.
#[derive(Clone, Copy, Debug)]
pub struct Budget {
    entries_left: u64,
    bytes_left: u64,
    exhausted: bool,
}

impl Budget {
    pub fn new(entries: u64, bytes: u64) -> Self {
        Self { entries_left: entries, bytes_left: bytes, exhausted: false }
    }

    /// Charge one entry of `bytes`. `false` means the budget is spent: the entry must not be
    /// sent or read, and the exchange ends short. The first refusal sticks.
    pub fn take(&mut self, bytes: usize) -> bool {
        if self.exhausted || self.entries_left == 0 || self.bytes_left < bytes as u64 {
            self.exhausted = true;
            return false;
        }
        self.entries_left -= 1;
        self.bytes_left -= bytes as u64;
        true
    }

    pub fn exhausted(&self) -> bool {
        self.exhausted
    }
}

/// Personas whose last exchange ended short of the peer's frontier. In memory and
/// boot-reset on purpose: a fresh boot re-fetches by staleness anyway, and a mark that
/// outlived the process could pin a persona nobody wants any more.
#[derive(Clone, Default)]
pub struct Behind(Arc<Mutex<HashMap<String, i64>>>);

impl Behind {
    pub fn mark(&self, root_hex: &str) {
        self.0
            .lock()
            .expect("behind marks poisoned")
            .insert(root_hex.to_string(), crate::clock::now_ms());
    }

    pub fn clear(&self, root_hex: &str) {
        self.0.lock().expect("behind marks poisoned").remove(root_hex);
    }

    pub fn is_behind(&self, root_hex: &str) -> bool {
        self.0.lock().expect("behind marks poisoned").contains_key(root_hex)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(max_connections: usize, max_unproven: usize, max_per_peer: usize) -> Limits {
        Limits {
            max_connections,
            max_unproven,
            max_per_peer,
            budget_entries: 10,
            budget_bytes: 1000,
            first_frame: std::time::Duration::from_secs(1),
            exchange_wall_clock: std::time::Duration::from_secs(1),
        }
    }

    #[test]
    fn the_ceiling_refuses_and_a_dropped_permit_reopens_it() {
        let a = Admission::new(limits(2, 2, 2));
        let p1 = a.try_admit([1; 32], false).expect("first");
        let _p2 = a.try_admit([2; 32], false).expect("second");
        assert!(a.try_admit([3; 32], false).is_none(), "over the ceiling: refused, not queued");
        assert_eq!(a.held(), (2, 2));
        drop(p1);
        assert_eq!(a.held(), (1, 1));
        assert!(a.try_admit([3; 32], false).is_some(), "the seat came back");
    }

    #[test]
    fn the_unproven_pool_is_smaller_and_proving_leaves_it() {
        let a = Admission::new(limits(10, 1, 10));
        let mut p1 = a.try_admit([1; 32], false).expect("first unproven");
        assert!(a.try_admit([2; 32], false).is_none(), "the unproven pool is full");
        assert!(a.try_admit([2; 32], true).is_some(), "proven at birth never needed the pool");
        p1.prove();
        p1.prove(); // idempotent
        assert_eq!(a.held().1, 0, "proving released the unproven seat");
        let _p3 = a.try_admit([3; 32], false).expect("and a stranger may use it now");
        drop(p1);
        assert_eq!(a.held().1, 1, "a proven permit's drop does not double-release the pool");
    }

    #[test]
    fn one_peer_is_capped_however_many_connections_it_opens() {
        let a = Admission::new(limits(100, 100, 2));
        let _x = a.try_admit([7; 32], false).expect("one");
        let _y = a.try_admit([7; 32], false).expect("two");
        assert!(a.try_admit([7; 32], false).is_none(), "the third from the same peer is refused");
        assert!(a.try_admit([8; 32], false).is_some(), "another peer is not");
    }

    #[test]
    fn a_budget_stops_at_entries_or_bytes_and_stays_stopped() {
        let mut by_entries = Budget::new(2, 1_000_000);
        assert!(by_entries.take(10) && by_entries.take(10));
        assert!(!by_entries.take(1), "the third entry is over");
        assert!(by_entries.exhausted());
        let mut by_bytes = Budget::new(100, 25);
        assert!(by_bytes.take(20));
        assert!(!by_bytes.take(10), "twenty-five bytes cannot carry thirty");
        assert!(!by_bytes.take(1), "and the first refusal sticks, even for an entry that would fit");
    }

    #[test]
    fn behind_marks_come_and_go() {
        let b = Behind::default();
        assert!(!b.is_behind("a"));
        b.mark("a");
        assert!(b.is_behind("a"));
        b.clear("a");
        assert!(!b.is_behind("a"));
    }
}
