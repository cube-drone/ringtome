//! API keys (Curtis, 2026-09-30: "tokens that I can use to authenticate external clients as me when
//! connecting to this node"). A key is a long random secret, `rtk_` and 64 hex characters, shown
//! once when it is made; an outside program sends it as `Authorization: Bearer rtk_...` and is that
//! account (extractor.rs) - everything a signed-in browser may do, but two things:
//!
//! - **No managing keys.** Making, listing and revoking keys takes a signed-in browser: a stolen
//!   key can't mint itself company, or hide by revoking the others. One exception, which keeps
//!   both promises: **an hour's key** ([`hour_handler`], 2026-10-11), for an agent's work its MCP
//!   tools don't reach. A key makes a child that stops working an hour after it's made, or the
//!   moment its parent is revoked, and that can't make keys itself - so a stolen key gains nothing
//!   by it that it didn't already hold, and revoking it still ends everything it made.
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
/// How long an hour's key works ([`hour_handler`]).
pub const HOUR_KEY_MS: i64 = 60 * 60 * 1000;
/// The most hour's keys one key holds at once. They don't count toward [`KEYS_MAX`], so an agent
/// asking for them can't use up the keys the person makes.
const HOUR_KEYS_MAX: i64 = 3;

fn hash(key: &str) -> String {
    blake3::hash(key.as_bytes()).to_hex().to_string()
}

fn new_key() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{KEY_PREFIX}{}", hex::encode(bytes))
}

/// A key's row as a request reads it: id, account, last used, expiry, made by an agent, and
/// whether its parent (if it has one) still stands.
type KeyRow = (String, String, Option<i64>, Option<i64>, i64, i64);
/// A key's row as the settings page lists it: id, name, made, last used, expiry.
type ListedRow = (String, String, i64, Option<i64>, Option<i64>);

/// A key that opened: the account it signs in, its id, and whether an agent's tool made it.
pub struct Opened {
    pub account: Account,
    pub id: String,
    /// An hour's key an agent asked for (mcp.rs): what it writes says "ai-agent" (made_with.rs).
    pub by_agent: bool,
}

/// The account a key signs in - or None for no such key, or an hour's key that has run out or
/// whose parent was revoked. Notes the use.
pub async fn account_for_key(db: &Db, key: &str) -> Result<Option<Opened>, AppError> {
    if !key.starts_with(KEY_PREFIX) {
        return Ok(None);
    }
    let row: Option<KeyRow> = db
        .fetch_optional(
            "SELECT k.id, k.account_id, k.last_used_ms, k.expires_ms, k.by_agent,
                    k.parent_id IS NULL OR EXISTS (SELECT 1 FROM api_keys p WHERE p.id = k.parent_id)
             FROM api_keys k WHERE k.key_hash = ?1",
            (hash(key),),
        )
        .await
        .context("reading an api key")
        .map_err(AppError::Internal)?;
    let Some((key_id, account_id, last_used, expires_ms, by_agent, parent_stands)) = row else {
        return Ok(None);
    };
    let now = now_ms();
    if expires_ms.is_some_and(|t| t <= now) || parent_stands == 0 {
        // Run out, or orphaned: gone for good, so its row goes too.
        db.execute("DELETE FROM api_keys WHERE id = ?1", (key_id.as_str(),))
            .await
            .context("forgetting a spent api key")
            .map_err(AppError::Internal)?;
        return Ok(None);
    }
    // The account is auth.rs's to read (tests/conventions.rs).
    let Some(account) = super::account_by_id(db, &account_id).await? else { return Ok(None) };
    if last_used.is_none_or(|t| now - t > LAST_USED_EVERY_MS) {
        db.execute("UPDATE api_keys SET last_used_ms = ?1 WHERE id = ?2", (now, key_id.as_str()))
            .await
            .context("noting an api key's use")
            .map_err(AppError::Internal)?;
    }
    Ok(Some(Opened { account, id: key_id, by_agent: by_agent != 0 }))
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
    let account = session.account.id.to_string();
    forget_spent(&state.node_db, &account).await?;
    let rows: Vec<ListedRow> = state
        .node_db
        .fetch_all(
            "SELECT id, name, created_ms, last_used_ms, expires_ms FROM api_keys WHERE account_id = ?1 ORDER BY created_ms DESC",
            (account,),
        )
        .await
        .context("listing api keys")
        .map_err(AppError::Internal)?;
    let keys: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, name, created_ms, last_used_ms, expires_ms)| serde_json::json!({ "id": id, "name": name, "created_ms": created_ms, "last_used_ms": last_used_ms, "expires_ms": expires_ms }))
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
        .fetch_one(
            "SELECT COUNT(*) FROM api_keys WHERE account_id = ?1 AND parent_id IS NULL",
            (account,),
        )
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
            // With the hour's keys it made, which end with it (module doc).
            "DELETE FROM api_keys WHERE account_id = ?2 AND (id = ?1 OR parent_id = ?1)",
            (id.as_str(), session.account.id.to_string()),
        )
        .await
        .context("revoking an api key")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "revoked": id })))
}

/// Delete an account's hour's keys that have run out, and any whose parent is gone.
async fn forget_spent(db: &Db, account: &str) -> Result<(), AppError> {
    db.execute(
        "DELETE FROM api_keys WHERE account_id = ?1 AND parent_id IS NOT NULL
           AND (expires_ms <= ?2 OR NOT EXISTS (SELECT 1 FROM api_keys p WHERE p.id = api_keys.parent_id))",
        (account, now_ms()),
    )
    .await
    .context("forgetting spent api keys")
    .map_err(AppError::Internal)?;
    Ok(())
}

/// POST `/api/auth/keys/hour`: an hour's key, made with a key (module doc) - what an agent asks
/// for (mcp.rs `hour_key`) to reach a door its tools don't. The answer carries the key, the only
/// time anyone sees it.
pub async fn hour_handler(
    State(state): State<AppState>,
    session: Session,
) -> Result<Json<serde_json::Value>, AppError> {
    let Some(parent) = session.key.as_deref() else {
        return Err(AppError::BadRequest(crate::msg!(
            "auth.keys.hour-from-a-key",
            "an hour's key is made with a key; a browser makes keys in settings"
        )));
    };
    let account = session.account.id.to_string();
    forget_spent(&state.node_db, &account).await?;
    let (parent_name, grandparent): (String, Option<String>) = state
        .node_db
        .fetch_one("SELECT name, parent_id FROM api_keys WHERE id = ?1", (parent,))
        .await
        .context("reading the key that asks")
        .map_err(AppError::Internal)?;
    if grandparent.is_some() {
        return Err(AppError::Forbidden(crate::msg!(
            "auth.keys.hour-makes-none",
            "an hour's key can't make another"
        )));
    }
    let (held,): (i64,) = state
        .node_db
        .fetch_one("SELECT COUNT(*) FROM api_keys WHERE parent_id = ?1", (parent,))
        .await
        .context("counting hour's keys")
        .map_err(AppError::Internal)?;
    if held >= HOUR_KEYS_MAX {
        return Err(AppError::BadRequest(crate::msg!(
            "auth.keys.hour-too-many",
            "this key has {n} hour's keys working already - use one of them",
            n = HOUR_KEYS_MAX
        )));
    }
    let key = new_key();
    let id = hex::encode(&blake3::hash(key.as_bytes()).as_bytes()[..8]);
    let created_ms = now_ms();
    let expires_ms = created_ms + HOUR_KEY_MS;
    // Named for its parent, so the settings page says where it came from.
    let name: String = format!("an hour's key from {parent_name}").chars().take(NAME_MAX).collect();
    state
        .node_db
        .execute(
            "INSERT INTO api_keys (id, account_id, name, key_hash, created_ms, parent_id, expires_ms, by_agent)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (
                id.as_str(),
                account.as_str(),
                name.as_str(),
                hash(&key),
                created_ms,
                parent,
                expires_ms,
                i64::from(session.by_agent),
            ),
        )
        .await
        .context("making an hour's key")
        .map_err(AppError::Internal)?;
    tracing::info!(account = %account, key = %id, parent = %parent, "made an hour's key");
    Ok(Json(serde_json::json!({
        "id": id,
        "name": name,
        "key": key,
        "created_ms": created_ms,
        "expires_ms": expires_ms,
    })))
}
