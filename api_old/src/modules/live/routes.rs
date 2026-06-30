use axum::Json;
use axum::extract::{Path, State, ws::WebSocketUpgrade};
use uuid::Uuid;

use crate::{AppState, AppError};
use crate::request_context::RequestContext;
use crate::modules::session::extractors::SessionExtractor;

use super::LiveEvent;

// POST /community/:slug/live
#[axum::debug_handler]
pub async fn create_connection(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    ) -> Result<Json<Uuid>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let live_view = community_db.live_view.clone();

    let connection_id = live_view.create_connection(&user_id, &ctx).await?;

    Ok(Json(connection_id))
}

// GET /community/:slug/live/:connection_id/events
#[axum::debug_handler]
pub async fn get_live_events(
    SessionExtractor{session: _}: SessionExtractor,
    Path((slug, connection_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ) -> Result<Json<Vec<LiveEvent>>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let live_view = community_db.live_view.clone();

    let events = live_view.get_events_for_connection(&connection_id).await?;

    Ok(Json(events))
}

// GET /community/:slug/live_ws
#[axum::debug_handler]
pub async fn live_ws(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
    ctx: RequestContext,
    ) -> Result<axum::response::Response, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let live_view = community_db.live_view.clone();

    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(e) = live_view.handle_websocket_connection(socket, &user_id, &ctx).await {
            tracing::info!("WebSocket closed with error: {:?}", e);
        }
    }))
}