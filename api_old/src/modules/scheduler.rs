use std::fs;
use std::sync::Arc;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::{RwLock, mpsc};
use anyhow::{Result, anyhow};
use uuid::Uuid;
use chrono::{DateTime, Utc};
use sqlx::{SqlitePool, Row};
use sqlx::sqlite::{SqliteRow, SqliteConnectOptions};
use std::collections::HashMap;

use crate::event::EventEnvelope;

use crate::service_registry::ServiceRegistry;

//pub mod routes;

const CREATE_SCHEDULE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS schedule (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_run TEXT NOT NULL,
    last_run_int INTEGER NOT NULL
)
"#;

const SCHEDULE_INDEX_NAME_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS schedule_name_index ON schedule (name)
"#;

pub struct Schedule {
    #[allow(dead_code)]
    pub id: Uuid,
    #[allow(dead_code)]
    pub name: String,
    pub last_run: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub enum HowOften{
    Minutely,
    FiveMinutes,
    FifteenMinutes,
    HalfHourly,
    Hourly,
    Daily,
}

impl HowOften {
    pub fn to_int_seconds(&self) -> u64 {
        match self {
            HowOften::Minutely => 60,
            HowOften::FiveMinutes => 300,
            HowOften::FifteenMinutes => 900,
            HowOften::HalfHourly => 1800,
            HowOften::Hourly => 3600,
            HowOften::Daily => 86400,
        }
    }
}

// The types get rather complicated, so we define some type aliases.
// Look, I'm going to admit it:
//  getting the type signatures right for Async closures was so complicated that I needed ChatGPT to help.
//  I _still_ don't understand why I need to pin a box. Apparently async future return values need to be pinned?
//  This is madness.
pub type DynRegistry = Arc<dyn ServiceRegistry>;
// this is the bit I'm still fuzzy on: a BoxFutureResult is a pinned box containing a dyn Future that returns a Result<()>.
//  I think the right mental model is "here is a place in memory where a result will eventually be stored"?
//  I _think_??!?
pub type BoxFutureResult = Pin<Box<dyn Future<Output = Result<()>> + Send + 'static>>;
// the JobFn type represents a function that takes a DynRegistry and returns a BoxFutureResult.
pub type JobFn = dyn Fn(DynRegistry) -> BoxFutureResult + Send + Sync + 'static;
// this one I kinda get: since a JobFn is a trait object, which is unsized, we need to wrap it in an Arc to make it usable.
pub type JobPointer = Arc<JobFn>;


#[derive(Clone)]
pub struct ScheduleService {
    pub pool: SqlitePool,
    pub config: crate::app_config::Config,
    pub registry: Arc<RwLock<Option<Arc<dyn ServiceRegistry>>>>,
    pub event_sender: mpsc::Sender<EventEnvelope>,
    pub tasks: Arc<RwLock<HashMap<String, (HowOften, JobPointer)>>>,
}

impl ScheduleService {
    /// Creates a new ScheduleService using sqlx’s connection pool.
    pub async fn new(config: crate::app_config::Config, event_sender: mpsc::Sender<EventEnvelope>) -> Result<Self> {

        // Create the data directory if it doesn't exist.
        let data_directory = config.data_directory.clone();
        tracing::info!("Creating data directory: {:?}", data_directory);
        fs::create_dir_all(&data_directory)?;

        let options = SqliteConnectOptions::new()
            .filename(data_directory.join("schedule.db"))
            .create_if_missing(true);

        // Create the pool. Adjust pool options as desired.
        let pool = SqlitePool::connect_with(options).await?;

        // Create tables and indices.
        sqlx::query(CREATE_SCHEDULE_TABLE).execute(&pool).await?;

        // Run PRAGMA statements.
        sqlx::query("PRAGMA journal_mode = WAL").execute(&pool).await?;
        sqlx::query("PRAGMA synchronous = normal").execute(&pool).await?;

        // Create indices.
        for index_sql in vec![
            SCHEDULE_INDEX_NAME_SQL,
        ] {
            sqlx::query(index_sql).execute(&pool).await?;
        }

        Ok(Self {
            pool,
            config: config.clone(),
            registry: Arc::new(RwLock::new(None)),
            event_sender,
            tasks: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub async fn set_registry(&self, registry: Arc<dyn ServiceRegistry>) {
        self.registry.write().await.replace(registry);
    }

    async fn schedule_pointer(&self, name: &str, frequency: HowOften, task: JobPointer) -> Result<()>{
        self.tasks.write().await.insert(name.into(), (frequency, task));

        Ok(())
    }

    pub async fn schedule<F, Fut>(
        &self,
        name: &str,
        frequency: HowOften,
        task: F,
    ) -> Result<()>
    where
        F: Fn(DynRegistry) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<()>> + Send + 'static,
    {
        let job: JobPointer = Arc::new(move |reg: DynRegistry| {
            Box::pin(task(reg))
        });
        self.schedule_pointer(name, frequency, job).await
    }

    async fn get_schedule_by_name(&self, name: &str) -> Result<Option<Schedule>> {
        let row: Option<SqliteRow> = sqlx::query("SELECT * FROM schedule WHERE name = ?")
            .bind(name)
            .fetch_optional(&self.pool)
            .await?;

        if let Some(r) = row {
            let id_str: String = r.try_get("id")?;
            let id = Uuid::parse_str(&id_str)?;
            let name: String = r.try_get("name")?;
            let last_run_str: String = r.try_get("last_run")?;
            let last_run = DateTime::parse_from_rfc3339(&last_run_str)?.with_timezone(&Utc);

            Ok(Some(Schedule {
                id,
                name,
                last_run,
            }))
        } else {
            Ok(None)
        }
    }

    async fn create_schedule(&self, name: &str) -> Result<()> {
        let id = Uuid::new_v4();
        let now = Utc::now();
        sqlx::query("INSERT INTO schedule (id, name, last_run, last_run_int) VALUES (?, ?, ?, ?)")
            .bind(id.to_string())
            .bind(name.to_string())
            .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            // here we use Unix-style timestamps (no microseconds, no milliseconds) because we don't need any more precision
            .bind(now.timestamp())
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn update_schedule_with_current_time(&self, name: &str) -> Result<()> {
        let now = Utc::now();
        sqlx::query("UPDATE schedule SET last_run = ?, last_run_int = ? WHERE name = ?")
            .bind(now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            // here we use Unix-style timestamps (no microseconds, no milliseconds) because we don't need any more precision
            .bind(now.timestamp())
            .bind(name.to_string())
            .execute(&self.pool)
            .await?;

        Ok(())
    }

    async fn create_or_update_schedule(&self, name: &str) -> Result<()> {
        let existing = self.get_schedule_by_name(name).await?;

        if existing.is_none() {
            self.create_schedule(name).await?;
        } else {
            self.update_schedule_with_current_time(name).await?;
        }

        Ok(())
    }

    pub async fn run_schedule(&self) -> Result<()> {
        let tasks = self.tasks.read().await.clone();
        let registry = self.registry.read().await.clone().ok_or_else(|| anyhow!("ServiceRegistry not set"))?;

        for (name, (frequency, task)) in tasks {
            let schedule = self.get_schedule_by_name(&name).await?;

            let should_run = match schedule {
                Some(s) => {
                    let next_run = s.last_run + chrono::Duration::seconds(frequency.to_int_seconds() as i64);
                    Utc::now() >= next_run
                },
                None => true,
            };

            if should_run {
                tracing::info!("Running scheduled task: {}", name);
                let task_clone = task.clone();
                let registry_clone = registry.clone();
                let name_clone = name.clone();
                tokio::spawn(async move {
                    if let Err(e) = (task_clone)(registry_clone).await {
                        tracing::error!("Error running scheduled task {}: {:?}", name, e);
                    }
                });

                self.create_or_update_schedule(&name_clone).await?;
            }
        }

        Ok(())
    }

}
