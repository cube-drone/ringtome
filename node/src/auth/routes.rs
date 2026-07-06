//! HTTP routes for the auth substrate: register, login, logout, whoami.

use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};

use super::extractor::{Session, SESSION_COOKIE};
use super::{delete_session, is_username_taken, login, register};
use crate::error::AppError;
use crate::request_context::RequestContext;
use crate::AppState;

/// New accounts allowed per IP per hour (when the caller's IP is visible). Deliberately low.
const REGISTER_LIMIT: u32 = 2;
const HOUR_SECS: u64 = 3600;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/whoami", get(whoami_handler))
        .route("/api/auth/check-username", get(check_username_handler))
}

#[derive(Deserialize)]
struct Credentials {
    username: String,
    password: String,
}

#[derive(Serialize)]
struct AccountInfo {
    id: String,
    username: String,
}

#[derive(Deserialize)]
struct UsernameQuery {
    username: String,
}

#[derive(Serialize)]
struct UsernameAvailability {
    available: bool,
}

/// Build the session cookie. HttpOnly and SameSite=Lax; Secure is omitted so it works over plain
/// HTTP on localhost (a node behind TLS terminates upstream). Path=/ so it covers the whole API.
fn session_cookie(token: String) -> Cookie<'static> {
    Cookie::build((SESSION_COOKIE, token))
        .http_only(true)
        .same_site(SameSite::Lax)
        .path("/")
        .build()
}

async fn register_handler(
    State(state): State<AppState>,
    ctx: RequestContext,
    Json(creds): Json<Credentials>,
) -> Result<Json<AccountInfo>, AppError> {
    state
        .rate_limiter
        .check(
            "register",
            &ctx.rate_limit_identifier(),
            REGISTER_LIMIT,
            HOUR_SECS,
        )
        .await?;

    let account = register(&state.node_db, &creds.username, &creds.password).await?;
    Ok(Json(AccountInfo {
        id: account.id.to_string(),
        username: account.username,
    }))
}

/// Fast "is this username available?" check for signup UX. Returns 400 if the username isn't a
/// valid slug (so the client can show the format error), otherwise `{ available: bool }`.
async fn check_username_handler(
    State(state): State<AppState>,
    Query(q): Query<UsernameQuery>,
) -> Result<Json<UsernameAvailability>, AppError> {
    let taken = is_username_taken(&state.node_db, &q.username).await?;
    Ok(Json(UsernameAvailability { available: !taken }))
}

async fn login_handler(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(creds): Json<Credentials>,
) -> Result<(CookieJar, Json<AccountInfo>), AppError> {
    let token = login(&state.node_db, &creds.username, &creds.password).await?;

    // Re-resolve so we return the canonical account info alongside the cookie.
    let account = super::account_for_token(&state.node_db, &token)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("session vanished after creation")))?;

    let jar = jar.add(session_cookie(token));
    Ok((
        jar,
        Json(AccountInfo {
            id: account.id.to_string(),
            username: account.username,
        }),
    ))
}

async fn logout_handler(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<CookieJar, AppError> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        delete_session(&state.node_db, cookie.value())
            .await
            .map_err(AppError::Internal)?;
    }
    // Clear the cookie regardless.
    Ok(jar.remove(Cookie::from(SESSION_COOKIE)))
}

async fn whoami_handler(session: Session) -> Json<AccountInfo> {
    Json(AccountInfo {
        id: session.account.id.to_string(),
        username: session.account.username,
    })
}
