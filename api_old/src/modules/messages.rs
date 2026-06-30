use std::sync::Arc;
use anyhow::{Result, anyhow};
use sqlx::{SqlitePool, Row};
use uuid::Uuid;
use serde::{Serialize, Deserialize};

use crate::event::EventListener;
use crate::paging::PagingOptions;
use crate::service_registry::ServiceRegistry;

pub mod view;
pub mod routes;

#[derive(Clone)]
pub struct MessageService {
    pub pool: SqlitePool,
    pub config: crate::app_config::Config,
    pub registry: Arc<dyn ServiceRegistry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Message {
    Link {
        url: String,
        title: Option<String>,
    },
    Text {
        message: String,
    },
    JustAnEmoji {
        emoji: String,
    },
    AdminOnlyMessage {
        message: String,
    }
}

impl Message {
    /// Every kind of message can currently be sent by any user,
    ///   but this may change in the future: if we want to restrict
    ///   who can send certain types of messages, set the
    ///   message type's response here to false
    pub fn can_user_send(&self) -> bool {
        match self {
            Message::AdminOnlyMessage { .. } => false,
            _ => true,
        }
    }
    pub fn to_text(&self) -> String {
        match self {
            Message::Link { url, title } => {
                if let Some(title) = title {
                    format!("{} ({})", title, url)
                } else {
                    url.to_string()
                }
            },
            Message::Text { message } => message.to_string(),
            Message::JustAnEmoji { emoji } => emoji.to_string(),
            Message::AdminOnlyMessage { message } => message.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEnvelope {
    pub id: Uuid,
    pub user_id: Uuid,                  // if there's a user id
    pub source_user_id: Option<Uuid>,   // if there's a target user id

    pub message: Message,               // the message itself

    pub seen: bool,                     // if the message has been seen
    pub created_at: String,
    pub created_at_int: i64,
}

const CREATE_MESSAGE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS message (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_user_id TEXT,
    message_serialized TEXT NOT NULL,
    seen BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL
)
"#;

const CREATE_AUDIT_INDEX_USER_ID: &str = r#"
CREATE INDEX IF NOT EXISTS message_user_id_index ON message(user_id);
"#;

const CREATE_AUDIT_INDEX_SOURCE_USER_ID: &str = r#"
CREATE INDEX IF NOT EXISTS message_source_user_id_index ON message(source_user_id);
"#;

const CREATE_AUDIT_INDEX_CREATED_AT: &str = r#"
CREATE INDEX IF NOT EXISTS message_created_at_index ON message(created_at_int);
"#;


impl MessageService {
    pub async fn new(config: crate::app_config::Config, pool: SqlitePool, registry: Arc<dyn ServiceRegistry>) -> Result<Self> {
        // Create the tables.
        // Create the indexes.
        for index_sql in vec![
            CREATE_MESSAGE_TABLE,
            CREATE_AUDIT_INDEX_USER_ID,
            CREATE_AUDIT_INDEX_SOURCE_USER_ID,
            CREATE_AUDIT_INDEX_CREATED_AT,
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

    pub async fn send_message(&self, envelope: MessageEnvelope) -> Result<()> {

        // ignore envelope.created_at - just use the current time
        let now = chrono::Utc::now();
        let timestamp_in_microseconds = now.timestamp_micros();

        // Insert the message into the database
        sqlx::query("INSERT INTO message (
            id,
            user_id,
            source_user_id,
            message_serialized,
            created_at,
            created_at_int)
            VALUES (?, ?, ?, ?, ?, ?)")
            .bind(envelope.id.to_string())
            .bind(envelope.user_id.to_string())
            .bind(envelope.source_user_id.map(|uid| uid.to_string()))
            .bind(serde_json::to_string(&envelope.message)?)
            .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .bind(timestamp_in_microseconds)
            .execute(&self.pool).await?;

        Ok(())
    }

    pub async fn get_message(&self, message_id: &Uuid) -> Result<Option<MessageEnvelope>> {
        // Query the message from the database
        let row = sqlx::query("
            SELECT
                id,
                user_id,
                source_user_id,
                message_serialized,
                seen,
                created_at,
                created_at_int
            FROM
                message
            WHERE
                id = ?")
            .bind(message_id.to_string())
            .fetch_optional(&self.pool).await?;

        if let Some(row) = row {
            Ok(Some(MessageEnvelope {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                user_id: Uuid::parse_str(row.get::<String, _>("user_id").as_str())?,
                source_user_id: row.get::<Option<String>, _>("source_user_id").map(|s| Uuid::parse_str(s.as_str()).ok()).flatten(),
                message: serde_json::from_str(&row.get::<String, _>("message_serialized"))?,
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
                seen: row.get("seen"),
            }))
        } else {
            Ok(None)
        }
    }

    pub async fn get_messages(&self, user_id: &Uuid, options: PagingOptions) -> Result<Vec<MessageEnvelope>> {
        // Query the messages from the database
        let mut query = sqlx::query("
            SELECT
                id,
                user_id,
                source_user_id,
                message_serialized,
                seen,
                created_at,
                created_at_int
            FROM
                message
            WHERE
                user_id = ?
            ORDER BY created_at_int DESC
            LIMIT ? OFFSET ?")
            .bind(user_id.to_string());

        if let Some(limit) = options.limit {
            query = query.bind(limit);
        }
        else{
            query = query.bind(100); // default limit
        }

        if let Some(offset) = options.offset {
            query = query.bind(offset);
        }
        else{
            query = query.bind(0); // default offset
        }

        let rows = query.fetch_all(&self.pool).await?;

        // Map the rows to MessageEnvelope
        let messages: Result<Vec<MessageEnvelope>, _> = rows.into_iter().map(|row| {
            Ok(MessageEnvelope {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                user_id: Uuid::parse_str(row.get::<String, _>("user_id").as_str())?,
                source_user_id: row.get::<Option<String>, _>("source_user_id").map(|s| Uuid::parse_str(s.as_str()).ok()).flatten(),
                message: serde_json::from_str(&row.get::<String, _>("message_serialized"))?,
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
                seen: row.get("seen"),
            })
        }).collect();

        messages
    }

    pub async fn get_messages_after(&self, user_id: &Uuid, after: i64, options: PagingOptions ) -> Result<Vec<MessageEnvelope>> {
        // Query the messages from the database
        let mut query = sqlx::query("
            SELECT
                id,
                user_id,
                source_user_id,
                message_serialized,
                seen,
                created_at,
                created_at_int
            FROM
                message
            WHERE
                user_id = ?
            AND
                created_at_int > ?
            ORDER BY created_at_int ASC
            LIMIT ? OFFSET ?")
            .bind(user_id.to_string())
            .bind(after);

        if let Some(limit) = options.limit {
            query = query.bind(limit);
        }
        else {
            query = query.bind(100); // default limit
        }

        if let Some(offset) = options.offset {
            query = query.bind(offset);
        }
        else {
            query = query.bind(0); // default offset
        }

        let rows = query.fetch_all(&self.pool).await?;

        // Map the rows to MessageEnvelope
        let messages: Result<Vec<MessageEnvelope>, _> = rows.into_iter().map(|row| {
            Ok(MessageEnvelope {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                user_id: Uuid::parse_str(row.get::<String, _>("user_id").as_str())?,
                source_user_id: row.get::<Option<String>, _>("source_user_id").map(|s| Uuid::parse_str(s.as_str()).ok()).flatten(),
                message: serde_json::from_str(&row.get::<String, _>("message_serialized"))?,
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
                seen: row.get("seen"),
            })
        }).collect();

        messages
    }

    pub async fn get_message_history_between_users(&self, user_id: &Uuid, other_user_id: &Uuid, options: PagingOptions) -> Result<Vec<MessageEnvelope>> {
        // Query the messages between the two users
        let rows = sqlx::query("
            SELECT
                id,
                user_id,
                source_user_id,
                message_serialized,
                seen,
                created_at,
                created_at_int
            FROM
                message
            WHERE
                (user_id = ? AND source_user_id = ?)
                OR (user_id = ? AND source_user_id = ?)
            ORDER BY created_at_int DESC
            LIMIT ? OFFSET ?
            ")
            .bind(user_id.to_string())
            .bind(other_user_id.to_string())
            .bind(other_user_id.to_string())
            .bind(user_id.to_string())
            .bind(options.limit.unwrap_or(100))
            .bind(options.offset.unwrap_or(0))
            .fetch_all(&self.pool).await?;

        // Map the rows to MessageEnvelope
        let messages: Result<Vec<MessageEnvelope>, _> = rows.into_iter().map(|row| {
            Ok(MessageEnvelope {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                user_id: Uuid::parse_str(row.get::<String, _>("user_id").as_str())?,
                source_user_id: row.get::<Option<String>, _>("source_user_id").map(|s| Uuid::parse_str(s.as_str()).ok()).flatten(),
                message: serde_json::from_str(&row.get::<String, _>("message_serialized"))?,
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
                seen: row.get("seen"),
            })
        }).collect();

        messages
    }

    pub async fn get_message_history_after(
        &self,
        user_id: &Uuid,
        other_user_id: &Uuid,
        after: i64,
        options: PagingOptions,
    ) -> Result<Vec<MessageEnvelope>> {
        // Query the messages between the two users after a certain timestamp
        let rows = sqlx::query("
            SELECT
                id,
                user_id,
                source_user_id,
                message_serialized,
                seen,
                created_at,
                created_at_int
            FROM
                message
            WHERE
                ((user_id = ? AND source_user_id = ?)
                OR (user_id = ? AND source_user_id = ?))
            AND
                created_at_int > ?
            ORDER BY created_at_int ASC
            LIMIT ? OFFSET ?
            ")
            .bind(user_id.to_string())
            .bind(other_user_id.to_string())
            .bind(other_user_id.to_string())
            .bind(user_id.to_string())
            .bind(after)
            .bind(options.limit.unwrap_or(100))
            .bind(options.offset.unwrap_or(0))
            .fetch_all(&self.pool).await?;

        // Map the rows to MessageEnvelope
        let messages: Result<Vec<MessageEnvelope>, _> = rows.into_iter().map(|row| {
            Ok(MessageEnvelope {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str())?,
                user_id: Uuid::parse_str(row.get::<String, _>("user_id").as_str())?,
                source_user_id: row.get::<Option<String>, _>("source_user_id").map(|s| Uuid::parse_str(s.as_str()).ok()).flatten(),
                message: serde_json::from_str(&row.get::<String, _>("message_serialized"))?,
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
                seen: row.get("seen"),
            })
        }).collect();

        messages
    }

    pub async fn mark_message_as_seen(&self, message_id: &Uuid) -> Result<()> {
        // Update the message to mark it as seen
        sqlx::query("UPDATE message SET seen = ? WHERE id = ?")
            .bind(true)
            .bind(message_id.to_string())
            .execute(&self.pool).await?;

        Ok(())
    }

    pub async fn delete_message(&self, message_id: &Uuid) -> Result<()> {
        // Delete the message from the database
        sqlx::query("DELETE FROM message WHERE id = ?")
            .bind(message_id.to_string())
            .execute(&self.pool).await?;

        Ok(())
    }

    pub async fn count_unseen_messages(&self, user_id: &Uuid) -> Result<i64> {
        // Count unseen messages for the user
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message WHERE user_id = ? AND seen = ?")
            .bind(user_id.to_string())
            .bind(false)
            .fetch_one(&self.pool).await?;

        Ok(count.0)
    }

    pub async fn count_unseen_messages_from_user(&self, user_id: &Uuid, from_user_id: &Uuid) -> Result<i64> {
        // Count unseen messages for the user from a specific other user
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message WHERE user_id = ? AND source_user_id = ? AND seen = ?")
            .bind(user_id.to_string())
            .bind(from_user_id.to_string())
            .bind(false)
            .fetch_one(&self.pool).await?;

        Ok(count.0)
    }
}

impl EventListener for MessageService {
    async fn on_event(&self, _event: crate::event::EventEnvelope) -> Result<()> {
        // ok
        Ok(())
    }
}