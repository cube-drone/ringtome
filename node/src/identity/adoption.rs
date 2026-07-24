//! The add-a-node ceremony (PROJECT_PLAN, Adding a New Node).
//!
//! Two copy-pastes: the joining node emits a *request code* (its fresh leaf key + how to reach
//! it); the identity's root node turns that into a signed authorization and emits a *grant code*
//! (the root + how to reach the granter); the joining node completes by syncing the identity
//! chains and finding its own authorization there. Codes are JSON - the M4 client dresses them
//! as QR.
//!
//! This module owns the `pending_adoptions` table (the joining node's between-steps state).

use anyhow::{anyhow, Context};
use ed25519_dalek::SigningKey;
use rand::rngs::OsRng;
use ringtome_proto::crown::KeyStatus;
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Authorize, Payload};
use uuid::Uuid;

use crate::clock::now_ms;
use crate::error::AppError;
use crate::pubkey;
use crate::AppState;

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

/// Step 1, on the joining node: mint a leaf keypair for a prospective identity and emit the
/// request code. The leaf is sealed immediately; nothing about the identity is known yet.
pub async fn begin(state: &AppState, account_id: &Uuid) -> Result<RequestCode, AppError> {
    let leaf = SigningKey::generate(&mut OsRng);
    let leaf_hex = hex::encode(leaf.verifying_key().to_bytes());

    state
        .keystore
        .store(&leaf_hex, &leaf.to_bytes(), leaf_hex.as_bytes())
        .context("sealing adoption leaf key")
        .map_err(AppError::Internal)?;
    let leaf_enc = crate::seal::EncKeyPair::generate();
    crate::record::private::store_enc_keypair(&state.keystore, &leaf_hex, &leaf_enc)
        .context("sealing adoption encryption key")
        .map_err(AppError::Internal)?;
    state
        .node_db
        .execute(
            "INSERT INTO pending_adoptions (leaf_pubkey, account_id, created_at_ms) VALUES (?1, ?2, ?3)",
            (leaf_hex.as_str(), account_id.to_string(), now_ms()),
        )
        .await
        .context("recording pending adoption")
        .map_err(AppError::Internal)?;

    Ok(RequestCode {
        v: 0,
        kind: REQUEST_KIND.to_string(),
        leaf_pubkey: leaf_hex,
        enc_pubkey: hex::encode(leaf_enc.public),
        endpoint_id: state.endpoint.id().to_string(),
        addrs: crate::net::p2p::addr_strings(&state.endpoint),
    })
}

/// Step 2, on the granting node: the identity's root signs the leaf into the tree and emits the
/// grant code. v1: only the root's own node may grant (the root is the only key whose stamp we
/// can compute as a parent here).
pub async fn authorize_node(
    state: &AppState,
    account_id: &Uuid,
    root_hex: &str,
    code: RequestCode,
) -> Result<GrantCode, AppError> {
    if code.kind != REQUEST_KIND {
        return Err(AppError::BadRequest("not an adoption request code".into()));
    }
    // Refuse self-adoption HERE, before any tree pollution: granting a request minted by this
    // very node would authorize a stray leaf and then die at completion's sync (iroh refuses
    // self-dial - correctly, since the data is already local). Adoption is for bringing a
    // persona to a computer that doesn't have it; a second account on THIS node joining the
    // same persona is a different, future mechanism (account linking - no new keys, no sync).
    if code.endpoint_id == state.endpoint.id().to_string() {
        return Err(AppError::BadRequest(
            "that request code comes from this very computer - it is already this persona. \
             Adoption brings a persona to a NEW computer; run \"bring your persona\" there \
             instead."
                .into(),
        ));
    }
    super::require_owned(&state.node_db, account_id, root_hex).await?;

    let leaf = pubkey::require(&code.leaf_pubkey, "leaf pubkey in request code")?;
    let leaf_enc = pubkey::require(&code.enc_pubkey, "encryption pubkey in request code")?;
    let root = pubkey::require(root_hex, "root pubkey")?;

    let signer =
        super::load_signing_key(&state.node_db, &state.keystore, account_id, root_hex).await?;
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
    let tree = crate::record::imaol::load_key_tree(&db, root_hex).await?;
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
    crate::record::imaol::append(
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
    let our_enc = crate::record::private::load_enc_keypair(&state.keystore, root_hex)
        .context("loading our encryption key")
        .map_err(AppError::Internal)?;
    let epoch_keys = crate::record::private::unseal_epoch_keys(&db, &root, &our_enc).await?;
    let resealed =
        crate::record::private::reseal_epochs_to(&db, &signer, &leaf, &leaf_enc, &epoch_keys)
            .await?;
    tracing::info!(root = %root_hex, leaf = %code.leaf_pubkey, resealed, "sealed epoch history");

    // Remember the joining node as a peer so future syncs reach it.
    crate::net::sync::add_peer(&state.node_db, root_hex, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;

    tracing::info!(root = %root_hex, leaf = %code.leaf_pubkey, "authorized new node");
    Ok(GrantCode {
        v: 0,
        kind: GRANT_KIND.to_string(),
        root_pubkey: root_hex.to_string(),
        leaf_pubkey: code.leaf_pubkey,
        endpoint_id: state.endpoint.id().to_string(),
        addrs: crate::net::p2p::addr_strings(&state.endpoint),
    })
}

/// Step 3, back on the joining node: sync the identity chains from the granter, verify our leaf
/// actually landed in the tree, and start agenting the identity.
/// Completion for an in-band-delivered grant (net::adopt): the pending row itself says which
/// account minted the request, so no session is involved - possession of a matching pending
/// leaf IS the authorization (the leaf pubkey is a 32-byte unguessable this node created).
/// A grant for a leaf with no pending row is refused unless that exact adoption already
/// completed (redelivery of a done deal acks ok).
pub async fn complete_delivered(state: &AppState, code: GrantCode) -> Result<(), AppError> {
    let pending: Option<(String,)> = state
        .node_db
        .fetch_optional(
            "SELECT account_id FROM pending_adoptions WHERE leaf_pubkey = ?1",
            (code.leaf_pubkey.as_str(),),
        )
        .await
        .context("checking pending adoption")
        .map_err(AppError::Internal)?;
    let Some((account_id,)) = pending else {
        if super::leaf_agents_root(&state.node_db, &code.root_pubkey, &code.leaf_pubkey).await? {
            return Ok(());
        }
        return Err(AppError::NotFound(
            "no pending adoption for that key".into(),
        ));
    };
    let account_uuid = Uuid::parse_str(&account_id)
        .map_err(|e| AppError::Internal(anyhow!("malformed pending account id: {e}")))?;
    complete(state, &account_uuid, code).await.map(|_| ())
}

pub async fn complete(
    state: &AppState,
    account_id: &Uuid,
    code: GrantCode,
) -> Result<super::Identity, AppError> {
    if code.kind != GRANT_KIND {
        return Err(AppError::BadRequest("not an adoption grant code".into()));
    }
    // Belt to the grant-side braces: a grant whose addresses point back at this same computer
    // can only end in iroh's self-dial refusal - say so in words instead.
    if code.endpoint_id == state.endpoint.id().to_string() {
        return Err(AppError::BadRequest(
            "that invite points back at this very computer - it was granted here. Paste it on \
             the NEW computer instead."
                .into(),
        ));
    }
    // The pending leaf must belong to this account (uniform 404 otherwise). One carve-out
    // makes completion IDEMPOTENT: if there is no pending row but this account already agents
    // the identity with this exact leaf, the adoption finished by another path (in-band grant
    // delivery beat the human's paste) - confirm success instead of 404ing a done deal.
    let pending: Option<(String,)> = state
        .node_db
        .fetch_optional(
            "SELECT account_id FROM pending_adoptions WHERE leaf_pubkey = ?1",
            (code.leaf_pubkey.as_str(),),
        )
        .await
        .context("checking pending adoption")
        .map_err(AppError::Internal)?;
    if pending.map(|(a,)| a) != Some(account_id.to_string()) {
        if let Some(identity) = super::adopted_identity(
            &state.node_db,
            account_id,
            &code.root_pubkey,
            &code.leaf_pubkey,
        )
        .await?
        {
            return Ok(identity);
        }
        return Err(AppError::NotFound(
            "no pending adoption for that key".into(),
        ));
    }

    let leaf = pubkey::require(&code.leaf_pubkey, "leaf pubkey in grant code")?;

    crate::net::sync::add_peer(&state.node_db, &code.root_pubkey, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;
    // Bootstrap dial: the grant code's addresses are ephemeral single-use hints (allowed to be
    // addresses precisely because they don't live long enough to rot). Later syncs resolve via
    // the directory.
    let addr = crate::net::sync::endpoint_addr(&code.endpoint_id, &code.addrs)
        .map_err(|e| AppError::BadRequest(format!("bad grant code addresses: {e}")))?;

    let stats = crate::net::sync::sync_with_peer(state, &code.root_pubkey, addr)
        .await
        .map_err(|e| AppError::Internal(anyhow!("initial sync failed: {e}")))?;
    tracing::info!(root = %code.root_pubkey, ?stats, "adoption sync complete");

    let db = state
        .user_dbs
        .get(&code.root_pubkey)
        .await
        .map_err(AppError::Internal)?;
    let tree = crate::record::imaol::load_key_tree(&db, &code.root_pubkey).await?;
    if tree.status(&leaf) != KeyStatus::Active {
        return Err(AppError::BadRequest(
            "our key is not (yet) authorized on the identity chain - paste the request code at \
             the granting node first"
                .into(),
        ));
    }

    let created_at_ms = now_ms();
    super::record_identity(
        &state.node_db,
        account_id,
        &code.root_pubkey,
        &code.leaf_pubkey,
        created_at_ms,
    )
    .await?;
    state
        .node_db
        .execute(
            "DELETE FROM pending_adoptions WHERE leaf_pubkey = ?1",
            (code.leaf_pubkey.as_str(),),
        )
        .await
        .context("clearing pending adoption")
        .map_err(AppError::Internal)?;
    crate::net::sync::mark_synced(&state.node_db, &code.root_pubkey, &code.endpoint_id)
        .await
        .map_err(AppError::Internal)?;

    // Second pass, now that we agent the identity: the first sync ran proof-less (no identities
    // row yet), so the granter rightly withheld the private chains. This one carries our member
    // proof and pulls them - adoption ends with the private state here, not eventually.
    let addr = crate::net::sync::endpoint_addr(&code.endpoint_id, &code.addrs)
        .map_err(|e| AppError::BadRequest(format!("bad grant code addresses: {e}")))?;
    let stats = crate::net::sync::sync_with_peer(state, &code.root_pubkey, addr)
        .await
        .map_err(|e| AppError::Internal(anyhow!("private-chain sync failed: {e}")))?;
    tracing::info!(root = %code.root_pubkey, ?stats, "adoption private sync complete");

    // The new key's device name - this node labeling itself, as its first authored write on
    // the identity (PROJECT_PLAN, Device Names). Best-effort by design: the epoch keys just
    // arrived on the private sync above, but if anything about that is still settling, a
    // missing label is a rename away - it must never fail an otherwise-complete adoption.
    match crate::record::store::open(state, account_id, &code.root_pubkey).await {
        Ok(data) => {
            if let Err(e) = data
                .devices()
                .set_name(&leaf, &state.config.node_name)
                .await
            {
                tracing::warn!(root = %code.root_pubkey, "could not write device name: {e}");
            }
        }
        Err(e) => {
            tracing::warn!(root = %code.root_pubkey, "could not open store for device name: {e}");
        }
    }

    Ok(super::Identity {
        root_pubkey: code.root_pubkey,
        created_at_ms,
    })
}
