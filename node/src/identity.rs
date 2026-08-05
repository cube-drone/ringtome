//! Identity creation and lookup.
//!
//! An identity is a root ed25519 keypair. Creating one: generate the keypair, seal its private key
//! to a key file (envelope-encrypted, with the pubkey bound as AEAD associated data), record an
//! `identities` row linking it to the owning account, and materialize its per-user database.
//!
//! An identity is born fully furnished: creation also writes the chain genesis (the recovery
//! key - the root's structurally-senior first child - authorized with its encryption pubkey),
//! mints the root's own encryption keypair, and publishes private-chain epoch 0.
//!
//! The node-facing lifecycle flows live in child modules - `serving` (records + the republish
//! pass) and `adoption` (the add-a-node ceremony) - built on what this file owns: the
//! `identities` table (all of its SQL stays here, behind blunt accessors) and the keystore
//! loaders. Revocation stays here too: it is key-tree lifecycle, and it is one function.

pub mod adoption;
mod routes;
pub(crate) mod serving;

pub use routes::{router, BodyLimits};

use anyhow::{anyhow, Context, Result};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Anchor, Authorize, Disposition, Payload, Revoke};
use uuid::Uuid;

use crate::clock::now_ms;
use crate::db::Db;
use crate::error::AppError;
use crate::keystore::Keystore;
use crate::pubkey;

/// A created/loaded identity. Public information only; the private key stays in the keystore.
#[derive(Debug, Clone)]
pub struct Identity {
    /// Hex-encoded ed25519 root public key - the identity's global name.
    pub root_pubkey: String,
    pub created_at_ms: i64,
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
    node_db: &Db,
    keystore: &Keystore,
    user_dbs: &crate::db::UserDbManager,
    account_id: &Uuid,
    node_name: &str,
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
    crate::record::private::store_enc_keypair(keystore, &pubkey_hex, &root_enc)
        .context("sealing identity encryption key")
        .map_err(AppError::Internal)?;

    // 4. Record the identity -> account link. On the creating node, the signing key *is* the
    //    root (leaf_pubkey = root_pubkey); nodes added later sign with granted leaf keys.
    let created_at_ms = now_ms();
    record_identity(node_db, account_id, &pubkey_hex, &pubkey_hex, created_at_ms).await?;

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
    let genesis = crate::record::imaol::append(
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
    let epoch_key = crate::record::private::fresh_epoch_key();
    crate::record::private::mint_epoch(
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

    // 8. The founding key's device name - the identity's first private record. On the creating
    //    node the root doubles as the working leaf, so the label lands on the root pubkey; the
    //    recovery key gets no label (it is a *role*, rendered by rank, not a device). Labels
    //    are labels: a failure here warns and moves on, it must never doom creation.
    let label_write = async {
        let epoch_keys =
            crate::record::private::unseal_epoch_keys(&user_db, &root_pubkey, &root_enc).await?;
        crate::record::private::write_record(
            &user_db,
            &signing_key,
            &epoch_keys,
            service::GENERAL_PRIVATE,
            &ringtome_proto::PrivatePlain {
                kind: ringtome_proto::PrivateKind::Register,
                collection: crate::record::store::DEVICES_COLLECTION.to_string(),
                key: pubkey_hex.clone(),
                value: Some(node_name.to_string()),
            },
        )
        .await
    };
    if let Err(e) = label_write.await {
        tracing::warn!(root = %pubkey_hex, "could not write founding device name: {e}");
    }

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

/// Record that this node agents `root_pubkey` for `account_id`, signing with the key named
/// `leaf_key_name` - the root itself at creation, a granted leaf after adoption.
pub async fn record_identity(
    node_db: &Db,
    account_id: &Uuid,
    root_pubkey: &str,
    leaf_key_name: &str,
    created_at_ms: i64,
) -> Result<(), AppError> {
    node_db
        .execute(
            "INSERT INTO identities (root_pubkey, account_id, created_at_ms, leaf_pubkey)
         VALUES (?1, ?2, ?3, ?4)",
            (
                root_pubkey,
                account_id.to_string(),
                created_at_ms,
                leaf_key_name,
            ),
        )
        .await
        .context("recording identity")
        .map_err(AppError::Internal)?;
    // Hosting supersedes having FETCHED them: a persona that lives here is no longer a
    // stranger this node once reached across the network for, and leaving the row behind
    // would tell the retention accounting a stranger's story about a tenant (found
    // 2026-08-03, adopting onto a node that had already fetched the persona - which works,
    // and this was its only untidy edge).
    crate::idface::forget_foreign_fetch(node_db, root_pubkey).await?;
    Ok(())
}

/// The already-adopted identity for (account, root, leaf), if completion has run - the
/// idempotency lookup adoption's complete path needs, kept here because this module owns the
/// `identities` table.
pub(crate) async fn adopted_identity(
    node_db: &Db,
    account_id: &Uuid,
    root_pubkey: &str,
    leaf_pubkey: &str,
) -> Result<Option<Identity>, AppError> {
    let row: Option<(String, i64)> = node_db
        .fetch_optional(
            "SELECT root_pubkey, created_at_ms FROM identities
             WHERE account_id = ?1 AND leaf_pubkey = ?2 AND root_pubkey = ?3",
            (account_id.to_string(), leaf_pubkey, root_pubkey),
        )
        .await
        .context("checking completed adoption")
        .map_err(AppError::Internal)?;
    Ok(row.map(|(root_pubkey, created_at_ms)| Identity {
        root_pubkey,
        created_at_ms,
    }))
}

/// Whether some account on this node already agents `root` with `leaf` - adoption's
/// redelivery check (grant arrives again after the deal is done).
pub(crate) async fn leaf_agents_root(
    node_db: &Db,
    root_pubkey: &str,
    leaf_pubkey: &str,
) -> Result<bool, AppError> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM identities WHERE leaf_pubkey = ?1 AND root_pubkey = ?2",
            (leaf_pubkey, root_pubkey),
        )
        .await
        .context("checking agenting leaf")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// List the identities owned by an account.
/// The designated recovery key: the unique Active key on the all-zeros rank path (the
/// leftmost spine - PROJECT_PLAN, Recovery Flows: "Designating 'the' recovery key"). `None`
/// when no such key exists; fails closed to `None` if the convention is somehow violated and
/// two Active keys share the spine.
fn designated_recovery(tree: &ringtome_proto::Crown) -> Option<[u8; 32]> {
    use ringtome_proto::crown::KeyStatus;
    let mut found: Option<[u8; 32]> = None;
    for (pk, status) in tree.members() {
        if status != KeyStatus::Active {
            continue;
        }
        let Some(path) = tree.rank_path(pk) else {
            continue;
        };
        if path.is_empty() || !path.iter().all(|&r| r == 0) {
            continue; // the root ([]) and every off-spine key are never reset-eligible
        }
        if found.is_some() {
            return None; // two Active spine keys: convention broken, fail closed
        }
        found = Some(*pk);
    }
    found
}

/// Flow A, scratch edition: the spare key as a password-reset factor (PROJECT_PLAN, Recovery
/// Flows: Passwords vs. Keys). Zero chain entries, zero new keys - the seed proves control of
/// the designated recovery key, and that alone. The scratch simplifications, named: the seed
/// is presented to the node rather than signing a browser-side challenge (fine on your own
/// node, a real exposure question for hosted nodes - the in-browser flow and post-use
/// rotation are the bells this version deliberately lacks), and there is no cooling-off
/// window yet. What is NOT simplified is the lattice: only the designated recovery key is
/// reset-eligible, and per-identity scoping holds - a reset is allowed only when the account
/// holds exactly the proven persona (the "proven-only account" case; re-homing a persona out
/// of a multi-persona account arrives with the full flow).
///
/// Every failure that could leak is the same uniform "recovery failed": whether the username
/// exists, whether it has personas, and whether the secret matched are all indistinguishable
/// to a caller who hasn't proven anything.
pub enum Recovery {
    /// Password reset in place: the account held exactly the proven persona, and keeps its
    /// sign-in name.
    Reset,
    /// The account holds siblings; the caller must pick a new sign-in name so the proven
    /// persona can be re-homed (a side-effect-free answer - nothing has changed yet).
    NeedsNewUsername,
    /// The proven persona moved to a freshly minted account; the old account is untouched.
    Rehomed,
}

pub async fn recover_password(
    state: &crate::AppState,
    username: &str,
    recovery_secret_hex: &str,
    new_password: &str,
    new_username: Option<&str>,
) -> Result<Recovery, AppError> {
    let uniform = || AppError::Unauthorized("recovery failed".into());

    let seed: [u8; 32] = hex::decode(recovery_secret_hex.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(uniform)?;
    let (recovery_key, _enc) = crate::seal::derive_recovery(&seed);
    let proven_pubkey = recovery_key.verifying_key().to_bytes();

    let account_id = crate::auth::account_id_by_username(&state.node_db, username)
        .await?
        .ok_or_else(uniform)?;
    let account_uuid = Uuid::parse_str(&account_id)
        .map_err(|e| AppError::Internal(anyhow!("malformed account id: {e}")))?;
    let identities = list_for_account(&state.node_db, &account_uuid).await?;

    // Which of the account's personas does this seed prove? The match is against each tree's
    // DESIGNATED recovery key - an ordinary leaf, even a valid one, proves nothing here
    // (presenting key K grants at most K's authority, and only the spine key carries reset).
    let mut proven: Option<String> = None;
    for identity in &identities {
        let db = state
            .user_dbs
            .get(&identity.root_pubkey)
            .await
            .map_err(AppError::Internal)?;
        let tree = crate::record::imaol::load_key_tree(&db, &identity.root_pubkey).await?;
        if designated_recovery(&tree) == Some(proven_pubkey) {
            proven = Some(identity.root_pubkey.clone());
            break;
        }
    }
    let proven = proven.ok_or_else(uniform)?;

    // Per-identity scoping: proof of one persona must not unlock its account-siblings.
    //
    // Single-persona account (the common case): reset in place - the account IS the proven
    // persona's, and re-homing here would cost the user their sign-in name for nothing.
    //
    // Multi-persona account: RE-HOME - the proven persona moves to a freshly minted account
    // the caller names, and the old account is left entirely alone: password intact, sessions
    // intact, siblings intact. Deliberately untouched, because if the spare key was *stolen*,
    // the old account belongs to the victim - the thief walks away with exactly the persona
    // the stolen key already owned outright, and nothing else. (The needs-a-new-name signal
    // below discloses that siblings exist - post-proof only, count-not-names, the accepted
    // trade for not stranding legitimate multi-persona users.)
    if identities.len() > 1 {
        let Some(new_username) = new_username else {
            return Ok(Recovery::NeedsNewUsername);
        };
        let account = crate::auth::register(
            &state.node_db,
            new_username,
            new_password,
            state.config.password_min_len(),
            state.config.local_test,
        )
        .await?;
        state
            .node_db
            .execute(
                "UPDATE identities SET account_id = ?1 WHERE root_pubkey = ?2 AND account_id = ?3",
                (account.id.to_string(), proven.as_str(), account_id.as_str()),
            )
            .await
            .context("re-homing identity")
            .map_err(AppError::Internal)?;
        tracing::info!(root = %proven, "persona re-homed to a fresh account via spare key");
        return Ok(Recovery::Rehomed);
    }

    crate::auth::set_password(
        &state.node_db,
        &account_id,
        new_password,
        state.config.password_min_len(),
        state.config.local_test,
    )
    .await?;
    crate::auth::purge_sessions(&state.node_db, &account_id).await?;
    tracing::info!(root = %proven, "password reset via spare key");
    Ok(Recovery::Reset)
}

pub async fn list_for_account(node_db: &Db, account_id: &Uuid) -> Result<Vec<Identity>, AppError> {
    let rows: Vec<(String, i64)> = node_db
        .fetch_all(
            "SELECT root_pubkey, created_at_ms FROM identities WHERE account_id = ?1 ORDER BY created_at_ms ASC",
            (account_id.to_string(),),
        )
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

/// This node's own standing in the identity's key tree: the status name of its signing leaf
/// ("active", "retired", "repudiated", ...), or "unknown" when the answer can't be computed (a
/// key or database that won't open must degrade the persona list, never fail it). What the
/// farewell flow reads: a well-intentioned node discovers its own revocation here and lets go.
pub async fn standing(
    state: &crate::AppState,
    account_id: &Uuid,
    root_hex: &str,
) -> &'static str {
    let Ok(signer) = load_signing_key(&state.node_db, &state.keystore, account_id, root_hex).await
    else {
        return "unknown";
    };
    let Ok(db) = state.user_dbs.get(root_hex).await else {
        return "unknown";
    };
    let Ok(tree) = crate::record::imaol::load_key_tree(&db, root_hex).await else {
        return "unknown";
    };
    tree.status(&signer.verifying_key().to_bytes()).name()
}

/// Detach an identity from an account on THIS node - the node-local unlink, nothing signed,
/// nothing synced. The persona goes on existing everywhere else; this node just stops agenting
/// it for this account. The farewell flow's final step, and (someday) the multi-persona "drop
/// one" action. The keystore's key files and the user database stay on disk - a janitor's
/// concern, not this function's.
pub async fn detach(node_db: &Db, account_id: &Uuid, root_hex: &str) -> Result<(), AppError> {
    require_owned(node_db, account_id, root_hex).await?;
    node_db
        .execute(
            "DELETE FROM identities WHERE root_pubkey = ?1 AND account_id = ?2",
            (root_hex, account_id.to_string()),
        )
        .await
        .context("detaching identity")
        .map_err(AppError::Internal)?;
    tracing::info!(root = %root_hex, "detached persona from this node");
    Ok(())
}

/// Whether this node agents the identity at all (any account). The sync server consults this -
/// per the data-access convention, `identities` SQL lives only in this module.
pub async fn is_agented(node_db: &Db, root_pubkey: &str) -> Result<bool, AppError> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM identities WHERE root_pubkey = ?1",
            (root_pubkey,),
        )
        .await
        .context("checking identity")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// Roots of every identity marked served - the republish loop's worklist.
/// Every root this node hosts, with the account that owns it - what a background pass needs to
/// open a persona's store (its signing key, and through it the epoch keys its private records
/// are sealed to).
pub async fn hosted_roots_with_accounts(node_db: &Db) -> Result<Vec<(String, Uuid)>, AppError> {
    let rows: Vec<(String, String)> = node_db
        .fetch_all("SELECT root_pubkey, account_id FROM identities", ())
        .await
        .context("listing hosted identities with accounts")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|(root, account)| Uuid::parse_str(&account).ok().map(|a| (root, a)))
        .collect())
}

/// Every root this node hosts, served or not. `served_roots` asks who we PUBLISH; this asks
/// who we carry, which is the question the frontier sweep has (an unpublished persona still
/// writes chains, and this node still holds them).
pub async fn hosted_roots(node_db: &Db) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT root_pubkey FROM identities", ())
        .await
        .context("listing hosted identities")
        .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

pub async fn served_roots(node_db: &Db) -> Result<Vec<String>, AppError> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT root_pubkey FROM identities WHERE served_at_ms IS NOT NULL",
            (),
        )
        .await
        .context("listing served identities")
        .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Stamp an identity as served. The flow around it (ownership check, immediate publication)
/// lives in `serving`; this is just the identities-table write.
pub(crate) async fn record_served(node_db: &Db, root_pubkey: &str) -> Result<(), AppError> {
    node_db
        .execute(
            "UPDATE identities SET served_at_ms = ?1 WHERE root_pubkey = ?2",
            (now_ms(), root_pubkey),
        )
        .await
        .context("marking identity served")
        .map_err(AppError::Internal)?;
    Ok(())
}

/// Verify that `account_id` owns the identity `root_pubkey`, uniformly 404ing otherwise (an
/// existing-but-not-yours identity is indistinguishable from a nonexistent one).
/// Is this root hosted by ANY account on this node? The /id surface's shelf question -
/// audience-independent, unlike `require_owned` below, which asks about one account.
pub async fn is_hosted(node_db: &Db, root_pubkey: &str) -> Result<bool, AppError> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM identities WHERE root_pubkey = ?1",
            (root_pubkey,),
        )
        .await
        .context("checking identity hosting")
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

pub async fn require_owned(
    node_db: &Db,
    account_id: &Uuid,
    root_pubkey: &str,
) -> Result<(), AppError> {
    let owned: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM identities WHERE root_pubkey = ?1 AND account_id = ?2",
            (root_pubkey, account_id.to_string()),
        )
        .await
        .context("checking identity ownership")
        .map_err(AppError::Internal)?;
    if owned.is_none() {
        return Err(AppError::NotFound("identity not found".into()));
    }
    Ok(())
}

/// Open a named signing key from the keystore. Key files are named by their own hex pubkey,
/// which is also bound in as the AAD, so a file can't be swapped for another key's.
fn signing_key_named(keystore: &Keystore, key_name: &str) -> Result<SigningKey, AppError> {
    let bytes = keystore
        .load_key(key_name, key_name.as_bytes())
        .map_err(AppError::Internal)?;
    let secret: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Internal(anyhow!("private key wrong length")))?;
    Ok(SigningKey::from_bytes(&secret))
}

/// Load *this node's* signing key for an identity - the root on the creating node, a granted
/// leaf on adopted nodes. Verifies the account owns the identity first.
pub async fn load_signing_key(
    node_db: &Db,
    keystore: &Keystore,
    account_id: &Uuid,
    root_pubkey: &str,
) -> Result<SigningKey, AppError> {
    let row: Option<(Option<String>,)> = node_db
        .fetch_optional(
            "SELECT leaf_pubkey FROM identities WHERE root_pubkey = ?1 AND account_id = ?2",
            (root_pubkey, account_id.to_string()),
        )
        .await
        .context("checking identity ownership")
        .map_err(AppError::Internal)?;
    let Some((leaf,)) = row else {
        return Err(AppError::NotFound("identity not found".into()));
    };
    // Pre-M3 rows have no leaf column value; they were created when the node key was the root.
    let key_name = leaf.unwrap_or_else(|| root_pubkey.to_string());
    signing_key_named(keystore, &key_name)
}

/// Load this node's signing key for an identity it agents, regardless of owning account - the
/// sync engine's loader (a member proof speaks for the node, not for a login session). `None`
/// when the node doesn't agent the identity.
pub async fn load_node_leaf_key(
    node_db: &Db,
    keystore: &Keystore,
    root_pubkey: &str,
) -> Result<Option<SigningKey>, AppError> {
    let row: Option<(Option<String>,)> = node_db
        .fetch_optional(
            "SELECT leaf_pubkey FROM identities WHERE root_pubkey = ?1",
            (root_pubkey,),
        )
        .await
        .context("looking up identity leaf")
        .map_err(AppError::Internal)?;
    let Some((leaf,)) = row else {
        return Ok(None);
    };
    let key_name = leaf.unwrap_or_else(|| root_pubkey.to_string());
    Ok(Some(signing_key_named(keystore, &key_name)?))
}

/// Revoke a key in the identity's tree: this node's key signs a `revoke` statement with anchors
/// at our stored heads of every chain the target has written. Seniority is pre-checked here for
/// a friendly error; every other node's ingest gate re-checks it independently, which is the
/// check that actually matters.
/// Where a repudiation's cut-point falls (PROJECT_PLAN, Revocation: the cut-point can be
/// anywhere in logical history).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cut {
    /// Anchor the target's current heads: it was you until this moment. Also the only cut a
    /// retirement can take - retirement IS the honoring of history.
    Now,
    /// Anchor nothing: it was never you, and no history is credited.
    Genesis,
}

pub async fn revoke_key(
    state: &crate::AppState,
    account_id: &Uuid,
    root_hex: &str,
    target_hex: &str,
    disposition: Disposition,
    cut: Cut,
) -> Result<String, AppError> {
    require_owned(&state.node_db, account_id, root_hex).await?;
    let target = pubkey::require(target_hex, "target pubkey")?;

    let signer = load_signing_key(&state.node_db, &state.keystore, account_id, root_hex).await?;
    let signer_pub = signer.verifying_key().to_bytes();

    let db = state
        .user_dbs
        .get(root_hex)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::record::imaol::load_key_tree(&db, root_hex).await?;

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
    // table's owner) - unless the cut is genesis, where anchoring nothing IS the statement:
    // no sealed prefix, no credited history, the gate refuses everything the key ever signed.
    let anchors: Vec<Anchor> = match cut {
        Cut::Genesis => Vec::new(),
        Cut::Now => crate::record::imaol::chain_heads_for_author(&db, target_hex)
            .await?
            .into_iter()
            .map(|(service, seq, head_hash)| Anchor {
                service,
                seq,
                head_hash,
            })
            .collect(),
    };

    let payload = Revoke {
        target,
        disposition,
        anchors,
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow!("encoding revocation: {e}")))?;
    let signed = crate::record::imaol::append(
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
    //
    // Except self-retirement, by the minter rule: **you may not sign the epoch that excludes
    // you.** A retiring key that mints the "fresh" epoch knows it - the key was in this
    // machine's memory on its way to the dumpster, which is exactly what rotation exists to
    // survive. The rotation falls to a surviving member's node on observing the retirement;
    // until then members keep writing under the old epoch, the honest window of the
    // cooperative disposition (a hostile exit is repudiation, senior-issued and windowless).
    if signer_pub == target {
        tracing::info!(
            root = %root_hex,
            "self-retirement: epoch rotation deferred to a surviving member (minter rule)"
        );
    } else {
        let tree = crate::record::imaol::load_key_tree(&db, root_hex).await?;
        match crate::record::private::rotate_epoch(&db, &signer, &tree, &target).await {
            Ok(epoch_entry) => tracing::info!(
                root = %root_hex,
                entry = %hex::encode(epoch_entry.hash()),
                "rotated private epoch after revocation"
            ),
            Err(e) => {
                tracing::error!(root = %root_hex, "epoch rotation after revocation failed: {e}")
            }
        }
    }

    // The revocation is on the chain; now let the gate's sweep apply it to what this node
    // already stores (a genesis cut evicts the target's uncredited chains and rebuilds the
    // views). An empty batch through the ordinary gate: one sweeper, no second code path.
    // Failure doesn't unwind the revocation - the next real ingest runs the same sweep.
    let root_pk = pubkey::require(root_hex, "root pubkey")?;
    if let Err(e) = crate::net::sync::ingest_batch(&db, root_pk, Vec::new(), false).await {
        tracing::error!(root = %root_hex, "post-revocation sweep failed: {e}");
    }

    tracing::info!(root = %root_hex, target = %target_hex, ?disposition, "revoked key");
    Ok(hex::encode(signed.hash()))
}
