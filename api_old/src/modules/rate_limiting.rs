use std::sync::Arc;
use tokio::sync::RwLock;
use anyhow::{Result, anyhow};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::service_registry::ServiceRegistry;

#[derive(Clone)]
pub struct RateLimitingService {
    pub config: crate::app_config::Config,
    pub registry: Arc<RwLock<Option<Arc<dyn ServiceRegistry>>>>,
    pub rate_limits: moka::future::Cache<String, Arc<AtomicU32>>,
}

impl RateLimitingService {
    /// Creates a new RateLimitingService.
    pub async fn new(config: crate::app_config::Config) -> Result<Self> {
        Ok(Self {
            config: config.clone(),
            registry: Arc::new(RwLock::new(None)),
            rate_limits: moka::future::Cache::new(config.rate_limiting_cache_size),
        })
    }

    pub async fn set_registry(&self, registry: Arc<dyn ServiceRegistry>) {
        self.registry.write().await.replace(registry);
    }

    /// Fixed-window limiter over an arbitrary `window` duration.
    async fn limit_per_window(&self, identifier: &str, limit: u32, window: Duration) -> Result<()> {
        if self.config.is_dev(){
            // No rate limiting in dev mode.
            return Ok(());
        }
        let key = Self::bucket_key(identifier, window);

        // Create the counter lazily if absent.
        let counter = self
            .rate_limits
            .get_with(key, async { Arc::new(AtomicU32::new(0)) })
            .await;

        // Increment atomically and check.
        let current = counter.fetch_add(1, Ordering::Relaxed) + 1;
        if current > limit {
            // You could enrich this with retry-after seconds based on time to bucket rollover.
            return Err(anyhow!("429 too_many_requests: you're hitting that endpoint too hard. Slow down."));
        }
        Ok(())
    }

    pub async fn limit_per_minute(&self, identifier: &str, limit: u32) -> Result<()> {
        self.limit_per_window(identifier, limit, Duration::from_secs(60)).await
    }

    pub async fn limit_per_hour(&self, identifier: &str, limit: u32) -> Result<()> {
        self.limit_per_window(identifier, limit, Duration::from_secs(3600)).await
    }

    pub async fn limit_per_day(&self, identifier: &str, limit: u32) -> Result<()> {
        self.limit_per_window(identifier, limit, Duration::from_secs(86400)).await
    }

    pub async fn ctx_limit_per_minute(&self, key: &str, ctx: &crate::request_context::RequestContext, limit: u32) -> Result<()> {
        self.limit_per_minute(&format!("{}-{}", key, ctx.rate_limit_identifier()), limit).await
    }

    pub async fn ctx_limit_per_hour(&self, key: &str, ctx: &crate::request_context::RequestContext, limit: u32) -> Result<()> {
        self.limit_per_hour(&format!("{}-{}", key, ctx.rate_limit_identifier()), limit).await
    }

    pub async fn ctx_limit_per_day(&self, key: &str, ctx: &crate::request_context::RequestContext, limit: u32) -> Result<()> {
        self.limit_per_day(&format!("{}-{}", key, ctx.rate_limit_identifier()), limit).await
    }

    /// Key is namespaced by identifier + window size + current bucket index.
    fn bucket_key(identifier: &str, window: Duration) -> String {
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let bucket = now_secs / window.as_secs().max(1);
        format!("rate_limit:{}:{}s:{}", identifier, window.as_secs(), bucket)
    }
}