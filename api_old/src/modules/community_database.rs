/*
    So, community.rs manages the database containing the list of all communities,
    but each community has its own, self-contained database with its own user table, audit logs, etc.

    Calling get_database() against the CommunityService in community.rs will return a CommunityDatabaseService instance,
    which is used to interact with the database for that specific community.
*/

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use anyhow::Result;
use sqlx::{SqlitePool, query};
use sqlx::sqlite::SqliteConnectOptions;

use crate::event::CommunityEventSender;
use crate::event::EventListener;
use crate::service_registry::ServiceRegistry;

use super::user::UserService;
use super::user::view::UserView;
use super::audit::AuditService;
use super::messages::MessageService;
use super::messages::view::MessageView;
use super::live::LiveService;
use super::live::view::LiveView;
use super::image::ImageService;
use super::image::view::ImageView;
use super::community_settings::CommunitySettingsService;

// A macro to simplify accessing services from the registry within an async context with access to self.registry.
/*
    Usage:
    let (user_service, message_service) = registry!(self, user_service, message_service);
    let (live_view, audit_service) = registry!(self, live_view, audit_service);
*/
#[macro_export]
macro_rules! registry {
    // same-name fields
    ($this:expr, $($field:ident),+ $(,)?) => {{
        // expands inline; requires an async context and a Result-returning fn because of `?`
        let __db = $this
            .registry
            .community_service()
            .get_database(&$this.community_slug)
            .await?;
        ( $( __db.$field.clone() ),+ )
    }};
}

#[derive(Clone)]
pub struct CommunityDatabaseService {
    pub community_database_connection: SqlitePool,
    pub user_service: UserService,
    pub user_view: UserView,
    pub audit_service: AuditService,
    pub message_service: MessageService,
    pub message_view: MessageView,
    pub live_service: LiveService,
    pub live_view: LiveView,
    pub image_service: ImageService,
    pub image_view: ImageView,
    pub community_settings_service: CommunitySettingsService,
    pub community_slug: String,
}

impl CommunityDatabaseService {

    pub async fn new(config: crate::app_config::Config, community_slug: &str, registry: Arc<dyn ServiceRegistry>, event_sender: mpsc::Sender<crate::event::EventEnvelope>) -> Result<Self> {
        let data_directory = config.clone().data_directory;

        // Create the community folder if it doesn't exist.
        let community_folder_path: PathBuf = data_directory.join(community_slug);
        fs::create_dir_all(&community_folder_path)?;

        // The database filename is based on the community slug.
        let db_name = format!("{}.db", community_slug);

        let options = SqliteConnectOptions::new()
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .filename(community_folder_path.join(db_name))
            .create_if_missing(true);

        // Create the pool. Adjust pool options as desired.
        let pool = SqlitePool::connect_with(options).await?;

        // Set PRAGMA statements.
        query("PRAGMA journal_mode = WAL")
            .execute(&pool)
            .await?;
        query("PRAGMA synchronous = normal")
            .execute(&pool)
            .await?;


        let community_event_sender = CommunityEventSender::new(event_sender.clone(), community_slug.to_string());
        // Create the user service using the same pool.
        let user_service = UserService::new(config.clone(), pool.clone(), registry.clone(), community_event_sender.clone()).await?;
        let user_view = UserView::new(config.clone(), community_slug.to_string(), user_service.clone(), registry.clone(), community_event_sender.clone());
        let audit_service = AuditService::new(config.clone(), pool.clone(), registry.clone()).await?;
        let message_service = MessageService::new(config.clone(), pool.clone(), registry.clone()).await?;
        let message_view = MessageView::new(config.clone(), community_slug.to_string(), message_service.clone(), registry.clone(), community_event_sender.clone());
        let live_service = LiveService::new(config.clone(), registry.clone()).await?;
        let live_view = LiveView::new(config.clone(), community_slug.to_string(), live_service.clone(), registry.clone(), community_event_sender.clone());
        let image_service = ImageService::new(config.clone(), pool.clone(), registry.clone()).await?;
        let image_view = ImageView::new(config.clone(), community_slug.to_string(), image_service.clone(), registry.clone(), community_event_sender.clone(), community_folder_path.clone());
        let community_settings_service = CommunitySettingsService::new(config.clone(), pool.clone(), registry.clone()).await?;

        Ok(Self {
            community_database_connection: pool,
            user_service,
            user_view,
            audit_service,
            community_slug: community_slug.to_string(),
            message_service,
            message_view,
            live_service,
            live_view,
            image_service,
            image_view,
            community_settings_service,
        })
    }

    pub async fn delete(&self) -> Result<()> {
        // Completely eradicate the community database
        let data_directory = crate::app_config::Config::new().data_directory;
        let community_folder_path = data_directory.join(&self.community_slug);

        fs::remove_dir_all(community_folder_path)?;
        Ok(())
    }

    pub async fn close(&self) -> Result<()> {
        // Close the database connection pool
        self.community_database_connection.close().await;
        Ok(())
    }
}

impl EventListener for CommunityDatabaseService {
    async fn on_event(&self, event: crate::event::EventEnvelope) -> Result<()> {

        // pass the event to all event-supporting sub-services:
        // edit: the reason we can't easily get a list of event-supporting services is because
        //  on_event is an async fn, and async fns can't be part of traits that are used as trait objects,
        //  without using something like async-trait, which has its own complications.
        // honestly rather than getting into the weeds with the async-trait crate, it's simpler to just maintain the list here
        self.user_service.on_event(event.clone()).await?;
        self.message_service.on_event(event.clone()).await?;
        self.live_service.on_event(event.clone()).await?;
        self.audit_service.on_event(event.clone()).await?;
        self.image_service.on_event(event.clone()).await?;

        // ok
        Ok(())
    }
}
