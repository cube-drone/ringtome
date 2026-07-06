//! Node accounts and sessions - the thin, identity-agnostic authentication substrate.
//!
//! An account is a login on this node (username + Argon2 password). A session is an opaque
//! server-side token stored in `node.db`; the cookie carries only the random token, this table is
//! the source of truth, and logout is a row delete (instant, authoritative revocation).
//!
//! Deliberately thin: right now a session authenticates you as *an account* and nothing more. The
//! account -> identity link (which identities an account may act as, and unlocking that identity's
//! key for signing) attaches later, when the identity layer exists. See the TODO seam below.

mod extractor;
mod routes;

pub use routes::router;

use anyhow::{anyhow, Context, Result};
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::Argon2;
use rand::RngCore;
use sqlx::SqlitePool;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use crate::error::AppError;

/// Full node administrator: may grant/revoke any tag, including `node_admin` itself. The first
/// account created on a node is made a `node_admin` automatically.
pub const TAG_NODE_ADMIN: &str = "node_admin";
/// Administrator: may grant/revoke any tag *except* `node_admin`.
pub const TAG_ADMIN: &str = "admin";

/// How long a freshly-created session is valid.
const SESSION_TTL_MS: i64 = 1000 * 60 * 60 * 24 * 30; // 30 days
/// Session token entropy.
const TOKEN_BYTES: usize = 32;

/// The authenticated account behind a session. (Intentionally minimal - identity binding is not
/// here yet.)
#[derive(Debug, Clone)]
pub struct Account {
    pub id: Uuid,
    pub username: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("hashing password: {e}"))
}

fn verify_password(password: &str, phc: &str) -> bool {
    match PasswordHash::new(phc) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut bytes);
    // URL/cookie-safe hex.
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Username length bounds.
const USERNAME_MIN: usize = 2;
const USERNAME_MAX: usize = 32;

/// Normalize and validate a username into a canonical slug.
///
/// Usernames are lowercase ASCII slugs: `[a-z0-9]`, plus `-`/`_` as internal separators. Input is
/// lowercased first (so "Curtis" and "curtis" are the same account and can never both exist against
/// the case-sensitive UNIQUE index), then validated - we reject rather than silently strip unknown
/// characters, so what you typed is what you get or a clear error.
pub fn normalize_username(input: &str) -> Result<String, AppError> {
    let name = input.trim().to_ascii_lowercase();

    if name.len() < USERNAME_MIN || name.len() > USERNAME_MAX {
        return Err(AppError::BadRequest(format!(
            "username must be {USERNAME_MIN}-{USERNAME_MAX} characters"
        )));
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(AppError::BadRequest(
            "username may contain only a-z, 0-9, - and _".into(),
        ));
    }
    // Separators can't lead, trail, or double up - keeps slugs clean and unambiguous.
    if name.starts_with(['-', '_']) || name.ends_with(['-', '_']) {
        return Err(AppError::BadRequest(
            "username can't start or end with - or _".into(),
        ));
    }
    if name.contains("--") || name.contains("__") || name.contains("-_") || name.contains("_-") {
        return Err(AppError::BadRequest(
            "username can't contain consecutive separators".into(),
        ));
    }

    Ok(name)
}

/// Register a new account. Fails if the username is taken.
/// Register a new account.
///
/// `skip_admin_bootstrap` disables the "first account becomes node_admin" rule. It is set in
/// local-test mode, where tests have direct DB access (the SQL passthrough) and set up whatever
/// tags they need explicitly - the auto-bootstrap would otherwise make a freshly-registered user's
/// tag state depend on registration order across the shared test node.
pub async fn register(
    db: &SqlitePool,
    username: &str,
    password: &str,
    skip_admin_bootstrap: bool,
) -> Result<Account, AppError> {
    let username = normalize_username(username)?;
    if password.len() < 8 {
        return Err(AppError::BadRequest(
            "password must be at least 8 characters".into(),
        ));
    }

    let id = Uuid::new_v4();
    let phc = hash_password(password).map_err(AppError::Internal)?;

    let result = sqlx::query(
        "INSERT INTO accounts (id, username, password_hash, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(id.to_string())
    .bind(&username)
    .bind(&phc)
    .bind(now_ms())
    .execute(db)
    .await;

    if let Err(e) = result {
        if e.to_string().contains("UNIQUE constraint failed") {
            return Err(AppError::BadRequest(format!(
                "username \"{username}\" is taken"
            )));
        }
        return Err(AppError::Internal(anyhow!("creating account: {e}")));
    }

    // The first account on a node becomes its node_admin. Checked after insert: if this row is the
    // only account, it was first. (A dead-heat between two first-registrations could in principle
    // tag both, but node bootstrap is a single-operator action, not an adversarial race.) Skipped
    // in local-test mode, where tests grant tags explicitly via the SQL passthrough.
    if !skip_admin_bootstrap {
        let (account_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM accounts")
            .fetch_one(db)
            .await
            .context("counting accounts")
            .map_err(AppError::Internal)?;
        if account_count == 1 {
            add_tag(db, &id, TAG_NODE_ADMIN).await?;
            tracing::info!(username = %username, "first account created; granted node_admin");
        }
    }

    Ok(Account {
        id,
        username: username.to_string(),
    })
}

/// Verify credentials and, on success, create a session; returns the session token.
pub async fn login(db: &SqlitePool, username: &str, password: &str) -> Result<String, AppError> {
    // Match the stored slug regardless of the case/whitespace typed. A username that isn't even a
    // valid slug simply won't match any row - fall through to the uniform "invalid credentials".
    let lookup = username.trim().to_ascii_lowercase();
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, password_hash FROM accounts WHERE username = ?1")
            .bind(&lookup)
            .fetch_optional(db)
            .await
            .context("looking up account")
            .map_err(AppError::Internal)?;

    // Uniform failure whether the account is missing or the password is wrong (no user enumeration).
    let (account_id, phc) =
        row.ok_or_else(|| AppError::Unauthorized("invalid credentials".into()))?;
    if !verify_password(password, &phc) {
        return Err(AppError::Unauthorized("invalid credentials".into()));
    }

    let token = generate_token();
    let now = now_ms();
    sqlx::query(
        "INSERT INTO sessions (token, account_id, created_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&token)
    .bind(&account_id)
    .bind(now)
    .bind(now + SESSION_TTL_MS)
    .execute(db)
    .await
    .context("creating session")
    .map_err(AppError::Internal)?;

    Ok(token)
}

/// Resolve a session token to its account, if the token exists and has not expired.
pub async fn account_for_token(db: &SqlitePool, token: &str) -> Result<Option<Account>, AppError> {
    let row: Option<(String, String, i64)> = sqlx::query_as(
        "SELECT a.id, a.username, s.expires_at_ms
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token = ?1",
    )
    .bind(token)
    .fetch_optional(db)
    .await
    .context("resolving session")
    .map_err(AppError::Internal)?;

    match row {
        Some((id, username, expires_at_ms)) if expires_at_ms > now_ms() => {
            let id = Uuid::parse_str(&id)
                .map_err(|e| AppError::Internal(anyhow!("corrupt account id: {e}")))?;
            Ok(Some(Account { id, username }))
        }
        // Expired: opportunistically clean it up.
        Some(_) => {
            let _ = delete_session(db, token).await;
            Ok(None)
        }
        None => Ok(None),
    }
}

/// Delete a session (logout).
pub async fn delete_session(db: &SqlitePool, token: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token = ?1")
        .bind(token)
        .execute(db)
        .await
        .context("deleting session")?;
    Ok(())
}

/// Whether a username is already taken. The input is normalized first, so an invalid slug returns
/// a validation error (the caller can surface "not a valid username" distinctly from "taken").
pub async fn is_username_taken(db: &SqlitePool, username: &str) -> Result<bool, AppError> {
    let name = normalize_username(username)?;
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM accounts WHERE username = ?1")
        .bind(&name)
        .fetch_optional(db)
        .await
        .context("checking username")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// Add a tag to an account (idempotent - re-adding an existing tag is a no-op).
pub async fn add_tag(db: &SqlitePool, account_id: &Uuid, tag: &str) -> Result<()> {
    sqlx::query("INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES (?1, ?2)")
        .bind(account_id.to_string())
        .bind(tag)
        .execute(db)
        .await
        .context("adding account tag")?;
    Ok(())
}

/// Remove a tag from an account.
pub async fn remove_tag(db: &SqlitePool, account_id: &Uuid, tag: &str) -> Result<()> {
    sqlx::query("DELETE FROM account_tags WHERE account_id = ?1 AND tag = ?2")
        .bind(account_id.to_string())
        .bind(tag)
        .execute(db)
        .await
        .context("removing account tag")?;
    Ok(())
}

/// Look up an account by (normalized) username.
pub async fn account_by_username(
    db: &SqlitePool,
    username: &str,
) -> Result<Option<Account>, AppError> {
    let lookup = username.trim().to_ascii_lowercase();
    let row: Option<(String, String)> =
        sqlx::query_as("SELECT id, username FROM accounts WHERE username = ?1")
            .bind(&lookup)
            .fetch_optional(db)
            .await
            .context("looking up account by username")
            .map_err(AppError::Internal)?;

    match row {
        Some((id, username)) => {
            let id = Uuid::parse_str(&id)
                .map_err(|e| AppError::Internal(anyhow!("corrupt account id: {e}")))?;
            Ok(Some(Account { id, username }))
        }
        None => Ok(None),
    }
}

/// Whether an account carries a given tag.
pub async fn has_tag(db: &SqlitePool, account_id: &Uuid, tag: &str) -> Result<bool, AppError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM account_tags WHERE account_id = ?1 AND tag = ?2")
            .bind(account_id.to_string())
            .bind(tag)
            .fetch_optional(db)
            .await
            .context("checking account tag")
            .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// All tags on an account.
pub async fn tags_for(db: &SqlitePool, account_id: &Uuid) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT tag FROM account_tags WHERE account_id = ?1 ORDER BY tag")
            .bind(account_id.to_string())
            .fetch_all(db)
            .await
            .context("reading account tags")
            .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(t,)| t).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn username_normalization() {
        assert_eq!(normalize_username("Curtis").unwrap(), "curtis");
        assert_eq!(normalize_username("  Hat_Fan  ").unwrap(), "hat_fan");
        assert_eq!(normalize_username("cool-name-99").unwrap(), "cool-name-99");

        for bad in [
            "a",             // too short
            "has spaces",    // space
            "-lead",         // leading sep
            "trail_",        // trailing sep
            "double__under", // consecutive sep
            "mix-_up",       // mixed consecutive sep
            "punct!",        // illegal char
            "café",          // non-ascii
        ] {
            assert!(normalize_username(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[tokio::test]
    async fn first_account_becomes_node_admin() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::node_migrator_for_test(&pool).await;

        let first = register(&pool, "founder", "password123", false)
            .await
            .unwrap();
        let second = register(&pool, "latecomer", "password123", false)
            .await
            .unwrap();

        assert!(has_tag(&pool, &first.id, TAG_NODE_ADMIN).await.unwrap());
        assert!(!has_tag(&pool, &second.id, TAG_NODE_ADMIN).await.unwrap());
    }

    #[tokio::test]
    async fn tags_round_trip() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::node_migrator_for_test(&pool).await;

        // Skip the admin bootstrap so this account starts with a clean tag set.
        let account = register(&pool, "tag_tester", "password123", true)
            .await
            .unwrap();

        assert!(tags_for(&pool, &account.id).await.unwrap().is_empty());

        add_tag(&pool, &account.id, "beta").await.unwrap();
        add_tag(&pool, &account.id, "beta").await.unwrap(); // idempotent
        add_tag(&pool, &account.id, "gamma").await.unwrap();

        assert_eq!(
            tags_for(&pool, &account.id).await.unwrap(),
            vec!["beta".to_string(), "gamma".to_string()]
        );

        remove_tag(&pool, &account.id, "beta").await.unwrap();
        assert_eq!(
            tags_for(&pool, &account.id).await.unwrap(),
            vec!["gamma".to_string()]
        );
    }
}
