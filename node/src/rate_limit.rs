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

use crate::clock::now_ms;
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

    /// [`check`], for a request with a context: the operator's own machine, talking to the
    /// node directly (loopback, unproxied), is never limited. The limiter exists to stop one
    /// IP hammering account creation from the NETWORK; a loopback caller is the operator or
    /// their tools - the test-data generator registering a hundred personas is the intended
    /// customer, not an attacker. Same audience-aware posture as the password floor, and the
    /// proxy hazard is handled where the question is answered (`is_direct_loopback`).
    pub async fn check_ctx(
        &self,
        action: &str,
        ctx: &crate::request_context::RequestContext,
        limit: u32,
        window_ms: i64,
    ) -> Result<(), AppError> {
        if ctx.is_direct_loopback() {
            return Ok(());
        }
        self.check(action, &ctx.rate_limit_identifier(), limit, window_ms)
            .await
    }

    /// Allow at most `limit` `action`s per `identifier` per `window_ms`. Returns
    /// `TooManyRequests` once the limit is exceeded within the current window.
    pub async fn check(
        &self,
        action: &str,
        identifier: &str,
        limit: u32,
        window_ms: i64,
    ) -> Result<(), AppError> {
        if !self.enabled {
            return Ok(());
        }

        let bucket = now_ms() / window_ms.max(1);
        let key = format!("{action}:{identifier}:{window_ms}:{bucket}");

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
