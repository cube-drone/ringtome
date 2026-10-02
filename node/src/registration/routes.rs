//! The doors for registration.rs: the policy as a signup screen needs it, and as an
//! administrator changes it.

use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{policy, Mode};
use crate::auth::NodeAdminSession;
use crate::error::AppError;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/registration", get(public_handler))
        .route("/api/admin/registration", get(status_handler).put(set_handler))
        .route("/api/admin/registration/limits", axum::routing::put(set_limits_handler))
        .route("/api/admin/auto-follow", axum::routing::post(crate::starters::add_handler))
        .route("/api/admin/auto-follow/{root}", axum::routing::delete(crate::starters::remove_handler))
}

/// What a signup screen needs to know: whether to offer signing up, and whether to ask for the
/// sign-up password. Public - a stranger at the door is exactly who reads it.
#[derive(Serialize)]
struct PublicPolicy {
    mode: &'static str,
}

async fn public_handler(State(state): State<AppState>) -> Result<Json<PublicPolicy>, AppError> {
    Ok(Json(PublicPolicy { mode: policy(&state).await?.mode.as_str() }))
}

/// Everything the Registration page shows.
#[derive(Serialize)]
struct Status {
    mode: &'static str,
    /// False while the node runs on its kind's default (open server, closed device).
    chosen: bool,
    has_password: bool,
    /// The limits and the group (2026-10-02), and where the node stands against them.
    limits: super::Limits,
    accounts: i64,
    disk_used_pct: Option<i64>,
    /// The people every persona made here begins knowing, the operator's list (starters.rs).
    auto_follow: Vec<crate::starters::AutoFollow>,
}

async fn status_handler(State(state): State<AppState>, _admin: NodeAdminSession) -> Result<Json<Status>, AppError> {
    let policy = policy(&state).await?;
    Ok(Json(Status {
        mode: policy.mode.as_str(),
        chosen: policy.chosen,
        has_password: policy.has_password(),
        limits: super::limits(&state).await?,
        accounts: crate::auth::account_count(&state.node_db).await?,
        disk_used_pct: super::disk_used_pct(&state),
        auto_follow: crate::starters::auto_follow(&state.node_db).await?,
    }))
}

#[derive(Deserialize)]
struct SetLimits {
    #[serde(default)]
    max_accounts: Option<i64>,
    #[serde(default)]
    disk_max_pct: Option<i64>,
    #[serde(default)]
    group_name: Option<String>,
}

async fn set_limits_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    Json(req): Json<SetLimits>,
) -> Result<Json<super::Limits>, AppError> {
    super::set_limits(
        &state,
        &super::Limits { max_accounts: req.max_accounts, disk_max_pct: req.disk_max_pct, group_name: req.group_name },
    )
    .await?;
    Ok(Json(super::limits(&state).await?))
}

#[derive(Deserialize)]
struct SetPolicy {
    mode: String,
    /// The sign-up password: required the first time `password` is chosen, optional after.
    #[serde(default)]
    password: Option<String>,
}

fn mode_from(s: &str) -> Result<Mode, AppError> {
    Mode::parse(s).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("registration.routes.unknown-mode", "sign-ups are open, password, or closed"))
    })
}

async fn set_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    Json(req): Json<SetPolicy>,
) -> Result<Json<PublicPolicy>, AppError> {
    let policy = super::set(&state, mode_from(&req.mode)?, req.password.as_deref()).await?;
    Ok(Json(PublicPolicy { mode: policy.mode.as_str() }))
}
