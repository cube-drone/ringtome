use axum::Json;
use axum::extract::{Path, State};
use anyhow::{Result, anyhow};

use crate::{AppState, AppError};
use crate::modules::session::extractors::SessionExtractor;

use super::CommunityConfig;


// GET /community/:slug/community_settings
#[axum::debug_handler]
pub async fn get_community_settings(
    SessionExtractor{session: _session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>
    ) -> Result<Json<CommunityConfig>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let settings_service = community_db.community_settings_service.clone();

    let config = settings_service.get_config().await?;

    Ok(Json(config))
}

// POST /community/:slug/community_settings
pub async fn update_community_settings(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    Json(new_config): Json<CommunityConfig>,
    ) -> Result<Json<CommunityConfig>, AppError> {

    if !session.is_admin {
        return Err(AppError(anyhow!("403 Only admins can update community settings")));
    }

    let community_db = state.community_service.get_database(&slug).await?;
    let settings_service = community_db.community_settings_service.clone();

    let updated_config = settings_service.update_config(new_config).await?;

    Ok(Json(updated_config))
}