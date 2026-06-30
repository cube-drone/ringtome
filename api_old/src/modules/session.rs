use std::fs;
use tokio::sync::mpsc;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use chrono::Utc;
use sqlx::{SqlitePool, Row};
use sqlx::sqlite::SqliteConnectOptions;
use axum_extra::extract::cookie::Cookie;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::user::User;
use super::community::Community;
use crate::event::{Event, EventEnvelope, EventListener};
use crate::service_registry::ServiceRegistry;

pub mod extractors;

#[derive(Clone)]
pub struct SessionService {
    pub pool: SqlitePool,
    pub cache: moka::future::Cache<String, Session>,
    pub registry: Arc<RwLock<Option<Arc<dyn ServiceRegistry>>>>,
    pub event_sender: mpsc::Sender<crate::event::EventEnvelope>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub session_key: String,

    pub community_id: Uuid,
    pub community_name: String,
    pub community_slug: String,
    pub community_tags: Vec<String>,

    pub user_id: Uuid,
    pub user_name: String,
    pub user_slug: String,
    pub user_tags: Vec<String>,
    pub is_admin: bool, // This field is not stored in the database, but can be derived from user_tags.

    pub created_at: String,
    pub created_at_int: i64,
    pub updated_at: String,
    pub updated_at_int: i64,
}

impl From<Session> for Cookie<'static> {
    fn from(session: Session) -> Self {
        Cookie::build(
            (
            format!("session_{}", session.community_slug),
            session.session_key,
            )
        )
        .path("/")
        .build()
        .into_owned()
    }
}

const CREATE_SESSION_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS session (
    session_key TEXT PRIMARY KEY,

    community_id TEXT NOT NULL,
    community_name TEXT NOT NULL,
    community_slug TEXT NOT NULL,
    community_tags_serialized TEXT NOT NULL,

    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    user_slug TEXT NOT NULL,
    user_tags_serialized TEXT NOT NULL,

    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    updated_at_int INTEGER NOT NULL
)
"#;

const SESSION_INDEX_UPDATED_AT_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS session_updated_at_index ON session(updated_at_int);
"#;

impl SessionService {
    /// Creates a new SessionService by initializing the SQLite database using sqlx.
    /// (This function is async because it creates a connection pool and executes queries.)
    pub async fn new(config: crate::app_config::Config, event_sender: mpsc::Sender<crate::event::EventEnvelope>) -> Result<Self> {
        // Ensure the data directory exists.
        let data_directory = config.data_directory.clone();
        fs::create_dir_all(&data_directory)?;

        let options = SqliteConnectOptions::new()
            .filename(data_directory.join("session.db"))
            .create_if_missing(true);

        // Create the pool. Adjust pool options as desired.
        let pool = SqlitePool::connect_with(options).await?;

        // Create the table.
        sqlx::query(CREATE_SESSION_TABLE).execute(&pool).await?;

        // Run PRAGMA statements.
        sqlx::query("PRAGMA journal_mode = WAL").execute(&pool).await?;
        sqlx::query("PRAGMA synchronous = normal").execute(&pool).await?;

        // Create indexes.
        sqlx::query(SESSION_INDEX_UPDATED_AT_SQL).execute(&pool).await?;

        let cache = moka::future::Cache::builder()
            .max_capacity(10000) // Adjust the capacity as needed
            .time_to_live(std::time::Duration::from_secs(60 * 60)) // 1 hour TTL
            .build();

        Ok(Self {
            pool,
            cache,
            registry: Arc::new(RwLock::new(None)),
            event_sender
         })
    }

    pub async fn set_registry(&self, registry: Arc<dyn ServiceRegistry>) {
        let mut reg_lock = self.registry.write().await;
        *reg_lock = Some(registry);
    }

    pub fn determine_admin(tags: &[String]) -> bool {
        // Check if the user has the 'admin' or 'owner' tag.
        tags.contains(&"admin".to_string()) || tags.contains(&"owner".to_string())
    }

    /// Inserts a new session into the database.
    pub async fn create_session(&self, community: &Community, user: &User) -> Result<Session> {
        let now = Utc::now();
        let now_int = now.timestamp();
        let key = Uuid::new_v4().to_string();

        let session = Session {
            session_key: key.clone(),
            community_id: community.id,
            community_name: community.name.clone(),
            community_slug: community.slug.clone(),
            community_tags: community.tags.clone(),
            user_id: user.id,
            user_name: user.name.clone(),
            user_slug: user.slug.clone(),
            user_tags: user.tags.clone(),
            is_admin: Self::determine_admin(&user.tags),
            created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            created_at_int: now_int,
            updated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            updated_at_int: now_int,
        };

        sqlx::query(
            "INSERT INTO session (
                session_key,
                community_id,
                community_name,
                community_slug,
                community_tags_serialized,
                user_id,
                user_name,
                user_slug,
                user_tags_serialized,
                created_at,
                created_at_int,
                updated_at,
                updated_at_int
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&session.session_key)
        .bind(&session.community_id)
        .bind(&session.community_name)
        .bind(&session.community_slug)
        .bind(serde_json::to_string(&session.community_tags)?)
        .bind(&session.user_id)
        .bind(&session.user_name)
        .bind(&session.user_slug)
        .bind(serde_json::to_string(&session.user_tags)?)
        .bind(&session.created_at)
        .bind(session.created_at_int)
        .bind(&session.updated_at)
        .bind(session.updated_at_int)
        .execute(&self.pool)
        .await?;

        // Store the session in the cache.
        self.cache.insert(key.clone(), session.clone()).await;

        Ok(session)
    }

    /// Retrieves a session by session_key.
    pub async fn get_session(&self, session_key: &str) -> Result<Option<Session>> {

        // Check the cache first.
        if let Some(cached_session) = self.cache.get(session_key).await {
            return Ok(Some(cached_session));
        }

        let row_opt = sqlx::query(
            "SELECT
                session_key,
                community_id,
                community_name,
                community_slug,
                community_tags_serialized,
                user_id,
                user_name,
                user_slug,
                user_tags_serialized,
                created_at,
                created_at_int,
                updated_at,
                updated_at_int
             FROM session
             WHERE session_key = ?
             LIMIT 1"
        )
        .bind(session_key)
        .fetch_optional(&self.pool)
        .await?;

        if let Some(row) = row_opt {
            // Extract serialized tags and parse them.
            let community_tags_json: String = row.try_get("community_tags_serialized")?;
            let user_tags_json: String = row.try_get("user_tags_serialized")?;
            let community_tags: Vec<String> = serde_json::from_str(&community_tags_json)?;
            let user_tags: Vec<String> = serde_json::from_str(&user_tags_json)?;

            let session = Session {
                session_key: row.try_get("session_key")?,
                community_id: row.try_get("community_id")?,
                community_name: row.try_get("community_name")?,
                community_slug: row.try_get("community_slug")?,
                community_tags,
                user_id: row.try_get("user_id")?,
                user_name: row.try_get("user_name")?,
                user_slug: row.try_get("user_slug")?,
                is_admin: Self::determine_admin(&user_tags),
                user_tags: user_tags,
                created_at: row.try_get("created_at")?,
                created_at_int: row.try_get("created_at_int")?,
                updated_at: row.try_get("updated_at")?,
                updated_at_int: row.try_get("updated_at_int")?,
            };
            // If we got here, that means the session exists in the database but not in the cache.
            // We can fix that!
            self.cache.insert(session_key.to_string(), session.clone()).await;

            Ok(Some(session))
        } else {
            Ok(None)
        }
    }

    // Refresh and update the session
    pub async fn update_session(&self, session: &Session, community: &Community, user: &User) -> Result<Session> {
        let now = Utc::now();
        let now_int = now.timestamp();

        let session = Session {
            session_key: session.session_key.clone(),
            community_id: session.community_id,
            community_name: community.name.clone(),
            community_slug: community.slug.clone(),
            community_tags: community.tags.clone(),
            user_id: session.user_id,
            user_name: user.name.clone(),
            user_slug: user.slug.clone(),
            user_tags: user.tags.clone(),
            is_admin: Self::determine_admin(&user.tags.clone()),
            created_at: session.created_at.clone(),
            created_at_int: session.created_at_int,
            updated_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            updated_at_int: now_int,
        };

        sqlx::query(
            "UPDATE session
             SET
                community_name = ?,
                community_slug = ?,
                community_tags_serialized = ?,
                user_name = ?,
                user_slug = ?,
                user_tags_serialized = ?,
                updated_at = ?,
                updated_at_int = ?
             WHERE session_key = ?"
        )
        .bind(&session.community_name)
        .bind(&session.community_slug)
        .bind(serde_json::to_string(&session.community_tags)?)
        .bind(&session.user_name)
        .bind(&session.user_slug)
        .bind(serde_json::to_string(&session.user_tags)?)
        .bind(&session.updated_at)
        .bind(session.updated_at_int)
        .bind(&session.session_key)
        .execute(&self.pool)
        .await?;

        // Update the session in the cache.
        self.cache.insert(session.session_key.clone(), session.clone()).await;

        Ok(session)
    }

    pub async fn delete_session(&self, session_key: &str) -> Result<()> {
        sqlx::query("DELETE FROM session WHERE session_key = ?")
            .bind(session_key)
            .execute(&self.pool)
            .await?;

        // remove the session from the cache
        self.cache.invalidate(session_key).await;

        Ok(())
    }

    pub async fn delete_all_sessions_for_user(&self, user_id: &Uuid) -> Result<()> {

        //first, get all sessions for the user
        let sessions = sqlx::query("SELECT session_key FROM session WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(&self.pool)
            .await?;

        // remove each session from the cache
        for row in sessions {
            let session_key: String = row.try_get("session_key")?;
            self.cache.invalidate(&session_key).await;
        }

        // then delete all sessions for the user from the database
        sqlx::query("DELETE FROM session WHERE user_id = ?")
            .bind(user_id)
            .execute(&self.pool)
            .await?;

        Ok(())
    }
}

// implement EventListener for SessionService
impl EventListener for SessionService {
    async fn on_event(&self, event: EventEnvelope) -> Result<()> {
        match event.event {
            Event::UserDeleted { admin_user_id: _ } => {
                // When a user is deleted, we should also delete all their sessions
                if let Some(user_id) = event.user_id {
                    tracing::info!("User deleted: {} - deleting all user sessions automatically!", user_id);
                    self.delete_all_sessions_for_user(&user_id).await?;
                } else {
                    tracing::warn!("User deleted event received without user_id, cannot delete sessions.");
                }
            },
            Event::UserLocked { admin_user_id: _ } => {
                // When a user is locked, we should also delete all their sessions
                if let Some(user_id) = event.user_id {
                    tracing::info!("User locked: {} - deleting all user sessions automatically!", user_id);
                    self.delete_all_sessions_for_user(&user_id).await?;
                } else {
                    tracing::warn!("User locked event received without user_id, cannot delete sessions.");
                }
            },
            Event::UserUnadmined { admin_user_id: _ } => {
                // we should also delete all sessions for the user that was unadmined, otherwise their sessions might still have admin privileges
                if let Some(user_id) = event.user_id {
                    tracing::info!("User unadmined: {} - deleting all user sessions automatically!", user_id);
                    self.delete_all_sessions_for_user(&user_id).await?;
                } else {
                    tracing::warn!("User unadmined event received without user_id, cannot delete sessions.");
                }
            },
            _ => {
                // any other event types can be ignored for session management
            }
        }

        Ok(())
    }
}