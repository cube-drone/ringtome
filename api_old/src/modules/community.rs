use std::fs;
use std::sync::Arc;
use rand::seq::SliceRandom;
use rand::thread_rng;
use tokio::sync::{RwLock, mpsc};
use anyhow::{Result, anyhow};
use slugify::slugify;
use uuid::Uuid;
use chrono::{DateTime, Utc};
use sqlx::{SqlitePool, Row};
use sqlx::sqlite::{SqliteRow, SqliteConnectOptions};
//use papaya::HashMap as LockFreeConcurrentHashMap;
use std::collections::HashMap;

use crate::event::{EventEnvelope, EventListener, Event};

use super::community::routes::NewCommunity;
use super::community_database::CommunityDatabaseService;
use crate::service_registry::ServiceRegistry;

pub mod routes;

const CREATE_COMMUNITY_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS community (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_at_int INTEGER NOT NULL,
    last_interaction TEXT NOT NULL,
    last_interaction_int INTEGER NOT NULL
)
"#;

const CREATE_COMMUNITY_TAGS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS community_tags (
    tag_id INTEGER PRIMARY KEY AUTOINCREMENT,
    community_id TEXT NOT NULL,
    tag TEXT NOT NULL
)
"#;

const COMMUNITY_INDEX_NAME_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS community_name_index ON community (name)
"#;

const COMMUNITY_INDEX_SLUG_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS community_slug_index ON community (slug)
"#;

const COMMUNITY_INDEX_CREATED_AT_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS community_created_at_index ON community (created_at)
"#;

const COMMUNITY_INDEX_UPDATED_AT_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS community_updated_at_index ON community (updated_at)
"#;

const COMMUNITY_INDEX_LAST_INTERACTION_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS community_last_interaction_index ON community (last_interaction)
"#;

const COMMUNITY_TAG_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS community_tag_index ON community_tags (community_id)
"#;


#[derive(Debug, Clone)]
pub struct Community {
    pub id: Uuid,
    pub name: String,
    pub slug: String,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // TODO: figure out how to update last_interaction every time a community is accessed
    pub last_interaction: DateTime<Utc>,
}

#[derive(Clone)]
pub struct CommunityService {
    pub pool: SqlitePool,
    pub community_databases: Arc<RwLock<HashMap<String, CommunityDatabaseService>>>,
    pub config: crate::app_config::Config,
    pub registry: Arc<RwLock<Option<Arc<dyn ServiceRegistry>>>>,
    pub event_sender: mpsc::Sender<EventEnvelope>,
}

impl CommunityService {
    /// Creates a new CommunityService using sqlx’s connection pool.
    /// (Note: this function is async.)
    pub async fn new(config: crate::app_config::Config, event_sender: mpsc::Sender<EventEnvelope>) -> Result<Self> {

        // Create the data directory if it doesn't exist.
        let data_directory = config.data_directory.clone();
        tracing::info!("Creating data directory: {:?}", data_directory);
        fs::create_dir_all(&data_directory)?;

        let options = SqliteConnectOptions::new()
            .filename(data_directory.join("community.db"))
            .create_if_missing(true);

        // Create the pool. Adjust pool options as desired.
        let pool = SqlitePool::connect_with(options).await?;

        // Create tables and indices.
        sqlx::query(CREATE_COMMUNITY_TABLE).execute(&pool).await?;
        sqlx::query(CREATE_COMMUNITY_TAGS_TABLE).execute(&pool).await?;

        // Run PRAGMA statements.
        sqlx::query("PRAGMA journal_mode = WAL").execute(&pool).await?;
        sqlx::query("PRAGMA synchronous = normal").execute(&pool).await?;

        // Create indices.
        for index_sql in vec![
            COMMUNITY_INDEX_NAME_SQL,
            COMMUNITY_INDEX_SLUG_SQL,
            COMMUNITY_INDEX_CREATED_AT_SQL,
            COMMUNITY_INDEX_UPDATED_AT_SQL,
            COMMUNITY_INDEX_LAST_INTERACTION_SQL,
            COMMUNITY_TAG_INDEX_SQL
        ] {
            sqlx::query(index_sql).execute(&pool).await?;
        }

        Ok(Self {
            pool,
            community_databases: Arc::new(RwLock::new(HashMap::new())),
            config: config.clone(),
            registry: Arc::new(RwLock::new(None)),
            event_sender,
        })
    }

    pub async fn set_registry(&self, registry: Arc<dyn ServiceRegistry>) {
        self.registry.write().await.replace(registry);
    }

    /// Checks if a community slug exists in the database.
    pub async fn slug_exists(&self, slug: &str) -> Result<bool> {
        let row: Option<(String,)> = sqlx::query_as("SELECT id FROM community WHERE slug = ?1")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await?;
        Ok(row.is_some())
    }

    /// Returns a valid, unique slug for a community.
    pub async fn get_valid_slug(&self, name: &str) -> Result<String> {
        let original_slug = slugify!(name);
        let mut slug = original_slug.clone();
        let mut i = 1;
        while self.slug_exists(&slug).await? {
            slug = format!("{}-{}", original_slug, i);
            i += 1;
        }
        Ok(slug)
    }

    /// Inserts a new community into the database.
    pub async fn create(&self, community: NewCommunity) -> Result<Community> {
        let id = Uuid::new_v4();
        let slug = self.get_valid_slug(&community.community_name).await?;
        let now = Utc::now();
        let now_rfc = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let now_int = now.timestamp_micros();

        // Perform the insertion.
        let result = sqlx::query(
            "INSERT INTO community (
                id, slug, name, created_at, created_at_int,
                updated_at, updated_at_int, last_interaction, last_interaction_int
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?4, ?5, ?4, ?5)"
        )
        .bind(id.to_string())
        .bind(&slug)
        .bind(&community.community_name)
        .bind(&now_rfc)
        .bind(now_int)
        .execute(&self.pool)
        .await;

        if let Err(e) = result {
            let e_str = e.to_string();
            if e_str.contains("UNIQUE constraint failed: community.name") {
                return Err(anyhow!("400 Community with name \"{}\" already exists", community.community_name));
            }
            if e_str.contains("UNIQUE constraint failed: community.slug") {
                return Err(anyhow!("400 Community with slug \"{}\" already exists", slug));
            }
            return Err(anyhow!("Could not create community: {}", e));
        }

        Ok(Community {
            id,
            slug,
            name: community.community_name,
            tags: vec![],
            created_at: now,
            updated_at: now,
            last_interaction: now,
        })
    }

    /// Deletes a community by slug.
    pub async fn delete(&self, slug: &String) -> Result<()> {
        sqlx::query("DELETE FROM community WHERE slug = ?1")
            .bind(slug)
            .execute(&self.pool)
            .await?;

        self.delete_and_close_database(slug).await?;
        // remove all tags associated with the community
        sqlx::query("DELETE FROM community_tags WHERE community_id = (SELECT id FROM community WHERE slug = ?1)")
            .bind(slug)
            .execute(&self.pool)
            .await?;

        // also delete the community's folder
        let community_folder = self.config.data_directory.join(slug);
        if community_folder.exists() {
            fs::remove_dir_all(community_folder)?;
        }

        Ok(())
    }

    async fn delete_and_close_database(&self, slug: &str) -> Result<()> {
        let mut community_databases = self.community_databases.write().await;
        if let Some(service) = community_databases.remove(slug) {
            service.close().await?;
        }
        Ok(())
    }

    /// Retrieves a CommunityDatabaseService for the given community slug if it exists.
    async fn _get_database(&self, slug: &str) -> Result<Option<CommunityDatabaseService>> {
        let community_databases = self.community_databases.read().await;
        Ok(community_databases.get(slug).cloned())
    }

    async fn create_and_insert_community_database(&self, slug: &str) -> Result<CommunityDatabaseService> {
        let registry = self.registry.read().await;
        let registry = registry.as_ref().ok_or_else(|| anyhow!("Service registry not set"))?;

        let service = CommunityDatabaseService::new(self.config.clone(), slug, registry.clone(), self.event_sender.clone()).await?;
        let mut community_databases = self.community_databases.write().await;
        community_databases.insert(slug.to_string(), service.clone());

        Ok(service)
    }

    async fn count_databases(&self) -> Result<usize> {
        let community_databases = self.community_databases.read().await;
        Ok(community_databases.len())
    }

    async fn clean_databases(&self, slug_definitely_not_to_delete: &str) -> Result<()> {
        // If we have too many databases open, close one
        let dropped_service = {
            let mut community_databases = self.community_databases.write().await;
            let keys = community_databases.keys().cloned().collect::<Vec<String>>();
            // select a random key to close
            let mut rng = thread_rng();
            let random_slug = keys.choose(&mut rng).cloned();
            if let Some(random_slug) = random_slug {
                if random_slug == slug_definitely_not_to_delete {
                    // If the random slug is the one we don't want to delete, just return
                    tracing::info!("Random slug is the one we don't want to delete: {:?}", random_slug);
                    return Ok(());
                }
                tracing::info!("Max files open reached, closing random community database: {:?}", random_slug);
                let random_service = community_databases.get(&random_slug).cloned();
                if let Some(random_service) = random_service {
                    community_databases.remove(&random_slug);
                    Some(random_service)
                }
                else{
                    None
                }
            }
            else{
                None
            }
        };
        if let Some(svc) = dropped_service {
            svc.close().await?;
        }
        Ok(())
    }

    /// Creates a new CommunityDatabaseService if one does not exist, or returns the existing one.
    pub async fn get_database(&self, slug: &str) -> Result<CommunityDatabaseService> {
        if let Some(service) = self._get_database(slug).await? {
            return Ok(service);
        }
        if !self.slug_exists(slug).await? {
            return Err(anyhow!("404 Community database not found"));
        }
        // if the registry is not set, return an error
        let registry = self.registry.read().await;
        let registry = registry.as_ref().ok_or_else(|| anyhow!("Service registry not set"))?;

        let service = CommunityDatabaseService::new(self.config.clone(), slug, registry.clone(), self.event_sender.clone()).await?;

        self.create_and_insert_community_database(slug).await?;
        let count = self.count_databases().await?;
        if count > self.config.max_files_open as usize {
            tracing::info!("Max files open reached: {}, cleaning up databases", count);
            self.clean_databases(slug).await?;
        }

        Ok(service)
    }

    /// Converts a sqlx row into a Community.
    fn row_to_community(row: &SqliteRow) -> Result<Community> {
        let id_str: String = row.try_get(0)?;
        let id = Uuid::parse_str(&id_str)?;
        let slug: String = row.try_get(1)?;
        let name: String = row.try_get(2)?;
        let created_at_str: String = row.try_get(3)?;
        let created_at = chrono::DateTime::parse_from_rfc3339(&created_at_str)?
            .with_timezone(&Utc);
        let updated_at_str: String = row.try_get(4)?;
        let updated_at = chrono::DateTime::parse_from_rfc3339(&updated_at_str)?
            .with_timezone(&Utc);
        let last_interaction_str: String = row.try_get(5)?;
        let last_interaction = chrono::DateTime::parse_from_rfc3339(&last_interaction_str)?
            .with_timezone(&Utc);
        Ok(Community {
            id,
            slug,
            name,
            tags: vec![],
            created_at,
            updated_at,
            last_interaction,
        })
    }

    async fn complete_community(&self, community: &Community) -> Result<Community> {
        let rows = sqlx::query("SELECT tag FROM community_tags WHERE community_id = ?1")
            .bind(community.id.to_string())
            .fetch_all(&self.pool)
            .await?;
        let tags = rows.into_iter()
            .map(|row| row.try_get(0))
            .collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(Community {
            tags,
            ..community.clone()
        })
    }

    /// Retrieves a community by id.
    pub async fn get(&self, id: &str) -> Result<Option<Community>> {
        let row = sqlx::query("SELECT id, slug, name, created_at, updated_at, last_interaction FROM community WHERE id = ?1 LIMIT 1")
            .bind(id)
            .fetch_optional(&self.pool)
            .await?;
        if let Some(row) = row {
            let community = Self::row_to_community(&row)?;
            let community = self.complete_community(&community).await?;
            Ok(Some(community))
        } else {
            Ok(None)
        }
    }

    /// Retrieves a community by slug.
    pub async fn get_slug(&self, slug: &str) -> Result<Option<Community>> {
        let row = sqlx::query("SELECT id, slug, name, created_at, updated_at, last_interaction FROM community WHERE slug = ?1 LIMIT 1")
            .bind(slug)
            .fetch_optional(&self.pool)
            .await?;
        if let Some(row) = row {
            let community = Self::row_to_community(&row)?;
            let community = self.complete_community(&community).await?;
            Ok(Some(community))
        } else {
            Ok(None)
        }
    }

    /// Retrieves all community slugs.
    pub async fn get_all_slugs(&self) -> Result<Vec<String>> {
        let rows = sqlx::query("SELECT slug FROM community")
            .fetch_all(&self.pool)
            .await?;
        let slugs = rows.into_iter()
            .map(|row| row.try_get(0))
            .collect::<std::result::Result<Vec<String>, _>>()?;
        Ok(slugs)
    }

    /// Marks a community as verified.
    pub async fn verify(&self, community_id: &Uuid) -> Result<()> {
        self.add_tag(community_id, "verified").await?;

        Ok(())
    }

    pub async fn verify_slug(&self, slug: &str) -> Result<()> {
        let community = self.get_slug(slug).await?;
        if let Some(community) = community {
            self.verify(&community.id).await?;
            Ok(())
        } else {
            Err(anyhow!("404 Community not found"))
        }
    }

    pub async fn add_tag(&self, community_id: &Uuid, tag: &str) -> Result<()> {
        sqlx::query("INSERT INTO community_tags (community_id, tag) VALUES (?1, ?2)")
            .bind(community_id.to_string())
            .bind(tag)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn remove_tag(&self, community_id: &Uuid, tag: &str) -> Result<()> {
        sqlx::query("DELETE FROM community_tags WHERE community_id = ?1 AND tag = ?2")
            .bind(community_id.to_string())
            .bind(tag)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_communities(&self, prefix: Option<String>, n: Option<i64>, offset: Option<i64>) -> Result<Vec<Community>> {

        // default n and offset
        let n = n.unwrap_or(50);
        let offset = offset.unwrap_or(0);

        // only get communities with the "verified" tag
        let query = "
            SELECT id,
                slug,
                name,
                created_at,
                updated_at,
                last_interaction
            FROM
                community
            WHERE
                name LIKE ?1
            AND
                id IN (
                    SELECT community_id FROM community_tags WHERE tag = 'verified'
                )
            ORDER BY created_at DESC
            LIMIT ?2
            OFFSET ?3
            ".to_string();

        let rows = sqlx::query(&query)
            .bind(format!("{}%", prefix.unwrap_or("".to_string())))
            .bind(n)
            .bind(offset)
            .fetch_all(&self.pool)
            .await?;

        let mut communities = Vec::new();
        for row in rows {
            let community = Self::row_to_community(&row)?;
            communities.push(community);
        }

        Ok(communities)
    }

    pub async fn bump_interaction(&self, community_slug: &str) -> Result<()> {
        // this happens a LOT, we might want to bundle these together and do them every minute or so
        let now = Utc::now();
        let now_rfc = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let now_int = now.timestamp_micros();

        sqlx::query("UPDATE community SET last_interaction = ?1, last_interaction_int = ?2 WHERE slug = ?3")
            .bind(&now_rfc)
            .bind(now_int)
            .bind(community_slug)
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    // we're looking for unverified communities with a last interaction date older than 7 days
    // (so that we can delete them)
    async fn get_old_unverified_communities(&self) -> Result<Vec<Community>> {
        let one_week_ago = Utc::now() - chrono::Duration::days(7);
        let one_week_ago_timestamp = one_week_ago.timestamp_micros();
        let query = "
            SELECT id,
                slug,
                name,
                created_at,
                updated_at,
                last_interaction
            FROM
                community
            WHERE
                id NOT IN (
                    SELECT community_id FROM community_tags WHERE tag = 'verified'
                )
            AND
                last_interaction_int < ?1
            ORDER BY created_at DESC
            ".to_string();

        let rows = sqlx::query(&query)
            .bind(one_week_ago_timestamp)
            .fetch_all(&self.pool)
            .await?;

        let mut communities = Vec::new();
        for row in rows {
            let community = Self::row_to_community(&row)?;
            communities.push(community);
        }

        Ok(communities)
    }

    async fn delete_old_unverified_communities(&self) -> Result<()> {
        let old_communities = self.get_old_unverified_communities().await?;
        for community in old_communities {
            tracing::info!("Deleting old unverified community: {:?}", community.slug);
            self.delete(&community.slug).await?;
        }
        Ok(())
    }

    pub async fn get_communities_that_have_an_interaction_in_the_past_week(&self) -> Result<Vec<Community>> {
        let one_week_ago = Utc::now() - chrono::Duration::days(7);
        let one_week_ago_rfc = one_week_ago.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let rows = sqlx::query("SELECT id, slug, name, created_at, updated_at, last_interaction FROM community WHERE last_interaction >= ?1")
            .bind(&one_week_ago_rfc)
            .fetch_all(&self.pool)
            .await?;

        let mut communities = Vec::new();
        for row in rows {
            let community = Self::row_to_community(&row)?;
            communities.push(community);
        }

        Ok(communities)
    }
}

// impement EventListener for CommunityService
impl EventListener for CommunityService {

    async fn on_event(&self, event: EventEnvelope) -> Result<()> {

        let mut bulk_community_updates = false;
        match event.event {
            Event::Minutely {  } => {
                bulk_community_updates = true;
            }
            Event::FiveMinutely {  } => {
                bulk_community_updates = true;
            }
            Event::FifteenMinutely {  } => {
                bulk_community_updates = true;
            }
            Event::HalfHourly {  } => {
                bulk_community_updates = true;
            }
            Event::Hourly {  } => {
                bulk_community_updates = true;
            }
            Event::Daily {  } => {
                bulk_community_updates = true;

                // while we're at it, delete old unverified communities
                self.delete_old_unverified_communities().await?;
            }
            _ => {
                // we don't have any specific community-related events to handle yet
            }
        }

        if event.community_slug.is_none() && !bulk_community_updates {
            return Ok(()); // No community slug, nothing to do (this is the community service, after all)
        }

        if event.community_slug.is_none() {
            // we need to do something for ALL communities
            let communities = self.get_communities_that_have_an_interaction_in_the_past_week().await?;
            for community in communities {
                let community_database = self.get_database(&community.slug).await?;
                community_database.on_event(event.clone()).await?;
            }
            return Ok(());
        }
        else{
            // Each event should only be handled by the community database service matching the community slug that generated the event.
            // (so, if the event is for community "foo", it should only be handled by the community database service for "foo")
            //  the community database itself will pass the event to its children as needed.
            let community_slug = event.community_slug.clone().unwrap_or_default();
            let community_database = self.get_database(&community_slug).await?;
            community_database.on_event(event.clone()).await?;

            // on ANY event, bump the interaction time for the community
            if let Some(slug) = event.community_slug {
                self.bump_interaction(&slug).await?;
            }
        }

        Ok(())
    }
}