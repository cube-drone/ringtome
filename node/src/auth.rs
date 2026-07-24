//! Node accounts and sessions - the thin, identity-agnostic authentication substrate.
//!
//! An account is a login on this node (username + Argon2 password). A session is an opaque
//! server-side token stored in `node.db`; the cookie carries only the random token, this table is
//! the source of truth, and logout is a row delete (instant, authoritative revocation).
//!
//! Deliberately thin: a session authenticates you as *an account* and nothing more. The
//! account -> identity link (which identities an account may act as) lives in the identity
//! module, keyed by `identities.account_id`; auth stays identity-agnostic.

mod extractor;
mod routes;

pub use extractor::Session;
pub use routes::router;

use anyhow::{anyhow, Context, Result};
use argon2::password_hash::{
    rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString,
};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use uuid::Uuid;

use crate::clock::now_ms;
use crate::db::Db;
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

/// The Argon2 instance used to hash new passwords. `fast` selects the weakest parameters the
/// format permits (8 KiB, t=1, p=1) - microseconds instead of tens of milliseconds - for
/// local-test mode, where an integration suite that registers and logs in constantly would
/// otherwise spend nearly all its runtime inside the KDF. Only the work factor changes: salt
/// generation, PHC encoding, and verification are the identical code path, and the parameters
/// ride inside the PHC string, so verification always applies whatever parameters a stored hash
/// was created with (weak and strong hashes coexist freely).
fn hasher(fast: bool) -> Argon2<'static> {
    if fast {
        let params = Params::new(
            Params::MIN_M_COST,
            Params::MIN_T_COST,
            Params::MIN_P_COST,
            None,
        )
        .expect("minimal Argon2 params are valid");
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
    } else {
        Argon2::default()
    }
}

fn hash_password(password: &str, fast: bool) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    hasher(fast)
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow!("hashing password: {e}"))
}

/// Enforce the node's password floor (`Config::password_min_len` - 8 facing the network, 1 on
/// a loopback-only node, where a short PIN is an honest posture because reaching the prompt
/// already required physical access).
fn check_password_len(password: &str, min: usize) -> Result<(), AppError> {
    if password.len() >= min {
        return Ok(());
    }
    Err(AppError::BadRequest(if min <= 1 {
        "password can't be empty".into()
    } else {
        format!("password must be at least {min} characters")
    }))
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
///
/// `local_test` adapts registration for the integration-test node in two ways:
/// - Passwords are hashed with minimal Argon2 parameters (see `hasher`), so test suites aren't
///   spending nearly all their runtime inside the KDF.
/// - The "first account becomes node_admin" bootstrap is skipped: tests have direct DB access
///   (the SQL passthrough) and set up whatever tags they need explicitly - the auto-bootstrap
///   would otherwise make a freshly-registered user's tag state depend on registration order
///   across the shared test node.
pub async fn register(
    db: &Db,
    username: &str,
    password: &str,
    min_password_len: usize,
    local_test: bool,
) -> Result<Account, AppError> {
    let username = normalize_username(username)?;
    check_password_len(password, min_password_len)?;

    let id = Uuid::new_v4();
    let phc = hash_password(password, local_test).map_err(AppError::Internal)?;

    let result = db
        .execute(
            "INSERT INTO accounts (id, username, password_hash, created_at_ms) VALUES (?1, ?2, ?3, ?4)",
            (id.to_string(), username.as_str(), phc.as_str(), now_ms()),
        )
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
    if !local_test {
        let (account_count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM accounts", ())
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
pub async fn login(db: &Db, username: &str, password: &str) -> Result<String, AppError> {
    // Match the stored slug regardless of the case/whitespace typed. A username that isn't even a
    // valid slug simply won't match any row - fall through to the uniform "invalid credentials".
    let lookup = username.trim().to_ascii_lowercase();
    let row: Option<(String, String)> = db
        .fetch_optional(
            "SELECT id, password_hash FROM accounts WHERE username = ?1",
            (lookup,),
        )
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
    db.execute(
        "INSERT INTO sessions (token, account_id, created_at_ms, expires_at_ms) VALUES (?1, ?2, ?3, ?4)",
        (token.as_str(), account_id.as_str(), now, now + SESSION_TTL_MS),
    )
    .await
    .context("creating session")
    .map_err(AppError::Internal)?;

    Ok(token)
}

/// Resolve a session token to its account, if the token exists and has not expired.
pub async fn account_for_token(db: &Db, token: &str) -> Result<Option<Account>, AppError> {
    let row: Option<(String, String, i64)> = db
        .fetch_optional(
            "SELECT a.id, a.username, s.expires_at_ms
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.token = ?1",
            (token,),
        )
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
pub async fn delete_session(db: &Db, token: &str) -> Result<()> {
    db.execute("DELETE FROM sessions WHERE token = ?1", (token,))
        .await
        .context("deleting session")?;
    Ok(())
}

/// Look up an account id by username (login's normalization: trim + lowercase; an invalid slug
/// matches no row). `None` is not an error - callers own their uniform-failure story.
pub async fn account_id_by_username(db: &Db, username: &str) -> Result<Option<String>, AppError> {
    let lookup = username.trim().to_ascii_lowercase();
    let row: Option<(String,)> = db
        .fetch_optional("SELECT id FROM accounts WHERE username = ?1", (lookup,))
        .await
        .context("looking up account")
        .map_err(AppError::Internal)?;
    Ok(row.map(|(id,)| id))
}

/// Replace an account's password. Identity-agnostic on purpose: *what evidence justifies this*
/// is the caller's problem (today: the spare-key recovery flow, `identity::recover_password`).
pub async fn set_password(
    db: &Db,
    account_id: &str,
    new_password: &str,
    min_password_len: usize,
    local_test: bool,
) -> Result<(), AppError> {
    check_password_len(new_password, min_password_len)?;
    let phc = hash_password(new_password, local_test).map_err(AppError::Internal)?;
    db.execute(
        "UPDATE accounts SET password_hash = ?1 WHERE id = ?2",
        (phc.as_str(), account_id),
    )
    .await
    .context("updating password")
    .map_err(AppError::Internal)?;
    Ok(())
}

/// Drop every session an account holds - standard hygiene after a password reset, so whoever
/// prompted the reset is the only one still standing (with their fresh login).
pub async fn purge_sessions(db: &Db, account_id: &str) -> Result<(), AppError> {
    db.execute("DELETE FROM sessions WHERE account_id = ?1", (account_id,))
        .await
        .context("purging sessions")
        .map_err(AppError::Internal)?;
    Ok(())
}

/// Whether a username is already taken. The input is normalized first, so an invalid slug returns
/// a validation error (the caller can surface "not a valid username" distinctly from "taken").
pub async fn is_username_taken(db: &Db, username: &str) -> Result<bool, AppError> {
    let name = normalize_username(username)?;
    let row: Option<(i64,)> = db
        .fetch_optional("SELECT 1 FROM accounts WHERE username = ?1", (name,))
        .await
        .context("checking username")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// Add a tag to an account (idempotent - re-adding an existing tag is a no-op).
pub async fn add_tag(db: &Db, account_id: &Uuid, tag: &str) -> Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES (?1, ?2)",
        (account_id.to_string(), tag),
    )
    .await
    .context("adding account tag")?;
    Ok(())
}

/// Remove a tag from an account.
pub async fn remove_tag(db: &Db, account_id: &Uuid, tag: &str) -> Result<()> {
    db.execute(
        "DELETE FROM account_tags WHERE account_id = ?1 AND tag = ?2",
        (account_id.to_string(), tag),
    )
    .await
    .context("removing account tag")?;
    Ok(())
}

/// Look up an account by (normalized) username.
pub async fn account_by_username(db: &Db, username: &str) -> Result<Option<Account>, AppError> {
    let lookup = username.trim().to_ascii_lowercase();
    let row: Option<(String, String)> = db
        .fetch_optional(
            "SELECT id, username FROM accounts WHERE username = ?1",
            (lookup,),
        )
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
pub async fn has_tag(db: &Db, account_id: &Uuid, tag: &str) -> Result<bool, AppError> {
    let row: Option<(i64,)> = db
        .fetch_optional(
            "SELECT 1 FROM account_tags WHERE account_id = ?1 AND tag = ?2",
            (account_id.to_string(), tag),
        )
        .await
        .context("checking account tag")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// All tags on an account.
pub async fn tags_for(db: &Db, account_id: &Uuid) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = db
        .fetch_all(
            "SELECT tag FROM account_tags WHERE account_id = ?1 ORDER BY tag",
            (account_id.to_string(),),
        )
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

    #[test]
    fn fast_hash_verifies_with_the_standard_verifier() {
        // The local-test fast path must differ only in work factor. The parameters travel in the
        // PHC string, so the unchanged verifier has to accept a minimal-params hash - this is the
        // property that lets weak (test) and strong (real) hashes coexist in one table.
        let phc = hash_password("hunter22hunter22", true).unwrap();
        assert!(
            phc.contains("m=8,t=1,p=1"),
            "expected minimal params in {phc}"
        );
        assert!(verify_password("hunter22hunter22", &phc));
        assert!(!verify_password("wrong-password", &phc));

        // And the real path still produces full-strength hashes.
        let strong = hash_password("hunter22hunter22", false).unwrap();
        assert!(
            !strong.contains("m=8,"),
            "default params should not be minimal: {strong}"
        );
        assert!(verify_password("hunter22hunter22", &strong));
    }

    #[tokio::test]
    async fn the_password_floor_follows_the_bind_address() {
        let pool = crate::db::test_node_db().await;

        // The network-facing floor: 8, with the count in the message.
        let err = register(&pool, "cautious", "pin", 8, true).await.unwrap_err();
        assert!(err.to_string().contains("8 characters"), "{err}");

        // The loopback floor: a short PIN is an honest posture on a machine you can touch...
        register(&pool, "cozy", "1234", 1, true).await.unwrap();

        // ...but an empty password is confusion, not a posture.
        let err = register(&pool, "voidling", "", 1, true).await.unwrap_err();
        assert!(err.to_string().contains("empty"), "{err}");

        // The config derivation itself: loopback relaxes, anything else doesn't - including
        // an unparseable bind, which fails closed to the strict floor.
        let mut config = crate::config::Config::from_env();
        config.bind_address = "127.0.0.1".into();
        assert_eq!(config.password_min_len(), 1);
        config.bind_address = "::1".into();
        assert_eq!(config.password_min_len(), 1);
        config.bind_address = "0.0.0.0".into();
        assert_eq!(config.password_min_len(), 8);
        config.bind_address = "localhost".into();
        assert_eq!(config.password_min_len(), 8, "unparseable fails closed");
    }

    #[tokio::test]
    async fn first_account_becomes_node_admin() {
        let pool = crate::db::test_node_db().await;

        let first = register(&pool, "founder", "password123", 8, false)
            .await
            .unwrap();
        let second = register(&pool, "latecomer", "password123", 8, false)
            .await
            .unwrap();

        assert!(has_tag(&pool, &first.id, TAG_NODE_ADMIN).await.unwrap());
        assert!(!has_tag(&pool, &second.id, TAG_NODE_ADMIN).await.unwrap());
    }

    #[tokio::test]
    async fn tags_round_trip() {
        let pool = crate::db::test_node_db().await;

        // Skip the admin bootstrap so this account starts with a clean tag set.
        let account = register(&pool, "tag_tester", "password123", 8, true)
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
