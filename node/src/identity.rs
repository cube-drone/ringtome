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

use anyhow::{anyhow, Context, Result};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use ringtome_proto::keytree::KeyStatus;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Anchor, Authorize, Disposition, Payload, Revoke};
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

/// The result of minting an identity. `recovery_secret` is the recovery key's **seed**,
/// hex-encoded, present **exactly once, here** - the node never persists it. The seed derives
/// both recovery keypairs (signing + encryption, via `seal::derive_recovery`), so the one photo
/// artifact carries both. Losing it after this response is the user's designed responsibility
/// ("put the spare key somewhere safe"); holding onto it would defeat its purpose (an offline
/// key the node cannot leak).
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
    // 1. Generate the root keypair. The public key is the identity's name.
    let signing_key = SigningKey::generate(&mut OsRng);
    let root_pubkey = signing_key.verifying_key().to_bytes();
    let pubkey_hex = hex::encode(root_pubkey);

    // 2. Generate the recovery *seed* and derive its two keypairs (signing + encryption). The
    //    seed is returned to the caller and NEVER written to the keystore, the database, or a
    //    log - the whole point is a key this node cannot leak.
    let recovery_seed: [u8; 32] = {
        use rand::RngCore;
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        seed
    };
    let (recovery_key, recovery_enc) = crate::seal::derive_recovery(&recovery_seed);
    let recovery_pubkey = recovery_key.verifying_key().to_bytes();

    // 3. Seal the root's private key to a key file, binding the pubkey as associated data so a
    //    key file can't be swapped for another identity's. The root also gets an encryption
    //    keypair (for opening epoch boxes), stored beside the signing key.
    keystore
        .store(&pubkey_hex, &signing_key.to_bytes(), pubkey_hex.as_bytes())
        .context("sealing identity private key")
        .map_err(AppError::Internal)?;
    let root_enc = crate::seal::EncKeyPair::generate();
    crate::private::store_enc_keypair(keystore, &pubkey_hex, &root_enc)
        .context("sealing identity encryption key")
        .map_err(AppError::Internal)?;

    // 4. Record the identity -> account link. On the creating node, the signing key *is* the
    //    root (leaf_pubkey = root_pubkey); nodes added later sign with granted leaf keys.
    let created_at_ms = now_ms();
    sqlx::query(
        "INSERT INTO identities (root_pubkey, account_id, created_at_ms, leaf_pubkey)
         VALUES (?1, ?2, ?3, ?1)",
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
        enc_pubkey: Some(recovery_enc.public),
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

    // 7. Epoch 0: the identity's first private-chain key, sealed to the root and the (offline)
    //    recovery key. Every private record ever written is under some epoch; minting the first
    //    one here means "has private chains" is an invariant, not a lazy upgrade.
    let epoch_key = crate::private::fresh_epoch_key();
    crate::private::mint_epoch(
        &user_db,
        &signing_key,
        0,
        &epoch_key,
        &[
            (root_pubkey, root_enc.public),
            (recovery_pubkey, recovery_enc.public),
        ],
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
        recovery_secret: hex::encode(recovery_seed),
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

/// Whether this node agents the identity at all (any account). The sync server consults this -
/// per the data-access convention, `identities` SQL lives only in this module.
pub async fn is_agented(node_db: &SqlitePool, root_pubkey: &str) -> Result<bool, AppError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM identities WHERE root_pubkey = ?1")
        .bind(root_pubkey)
        .fetch_optional(node_db)
        .await
        .context("checking identity")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// Roots of every identity marked served - the republish loop's worklist.
pub async fn served_roots(node_db: &SqlitePool) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT root_pubkey FROM identities WHERE served_at_ms IS NOT NULL")
            .fetch_all(node_db)
            .await
            .context("listing served identities")
            .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
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

/// Load *this node's* signing key for an identity - the root on the creating node, a granted
/// leaf on adopted nodes. Verifies the account owns the identity first.
pub async fn load_signing_key(
    node_db: &SqlitePool,
    keystore: &Keystore,
    account_id: &Uuid,
    root_pubkey: &str,
) -> Result<SigningKey, AppError> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT leaf_pubkey FROM identities WHERE root_pubkey = ?1 AND account_id = ?2",
    )
    .bind(root_pubkey)
    .bind(account_id.to_string())
    .fetch_optional(node_db)
    .await
    .context("checking identity ownership")
    .map_err(AppError::Internal)?;
    let Some((leaf,)) = row else {
        return Err(AppError::NotFound("identity not found".into()));
    };
    // Pre-M3 rows have no leaf column value; they were created when the node key was the root.
    let key_name = leaf.unwrap_or_else(|| root_pubkey.to_string());

    let bytes = keystore
        .load_key(&key_name, key_name.as_bytes())
        .map_err(AppError::Internal)?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal(anyhow!("private key wrong length")))?;
    Ok(SigningKey::from_bytes(&arr))
}

/// Load this node's signing key for an identity it agents, regardless of owning account - the
/// sync engine's loader (a member proof speaks for the node, not for a login session). `None`
/// when the node doesn't agent the identity.
pub async fn load_node_leaf_key(
    node_db: &SqlitePool,
    keystore: &Keystore,
    root_pubkey: &str,
) -> Result<Option<SigningKey>, AppError> {
    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT leaf_pubkey FROM identities WHERE root_pubkey = ?1")
            .bind(root_pubkey)
            .fetch_optional(node_db)
            .await
            .context("looking up identity leaf")
            .map_err(AppError::Internal)?;
    let Some((leaf,)) = row else {
        return Ok(None);
    };
    let key_name = leaf.unwrap_or_else(|| root_pubkey.to_string());
    let bytes = keystore
        .load_key(&key_name, key_name.as_bytes())
        .map_err(AppError::Internal)?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal(anyhow!("private key wrong length")))?;
    Ok(Some(SigningKey::from_bytes(&arr)))
}

// ---------------------------------------------------------------------------------------------
// The add-a-node ceremony (PROJECT_PLAN, Adding a New Node) and key revocation.
//
// Two copy-pastes: the joining node emits a *request code* (its fresh leaf key + how to reach
// it); the identity's root node turns that into a signed authorization and emits a *grant code*
// (the root + how to reach the granter); the joining node completes by syncing the identity
// chains and finding its own authorization there. Codes are JSON - the M4 client dresses them
// as QR.

const REQUEST_KIND: &str = "ringtome-adopt-request";
const GRANT_KIND: &str = "ringtome-adopt-grant";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RequestCode {
    pub v: u8,
    pub kind: String,
    pub leaf_pubkey: String,
    /// The leaf's X25519 encryption pubkey - parent-attested in the authorize stamp so epoch
    /// keys can be sealed to this node from birth.
    pub enc_pubkey: String,
    pub endpoint_id: String,
    pub addrs: Vec<String>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct GrantCode {
    pub v: u8,
    pub kind: String,
    pub root_pubkey: String,
    pub leaf_pubkey: String,
    pub endpoint_id: String,
    pub addrs: Vec<String>,
}

/// Publish (or refresh) this node's serving record for an identity: "our leaf serves this root,
/// reachable at our endpoint." Called when an identity is marked served and by the republish
/// loop. In mainline mode the pkarr packet is additionally signed by the leaf key itself.
pub async fn publish_serving_record(
    state: &crate::AppState,
    root_hex: &str,
) -> Result<(), AppError> {
    use ringtome_proto::directory::{ServingRecord, SignedServingRecord, RECORD_VERSION};

    let row: Option<(Option<String>,)> =
        sqlx::query_as("SELECT leaf_pubkey FROM identities WHERE root_pubkey = ?1")
            .bind(root_hex)
            .fetch_optional(&state.node_db)
            .await
            .context("looking up identity")
            .map_err(AppError::Internal)?;
    let Some((leaf,)) = row else {
        return Err(AppError::NotFound("identity not found".into()));
    };
    let key_name = leaf.unwrap_or_else(|| root_hex.to_string());

    let secret = state
        .keystore
        .load_key(&key_name, key_name.as_bytes())
        .map_err(AppError::Internal)?;
    let secret: [u8; 32] = secret
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal(anyhow!("leaf key wrong length")))?;
    let leaf_key = SigningKey::from_bytes(&secret);

    let root: [u8; 32] = hex::decode(root_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("bad root pubkey".into()))?;
    let record = ServingRecord {
        v: RECORD_VERSION,
        root,
        node_key: leaf_key.verifying_key().to_bytes(),
        endpoint_id: *state.endpoint.id().as_bytes(),
        timestamp_ms: now_ms() as u64,
    };
    let signed = SignedServingRecord::create(&record, &leaf_key)
        .map_err(|e| AppError::Internal(anyhow!("signing serving record: {e}")))?;

    match &state.directory {
        crate::discovery::Directory::Mainline(m) => m
            .publish_serving_with_key(&signed, &secret)
            .await
            .map_err(AppError::Internal)?,
        other => other
            .publish_serving(&signed)
            .await
            .map_err(AppError::Internal)?,
    }
    Ok(())
}

/// Mark an identity as served (publication is an act) and publish its record immediately.
pub async fn mark_served(
    state: &crate::AppState,
    account_id: &Uuid,
    root_hex: &str,
) -> Result<(), AppError> {
    require_owned(&state.node_db, account_id, root_hex).await?;
    sqlx::query("UPDATE identities SET served_at_ms = ?1 WHERE root_pubkey = ?2")
        .bind(now_ms())
        .bind(root_hex)
        .execute(&state.node_db)
        .await
        .context("marking identity served")
        .map_err(AppError::Internal)?;
    publish_serving_record(state, root_hex).await
}

/// Step 1, on the joining node: mint a leaf keypair for a prospective identity and emit the
/// request code. The leaf is sealed immediately; nothing about the identity is known yet.
pub async fn begin_adoption(
    state: &crate::AppState,
    account_id: &Uuid,
) -> Result<RequestCode, AppError> {
    let leaf = SigningKey::generate(&mut OsRng);
    let leaf_hex = hex::encode(leaf.verifying_key().to_bytes());

    state
        .keystore
        .store(&leaf_hex, &leaf.to_bytes(), leaf_hex.as_bytes())
        .context("sealing adoption leaf key")
        .map_err(AppError::Internal)?;
    let leaf_enc = crate::seal::EncKeyPair::generate();
    crate::private::store_enc_keypair(&state.keystore, &leaf_hex, &leaf_enc)
        .context("sealing adoption encryption key")
        .map_err(AppError::Internal)?;
    sqlx::query(
        "INSERT INTO pending_adoptions (leaf_pubkey, account_id, created_at_ms) VALUES (?1, ?2, ?3)",
    )
    .bind(&leaf_hex)
    .bind(account_id.to_string())
    .bind(now_ms())
    .execute(&state.node_db)
    .await
    .context("recording pending adoption")
    .map_err(AppError::Internal)?;

    Ok(RequestCode {
        v: 0,
        kind: REQUEST_KIND.to_string(),
        leaf_pubkey: leaf_hex,
        enc_pubkey: hex::encode(leaf_enc.public),
        endpoint_id: state.endpoint.id().to_string(),
        addrs: crate::p2p::addr_strings(&state.endpoint),
    })
}

/// Step 2, on the granting node: the identity's root signs the leaf into the tree and emits the
/// grant code. v1: only the root's own node may grant (the root is the only key whose stamp we
/// can compute as a parent here).
pub async fn authorize_node(
    state: &crate::AppState,
    account_id: &Uuid,
    root_hex: &str,
    code: RequestCode,
) -> Result<GrantCode, AppError> {
    if code.kind != REQUEST_KIND {
        return Err(AppError::BadRequest("not an adoption request code".into()));
    }
    require_owned(&state.node_db, account_id, root_hex).await?;

    let leaf: [u8; 32] = hex::decode(&code.leaf_pubkey)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("bad leaf pubkey in request code".into()))?;
    let leaf_enc: [u8; 32] = hex::decode(&code.enc_pubkey)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("bad encryption pubkey in request code".into()))?;
    let root: [u8; 32] = hex::decode(root_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("bad root pubkey".into()))?;

    let signer = load_signing_key(&state.node_db, &state.keystore, account_id, root_hex).await?;
    if signer.verifying_key().to_bytes() != root {
        return Err(AppError::Forbidden(
            "v1: only the identity's root node can authorize new nodes".into(),
        ));
    }

    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::imaol::load_key_tree(&db, root_hex).await?;
    if tree.status(&leaf) != KeyStatus::Unknown {
        return Err(AppError::BadRequest(
            "that key is already in the tree".into(),
        ));
    }

    // The stamp: parent's usurpers ([] for the root) + parent + parent's prior children.
    let mut stamp = vec![root];
    stamp.extend_from_slice(tree.children_of(&root));
    let payload = Authorize {
        child: leaf,
        usurpers: stamp,
        enc_pubkey: Some(leaf_enc),
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow!("encoding authorization: {e}")))?;
    crate::imaol::append(
        &db,
        &signer,
        service::IDENTITY_PUBLIC,
        entry_type::AUTHORIZE,
        Payload::Inline(payload),
    )
    .await?;

    // Adoption's private half: re-seal every epoch key this node holds to the newcomer, so its
    // private view reaches all the way back. A member is a member of the whole history - the
    // exclusion boundary is revocation's rotation, never adoption.
    let our_enc = crate::private::load_enc_keypair(&state.keystore, root_hex)
        .context("loading our encryption key")
        .map_err(AppError::Internal)?;
    let epoch_keys = crate::private::unseal_epoch_keys(&db, &root, &our_enc).await?;
    let resealed =
        crate::private::reseal_epochs_to(&db, &signer, &leaf, &leaf_enc, &epoch_keys).await?;
    tracing::info!(root = %root_hex, leaf = %code.leaf_pubkey, resealed, "sealed epoch history");

    // Remember the joining node as a peer so future syncs reach it.
    crate::sync::add_peer(&state.node_db, root_hex, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;

    tracing::info!(root = %root_hex, leaf = %code.leaf_pubkey, "authorized new node");
    Ok(GrantCode {
        v: 0,
        kind: GRANT_KIND.to_string(),
        root_pubkey: root_hex.to_string(),
        leaf_pubkey: code.leaf_pubkey,
        endpoint_id: state.endpoint.id().to_string(),
        addrs: crate::p2p::addr_strings(&state.endpoint),
    })
}

/// Step 3, back on the joining node: sync the identity chains from the granter, verify our leaf
/// actually landed in the tree, and start agenting the identity.
pub async fn complete_adoption(
    state: &crate::AppState,
    account_id: &Uuid,
    code: GrantCode,
) -> Result<Identity, AppError> {
    if code.kind != GRANT_KIND {
        return Err(AppError::BadRequest("not an adoption grant code".into()));
    }
    // The pending leaf must belong to this account (uniform 404 otherwise).
    let pending: Option<(String,)> =
        sqlx::query_as("SELECT account_id FROM pending_adoptions WHERE leaf_pubkey = ?1")
            .bind(&code.leaf_pubkey)
            .fetch_optional(&state.node_db)
            .await
            .context("checking pending adoption")
            .map_err(AppError::Internal)?;
    if pending.map(|(a,)| a) != Some(account_id.to_string()) {
        return Err(AppError::NotFound(
            "no pending adoption for that key".into(),
        ));
    }

    let leaf: [u8; 32] = hex::decode(&code.leaf_pubkey)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("bad leaf pubkey in grant code".into()))?;

    crate::sync::add_peer(&state.node_db, &code.root_pubkey, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;
    // Bootstrap dial: the grant code's addresses are ephemeral single-use hints (allowed to be
    // addresses precisely because they don't live long enough to rot). Later syncs resolve via
    // the directory.
    let addr = crate::sync::endpoint_addr(&code.endpoint_id, &code.addrs)
        .map_err(|e| AppError::BadRequest(format!("bad grant code addresses: {e}")))?;

    let stats = crate::sync::sync_with_peer(state, &code.root_pubkey, addr)
        .await
        .map_err(|e| AppError::Internal(anyhow!("initial sync failed: {e}")))?;
    tracing::info!(root = %code.root_pubkey, ?stats, "adoption sync complete");

    let db = state
        .user_dbs
        .get(&code.root_pubkey)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::imaol::load_key_tree(&db, &code.root_pubkey).await?;
    if tree.status(&leaf) != KeyStatus::Active {
        return Err(AppError::BadRequest(
            "our key is not (yet) authorized on the identity chain - paste the request code at \
             the granting node first"
                .into(),
        ));
    }

    let created_at_ms = now_ms();
    sqlx::query(
        "INSERT INTO identities (root_pubkey, account_id, created_at_ms, leaf_pubkey)
         VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(&code.root_pubkey)
    .bind(account_id.to_string())
    .bind(created_at_ms)
    .bind(&code.leaf_pubkey)
    .execute(&state.node_db)
    .await
    .context("recording adopted identity")
    .map_err(AppError::Internal)?;
    sqlx::query("DELETE FROM pending_adoptions WHERE leaf_pubkey = ?1")
        .bind(&code.leaf_pubkey)
        .execute(&state.node_db)
        .await
        .context("clearing pending adoption")
        .map_err(AppError::Internal)?;
    crate::sync::mark_synced(&state.node_db, &code.root_pubkey, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;

    // Second pass, now that we agent the identity: the first sync ran proof-less (no identities
    // row yet), so the granter rightly withheld the private chains. This one carries our member
    // proof and pulls them - adoption ends with the private state here, not eventually.
    let addr = crate::sync::endpoint_addr(&code.endpoint_id, &code.addrs)
        .map_err(|e| AppError::BadRequest(format!("bad grant code addresses: {e}")))?;
    let stats = crate::sync::sync_with_peer(state, &code.root_pubkey, addr)
        .await
        .map_err(|e| AppError::Internal(anyhow!("private-chain sync failed: {e}")))?;
    tracing::info!(root = %code.root_pubkey, ?stats, "adoption private sync complete");

    Ok(Identity {
        root_pubkey: code.root_pubkey,
        created_at_ms,
    })
}

/// Revoke a key in the identity's tree: this node's key signs a `revoke` statement with anchors
/// at our stored heads of every chain the target has written. Seniority is pre-checked here for
/// a friendly error; every other node's ingest gate re-checks it independently, which is the
/// check that actually matters.
pub async fn revoke_key(
    state: &crate::AppState,
    account_id: &Uuid,
    root_hex: &str,
    target_hex: &str,
    disposition: Disposition,
) -> Result<String, AppError> {
    require_owned(&state.node_db, account_id, root_hex).await?;
    let target: [u8; 32] = hex::decode(target_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("bad target pubkey".into()))?;

    let signer = load_signing_key(&state.node_db, &state.keystore, account_id, root_hex).await?;
    let signer_pub = signer.verifying_key().to_bytes();

    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::imaol::load_key_tree(&db, root_hex).await?;

    let authorized = match disposition {
        Disposition::Retirement => signer_pub == target || tree.is_senior(&signer_pub, &target),
        Disposition::Repudiation => signer_pub != target && tree.is_senior(&signer_pub, &target),
    };
    if !authorized {
        return Err(AppError::Forbidden(
            "this node's key is not senior to the target".into(),
        ));
    }

    // Anchors: our stored head of every chain the target has written (via imaol - the entries
    // table's owner).
    let anchors: Vec<Anchor> = crate::imaol::chain_heads_for_author(&db, target_hex)
        .await?
        .into_iter()
        .map(|(service, seq, head_hash)| Anchor {
            service,
            seq,
            head_hash,
        })
        .collect();

    let payload = Revoke {
        target,
        disposition,
        anchors,
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow!("encoding revocation: {e}")))?;
    let signed = crate::imaol::append(
        &db,
        &signer,
        service::IDENTITY_PUBLIC,
        entry_type::REVOKE,
        Payload::Inline(payload),
    )
    .await?;

    // The forward-secrecy boundary: a revoked key's server still holds its epoch keys, so every
    // revocation - retirement included, however friendly - rotates to a fresh epoch sealed to
    // everyone but the departed. It reads its era forever; the future is closed. (Rotation
    // failing must not unwind the revocation itself: eviction now, re-key ASAP beats neither.)
    let tree = crate::imaol::load_key_tree(&db, root_hex).await?;
    match crate::private::rotate_epoch(&db, &signer, &tree, &target).await {
        Ok(epoch_entry) => tracing::info!(
            root = %root_hex,
            entry = %hex::encode(epoch_entry.hash()),
            "rotated private epoch after revocation"
        ),
        Err(e) => tracing::error!(root = %root_hex, "epoch rotation after revocation failed: {e}"),
    }

    tracing::info!(root = %root_hex, target = %target_hex, ?disposition, "revoked key");
    Ok(hex::encode(signed.hash()))
}
