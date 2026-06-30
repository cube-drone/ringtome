use axum::Json;
use axum::extract::{State};
use serde::{Deserialize};

use crate::{AppState, AppError, AppOk};

// POST /admin/flush
/// Flushes the event queue, ensuring all events are processed before continuing.
#[axum::debug_handler]
pub async fn flush_event_queue(
    State(state): State<AppState>,
) -> Result<Json<AppOk>, AppError> {

    let admin_service = state.admin_service.clone();
    admin_service.flush_event_queue().await?;

    Ok(Json(AppOk{
        message: "FLOOSH!".to_string()
    }))
}


#[derive(Debug, Clone, Deserialize)]
pub struct TestStart {
    pub name: String,
}

// POST /admin/start_test
/// At the beginning of a test, we call "start_test" to print a huge "STARTING TEST" message to the log.
/// Because tests are run serially, this is a good way to match up log messages with test cases.
#[axum::debug_handler]
pub async fn start_test(
    State(state): State<AppState>,
    Json(test_start): Json<TestStart>,
) -> Result<Json<AppOk>, AppError> {

    let admin_service = state.admin_service.clone();
    admin_service.start_test(&test_start.name).await?;

    Ok(Json(AppOk{
        message: "STARTING TEST".to_string()
    }))
}

// POST /admin/donk
/// To test the event system, we can send a "donk" event.
/// When the "donk" event is received by the AdminService, it will increment the donk count.
/// The "donk" counter is not incremented UNTIL the event is fully processed.
/// This is useful for testing the event system and ensuring that events are processed correctly.
#[axum::debug_handler]
pub async fn donk(
    State(state): State<AppState>,
) -> Result<Json<AppOk>, AppError> {

    let admin_service = state.admin_service.clone();
    admin_service.donk().await?;

    Ok(Json(AppOk{
        message: "DONK!".to_string()
    }))
}

// POST /admin/donk/count
/// Returns the current donk count.
#[axum::debug_handler]
pub async fn get_donk_count(
    State(state): State<AppState>,
) -> Result<Json<u32>, AppError> {

    let admin_service = state.admin_service.clone();
    let count = admin_service.get_donk_count().await?;

    Ok(Json(count))
}