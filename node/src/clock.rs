//! Wall-clock time: `i64` milliseconds since the Unix epoch, the one time type the whole system
//! speaks - SQLite's integer columns, the proto layer's entry timestamps, everything between.
//! (On the wire a timestamp is a CBOR uint; the strict decoder rejects values past `i64::MAX`.)
//!
//! Timestamps are ADVISORY throughout - display interleaving and LWW of cosmetic fields, never
//! a security input (PROJECT_PLAN, The Ordering Contract).

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
