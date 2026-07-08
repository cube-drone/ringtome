//! HTTP routes for identities: create one, list the caller's, and work with an identity's
//! chains - profile get/set, view rebuild, and the raw entry log.
//!
//! Everything under `/api/identity/{root}/...` is owner-gated for M1: the session's account must
//! own the identity. (Public serving of profiles is an M3/M4 concern, arriving with sync.)

use axum::extract::{Path, State};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::imaol;
use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/identity", post(create_handler))
        .route("/api/identity", get(list_handler))
        .route(
            "/api/identity/{root}/profile",
            get(get_profile_handler).post(set_profile_handler),
        )
        .route("/api/identity/{root}/rebuild", post(rebuild_handler))
        .route("/api/identity/{root}/entries", get(entries_handler))
        .route("/api/identity/{root}/keys", get(keys_handler))
        // M3: multi-node.
        .route("/api/identity/adopt/begin", post(adopt_begin_handler))
        .route("/api/identity/adopt/complete", post(adopt_complete_handler))
        .route("/api/identity/{root}/nodes", post(authorize_node_handler))
        .route("/api/identity/{root}/sync", post(sync_handler))
        .route("/api/identity/{root}/serve", post(serve_handler))
        .route(
            "/api/identity/{root}/keys/{target}/revoke",
            post(revoke_key_handler),
        )
        // Private chains: the member-only KV + set store (encrypted at rest, synced only to the
        // identity's own nodes).
        .route(
            "/api/identity/{root}/private/kv/{collection}",
            get(private_kv_list_handler),
        )
        .route(
            "/api/identity/{root}/private/kv/{collection}/{key}",
            put(private_kv_put_handler),
        )
        .route(
            "/api/identity/{root}/private/set/{collection}",
            get(private_set_list_handler).post(private_set_add_handler),
        )
        .route(
            "/api/identity/{root}/private/set/{collection}/{element}",
            delete(private_set_remove_handler),
        )
}

/// Profile fields settable in v0. A closed set: the profile is a schema, not a junk drawer.
const ALLOWED_PROFILE_FIELDS: &[&str] = &["name", "bio"];

#[derive(Serialize)]
struct IdentityInfo {
    root_pubkey: String,
    created_at_ms: i64,
}

impl From<super::Identity> for IdentityInfo {
    fn from(i: super::Identity) -> Self {
        Self {
            root_pubkey: i.root_pubkey,
            created_at_ms: i.created_at_ms,
        }
    }
}

/// Identity creation response. `recovery_secret` appears here and **nowhere else, ever** - the
/// node does not keep it. The client owns the "put the spare key somewhere safe" ceremony.
#[derive(Serialize)]
struct CreatedIdentityInfo {
    root_pubkey: String,
    created_at_ms: i64,
    recovery_pubkey: String,
    recovery_secret: String,
    authorize_entry_hash: String,
}

/// Create a new identity owned by the logged-in account, minting its recovery key.
async fn create_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Json<CreatedIdentityInfo>, AppError> {
    let created = super::create(
        &state.node_db,
        &state.keystore,
        &state.user_dbs,
        &session.account.id,
    )
    .await?;
    Ok(Json(CreatedIdentityInfo {
        root_pubkey: created.root_pubkey,
        created_at_ms: created.created_at_ms,
        recovery_pubkey: created.recovery_pubkey,
        recovery_secret: created.recovery_secret,
        authorize_entry_hash: created.authorize_entry_hash,
    }))
}

/// List the identities owned by the logged-in account.
async fn list_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Json<Vec<IdentityInfo>>, AppError> {
    let identities = super::list_for_account(&state.node_db, &session.account.id).await?;
    Ok(Json(identities.into_iter().map(Into::into).collect()))
}

#[derive(Deserialize)]
struct SetProfileField {
    field: String,
    value: String,
}

#[derive(Serialize)]
struct SetProfileResponse {
    field: String,
    value: String,
    seq: u64,
    entry_hash: String,
}

/// Set one public-profile field: signs a `profile-set` entry onto the identity's profile chain
/// and folds it into the materialized view.
async fn set_profile_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<SetProfileField>,
) -> Result<Json<SetProfileResponse>, AppError> {
    if !ALLOWED_PROFILE_FIELDS.contains(&req.field.as_str()) {
        return Err(AppError::BadRequest(format!(
            "unknown profile field {:?} (allowed: {})",
            req.field,
            ALLOWED_PROFILE_FIELDS.join(", ")
        )));
    }

    let key = super::load_signing_key(&state.node_db, &state.keystore, &session.account.id, &root)
        .await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;

    let signed = imaol::set_profile_field(&db, &key, &req.field, &req.value).await?;
    Ok(Json(SetProfileResponse {
        field: req.field,
        value: req.value,
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// The identity's materialized public profile.
async fn get_profile_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<imaol::ProfileField>>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(imaol::get_profile(&db).await?))
}

#[derive(Serialize)]
struct RebuildResponse {
    entries_replayed: u64,
}

/// Wipe the materialized views and rebuild them from the signed entries log, re-validating every
/// chain link. The views are caches; this proves it.
///
/// Local-test only, like the SQL passthrough: the *operation* has real production triggers
/// (view-schema migrations, repudiation/fork aftermath, corruption repair), but they all call
/// `imaol::rebuild_views` internally - this HTTP surface has no production caller until an
/// operator/admin surface exists, and it is deliberately non-transactional (readers mid-rebuild
/// see partial views; a failed rebuild leaves them wiped - loud by design for a debug tool).
/// When it returns as an admin action, it returns transactional.
async fn rebuild_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<RebuildResponse>, AppError> {
    if !state.config.local_test {
        // Uniform 404: on a production node this endpoint does not exist.
        return Err(AppError::NotFound("not found".into()));
    }
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    let entries_replayed = imaol::rebuild_views(&db).await?;
    Ok(Json(RebuildResponse { entries_replayed }))
}

/// The raw entry log, hex-encoded - the debug surface (`ringtome inspect` eats the hex).
async fn entries_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<imaol::StoredEntry>>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(imaol::list_entries(&db).await?))
}

/// Adoption codes travel as opaque strings (JSON today, QR clothing in M4).
#[derive(Serialize)]
struct CodeResponse {
    code: String,
}

#[derive(Deserialize)]
struct CodeRequest {
    code: String,
}

/// Step 1 (joining node): mint a leaf key, get the request code to carry to the granting node.
async fn adopt_begin_handler(
    session: Session,
    State(state): State<AppState>,
) -> Result<Json<CodeResponse>, AppError> {
    let request = super::begin_adoption(&state, &session.account.id).await?;
    let code = serde_json::to_string(&request)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("encoding request code: {e}")))?;
    Ok(Json(CodeResponse { code }))
}

/// Step 2 (granting node): authorize the requesting node's leaf into the tree; returns the
/// grant code to carry back.
async fn authorize_node_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<CodeRequest>,
) -> Result<Json<CodeResponse>, AppError> {
    let request: super::RequestCode = serde_json::from_str(&req.code)
        .map_err(|_| AppError::BadRequest("unparseable request code".into()))?;
    let grant = super::authorize_node(&state, &session.account.id, &root, request).await?;
    let code = serde_json::to_string(&grant)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("encoding grant code: {e}")))?;
    Ok(Json(CodeResponse { code }))
}

/// Step 3 (joining node): sync from the granter, verify our authorization, start agenting.
async fn adopt_complete_handler(
    session: Session,
    State(state): State<AppState>,
    Json(req): Json<CodeRequest>,
) -> Result<Json<IdentityInfo>, AppError> {
    let grant: super::GrantCode = serde_json::from_str(&req.code)
        .map_err(|_| AppError::BadRequest("unparseable grant code".into()))?;
    let identity = super::complete_adoption(&state, &session.account.id, grant).await?;
    Ok(Json(identity.into()))
}

#[derive(Serialize)]
struct PeerSyncResult {
    peer: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    stats: Option<crate::sync::ExchangeStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Run a full exchange with every known peer of this identity. Per-peer failures are reported,
/// not fatal - an unreachable peer is a normal day on a p2p network.
async fn sync_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<PeerSyncResult>>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let peers = crate::sync::peers_for(&state.node_db, &root)
        .await
        .map_err(AppError::Internal)?;

    let mut results = Vec::new();
    for peer_id in peers {
        // Resolve at dial time: id -> addresses via the directory (or iroh's own discovery).
        let attempt = async {
            let addr = crate::sync::dial_addr(&state, &peer_id).await?;
            crate::sync::sync_with_peer(&state, &root, addr).await
        };
        match attempt.await {
            Ok(stats) => {
                crate::sync::mark_synced(&state.node_db, &root, &peer_id)
                    .await
                    .map_err(AppError::Internal)?;
                results.push(PeerSyncResult {
                    peer: peer_id,
                    ok: true,
                    stats: Some(stats),
                    error: None,
                });
            }
            Err(e) => results.push(PeerSyncResult {
                peer: peer_id,
                ok: false,
                stats: None,
                error: Some(format!("{e:#}")),
            }),
        }
    }
    Ok(Json(results))
}

#[derive(Serialize)]
struct ServeResponse {
    served: bool,
}

/// Mark this identity as served by this node and publish its serving record. This is the
/// publication *act*: until it happens, the identity is dark - no record exists anywhere.
async fn serve_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<ServeResponse>, AppError> {
    super::mark_served(&state, &session.account.id, &root).await?;
    Ok(Json(ServeResponse { served: true }))
}

#[derive(Deserialize)]
struct RevokeRequest {
    disposition: String,
}

#[derive(Serialize)]
struct RevokeResponse {
    entry_hash: String,
}

/// Revoke a key in this identity's tree ("retirement" or "repudiation"). The statement lands on
/// this node's identity chain and reaches other nodes via sync, whose gates enforce it.
async fn revoke_key_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, target)): Path<(String, String)>,
    Json(req): Json<RevokeRequest>,
) -> Result<Json<RevokeResponse>, AppError> {
    let disposition = match req.disposition.as_str() {
        "retirement" => ringtome_proto::Disposition::Retirement,
        "repudiation" => ringtome_proto::Disposition::Repudiation,
        other => {
            return Err(AppError::BadRequest(format!(
                "unknown disposition {other:?} (retirement | repudiation)"
            )))
        }
    };
    let entry_hash =
        super::revoke_key(&state, &session.account.id, &root, &target, disposition).await?;
    Ok(Json(RevokeResponse { entry_hash }))
}

#[derive(Serialize)]
struct KeyInfo {
    pubkey: String,
    status: &'static str,
    rank_path: Vec<u64>,
}

#[derive(Serialize)]
struct KeyTreeResponse {
    root_pubkey: String,
    keys: Vec<KeyInfo>,
    forks: usize,
}

/// The identity's resolved key tree: every known key with its status and rank path, plus a fork
/// count (any nonzero value is evidence of key duplication or compromise).
async fn keys_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<KeyTreeResponse>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(AppError::Internal)?;
    let tree = imaol::load_key_tree(&db, &root).await?;

    let keys = tree
        .members()
        .map(|(pk, status)| KeyInfo {
            pubkey: hex::encode(pk),
            status: status.name(),
            rank_path: tree.rank_path(pk).unwrap_or_default().to_vec(),
        })
        .collect();

    Ok(Json(KeyTreeResponse {
        root_pubkey: root,
        keys,
        forks: tree.forks().len(),
    }))
}

// ---------------------------------------------------------------------------------------------
// Private chains: the member-only KV + set store.

/// Everything a private-store operation needs: the per-user DB, this node's signing key, and the
/// epoch keys it can unseal. Owner-gated like every other identity route.
async fn private_context(
    state: &AppState,
    account_id: &uuid::Uuid,
    root: &str,
) -> Result<
    (
        sqlx::SqlitePool,
        ringtome_proto::SigningKey,
        crate::private::EpochKeys,
    ),
    AppError,
> {
    let signer = super::load_signing_key(&state.node_db, &state.keystore, account_id, root).await?;
    let leaf = signer.verifying_key().to_bytes();
    let enc = crate::private::load_enc_keypair(&state.keystore, &hex::encode(leaf))
        .map_err(AppError::Internal)?;
    let db = state.user_dbs.get(root).await.map_err(AppError::Internal)?;
    let keys = crate::private::unseal_epoch_keys(&db, &leaf, &enc).await?;
    Ok((db, signer, keys))
}

#[derive(Deserialize)]
struct PrivateKvPut {
    value: String,
}

#[derive(Serialize)]
struct PrivateWriteResponse {
    seq: u64,
    entry_hash: String,
}

/// Set one register in a private collection (LWW per key).
async fn private_kv_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, collection, key)): Path<(String, String, String)>,
    Json(req): Json<PrivateKvPut>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let (db, signer, keys) = private_context(&state, &session.account.id, &root).await?;
    let plain = ringtome_proto::PrivatePlain {
        kind: ringtome_proto::PrivateKind::Register,
        collection,
        key,
        value: Some(req.value),
    };
    let signed = crate::private::write_record(&db, &signer, &keys, &plain).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Serialize)]
struct PrivateKvListResponse {
    values: Vec<crate::private::RegisterValue>,
    /// Records on this node's chains that none of our epoch keys open. Nonzero is worth showing
    /// a user: it means history from outside this key's membership era.
    undecryptable: u64,
}

/// The materialized registers of one private collection.
async fn private_kv_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, collection)): Path<(String, String)>,
) -> Result<Json<PrivateKvListResponse>, AppError> {
    let (db, _signer, keys) = private_context(&state, &session.account.id, &root).await?;
    let view = crate::private::materialize(&db, &keys).await?;
    Ok(Json(PrivateKvListResponse {
        values: view.registers_in(&collection),
        undecryptable: view.undecryptable,
    }))
}

#[derive(Deserialize)]
struct PrivateSetAdd {
    element: String,
    value: Option<String>,
}

/// Add an element to a private set (LWW-element-set: one entry per element, add/remove race
/// resolves by timestamp).
async fn private_set_add_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, collection)): Path<(String, String)>,
    Json(req): Json<PrivateSetAdd>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let (db, signer, keys) = private_context(&state, &session.account.id, &root).await?;
    let plain = ringtome_proto::PrivatePlain {
        kind: ringtome_proto::PrivateKind::SetAdd,
        collection,
        key: req.element,
        value: req.value,
    };
    let signed = crate::private::write_record(&db, &signer, &keys, &plain).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Remove an element from a private set.
async fn private_set_remove_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, collection, element)): Path<(String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let (db, signer, keys) = private_context(&state, &session.account.id, &root).await?;
    let plain = ringtome_proto::PrivatePlain {
        kind: ringtome_proto::PrivateKind::SetRemove,
        collection,
        key: element,
        value: None,
    };
    let signed = crate::private::write_record(&db, &signer, &keys, &plain).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Serialize)]
struct PrivateSetListResponse {
    elements: Vec<crate::private::SetElement>,
    undecryptable: u64,
}

/// The present elements of one private set.
async fn private_set_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, collection)): Path<(String, String)>,
) -> Result<Json<PrivateSetListResponse>, AppError> {
    let (db, _signer, keys) = private_context(&state, &session.account.id, &root).await?;
    let view = crate::private::materialize(&db, &keys).await?;
    Ok(Json(PrivateSetListResponse {
        elements: view.set_elements(&collection),
        undecryptable: view.undecryptable,
    }))
}
