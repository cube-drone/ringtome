//! Identity creation and lookup.
//!
//! An identity is a root ed25519 keypair. Creating one: generate the keypair, seal its private key
//! to a key file (envelope-encrypted, with the pubkey bound as AEAD associated data), record an
//! `identities` row linking it to the owning account, and materialize its per-user database.
//!
//! This is the thinnest slice: an identity *existing* is just possessing the root key - the root's
//! authority is intrinsic to its name and needs no signed statement to exist. Signing (chain
//! entries, canonical CBOR), the key tree, child keys, and the recovery key all come later, when
//! the identity acts or gains a second device.

mod routes;

pub use routes::router;

use anyhow::{Context, Result};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::error::AppError;
use crate::keystore::Keystore;

/// A created/loaded identity. Public information only; the private key stays in the keystore.
#[derive(Debug, Clone)]
pub struct Identity {
    /// Hex-encoded ed25519 root public key - the identity's global name.
    pub root_pubkey: String,
    pub created_at_ms: i64,
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Create a new identity owned by `account_id`: generate the root keypair, seal the private key,
/// record it, and materialize its per-user database.
pub async fn create(
    node_db: &SqlitePool,
    keystore: &Keystore,
    user_dbs: &crate::db::UserDbManager,
    account_id: &Uuid,
) -> Result<Identity, AppError> {
    // 1. Generate the root keypair. The public key is the identity's name.
    let signing_key = SigningKey::generate(&mut OsRng);
    let pubkey_hex = hex::encode(signing_key.verifying_key().to_bytes());

    // 2. Seal the private key to a key file, binding the pubkey as associated data so a key file
    //    can't be swapped for another identity's.
    keystore
        .store(
            &pubkey_hex,
            &signing_key.to_bytes(),
            pubkey_hex.as_bytes(),
        )
        .context("sealing identity private key")
        .map_err(AppError::Internal)?;

    // 3. Record the identity -> account link.
    let created_at_ms = now_ms();
    sqlx::query(
        "INSERT INTO identities (root_pubkey, account_id, created_at_ms) VALUES (?1, ?2, ?3)",
    )
    .bind(&pubkey_hex)
    .bind(account_id.to_string())
    .bind(created_at_ms)
    .execute(node_db)
    .await
    .context("recording identity")
    .map_err(AppError::Internal)?;

    // 4. Materialize the per-user database (opens + migrates it).
    user_dbs
        .get(&pubkey_hex)
        .await
        .context("creating per-user database")
        .map_err(AppError::Internal)?;

    tracing::info!(root_pubkey = %pubkey_hex, "created identity");

    Ok(Identity {
        root_pubkey: pubkey_hex,
        created_at_ms,
    })
}

/// List the identities owned by an account.
pub async fn list_for_account(
    node_db: &SqlitePool,
    account_id: &Uuid,
) -> Result<Vec<Identity>, AppError> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT root_pubkey, created_at_ms FROM identities WHERE account_id = ?1 ORDER BY created_at_ms ASC",
    )
    .bind(account_id.to_string())
    .fetch_all(node_db)
    .await
    .context("listing identities")
    .map_err(AppError::Internal)?;

    Ok(rows
        .into_iter()
        .map(|(root_pubkey, created_at_ms)| Identity {
            root_pubkey,
            created_at_ms,
        })
        .collect())
}

/// Load an identity's signing key from the keystore (for future signing operations). Verifies the
/// account owns it first.
#[allow(dead_code)] // used once identities start signing
pub async fn load_signing_key(
    node_db: &SqlitePool,
    keystore: &Keystore,
    account_id: &Uuid,
    root_pubkey: &str,
) -> Result<SigningKey, AppError> {
    let owned: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM identities WHERE root_pubkey = ?1 AND account_id = ?2")
            .bind(root_pubkey)
            .bind(account_id.to_string())
            .fetch_optional(node_db)
            .await
            .context("checking identity ownership")
            .map_err(AppError::Internal)?;
    if owned.is_none() {
        return Err(AppError::NotFound("identity not found".into()));
    }

    let bytes = keystore
        .load_key(root_pubkey, root_pubkey.as_bytes())
        .map_err(AppError::Internal)?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal(anyhow::anyhow!("private key wrong length")))?;
    Ok(SigningKey::from_bytes(&arr))
}
