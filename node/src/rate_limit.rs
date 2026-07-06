//! Fixed-window rate limiting, backed by an in-memory moka cache.
//!
//! Keys are namespaced by `(action, identifier, time-bucket)`, so distinct actions and callers
//! count independently and buckets roll over automatically. Disabled entirely in local-test mode
//! (integration tests would otherwise trip the limits).
//!
//! This is a per-node, in-memory limiter: it resets on restart and does not coordinate across
//! nodes. That is the right scope for "stop one IP from hammering account creation on this node,"
//! which is all it is for right now.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::AppError;

#[derive(Clone)]
pub struct RateLimiter {
    enabled: bool,
    counters: moka::future::Cache<String, Arc<AtomicU32>>,
}

impl RateLimiter {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            // Generous ceiling; entries are tiny and expire implicitly via bucket rollover.
            counters: moka::future::Cache::new(100_000),
        }
    }

    /// Allow at most `limit` `action`s per `identifier` per `window_secs`. Returns
    /// `TooManyRequests` once the limit is exceeded within the current window.
    pub async fn check(
        &self,
        action: &str,
        identifier: &str,
        limit: u32,
        window_secs: u64,
    ) -> Result<(), AppError> {
        if !self.enabled {
            return Ok(());
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bucket = now / window_secs.max(1);
        let key = format!("{action}:{identifier}:{window_secs}:{bucket}");

        let counter = self
            .counters
            .get_with(key, async { Arc::new(AtomicU32::new(0)) })
            .await;
        let count = counter.fetch_add(1, Ordering::Relaxed) + 1;

        if count > limit {
            return Err(AppError::TooManyRequests(format!(
                "rate limit for {action} exceeded; slow down"
            )));
        }
        Ok(())
    }
}
