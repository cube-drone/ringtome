//! HTTP routes for identities: create one, list the caller's, and work with an identity's
//! chains - profile get/set, view rebuild, and the raw entry log.
//!
//! Everything under `/api/identity/{root}/...` is owner-gated for M1: the session's account must
//! own the identity. (Public serving of profiles is an M3/M4 concern, arriving with sync.)

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::imaol;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/identity", post(create_handler))
        .route("/api/identity", get(list_handler))
        .route(
            "/api/identity/{root}/profile",
            get(get_profile_handler).post(set_profile_handler),
        )
        .route("/api/identity/{root}/rebuild", post(rebuild_handler))
        .route("/api/identity/{root}/entries", get(entries_handler))
}

/// Profile fields settable in v0. A closed set: the profile is a schema, not a junk drawer.
const ALLOWED_PROFILE_FIELDS: &[&str] = &["name", "bio"];

#[derive(Serialize)]
struct IdentityInfo {
    root_pubkey: String,
    created_at_ms: i64,
}

impl From<super::Identity> for IdentityInfo {
    fn from(i: super::Identity) -> Self {
        Self {
            root_pubkey: i.root_pubkey,
            created_at_ms: i.created_at_ms,
        }
    }
}

/// Create a new identity owned by the logged-in account.
async fn create_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Json<IdentityInfo>, AppError> {
    let identity = super::create(
        &state.node_db,
        &state.keystore,
        &state.user_dbs,
        &session.account.id,
    )
    .await?;
    Ok(Json(identity.into()))
}

/// List the identities owned by the logged-in account.
async fn list_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Json<Vec<IdentityInfo>>, AppError> {
    let identities = super::list_for_account(&state.node_db, &session.account.id).await?;
    Ok(Json(identities.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct SetProfileField {
    field: String,
    value: String,
}

#[derive(Serialize)]
struct SetProfileResponse {
    field: String,
    value: String,
    seq: u64,
    entry_hash: String,
}

/// Set one public-profile field: signs a `profile-set` entry onto the identity's profile chain
/// and folds it into the materialized view.
async fn set_profile_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<SetProfileField>,
) -> Result<Json<SetProfileResponse>, AppError> {
    if !ALLOWED_PROFILE_FIELDS.contains(&req.field.as_str()) {
        return Err(AppError::BadRequest(format!(
            "unknown profile field {:?} (allowed: {})",
            req.field,
            ALLOWED_PROFILE_FIELDS.join(", ")
        )));
    }

    let key = super::load_signing_key(&state.node_db, &state.keystore, &session.account.id, &root)
        .await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;

    let signed = imaol::set_profile_field(&db, &key, &req.field, &req.value).await?;
    Ok(Json(SetProfileResponse {
        field: req.field,
        value: req.value,
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// The identity's materialized public profile.
async fn get_profile_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<imaol::ProfileField>>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(imaol::get_profile(&db).await?))
}

#[derive(Serialize)]
struct RebuildResponse {
    entries_replayed: u64,
}

/// Wipe the materialized views and rebuild them from the signed entries log, re-validating every
/// chain link. The views are caches; this proves it.
async fn rebuild_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<RebuildResponse>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    let entries_replayed = imaol::rebuild_views(&db).await?;
    Ok(Json(RebuildResponse { entries_replayed }))
}

/// The raw entry log, hex-encoded - the debug surface (`ringtome inspect` eats the hex).
async fn entries_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<imaol::StoredEntry>>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(imaol::list_entries(&db).await?))
}
