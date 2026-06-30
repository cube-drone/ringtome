use axum::Json;
use axum::extract::{Path, State, Query};
use uuid::Uuid;
use serde::{Serialize, Deserialize};

use crate::{AppState, AppError, AppOk};
use crate::request_context::RequestContext;
use crate::modules::session::extractors::SessionExtractor;

use crate::paging::PagingOptions;
use super::MessageEnvelope;


// GET /community/:slug/messages/:id
#[axum::debug_handler]
pub async fn get_message(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, message_id)): Path<(String, Uuid)>,
    State(state): State<AppState>
    ) -> Result<Json<Option<MessageEnvelope>>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let message = message_view.get_message(&user_id, &message_id).await?;

    Ok(Json(message))
}


// GET /community/:slug/messages
#[axum::debug_handler]
pub async fn get_messages(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    Query(paging_options): Query<PagingOptions>,
    State(state): State<AppState>
    ) -> Result<Json<Vec<MessageEnvelope>>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let messages = message_view.get_messages(&user_id, paging_options).await?;

    Ok(Json(messages))
}

// GET /community/:slug/messages/count
#[axum::debug_handler]
pub async fn count_messages(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>
    ) -> Result<Json<i64>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let count = message_view.count_unseen_messages(&user_id).await?;

    Ok(Json(count))
}

// GET /community/:slug/messages/after/:timestamp
#[axum::debug_handler]
pub async fn get_messages_after(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, timestamp)): Path<(String, i64)>,
    Query(paging_options): Query<PagingOptions>,
    State(state): State<AppState>
    ) -> Result<Json<Vec<MessageEnvelope>>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let messages = message_view.get_messages_after(&user_id, timestamp, paging_options).await?;

    Ok(Json(messages))
}

// GET /community/:slug/messages/with/:other_user_id
#[axum::debug_handler]
pub async fn get_message_history_between_users(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, other_user_id)): Path<(String, Uuid)>,
    Query(paging_options): Query<PagingOptions>,
    State(state): State<AppState>
    ) -> Result<Json<Vec<MessageEnvelope>>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let messages = message_view.get_message_history_between_users(&user_id, &other_user_id, paging_options).await?;

    Ok(Json(messages))
}

// GET /community/:slug/messages/with/:other_user_id/after/:timestamp
#[axum::debug_handler]
pub async fn get_message_history_after(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, other_user_id, timestamp)): Path<(String, Uuid, i64)>,
    Query(paging_options): Query<PagingOptions>,
    State(state): State<AppState>
    ) -> Result<Json<Vec<MessageEnvelope>>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let messages = message_view.get_message_history_after(&user_id, &other_user_id, timestamp, paging_options).await?;

    Ok(Json(messages))
}

// GET /community/:slug/messages/with/:other_user_id/count
#[axum::debug_handler]
pub async fn count_unseen_messages_from_user(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, other_user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>
    ) -> Result<Json<i64>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let count = message_view.count_unseen_messages_from_user(&user_id, &other_user_id).await?;

    Ok(Json(count))
}

// POST /community/:slug/messages/:id/seen
#[axum::debug_handler]
pub async fn mark_message_as_seen(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, message_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext
    ) -> Result<Json<AppOk>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    message_view.mark_message_as_seen(&message_id, &user_id, Some(&ctx)).await?;

    Ok(Json(AppOk{message: "Seen!".to_string()}))
}

// DELETE /community/:slug/messages/:id
#[axum::debug_handler]
pub async fn delete_message(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, message_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext,
    ) -> Result<Json<AppOk>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    message_view.delete_message(&message_id, &user_id, Some(&ctx)).await?;

    Ok(Json(AppOk{message: "Message deleted".to_string()}))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateMessagePayload {
    pub target_user_id: Uuid,
    pub message: super::Message,
}

// POST /community/:slug/messages
#[axum::debug_handler]
pub async fn create_message(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    Json(payload): Json<CreateMessagePayload>,
) -> Result<Json<AppOk>, AppError> {

    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let message_view = community_db.message_view.clone();

    let envelope = MessageEnvelope {
        id: Uuid::new_v4(),
        user_id: payload.target_user_id.clone(),
        source_user_id: Some(user_id.clone()),
        message: payload.message,
        created_at: chrono::Utc::now().to_rfc3339(),
        created_at_int: chrono::Utc::now().timestamp(),
        seen: false,
    };

    message_view.send_message(
        envelope,
        session.is_admin,
        Some(&ctx)
    ).await?;

    Ok(Json(AppOk{message: "Message created".to_string()}))
}