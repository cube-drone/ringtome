//! HTTP routes for the auth substrate: register, login, logout, whoami.

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use serde::{Deserialize, Serialize};

use super::extractor::{session_cookie_name, AdminSession, NodeAdminSession, Session};
use super::{
    account_by_username, add_tag, delete_session, has_tag, is_username_taken, login, register,
    remove_tag, tags_for, TAG_NODE_ADMIN,
};
use crate::error::AppError;
use crate::request_context::RequestContext;
use crate::AppState;

/// New accounts allowed per IP per hour (when the caller's IP is visible). Deliberately low.
const REGISTER_LIMIT: u32 = 2;
/// Spare-key recovery attempts per IP per hour. Stricter than register: every attempt is a
/// guess at a 256-bit secret, so honest users need one or two and everyone else is probing.
const RECOVER_LIMIT: u32 = 5;
const HOUR_MS: i64 = 60 * 60 * 1000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/auth/register", post(register_handler))
        .route("/api/auth/login", post(login_handler))
        .route("/api/auth/logout", post(logout_handler))
        .route("/api/auth/whoami", get(whoami_handler))
        .route("/api/auth/check-username", get(check_username_handler))
        .route("/api/auth/recover", post(recover_handler))
        // Tag administration.
        .route("/api/admin/grant", post(grant_handler))
        .route("/api/admin/revoke", post(revoke_handler))
        .route("/api/admin/tags", get(tags_handler))
        // Sample gated endpoints - exist purely to test the extractors: 200 iff authorized.
        .route("/api/admin/ping", get(admin_ping))
        .route("/api/admin/node/ping", get(node_admin_ping))
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
fn session_cookie(token: String, port: u16) -> Cookie<'static> {
    Cookie::build((session_cookie_name(port), token))
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
        .check_ctx("register", &ctx, REGISTER_LIMIT, HOUR_MS)
        .await?;

    let account = register(
        &state.node_db,
        &creds.username,
        &creds.password,
        state.config.password_min_len(),
        state.config.local_test,
    )
    .await?;
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

#[derive(Deserialize)]
struct RecoverRequest {
    username: String,
    recovery_secret: String,
    new_password: String,
    /// Required only when the proven persona lives on a multi-persona account: the sign-in
    /// name for the fresh account it re-homes into.
    new_username: Option<String>,
}

#[derive(Serialize)]
struct RecoverResponse {
    ok: bool,
    /// True when the persona moved to a fresh account (log in with the NEW name); false for
    /// an in-place reset (same name, new password).
    rehomed: bool,
}

#[derive(Serialize)]
struct RecoverNeedsName {
    message: String,
    needs_new_username: bool,
}

/// Spare-key password reset (Flow A - see `identity::recover_password` for the rules and the
/// named simplifications). No session is minted here: the caller logs in like anyone else
/// afterwards. A 409 means the key proved out but the account holds siblings - resubmit with
/// `new_username` to re-home the proven persona into a fresh account.
async fn recover_handler(
    State(state): State<AppState>,
    ctx: RequestContext,
    Json(req): Json<RecoverRequest>,
) -> Result<Response, AppError> {
    state
        .rate_limiter
        .check_ctx("recover", &ctx, RECOVER_LIMIT, HOUR_MS)
        .await?;

    let outcome = crate::identity::recover_password(
        &state,
        &req.username,
        &req.recovery_secret,
        &req.new_password,
        req.new_username.as_deref(),
    )
    .await?;

    use crate::identity::Recovery;
    Ok(match outcome {
        Recovery::Reset => Json(RecoverResponse {
            ok: true,
            rehomed: false,
        })
        .into_response(),
        Recovery::Rehomed => Json(RecoverResponse {
            ok: true,
            rehomed: true,
        })
        .into_response(),
        Recovery::NeedsNewUsername => (
            StatusCode::CONFLICT,
            Json(RecoverNeedsName {
                message: "this spare key is real, but the account holds more than one persona \
                          - pick a new sign-in name and this one will move into a fresh \
                          account of its own"
                    .into(),
                needs_new_username: true,
            }),
        )
            .into_response(),
    })
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

    let jar = jar.add(session_cookie(token, state.config.port));
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
    let name = session_cookie_name(state.config.port);
    if let Some(cookie) = jar.get(&name) {
        delete_session(&state.node_db, cookie.value())
            .await
            .map_err(AppError::Internal)?;
    }
    // Clear the cookie regardless.
    Ok(jar.remove(Cookie::from(name)))
}

async fn whoami_handler(session: Session) -> Json<AccountInfo> {
    Json(AccountInfo {
        id: session.account.id.to_string(),
        username: session.account.username,
    })
}

#[derive(Deserialize)]
struct TagChange {
    /// Username of the account to grant/revoke the tag on.
    username: String,
    tag: String,
}

/// Grant a tag to an account. Requires admin; granting `node_admin` additionally requires the
/// actor to be a node_admin (admins cannot mint node_admins).
async fn grant_handler(
    admin: AdminSession,
    State(state): State<AppState>,
    Json(req): Json<TagChange>,
) -> Result<Json<AccountInfo>, AppError> {
    let db = &state.node_db;
    authorize_tag_change(db, &admin, &req.tag).await?;

    let target = account_by_username(db, &req.username)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no account \"{}\"", req.username)))?;

    add_tag(db, &target.id, &req.tag).await?;
    Ok(Json(AccountInfo {
        id: target.id.to_string(),
        username: target.username,
    }))
}

/// Revoke a tag from an account. Same authorization rule as granting.
async fn revoke_handler(
    admin: AdminSession,
    State(state): State<AppState>,
    Json(req): Json<TagChange>,
) -> Result<Json<AccountInfo>, AppError> {
    let db = &state.node_db;
    authorize_tag_change(db, &admin, &req.tag).await?;

    let target = account_by_username(db, &req.username)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no account \"{}\"", req.username)))?;

    remove_tag(db, &target.id, &req.tag).await?;
    Ok(Json(AccountInfo {
        id: target.id.to_string(),
        username: target.username,
    }))
}

/// The tag rule: an `AdminSession` may act on any tag *except* `node_admin`, which requires the
/// actor to actually hold `node_admin`.
async fn authorize_tag_change(
    db: &crate::db::Db,
    admin: &AdminSession,
    tag: &str,
) -> Result<(), AppError> {
    if tag == TAG_NODE_ADMIN && !has_tag(db, &admin.account.id, TAG_NODE_ADMIN).await? {
        return Err(AppError::Forbidden(
            "only a node_admin may grant or revoke node_admin".into(),
        ));
    }
    Ok(())
}

#[derive(Serialize)]
struct TagsResponse {
    username: String,
    tags: Vec<String>,
}

/// List the tags on an account. Admin-gated (tags are node-management metadata).
async fn tags_handler(
    _admin: AdminSession,
    State(state): State<AppState>,
    Query(q): Query<UsernameQuery>,
) -> Result<Json<TagsResponse>, AppError> {
    let db = &state.node_db;
    let target = account_by_username(db, &q.username)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no account \"{}\"", q.username)))?;
    let tags = tags_for(db, &target.id).await?;
    Ok(Json(TagsResponse {
        username: target.username,
        tags,
    }))
}

/// Sample endpoints for testing the extractors: return 200 iff the caller is authorized.
async fn admin_ping(_admin: AdminSession) -> &'static str {
    "ok"
}

async fn node_admin_ping(_admin: NodeAdminSession) -> &'static str {
    "ok"
}
