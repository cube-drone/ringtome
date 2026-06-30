use tokio;
use tokio::sync::mpsc;
use axum::{
    routing::{get, post, delete},
    http::HeaderMap,
    Router,
    response::{Html, IntoResponse},
    extract::{Path, State, Json},
};
use axum_macros::FromRequest;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;
use tower_http::limit::RequestBodyLimitLayer;
use std::fs;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use tracing::info_span;
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;
use uuid::Uuid;

use crate::app_config::PublicConfig;
use crate::event::EventListener;
use crate::modules::email;
use crate::modules::sms;
use crate::service_registry::ServiceRegistry;

mod app_config;
mod app_error;
mod semver;
mod modules;
mod paging;
mod event;
mod request_context;
mod service_registry;

use app_error::AppError;

const HOME_PAGE: &str = include_str!("../html/index.html");
const JS: &str = include_str!("../js/target/js/bundle.js");
const CSS: &str = include_str!("../js/target/css/bundle.css");

#[derive(Debug, Serialize)]
struct AppOk {
    message: String,
}

#[derive(FromRequest)]
#[from_request(via(Json), rejection(AppError))]
pub struct AppJson<T>(T);


#[derive(Clone)]
pub struct AppState {
    pub config: app_config::Config,
    pub admin_service: modules::admin::AdminService,
    pub community_service: modules::community::CommunityService,
    pub session_service: modules::session::SessionService,
    pub sms_service: sms::SmsService,
    pub email_service: modules::email::EmailService,
    pub scheduling_service: modules::scheduler::ScheduleService,
    pub rate_limiting_service: modules::rate_limiting::RateLimitingService,
    pub event_sender: mpsc::Sender<crate::event::EventEnvelope>,
}

async fn homepage(State(state): State<AppState>) -> Html<String> {
    let version = &state.config.app_version.to_string();
    let environment = if state.config.is_dev() { "dev" } else { "prod" };

    let home_page = HOME_PAGE.to_string()
        .replace("$VERSION$", version)
        .replace("$ENVIRONMENT$", environment);

    Html(home_page)
}

async fn app_js(Path(version): Path<String>, State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let version = semver::semver_to_comparable_integer(&version)?;

    // check if the version is less than or equal to the current app version
    // if it is, return the JS file, otherwise return an error
    // the reason we do this is for caching purposes: we never want to accidentally cache a future version of the js or CSS

    match version {
        version_integer if version_integer <= state.config.app_version_integer => {
            let config = &state.config;
            if config.is_dev() {
                tracing::info!("In dev mode, reloading JS from disk");
                let contents = fs::read_to_string("js/target/js/bundle.js")?;
                Ok(([("Content-Type", "application/javascript")], contents))
            }
            else{
                Ok(([("Content-Type", "application/javascript")], JS.to_string()))
            }
        },
        _ => Err(anyhow::anyhow!("400 Wrong version").into())
    }
}

async fn app_css(Path(version): Path<String>, State(state): State<AppState>) -> Result<impl IntoResponse, AppError> {
    let version = semver::semver_to_comparable_integer(&version)?;

    match version {
        version_integer if version_integer <= state.config.app_version_integer => {
            let config = &state.config;
            if config.is_dev() {
                tracing::info!("In dev mode, reloading CSS from disk");
                let contents = fs::read_to_string("js/target/css/bundle.css")?;
                return Ok(([("Content-Type", "text/css")], contents));
            }
            else{
                return Ok(([("Content-Type", "text/css")], CSS.to_string()));
            }
        },
        _ => Err(anyhow::anyhow!("400 Wrong version").into())

    }
}

async fn reflect_ip(axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<SocketAddr>, headers: HeaderMap) -> String {
    let x_forwarded_for = headers.get("X-Forwarded-For").and_then(|h| h.to_str().ok()).unwrap_or("--not forwarded--");

    tracing::info!("X-Forwarded-For: {}", x_forwarded_for);
    tracing::info!("Reflecting IP: {}", addr.ip());
    format!("Your IP is: {}, forwarded for: {}", addr.ip(), x_forwarded_for)
}

async fn reflect_headers(headers: HeaderMap) -> String {
    let mut header_string = String::new();
    for (name, value) in headers.iter() {
        header_string.push_str(&format!("{}: {}\n", name, value.to_str().unwrap_or("Invalid UTF-8")));
    }
    header_string
}

async fn get_config(State(state): State<AppState>) -> Result<Json<PublicConfig>, AppError> {
    let public_config = app_config::PublicConfig::from(state.config.clone());
    Ok(Json(public_config))
}

#[tokio::main]
async fn main() {

    // get environment variables
    let config = app_config::Config::new();

    // set up logging
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                // add sqlx=debug to this if you want to see the timing for every SQL query
                // or remove the filter entirely to get ABSOLUTELY EVERYTHING
                .unwrap_or_else(|_| format!("{}=debug,tower_http=debug", env!("CARGO_CRATE_NAME")).into()),
        )
        .with(
            tracing_subscriber::fmt::layer()
                .with_span_events(tracing_subscriber::fmt::format::FmtSpan::CLOSE)
                .with_ansi(config.is_dev())     // only use ANSI colors in dev mode (in prod we're logging to a file probably)
        )
        .init();

    tracing::info!("Starting up");

    // Enter a root span named "${CRATE_NAME}" only in production
    // (this is for to make it easy to find all logs from this app in a big log stream)
    // (keep the guard alive for the whole program)
    let _app_span_guard = if config.is_dev() {
        None
    } else {
        Some(tracing::info_span!(env!("CARGO_CRATE_NAME")).entered())
    };

    let app = Router::new();


    // set up the SMS service
    let sms_service = sms::SmsService::new(config.clone()).await;
    // on boot, send a test SMS
    if let Some(phone_number) = config.clone().personal_phone_number{
        tracing::info!("Sending test SMS to {}", phone_number);
        sms_service.send_sms(&phone_number, "Hello, world!").await.unwrap();
    }

    // set up the email service
    let email_service: email::EmailService = email::EmailService::new(config.clone()).await;
    // on boot, send a test email
    if let Some(email_address) = config.clone().personal_email_address{
        tracing::info!("Sending test email to {}", email_address);
        email_service.send_email(&email_address, "Hello, world!", "Hello, world!").await.unwrap();
    }

    // on boot, write to the data directory a file called "boot.txt" with the current timestamp
    let boot_file = config.data_directory.join("boot.txt");
    let boot_message = format!("Booted at {}\n", chrono::Utc::now().to_rfc3339());
    fs::create_dir_all(&config.data_directory).unwrap();
    fs::write(&boot_file, boot_message).unwrap();
    tracing::info!("Wrote boot file to {:?}", boot_file);

    let (event_sender, mut event_receiver) = mpsc::channel::<crate::event::EventEnvelope>(1000);

    let admin_service = modules::admin::AdminService::new(config.clone(), event_sender.clone());
    let community_service = modules::community::CommunityService::new(config.clone(), event_sender.clone()).await.unwrap();
    let session_service = modules::session::SessionService::new(config.clone(), event_sender.clone()).await.unwrap();
    let scheduling_service = modules::scheduler::ScheduleService::new(config.clone(), event_sender.clone()).await.unwrap();
    let rate_limiting_service = modules::rate_limiting::RateLimitingService::new(config.clone()).await.unwrap();

    // set up the modules for our app
    let state = AppState {
        config,
        admin_service,
        community_service,
        sms_service,
        email_service,
        session_service,
        scheduling_service,
        rate_limiting_service,
        event_sender: event_sender.clone(),
    };

    state.community_service.set_registry(Arc::new(state.clone())).await;
    state.session_service.set_registry(Arc::new(state.clone())).await;
    state.scheduling_service.set_registry(Arc::new(state.clone())).await;
    state.rate_limiting_service.set_registry(Arc::new(state.clone())).await;

    // set up the routes
    let app = app
        // VARIOUS HOMEPAGES
        .route("/", get(homepage))
        .route("/home", get(homepage))
        .route("/home/", get(homepage))
        .route("/home/{*wildcard}", get(homepage))
        .route("/community/{*wildcard}", get(homepage))
        // JS, CSS
        .route("/static/{:version}/app.js", get(app_js) )
        .route("/static/{:version}/app.css", get(app_css) )

        // IP
        .route("/reflect-ip", get(reflect_ip))
        .route("/reflect-headers", get(reflect_headers))

        // APP ROUTES: CONFIG
        .route("/api/config", get(get_config))

        // APP ROUTES: ADMIN
        .route("/api/admin/flush", post(modules::admin::routes::flush_event_queue))
        .route("/api/admin/start_test", post(modules::admin::routes::start_test))
        .route("/api/admin/donk", post(modules::admin::routes::donk))
        .route("/api/admin/donk/count", get(modules::admin::routes::get_donk_count))

        // APP ROUTES: WEBFINGER
        .route("/.well-known/webfinger", get(modules::activitypub::routes::webfinger))

        // APP ROUTES: COMMUNITY
        .route("/api/community", get(modules::community::routes::get_communities))
        .route("/api/community", post(modules::community::routes::create_community))
        .route("/api/community/name", post(modules::community::routes::test_name))
        .route("/api/community/{:slug}", get(modules::community::routes::get_community))
        .route("/api/community/{:slug}/admin", post(modules::community::routes::make_admin))

        // APP ROUTES: AUDIT
        .route("/api/community/{:slug}/audit", get(modules::audit::routes::get_audit_logs))

        // APP ROUTES: USER
        .route("/api/community/{:slug}/auth", get(modules::user::routes::get_session))
        .route("/api/community/{:slug}/auth/verify/email", post(modules::user::routes::send_email_verification))
        .route("/api/community/{:slug}/auth/verify/email/complete", post(modules::user::routes::complete_email_verification))
        .route("/api/community/{:slug}/auth/verify/sms", post(modules::user::routes::send_sms_verification))
        .route("/api/community/{:slug}/auth/verify/sms/complete", post(modules::user::routes::complete_sms_verification))
        .route("/api/community/{:slug}/auth/change/password", post(modules::user::routes::change_password))
        .route("/api/community/{:slug}/auth/change/email", post(modules::user::routes::change_email))
        .route("/api/community/{:slug}/auth/change/phone", post(modules::user::routes::change_phone_number))
        .route("/api/community/{:slug}/auth/change/name", post(modules::user::routes::change_name))
        .route("/api/community/{:slug}/invite", get(modules::user::routes::get_invite_codes))
        .route("/api/community/{:slug}/invite", post(modules::user::routes::create_invite_code))
        .route("/api/community/{:slug}/invite/{:invite_code}", post(modules::user::routes::create_user_with_invite_code))
        .route("/api/community/{:slug}/invite/{:invite_code}", delete(modules::user::routes::delete_invite_code))
        .route("/api/community/{:slug}/login", post(modules::user::routes::login))
        .route("/api/community/{:slug}/login/token", post(modules::user::routes::login_token))
        .route("/api/community/{:slug}/login/token/complete", post(modules::user::routes::complete_token_login))
        .route("/api/community/{:slug}/logout", get(modules::user::routes::logout))
        .route("/api/community/{:slug}/users", get(modules::user::routes::get_users))
        .route("/api/community/{:slug}/admin_users", get(modules::user::routes::get_admin_users))
        .route("/api/community/{:slug}/user/{:user_id}", get(modules::user::routes::get_user))
        .route("/api/community/{:slug}/user/{:user_id}", delete(modules::user::routes::delete_user))
        .route("/api/community/{:slug}/slug/{:user_slug}", get(modules::user::routes::get_user_by_slug))
        .route("/api/community/{:slug}/user/{:user_id}/lock", post(modules::user::routes::lock_user))
        .route("/api/community/{:slug}/user/{:user_id}/unlock", post(modules::user::routes::unlock_user))
        .route("/api/community/{:slug}/user/{:user_id}/admin", post(modules::user::routes::make_user_admin))
        .route("/api/community/{:slug}/user/{:user_id}/unadmin", post(modules::user::routes::unmake_user_admin))

        // APP ROUTES: ACTIVITYPUB
        .route("/api/community/{:slug}/user/{:user_slug}/actor", get(modules::activitypub::routes::get_actor))

        // these are just to help with testing (they're only accessible at all in dev mode)
        .route("/api/community/{:slug}/force/verify", post(modules::user::routes::force_verify))
        .route("/api/community/{:slug}/force/admin", post(modules::user::routes::force_admin))

        // APP ROUTES: IMAGE
        .route("/api/community/{:slug}/image", post(modules::image::routes::create_image_multipart))
        .route("/api/community/{:slug}/image_base64", post(modules::image::routes::create_image_base64))
        .route("/api/community/{:slug}/image/{:id}", get(modules::image::routes::get_image))
        .route("/api/community/{:slug}/public/image/{:id}", get(modules::image::routes::get_public_image))

        // APP ROUTES: MESSAGES
        .route("/api/community/{:slug}/messages", get(modules::messages::routes::get_messages))
        .route("/api/community/{:slug}/messages/count", get(modules::messages::routes::count_messages))
        .route("/api/community/{:slug}/messages/after/{:timestamp}", get(modules::messages::routes::get_messages_after))
        .route("/api/community/{:slug}/messages/with/{:other_user_id}", get(modules::messages::routes::get_message_history_between_users))
        .route("/api/community/{:slug}/messages/with/{:other_user_id}/after/{:timestamp}", get(modules::messages::routes::get_message_history_after))
        .route("/api/community/{:slug}/messages/from/{:other_user_id}/count", get(modules::messages::routes::count_unseen_messages_from_user))
        .route("/api/community/{:slug}/messages/{:id}", get(modules::messages::routes::get_message))
        .route("/api/community/{:slug}/messages/{:id}/seen", post(modules::messages::routes::mark_message_as_seen))
        .route("/api/community/{:slug}/messages/{:id}", delete(modules::messages::routes::delete_message))
            // admin-only route to create messages
        .route("/api/community/{:slug}/messages", post(modules::messages::routes::create_message))

        .route("/api/community/{:slug}/settings", get(modules::community_settings::routes::get_community_settings))
        .route("/api/community/{:slug}/settings", post(modules::community_settings::routes::update_community_settings))

        // LIVE CONNECTION STUFFS
        .route("/api/community/{:slug}/live", post(modules::live::routes::create_connection))
        .route("/api/community/{:slug}/live/{:connection_id}/events", get(modules::live::routes::get_live_events))
        .route("/api/community/{:slug}/live_ws", get(modules::live::routes::live_ws))

        // TEST ROUTES
        .route("/test/email", get(email::dump_email))
        .route("/test/email", post(email::test_email))
        .route("/test/sms", get(sms::dump_sms))
        .route("/test/sms", post(sms::test_sms))
        .nest_service("/public/{:version}", ServeDir::new("public").append_index_html_on_directories(true))
        .with_state(state.clone())
        .layer(TraceLayer::new_for_http().make_span_with(|req: &axum::http::Request<_>| {
            info_span!(
                "req",
                method = %req.method(),
                uri = %req.uri(),
                version = ?req.version(),
                c_id = tracing::field::Empty,
                remote_ip = tracing::field::Empty,
                forwarded_for = tracing::field::Empty,
                user_agent = tracing::field::Empty
            )
        }))
        .layer(RequestBodyLimitLayer::new(2 * 1024 * 1024))
        .into_make_service_with_connect_info::<SocketAddr>();

    let state_clone = state.clone();
    tokio::task::spawn(async move {
        // do some background work here
        let event_receiver = &mut event_receiver;
        // loop forever, listening for events and processing them
        loop {
            match event_receiver.recv().await {
                Some(event) => {
                    // for each event, pass it to every service in the state
                    tracing::info!("Received event: {:?}", event);
                    match state_clone.community_service.on_event(event.clone()).await{
                        Err(e) => tracing::error!("CommunityService failed to handle event: {:?}, error: {}", event, e),
                        _ => {}
                    }
                    match state_clone.session_service.on_event(event.clone()).await{
                        Err(e) => tracing::error!("SessionService failed to handle event: {:?}, error: {}", event, e),
                        _ => {}
                    }
                    match state_clone.admin_service.on_event(event.clone()).await{
                        Err(e) => tracing::error!("AdminService failed to handle event: {:?}, error: {}", event, e),
                        _ => {}
                    }
                },
                None => {
                    // Channel closed
                    break;
                }
            }
        }
    });

    let state_clone = state.clone();

    let minutely_job = async move |registry: Arc<dyn ServiceRegistry>| {
        let event_sender = registry.event_sender();
        event_sender.send(crate::event::EventEnvelope{
            user_id: None,
            community_slug: None,
            request_context: None,
            correlation_id: Uuid::new_v4(),
            event: crate::event::Event::Minutely{},
            timestamp: chrono::Utc::now().timestamp(),
        }).await.map_err(|e| anyhow::anyhow!("Failed to send Minutely event: {}", e))?;
        Ok(())
    };
    state_clone.scheduling_service.schedule("Minutely", crate::modules::scheduler::HowOften::Minutely, minutely_job).await.unwrap();

    let five_minute_job = async move |registry: Arc<dyn ServiceRegistry>| {
        let event_sender = registry.event_sender();
        event_sender.send(crate::event::EventEnvelope{
            user_id: None,
            community_slug: None,
            request_context: None,
            correlation_id: Uuid::new_v4(),
            event: crate::event::Event::FiveMinutely{},
            timestamp: chrono::Utc::now().timestamp(),
        }).await.map_err(|e| anyhow::anyhow!("Failed to send FiveMinutes event: {}", e))?;
        Ok(())
    };
    state_clone.scheduling_service.schedule("FiveMinutes", crate::modules::scheduler::HowOften::FiveMinutes, five_minute_job).await.unwrap();

    let fifteen_minute_job = async move |registry: Arc<dyn ServiceRegistry>| {
        let event_sender = registry.event_sender();
        event_sender.send(crate::event::EventEnvelope{
            user_id: None,
            community_slug: None,
            request_context: None,
            correlation_id: Uuid::new_v4(),
            event: crate::event::Event::FifteenMinutely{},
            timestamp: chrono::Utc::now().timestamp(),
        }).await.map_err(|e| anyhow::anyhow!("Failed to send FifteenMinutes event: {}", e))?;
        Ok(())
    };
    state_clone.scheduling_service.schedule("FifteenMinutes", crate::modules::scheduler::HowOften::FifteenMinutes, fifteen_minute_job).await.unwrap();

    let half_hourly_job = async move |registry: Arc<dyn ServiceRegistry>| {
        let event_sender = registry.event_sender();
        event_sender.send(crate::event::EventEnvelope{
            user_id: None,
            community_slug: None,
            request_context: None,
            correlation_id: Uuid::new_v4(),
            event: crate::event::Event::HalfHourly{},
            timestamp: chrono::Utc::now().timestamp(),
        }).await.map_err(|e| anyhow::anyhow!("Failed to send HalfHourly event: {}", e))?;
        Ok(())
    };
    state_clone.scheduling_service.schedule("HalfHourly", crate::modules::scheduler::HowOften::HalfHourly, half_hourly_job).await.unwrap();

    let hourly_job = async move |registry: Arc<dyn ServiceRegistry>| {
        let event_sender = registry.event_sender();
        event_sender.send(crate::event::EventEnvelope{
            user_id: None,
            community_slug: None,
            request_context: None,
            correlation_id: Uuid::new_v4(),
            event: crate::event::Event::Hourly{},
            timestamp: chrono::Utc::now().timestamp(),
        }).await.map_err(|e| anyhow::anyhow!("Failed to send Hourly event: {}", e))?;
        Ok(())
    };
    state_clone.scheduling_service.schedule("Hourly", crate::modules::scheduler::HowOften::Hourly, hourly_job).await.unwrap();

    let daily_job = async move |registry: Arc<dyn ServiceRegistry>| {
        let event_sender = registry.event_sender();
        event_sender.send(crate::event::EventEnvelope{
            user_id: None,
            community_slug: None,
            request_context: None,
            correlation_id: Uuid::new_v4(),
            event: crate::event::Event::Daily{},
            timestamp: chrono::Utc::now().timestamp(),
        }).await.map_err(|e| anyhow::anyhow!("Failed to send Daily event: {}", e))?;
        Ok(())
    };
    state_clone.scheduling_service.schedule("Daily", crate::modules::scheduler::HowOften::Daily, daily_job).await.unwrap();

    tokio::task::spawn(async move {
        let scheduling_service = &state_clone.scheduling_service;
        loop {
            if let Err(e) = scheduling_service.run_schedule().await {
                tracing::error!("Error running scheduled tasks: {:?}", e);
            }
            // sleep for 30 seconds
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });

    // run our app with hyper, listening globally on port 3000^H^H^H^H - the configured port, defaulting to 3000
    let port = state.config.port;
    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", port)).await.unwrap();
    tracing::info!("Listening on 0.0.0.0:{}", port);
    axum::serve(listener, app).await.unwrap();
}
