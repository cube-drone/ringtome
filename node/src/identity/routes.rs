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
        .route("/api/identity/{root}/keys", get(keys_handler))
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

/// Identity creation response. `recovery_secret` appears here and **nowhere else, ever** - the
/// node does not keep it. The client owns the "put the spare key somewhere safe" ceremony.
#[derive(Serialize)]
struct CreatedIdentityInfo {
    root_pubkey: String,
    created_at_ms: i64,
    recovery_pubkey: String,
    recovery_secret: String,
    authorize_entry_hash: String,
}

/// Create a new identity owned by the logged-in account, minting its recovery key.
async fn create_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Json<CreatedIdentityInfo>, AppError> {
    let created = super::create(
        &state.node_db,
        &state.keystore,
        &state.user_dbs,
        &session.account.id,
    )
    .await?;
    Ok(Json(CreatedIdentityInfo {
        root_pubkey: created.root_pubkey,
        created_at_ms: created.created_at_ms,
        recovery_pubkey: created.recovery_pubkey,
        recovery_secret: created.recovery_secret,
        authorize_entry_hash: created.authorize_entry_hash,
    }))
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
///
/// Local-test only, like the SQL passthrough: the *operation* has real production triggers
/// (view-schema migrations, repudiation/fork aftermath, corruption repair), but they all call
/// `imaol::rebuild_views` internally - this HTTP surface has no production caller until an
/// operator/admin surface exists, and it is deliberately non-transactional (readers mid-rebuild
/// see partial views; a failed rebuild leaves them wiped - loud by design for a debug tool).
/// When it returns as an admin action, it returns transactional.
async fn rebuild_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<RebuildResponse>, AppError> {
    if !state.config.local_test {
        // Uniform 404: on a production node this endpoint does not exist.
        return Err(AppError::NotFound("not found".into()));
    }
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

#[derive(Serialize)]
struct KeyInfo {
    pubkey: String,
    status: &'static str,
    rank_path: Vec<u64>,
}

#[derive(Serialize)]
struct KeyTreeResponse {
    root_pubkey: String,
    keys: Vec<KeyInfo>,
    forks: usize,
}

/// The identity's resolved key tree: every known key with its status and rank path, plus a fork
/// count (any nonzero value is evidence of key duplication or compromise).
async fn keys_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<KeyTreeResponse>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    let tree = imaol::load_key_tree(&db, &root).await?;

    let keys = tree
        .members()
        .map(|(pk, status)| KeyInfo {
            pubkey: hex::encode(pk),
            status: status.name(),
            rank_path: tree.rank_path(pk).unwrap_or_default().to_vec(),
        })
        .collect();

    Ok(Json(KeyTreeResponse {
        root_pubkey: root,
        keys,
        forks: tree.forks().len(),
    }))
}
