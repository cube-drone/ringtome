use std::sync::Arc;
use anyhow::{Result, anyhow};
use sqlx::{SqlitePool, Row};
use uuid::Uuid;
use serde::{Serialize, Deserialize};

use crate::event::EventListener;
use crate::service_registry::ServiceRegistry;
use super::audit::routes::AuditQueryOptions;

pub mod routes;

#[derive(Clone)]
pub struct AuditService {
    pub pool: SqlitePool,
    pub config: crate::app_config::Config,
    pub registry: Arc<dyn ServiceRegistry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Audit {
    pub id: Uuid,
    pub user_id: Option<Uuid>,          // if there's a user id
    pub triggered_by: Option<Uuid>,     // if there's a user that triggered this action
    pub system: String,                 // "user"
    pub action: String,                 // "login", "logout", "create_user", etc.
    pub serialized_event: String,       // additional info about the action
    pub user_agent: Option<String>,     // User-Agent header value
    pub ip: Option<String>,             // IP address of the user
    pub forwarded_for: Option<String>,  // X-Forwarded-For header value
    pub correlation_id: Option<String>, // Correlation ID for tracing
    pub fingerprint: Option<String>,    // Fingerprint of the request
    pub created_at: String,
    pub created_at_int: i64,
}

impl Audit {
    pub fn new(
        user_id: Option<Uuid>,
        triggered_by: Option<Uuid>,
        system: &str,
        action: &str,
        serialized_event: &str,
        user_agent: Option<String>,
        ip: Option<String>,
        forwarded_for: Option<String>,
        correlation_id: Option<String>,
        fingerprint: Option<String>) -> Self {
        let now = chrono::Utc::now();
        Self {
            id: Uuid::new_v4(),
            user_id,
            triggered_by,
            system: system.to_string(),
            action: action.to_string(),
            serialized_event: serialized_event.to_string(),
            user_agent,
            ip,
            forwarded_for,
            correlation_id,
            fingerprint,
            created_at: now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            created_at_int: now.timestamp_micros(),
        }
    }
    pub fn quick(user_id: Option<Uuid>, system: &str, action: &str, serialized_event: &str) -> Self {
        Self::new(user_id, None, system, action, serialized_event, None, None, None, None, None)
    }
}

// convert an EventEnvelope to an Audit
impl From<crate::event::EventEnvelope> for Audit {
    fn from(event: crate::event::EventEnvelope) -> Self {

        // only some events have an admin_user_id
        let triggered_by = event.event.triggered_by();

        // the "serialized_event" is just the whole serialized event
        let serialized_event = serde_json::to_string(&event).unwrap_or_else(|_| "Could not serialize event".to_string());

        if event.request_context.is_none() {
            return Audit {
                id: Uuid::new_v4(),
                user_id: event.user_id,
                triggered_by,
                system: event.event.event_system().to_string(),
                action: event.event.event_type().to_string(),
                serialized_event,
                user_agent: None,
                ip: None,
                forwarded_for: None,
                correlation_id: None,
                fingerprint: None,
                created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                created_at_int: chrono::Utc::now().timestamp_micros(),
            };
        }
        else{
            let ctx = event.request_context.unwrap();
            let fingerprint = format!("{}:{}:{}", ctx.remote_ip, ctx.forwarded_for, ctx.user_agent);
            Audit {
                id: Uuid::new_v4(),
                user_id: event.user_id,
                triggered_by,
                system: event.event.event_system().to_string(),
                action: event.event.event_type().to_string(),
                serialized_event,
                user_agent: Some(ctx.user_agent),
                ip: Some(ctx.remote_ip.to_string()),
                forwarded_for: Some(ctx.forwarded_for),
                correlation_id: Some(ctx.correlation_id.to_string()),
                fingerprint: Some(fingerprint),
                created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                created_at_int: chrono::Utc::now().timestamp_micros(),
            }
        }
    }
}

const CREATE_AUDIT_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS audit (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    system TEXT,
    action TEXT,
    triggered_by TEXT,
    serialized_event TEXT,
    user_agent TEXT,
    correlation_id TEXT,
    fingerprint TEXT,
    created_at TEXT NOT NULL,
    created_at_int INTEGER NOT NULL
)
"#;

// alter table to add "ip" and "forwarded_for" columns if they don't exist
// technically, we could have included this in the original CREATE_AUDIT_TABLE statement, but
//  this is intended to demonstrate how a migration might work in our system
const UPDATE_AUDIT_TABLE_0: &str = r#"
ALTER TABLE audit ADD COLUMN ip TEXT
"#;

const UPDATE_AUDIT_TABLE_1: &str = r#"
ALTER TABLE audit ADD COLUMN forwarded_for TEXT
"#;

const CREATE_AUDIT_INDEX_USER_ID: &str = r#"
CREATE INDEX IF NOT EXISTS audit_user_id_index ON audit(user_id);
"#;

const CREATE_AUDIT_INDEX_CREATED_AT: &str = r#"
CREATE INDEX IF NOT EXISTS audit_created_at_index ON audit(created_at_int);
"#;

const CREATE_AUDIT_INDEX_SYSTEM: &str = r#"
CREATE INDEX IF NOT EXISTS audit_system_index ON audit(system);
"#;

const CREATE_AUDIT_INDEX_TRIGGERED_BY: &str = r#"
CREATE INDEX IF NOT EXISTS audit_triggered_by_index ON audit(triggered_by);
"#;

const CREATE_AUDIT_INDEX_IP: &str = r#"
CREATE INDEX IF NOT EXISTS audit_ip_index ON audit(ip);
"#;

const CREATE_AUDIT_INDEX_FORWARDED_FOR: &str = r#"
CREATE INDEX IF NOT EXISTS audit_forwarded_for_index ON audit(forwarded_for);
"#;

const CREATE_AUDIT_INDEX_FINGERPRINT: &str = r#"
CREATE INDEX IF NOT EXISTS audit_fingerprint_index ON audit(fingerprint);
"#;


impl AuditService {
    pub async fn new(config: crate::app_config::Config, pool: SqlitePool, registry: Arc<dyn ServiceRegistry>) -> Result<Self> {
        // Create the tables.
        // Create the indexes.
        for index_sql in vec![
            CREATE_AUDIT_TABLE,
            UPDATE_AUDIT_TABLE_0,
            UPDATE_AUDIT_TABLE_1,
            CREATE_AUDIT_INDEX_USER_ID,
            CREATE_AUDIT_INDEX_CREATED_AT,
            CREATE_AUDIT_INDEX_SYSTEM,
            CREATE_AUDIT_INDEX_TRIGGERED_BY,
            CREATE_AUDIT_INDEX_IP,
            CREATE_AUDIT_INDEX_FORWARDED_FOR,
            CREATE_AUDIT_INDEX_FINGERPRINT,
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

    pub async fn log(&self, audit: Audit) -> Result<()> {
        // if the user would bother to log it, we might as well also log it
        tracing::info!("Logging audit: {:?}", audit);

        // put it in the database
        sqlx::query("INSERT INTO audit (
            id,
            user_id,
            system,
            action,
            triggered_by,
            serialized_event,
            user_agent,
            ip,
            forwarded_for,
            correlation_id,
            fingerprint,
            created_at,
            created_at_int)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(audit.id.to_string())
            .bind(audit.user_id.map(|uid| uid.to_string()))
            .bind(audit.system)
            .bind(audit.action)
            .bind(audit.triggered_by.map(|uid| uid.to_string()))
            .bind(audit.serialized_event)
            .bind(audit.user_agent)
            .bind(audit.ip)
            .bind(audit.forwarded_for)
            .bind(audit.correlation_id)
            .bind(audit.fingerprint)
            .bind(audit.created_at)
            .bind(audit.created_at_int)
            .execute(&self.pool).await?;

        self.maybe_prune_audit_logs().await?;

        Ok(())
    }

    pub async fn get_audit_logs(&self,
        query_options: AuditQueryOptions,
    ) -> Result<Vec<Audit>> {
        let mut query = "SELECT * FROM audit".to_string();
        let mut conditions = vec![];

        let mut args = vec![];
        if let Some(uid) = query_options.user_id {
            conditions.push("user_id = ?".to_string());
            args.push(uid.to_string());
        }
        if let Some(sys) = query_options.system {
            conditions.push("system = ?".to_string());
            args.push(sys.to_string());
        }
        if let Some(act) = query_options.action {
            conditions.push("action = ?".to_string());
            args.push(act.to_string());
        }
        if let Some(triggered_by) = query_options.triggered_by {
            conditions.push(format!("triggered_by = ?"));
            args.push(triggered_by.to_string());
        }
        if let Some(ip_addr) = query_options.ip {
            //ip can match either the "ip" or "forwarded_for" column
            conditions.push(format!("ip = ?"));
            args.push(ip_addr.to_string());
            conditions.push(format!("forwarded_for = ?"));
            args.push(ip_addr.to_string());
        }
        if let Some(fwd) = query_options.forwarded_for {
            conditions.push(format!("forwarded_for = ?"));
            args.push(fwd.to_string());
        }
        if let Some(fp) = query_options.fingerprint {
            conditions.push(format!("fingerprint = ?"));
            args.push(fp.to_string());
        }

        if !conditions.is_empty() {
            query.push_str(" WHERE ");
            query.push_str(&conditions.join(" AND "));
        }

        query.push_str(" ORDER BY created_at_int DESC");

        let limit = query_options.n.unwrap_or(100);
        let offset = query_options.offset.unwrap_or(0);

        query.push_str(" LIMIT ?");
        args.push(limit.to_string());
        query.push_str(" OFFSET ?");
        args.push(offset.to_string());

        let query = sqlx::query(&query);
        // bind the arguments to the query
        let query = if args.is_empty() {
            query
        } else {
            let mut query = query;
            for arg in args {
                query = query.bind(arg);
            }
            query
        };

        let rows = query.fetch_all(&self.pool).await?;

        // get audits
        let audits = rows.into_iter().map(|row| {
            Audit {
                id: Uuid::parse_str(row.get::<String, _>("id").as_str()).unwrap(),
                user_id: row.get::<Option<String>, _>("user_id").map(|uid| Uuid::parse_str(uid.as_str()).unwrap()),
                triggered_by: row.get::<Option<String>, _>("triggered_by").map(|uid| Uuid::parse_str(uid.as_str()).unwrap()),
                system: row.get("system"),
                action: row.get("action"),
                serialized_event: row.get("serialized_event"),
                user_agent: row.get("user_agent"),
                ip: row.get("ip"),
                forwarded_for: row.get("forwarded_for"),
                correlation_id: row.get("correlation_id"),
                fingerprint: row.get("fingerprint"),
                created_at: row.get("created_at"),
                created_at_int: row.get("created_at_int"),
            }
        }).collect();

        Ok(audits)
    }

    /// This function will run prune_audit_logs about 2% of the time
    pub async fn maybe_prune_audit_logs(&self) -> Result<()> {
        let n: u8 = rand::random::<u8>() % 100;
        if n <= 2 {
            self.prune_audit_logs().await?;
        }
        Ok(())
    }

    /// Every community keeps, at most, 5000 audit logs. (The number can be set higher in the config.)
    /// This function will prune old audit logs to ensure we don't exceed this limit.
    /// It's called after every log entry is created.
    pub async fn prune_audit_logs(&self) -> Result<()> {
        let max_logs = self.config.audit_max_logs;
        sqlx::query("DELETE FROM audit WHERE id IN (
            SELECT id FROM audit ORDER BY created_at_int DESC LIMIT -1 OFFSET ?
        )")
            .bind(max_logs as i64)
            .execute(&self.pool).await?;

        Ok(())
    }

}

impl EventListener for AuditService {
    async fn on_event(&self, event: crate::event::EventEnvelope) -> Result<()> {
        // we want to log EVERY event that comes through
        if !event.event.should_audit() {
            return Ok(());
        }
        let audit: Audit = event.into();
        self.log(audit).await?;
        Ok(())
    }
}