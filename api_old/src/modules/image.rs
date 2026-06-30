use std::sync::Arc;
use anyhow::{Result, anyhow};
use sqlx::{SqlitePool, Row};
use uuid::Uuid;
use serde::{Serialize, Deserialize};

pub mod view;
pub mod routes;

use crate::event::EventListener;
use crate::service_registry::ServiceRegistry;

#[derive(Clone)]
pub struct ImageService {
    pub pool: SqlitePool,
    pub config: crate::app_config::Config,
    pub registry: Arc<dyn ServiceRegistry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Visibility {
    GlobalPublic,       // anybody can see this file, even outside the community
    Public,             // anybody can see this file
    Private,            // only the creator and admins can see this file
    Hidden,             // only admins can see this file
}

#[derive(Debug)]
pub struct Image {
    pub id: Uuid,
    pub file_path: String,
    pub ext: String,
    pub user_id: String,
    pub visibility: Visibility,
    pub created_at: String,
    pub created_at_int: i64,
}

const CREATE_IMAGE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS image (
    id TEXT PRIMARY KEY,
    file_path TEXT NOT NULL,
    ext TEXT NOT NULL,
    user_id TEXT NOT NULL,
    visibility TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL
)
"#;

const CREATE_INDEX_USER_ID: &str = r#"
CREATE INDEX IF NOT EXISTS image_user_id_index ON image(user_id);
"#;

impl ImageService {
    pub async fn new(config: crate::app_config::Config, pool: SqlitePool, registry: Arc<dyn ServiceRegistry>) -> Result<Self> {
        // Create the tables.
        // Create the indexes.
        for index_sql in vec![
            CREATE_IMAGE_TABLE,
            CREATE_INDEX_USER_ID,
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

    pub async fn create_image(&self, id: &Uuid, file_path: &str, ext: &str, user_id: &Uuid, visibility: Visibility) -> Result<Image> {
        let now = chrono::Utc::now();
        sqlx::query("INSERT INTO image (id, file_path, ext, user_id, created_at, created_at_int, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(id.to_string())
            .bind(file_path)
            .bind(ext)
            .bind(user_id.to_string())
            .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(now.timestamp_millis())
            .bind(serde_json::to_string(&visibility)?)
            .execute(&self.pool)
            .await?;

        Ok(Image {
            id: *id,
            file_path: file_path.to_string(),
            ext: ext.to_string(),
            user_id: user_id.to_string(),
            created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            created_at_int: now.timestamp_millis(),
            visibility,
        })
    }

    pub async fn get_image(&self, id: &Uuid) -> Result<Option<Image>> {
        let row = sqlx::query("SELECT id, file_path, ext, user_id, created_at, created_at_int, visibility FROM image WHERE id = ?")
            .bind(id.to_string())
            .fetch_optional(&self.pool)
            .await?;

        if let Some(row) = row {
            Ok(Some(Image {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                file_path: row.get("file_path"),
                ext: row.get("ext"),
                user_id: row.get("user_id"),
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
                visibility: serde_json::from_str(row.get("visibility"))?,
            }))
        } else {
            Ok(None)
        }
    }

}

impl EventListener for ImageService {
    async fn on_event(&self, _event: crate::event::EventEnvelope) -> Result<()> {
        // ok
        Ok(())
    }
}