//! An account, as a node administrator sees it (Curtis, 2026-10-20): reached from any persona's
//! page here, it lists every persona the account manages, and holds the two things an
//! administrator may do to it - switch its sign-in off (and back on), or evict it outright.
//!
//! **Switching sign-in off** stops every door in at once - a password, a session already open, an
//! API key, a spare-key reset or re-homing (auth.rs's `sign_in_off`, asked at each) - and ends the
//! sessions it held. Nothing else changes: its personas stay hosted, keep syncing and stay
//! readable, so switching it back on gives the person everything back.
//!
//! **Evicting** is the farewell flow's detach (identity.rs) for every persona the account
//! manages, and then the account itself, with the rows other modules keep for it (its API keys,
//! its adoptions between steps). Nothing is signed: each persona goes on existing everywhere else
//! that holds it, and what this node held of it becomes an ordinary mirror, which the mirror
//! sweep (eviction.rs) collects once nobody here wants it. A persona this node was the only home
//! of survives only in other people's copies and its spare key.
//!
//! Neither is done to the administrator's own account, nor to another administrator's: taking
//! their administrator status away comes first, so no server is ever left with nobody to run it.
//! Every door here is the node administrator's alone (`NodeAdminSession`).

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::NodeAdminSession;
use crate::error::AppError;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/admin/accounts/{id}", get(view_handler).delete(evict_handler))
        .route("/api/admin/accounts/of/{root}", get(of_handler))
        .route("/api/admin/accounts/{id}/sign-in", post(sign_in_handler))
}

/// One persona the account manages.
#[derive(Serialize)]
struct Persona {
    root: String,
    name: Option<String>,
    created_ms: i64,
    /// What it costs to move, and what evicting it would free (storage.rs), once tallied.
    storage: Option<crate::storage::Standing>,
}

#[derive(Serialize)]
struct View {
    id: String,
    username: String,
    created_ms: i64,
    /// Since when its sign-in has been switched off; None while it signs in.
    sign_in_off_ms: Option<i64>,
    /// An administrator's account: neither switched off nor evicted from here.
    admin: bool,
    /// The viewer's own account.
    yours: bool,
    personas: Vec<Persona>,
}

async fn record(state: &AppState, id: &str) -> Result<crate::auth::AccountRecord, AppError> {
    crate::auth::account_record(&state.node_db, id).await?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("accounts.no-such-account", "there's no such account here"))
    })
}

async fn view(state: &AppState, viewer: &Uuid, id: &str) -> Result<View, AppError> {
    let account = record(state, id).await?;
    let mine = crate::identity::list_for_account(&state.node_db, &account.id).await?;
    let roots: Vec<String> = mine.iter().map(|i| i.root_pubkey.clone()).collect();
    let bylines =
        crate::profiles::bylines(&state.node_db, &roots).await.map_err(AppError::Internal)?;
    let storage = crate::storage::all(&state.node_db).await.map_err(AppError::Internal)?;
    let personas = mine
        .into_iter()
        .map(|i| Persona {
            name: bylines.get(&i.root_pubkey).and_then(|b| b.name.clone()),
            storage: storage.get(&i.root_pubkey).cloned(),
            created_ms: i.created_at_ms,
            root: i.root_pubkey,
        })
        .collect();
    Ok(View {
        id: account.id.to_string(),
        admin: crate::auth::has_tag(&state.node_db, &account.id, crate::auth::TAG_NODE_ADMIN)
            .await?,
        yours: &account.id == viewer,
        username: account.username,
        created_ms: account.created_at_ms,
        sign_in_off_ms: account.sign_in_off_ms,
        personas,
    })
}

/// The account an administrator may act on: neither their own nor another administrator's.
async fn actionable(
    state: &AppState,
    admin: &NodeAdminSession,
    id: &str,
) -> Result<crate::auth::AccountRecord, AppError> {
    let account = record(state, id).await?;
    if account.id == admin.account.id {
        return Err(AppError::BadRequest(crate::msg!(
            "accounts.thats-your-own-account",
            "that's your own account"
        )));
    }
    if crate::auth::has_tag(&state.node_db, &account.id, crate::auth::TAG_NODE_ADMIN).await? {
        return Err(AppError::BadRequest(crate::msg!(
            "accounts.take-their-administrator-status-first",
            "that account runs this server too - take its administrator status away first"
        )));
    }
    Ok(account)
}

/// GET `/api/admin/accounts/{id}`.
async fn view_handler(
    State(state): State<AppState>,
    admin: NodeAdminSession,
    Path(id): Path<String>,
) -> Result<Json<View>, AppError> {
    Ok(Json(view(&state, &admin.account.id, &id).await?))
}

/// GET `/api/admin/accounts/of/{root}` - the account that manages a persona hosted here: what a
/// persona's page asks, to offer its administrator the way to the account. 404 for anyone else's.
async fn of_handler(
    State(state): State<AppState>,
    admin: NodeAdminSession,
    Path(root): Path<String>,
) -> Result<Json<View>, AppError> {
    let hosted = crate::identity::hosted_roots_with_accounts(&state.node_db).await?;
    let Some((_, account)) = hosted.into_iter().find(|(r, _)| *r == root) else {
        return Err(AppError::NotFound(crate::msg!(
            "accounts.nobody-here-manages-that-persona",
            "no account here manages that persona"
        )));
    };
    Ok(Json(view(&state, &admin.account.id, &account.to_string()).await?))
}

#[derive(Deserialize)]
struct SignIn {
    /// False switches it off; true back on.
    on: bool,
}

/// POST `/api/admin/accounts/{id}/sign-in` `{on}`.
async fn sign_in_handler(
    State(state): State<AppState>,
    admin: NodeAdminSession,
    Path(id): Path<String>,
    Json(req): Json<SignIn>,
) -> Result<Json<View>, AppError> {
    let account = actionable(&state, &admin, &id).await?;
    crate::auth::set_sign_in_off(&state.node_db, &account.id.to_string(), !req.on).await?;
    tracing::info!(account = %account.id, on = req.on, by = %admin.account.id, "an administrator switched an account's sign-in");
    Ok(Json(view(&state, &admin.account.id, &id).await?))
}

#[derive(Serialize)]
struct Evicted {
    /// The personas that left this node with it.
    personas: Vec<String>,
}

/// DELETE `/api/admin/accounts/{id}` - evict the account: every persona it manages detached, then
/// the account and what other modules keep for it.
async fn evict_handler(
    State(state): State<AppState>,
    admin: NodeAdminSession,
    Path(id): Path<String>,
) -> Result<Json<Evicted>, AppError> {
    let account = actionable(&state, &admin, &id).await?;
    let id = account.id.to_string();
    // Its doors shut first, so nothing it does mid-eviction lands on a half-gone account.
    crate::auth::set_sign_in_off(&state.node_db, &id, true).await?;
    let mut personas = Vec::new();
    for persona in crate::identity::list_for_account(&state.node_db, &account.id).await? {
        crate::identity::detach(&state.node_db, &account.id, &persona.root_pubkey).await?;
        personas.push(persona.root_pubkey);
    }
    crate::auth::keys::forget_account(&state.node_db, &id).await?;
    crate::identity::adoption::forget_account(&state, &id).await?;
    crate::auth::remove_account(&state.node_db, &id).await?;
    tracing::info!(account = %id, personas = personas.len(), by = %admin.account.id, "an administrator evicted an account");
    Ok(Json(Evicted { personas }))
}
