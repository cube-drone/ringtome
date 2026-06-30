use std::sync::Arc;
use anyhow::{Result, anyhow};
use sqlx::{SqlitePool, Row};
use serde::{Serialize, Deserialize};

use crate::service_registry::ServiceRegistry;

pub mod routes;

#[derive(Clone)]
pub struct CommunitySettingsService {
    pub pool: SqlitePool,
    pub config: crate::app_config::Config,
    pub registry: Arc<dyn ServiceRegistry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityConfig {
    pub viral_growth_enabled: bool,
    pub lock_community: bool,
}
// is it possible to generate CONFIG_KEYS dynamically from the fields of CommunityConfig?
// it'd be a simple Object.keys in JS - does Rust have some kind of reflection or macro system for this?
pub const COMMUNITY_CONFIG_KEYS: [&str; 2] = [
    "viral_growth_enabled",
    "lock_community",
];

impl Default for CommunityConfig {
    fn default() -> Self {
        Self {
            // with viral growth enabled, users can invite others to join the community
            viral_growth_enabled: false,
            // with lock_community enabled, nobody can join the community at all
            lock_community: false,
        }
    }
}

// The way that community config variables are stored in the database are as key-value pairs
// Since the community has a whole database to itself, we're guaranteed to have only the one community
// so we don't need to namespace the keys by community ID..

const CREATE_COMMUNITY_CONFIG_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS community_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)
"#;

impl CommunitySettingsService {

    pub async fn new(config: crate::app_config::Config, pool: SqlitePool, registry: Arc<dyn ServiceRegistry>) -> Result<Self> {
        // Create the tables.
        // Create the indexes.
        for index_sql in vec![
            CREATE_COMMUNITY_CONFIG_TABLE,
        ] {
            match sqlx::query(index_sql).execute(&pool).await {
                Ok(_) => {},
                Err(e) => {
                    // Ignore duplicate column errors, as they may occur if the migration is run multiple times
                    if e.to_string().contains("duplicate column name") || e.to_string().contains("already exists") {
                        continue;
                    }
                    else{
                        return Err(anyhow!(format!("Error creating table: {} - {}", index_sql, e)));
                    }
                }
            };
        }

        Ok(Self { config, pool, registry })
    }

    pub async fn set(&self, key: &str, value: &str) -> Result<()> {

        // if the key is not one of the keys in the CommunityConfig struct, return an error
        if !COMMUNITY_CONFIG_KEYS.contains(&key) {
            return Err(anyhow!("Invalid community config key: {}", key));
        }

        sqlx::query("INSERT INTO community_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn get(&self, key: &str) -> Result<Option<String>> {
        let row = sqlx::query("SELECT value FROM community_config WHERE key = ?")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?;

        if let Some(row) = row {
            let value: String = row.try_get("value")?;
            Ok(Some(value))
        } else {
            Ok(None)
        }
    }

    pub async fn get_config(&self) -> Result<CommunityConfig> {
        let mut config = CommunityConfig::default();

        if let Some(value) = self.get("viral_growth_enabled").await? {
            config.viral_growth_enabled = value.parse::<bool>().unwrap_or(false);
        }
        if let Some(value) = self.get("lock_community").await? {
            config.lock_community = value.parse::<bool>().unwrap_or(false);
        }

        Ok(config)
    }

    pub async fn update_config(&self, new_config: CommunityConfig) -> Result<CommunityConfig> {
        self.set("viral_growth_enabled", &new_config.viral_growth_enabled.to_string()).await?;
        self.set("lock_community", &new_config.lock_community.to_string()).await?;

        Ok(self.get_config().await?)
    }
}