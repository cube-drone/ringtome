use axum::Json;
use axum::extract::{Path, State, Multipart};
use uuid::Uuid;
use anyhow::{Result, anyhow};

use crate::{AppState, AppError};
use crate::request_context::RequestContext;
use crate::modules::session::extractors::SessionExtractor;



// POST /community/:slug/image (multipart/form-data)
#[axum::debug_handler]
pub async fn create_image_multipart(
    SessionExtractor { session }: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    mut multipart: Multipart,
) -> Result<Json<Uuid>, AppError> {
    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let image_view = community_db.image_view.clone();

    let image = image_view.save_image(&mut multipart, &user_id, &ctx).await?;

    Ok(Json(image.id))
}

#[derive(serde::Deserialize)]
pub struct CreateImageBase64Payload {
    pub image: String, // base64 encoded image data, with data URL prefix (e.g. "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...")
    pub visibility: Option<String>, // "globalpublic", "public" or "private"
}

// POST /community/:slug/image_base64 (application/json)
#[axum::debug_handler]
pub async fn create_image_base64(
    SessionExtractor { session }: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    Json(payload): Json<CreateImageBase64Payload>,
) -> Result<Json<Uuid>, AppError> {
    let user_id = session.user_id.clone();

    let community_db = state.community_service.get_database(&slug).await?;
    let image_view = community_db.image_view.clone();

    let image = image_view.save_image_base64(&payload.image, payload.visibility.as_deref(), &user_id, &ctx).await?;

    Ok(Json(image.id))
}

// GET /community/:slug/image/:id
#[axum::debug_handler]
pub async fn get_image(
    SessionExtractor { session }: SessionExtractor,
    Path((slug, id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<(axum::http::HeaderMap, Vec<u8>), AppError> {
    let community_db = state.community_service.get_database(&slug).await?;
    let image_view = community_db.image_view.clone();

    if let Some(image) = image_view.get_image(&id, &session.user_id, session.is_admin, ctx).await? {
        let image_path = image.file_path.clone();
        let image_data = tokio::fs::read(&image_path).await.map_err(|_| anyhow!("500 Image File Should Exist, But Conspicuously Missing From Hard Disk"))?;

        let mut headers = axum::http::HeaderMap::new();
        //let content_type = content_type_from_ext(&image.ext);
        let content_type = "image/webp"; // it's always webp now, because of the conversion on upload
        headers.insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static(content_type));
        headers.insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"));

        Ok((headers, image_data))
    } else {
        Err(anyhow::anyhow!("404 Image not found").into())
    }
}

// GET /community/:slug/public/image/:id
#[axum::debug_handler]
pub async fn get_public_image(
    Path((slug, id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
) -> Result<(axum::http::HeaderMap, Vec<u8>), AppError> {
    let community_db = state.community_service.get_database(&slug).await?;
    let image_view = community_db.image_view.clone();

    if let Some(image) = image_view.get_public_image(&id).await? {
        let image_path = image.file_path.clone();
        let image_data = tokio::fs::read(&image_path).await.map_err(|_| anyhow!("500 Image File Should Exist, But Conspicuously Missing From Hard Disk"))?;

        let mut headers = axum::http::HeaderMap::new();
        //let content_type = content_type_from_ext(&image.ext);
        let content_type = "image/webp"; // it's always webp now, because of the conversion on upload
        headers.insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static(content_type));
        headers.insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("public, max-age=31536000, immutable"));

        Ok((headers, image_data))
    } else {
        Err(anyhow::anyhow!("404 Image not found").into())
    }
}