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

/// The result of minting an identity. `recovery_secret` is the recovery key's seed, hex-encoded,
/// present **exactly once, here** - the node never persists it. Losing it after this response is
/// the user's designed responsibility ("put the spare key somewhere safe"); holding onto it would
/// defeat its purpose (an offline key the node cannot leak).
#[derive(Debug)]
pub struct CreatedIdentity {
    pub root_pubkey: String,
    pub created_at_ms: i64,
    pub recovery_pubkey: String,
    pub recovery_secret: String,
    /// Hash of the genesis authorize entry (the recovery key's structural seniority, on chain).
    pub authorize_entry_hash: String,
}

/// Create a new identity owned by `account_id`: generate the root keypair, seal the root's
/// private key, record the identity, materialize its per-user database, and **mint the recovery
/// key** - a fresh keypair authorized as the root's first child (rank path `[0]`), structurally
/// senior to every key added afterward, forever (PROJECT_PLAN, Recovery Planning).
pub async fn create(
    node_db: &SqlitePool,
    keystore: &Keystore,
    user_dbs: &crate::db::UserDbManager,
    account_id: &Uuid,
) -> Result<CreatedIdentity, AppError> {
    use ringtome_proto::registry::{entry_type, service};
    use ringtome_proto::{Authorize, Payload};

    // 1. Generate the root keypair. The public key is the identity's name.
    let signing_key = SigningKey::generate(&mut OsRng);
    let root_pubkey = signing_key.verifying_key().to_bytes();
    let pubkey_hex = hex::encode(root_pubkey);

    // 2. Generate the recovery keypair. Its private key is returned to the caller and NEVER
    //    written to the keystore, the database, or a log - the whole point is a key this node
    //    cannot leak.
    let recovery_key = SigningKey::generate(&mut OsRng);
    let recovery_pubkey = recovery_key.verifying_key().to_bytes();

    // 3. Seal the root's private key to a key file, binding the pubkey as associated data so a
    //    key file can't be swapped for another identity's.
    keystore
        .store(&pubkey_hex, &signing_key.to_bytes(), pubkey_hex.as_bytes())
        .context("sealing identity private key")
        .map_err(AppError::Internal)?;

    // 4. Record the identity -> account link.
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

    // 5. Materialize the per-user database (opens + migrates it).
    let user_db = user_dbs
        .get(&pubkey_hex)
        .await
        .context("creating per-user database")
        .map_err(AppError::Internal)?;

    // 6. The identity chain's genesis: root authorizes the recovery key as its first child,
    //    stamped with the usurper list [root]. Being first is what makes it senior to everything
    //    that ever comes after. (Steps 3-6 are not atomic; a crash between them leaves an
    //    identity whose chain lacks its genesis. Single-process M2 accepts this; the identity is
    //    unusable-but-recreatable, and creation is cheap by design.)
    let stamp = Authorize {
        child: recovery_pubkey,
        usurpers: vec![root_pubkey],
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow::anyhow!("encoding recovery authorization: {e}")))?;
    let genesis = crate::imaol::append(
        &user_db,
        &signing_key,
        service::IDENTITY_PUBLIC,
        entry_type::AUTHORIZE,
        Payload::Inline(stamp),
    )
    .await?;

    tracing::info!(
        root_pubkey = %pubkey_hex,
        recovery_pubkey = %hex::encode(recovery_pubkey),
        "created identity with recovery key"
    );

    Ok(CreatedIdentity {
        root_pubkey: pubkey_hex,
        created_at_ms,
        recovery_pubkey: hex::encode(recovery_pubkey),
        recovery_secret: hex::encode(recovery_key.to_bytes()),
        authorize_entry_hash: hex::encode(genesis.hash()),
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

/// Verify that `account_id` owns the identity `root_pubkey`, uniformly 404ing otherwise (an
/// existing-but-not-yours identity is indistinguishable from a nonexistent one).
pub async fn require_owned(
    node_db: &SqlitePool,
    account_id: &Uuid,
    root_pubkey: &str,
) -> Result<(), AppError> {
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
    Ok(())
}

/// Load an identity's signing key from the keystore. Verifies the account owns it first.
pub async fn load_signing_key(
    node_db: &SqlitePool,
    keystore: &Keystore,
    account_id: &Uuid,
    root_pubkey: &str,
) -> Result<SigningKey, AppError> {
    require_owned(node_db, account_id, root_pubkey).await?;

    let bytes = keystore
        .load_key(root_pubkey, root_pubkey.as_bytes())
        .map_err(AppError::Internal)?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal(anyhow::anyhow!("private key wrong length")))?;
    Ok(SigningKey::from_bytes(&arr))
}
