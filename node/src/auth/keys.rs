//! API keys (Curtis, 2026-09-30: "tokens that I can use to authenticate external clients as me when
//! connecting to this node"). A key is a long random secret, `rtk_` and 64 hex characters, shown
//! once when it is made; an outside program sends it as `Authorization: Bearer rtk_...` and is that
//! account (extractor.rs) - everything a signed-in browser may do, but two things:
//!
//! - **No managing keys.** Making, listing and revoking keys takes a signed-in browser: a stolen
//!   key can't mint itself company, or hide by revoking the others.
//! - **No administering.** `NodeAdminSession` and `AdminSession` refuse a key, even an
//!   administrator's: the server's controls stay behind its sign-in.
//! - **No reshaping a persona** (2026-10-01): creating one, detaching, rebuilding, adopting, authorizing
//!   another node, revoking a key in its tree ([`identity_by_browser`], identity/routes.rs). A key acts
//!   as you for what you make and say, never for what your identity is - a stolen one can't add itself
//!   a node, or cut your devices away.
//!
//! The node keeps only each key's blake3 hash (a key is 256 random bits - nothing to brute-force,
//! so a fast hash is the right one), so its table leaking leaks no working key. Owns the `api_keys`
//! SQL (tests/conventions.rs).

use anyhow::Context;
use axum::extract::{Path, State};
use axum::Json;
use rand::RngCore;
use serde::Deserialize;

use super::extractor::Session;
use super::Account;
use crate::clock::now_ms;
use crate::db::Db;
use crate::error::AppError;
use crate::AppState;

/// What every key starts with, so one is recognisable in a config file or a leak scanner.
pub const KEY_PREFIX: &str = "rtk_";
/// The most keys an account holds at once.
const KEYS_MAX: i64 = 25;
/// A key's name, at most.
const NAME_MAX: usize = 80;
/// How stale "last used" may grow before a request writes it again.
const LAST_USED_EVERY_MS: i64 = 60_000;

fn hash(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}

fn new_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{KEY_PREFIX}{}", hex::encode(bytes))
}

/// The account a key signs in, and the key's id - or None for no such key. Notes the use.
pub async fn account_for_key(db: &Db, key: &str) -> Result<Option<(Account, String)>, AppError> {
    if !key.starts_with(KEY_PREFIX) {
        return Ok(None);
    }
    let row: Option<(String, String, Option<i64>)> = db
        .fetch_optional(
            "SELECT id, account_id, last_used_ms FROM api_keys WHERE key_hash = ?1",
            (hash(key),),
        )
        .await
        .context("reading an api key")
        .map_err(AppError::Internal)?;
    let Some((key_id, account_id, last_used)) = row else { return Ok(None) };
    // The account is auth.rs's to read (tests/conventions.rs).
    let Some(account) = super::account_by_id(db, &account_id).await? else { return Ok(None) };
    let now = now_ms();
    if last_used.is_none_or(|t| now - t > LAST_USED_EVERY_MS) {
        db.execute("UPDATE api_keys SET last_used_ms = ?1 WHERE id = ?2", (now, key_id.as_str()))
            .await
            .context("noting an api key's use")
            .map_err(AppError::Internal)?;
    }
    Ok(Some((account, key_id)))
}

/// Keys are managed from a signed-in browser only (module doc).
pub fn by_browser(session: &Session) -> Result<(), AppError> {
    if session.key.is_some() {
        return Err(AppError::Forbidden(crate::msg!(
            "auth.keys.manage-keys-from-a-browser",
            "API keys are managed from a signed-in browser, not with a key"
        )));
    }
    Ok(())
}

/// A persona's structure - its keys, its nodes, whether it lives here at all - is changed from a
/// signed-in browser only (module doc).
pub fn identity_by_browser(session: &Session) -> Result<(), AppError> {
    if session.key.is_some() {
        return Err(AppError::Forbidden(crate::msg!(
            "auth.keys.identity-by-browser",
            "a persona's keys and homes are changed from a signed-in browser, not with an API key"
        )));
    }
    Ok(())
}

/// GET `/api/auth/keys`: the account's keys - never the keys themselves, which nobody holds.
pub async fn list_handler(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<serde_json::Value>, AppError> {
    by_browser(&session)?;
    let rows: Vec<(String, String, i64, Option<i64>)> = state
        .node_db
        .fetch_all(
            "SELECT id, name, created_ms, last_used_ms FROM api_keys WHERE account_id = ?1 ORDER BY created_ms DESC",
            (session.account.id.to_string(),),
        )
        .await
        .context("listing api keys")
        .map_err(AppError::Internal)?;
    let keys: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, name, created_ms, last_used_ms)| serde_json::json!({ "id": id, "name": name, "created_ms": created_ms, "last_used_ms": last_used_ms }))
        .collect();
    Ok(Json(serde_json::json!({ "keys": keys })))
}

#[derive(Deserialize)]
pub struct NewKey {
    name: String,
}

/// POST `/api/auth/keys`: make one. The answer carries the key - the only time anyone sees it.
pub async fn create_handler(
    State(state): State<AppState>,
    session: Session,
    Json(req): Json<NewKey>,
) -> Result<Json<serde_json::Value>, AppError> {
    by_browser(&session)?;
    let made = mint(&state.node_db, &session.account.id.to_string(), &req.name).await?;
    Ok(Json(serde_json::json!({
        "id": made.id,
        "name": made.name,
        "created_ms": made.created_ms,
        "key": made.key,
    })))
}

/// A key just made: the only moment anyone holds `key` itself.
pub struct Minted {
    pub id: String,
    pub name: String,
    pub created_ms: i64,
    pub key: String,
}

/// Make a key for an account, named `name`. The settings page's door makes them, and so does an
/// AI assistant's connection, consented to from a signed-in browser (oauth.rs) - either way an
/// ordinary key, listed and revoked with the rest. Whoever calls this has already established
/// that a signed-in browser asked.
pub async fn mint(db: &Db, account: &str, name: &str) -> Result<Minted, AppError> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > NAME_MAX {
        return Err(AppError::BadRequest(crate::msg!(
            "auth.keys.name-the-key",
            "give the key a name, up to 80 characters"
        )));
    }
    let (held,): (i64,) = db
        .fetch_one("SELECT COUNT(*) FROM api_keys WHERE account_id = ?1", (account,))
        .await
        .context("counting api keys")
        .map_err(AppError::Internal)?;
    if held >= KEYS_MAX {
        return Err(AppError::BadRequest(crate::msg!(
            "auth.keys.too-many-keys",
            "that's 25 keys already - revoke one first"
        )));
    }
    let key = new_key();
    let id = hex::encode(&blake3::hash(key.as_bytes()).as_bytes()[..8]);
    let created_ms = now_ms();
    db.execute(
        "INSERT INTO api_keys (id, account_id, name, key_hash, created_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
        (id.as_str(), account, name.as_str(), hash(&key), created_ms),
    )
    .await
    .context("making an api key")
    .map_err(AppError::Internal)?;
    tracing::info!(account = %account, key = %id, "made an api key");
    Ok(Minted { id, name, created_ms, key })
}

/// DELETE `/api/auth/keys/{id}`: revoke it - it stops working at once.
pub async fn revoke_handler(
    State(state): State<AppState>,
    session: Session,
    Path(id): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    by_browser(&session)?;
    state
        .node_db
        .execute(
            "DELETE FROM api_keys WHERE id = ?1 AND account_id = ?2",
            (id.as_str(), session.account.id.to_string()),
        )
        .await
        .context("revoking an api key")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "revoked": id })))
}
