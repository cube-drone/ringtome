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
use crate::private;
use crate::store;
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
        // Versioned documents (the notes app): headers on the notes chain, bodies in the file
        // layer, divergence kept - never LWW'd away.
        .route(
            "/api/identity/{root}/docs",
            get(docs_list_handler).post(docs_create_handler),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}",
            get(docs_get_handler).put(docs_save_handler),
        )
}

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
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.profile().set(&req.field, &req.value).await?;
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
    let data = store::open(&state, &session.account.id, &root).await?;
    Ok(Json(data.profile().all().await?))
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
    let request = super::adoption::begin(&state, &session.account.id).await?;
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
    let request: super::adoption::RequestCode = serde_json::from_str(&req.code)
        .map_err(|_| AppError::BadRequest("unparseable request code".into()))?;
    let grant =
        super::adoption::authorize_node(&state, &session.account.id, &root, request).await?;
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
    let grant: super::adoption::GrantCode = serde_json::from_str(&req.code)
        .map_err(|_| AppError::BadRequest("unparseable grant code".into()))?;
    let identity = super::adoption::complete(&state, &session.account.id, grant).await?;
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
    super::serving::mark_served(&state, &session.account.id, &root).await?;
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
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data
        .private_registers(&collection)
        .set(&key, &req.value)
        .await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Serialize)]
struct PrivateKvListResponse {
    values: Vec<private::RegisterValue>,
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
    let data = store::open(&state, &session.account.id, &root).await?;
    let (values, undecryptable) = data.private_registers(&collection).all().await?;
    Ok(Json(PrivateKvListResponse {
        values,
        undecryptable,
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
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data
        .private_set(&collection)
        .add(&req.element, req.value)
        .await?;
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
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.private_set(&collection).remove(&element).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

// ---------------------------------------------------------------------------------------------
// Versioned documents (the notes app).

fn hex_fixed<const N: usize>(s: &str, what: &str) -> Result<[u8; N], AppError> {
    hex::decode(s)
        .ok()
        .and_then(|b| <[u8; N]>::try_from(b).ok())
        .ok_or_else(|| AppError::BadRequest(format!("bad {what} (expected {} hex chars)", N * 2)))
}

#[derive(Deserialize)]
struct DocCreate {
    title: String,
    body: String,
}

#[derive(Serialize)]
struct DocCreated {
    doc_id: String,
    version: String,
}

/// Create a document: mint its id, save the genesis version.
async fn docs_create_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<DocCreate>,
) -> Result<Json<DocCreated>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (doc_id, version) = data.documents().create(&req.title, req.body.as_bytes()).await?;
    Ok(Json(DocCreated {
        doc_id: hex::encode(doc_id),
        version: hex::encode(version),
    }))
}

#[derive(Deserialize)]
struct DocSave {
    title: String,
    body: String,
    /// The version hash(es) this save was edited from - the current head for an ordinary save.
    parents: Vec<String>,
}

#[derive(Serialize)]
struct DocSaved {
    version: String,
}

/// Save one version of a document. The client asserts `parents`; the materializer detects the
/// consequences (fast-forward or divergence) - it never resolves them by clock.
async fn docs_save_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
    Json(req): Json<DocSave>,
) -> Result<Json<DocSaved>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let parents = req
        .parents
        .iter()
        .map(|p| hex_fixed::<32>(p, "parent version hash"))
        .collect::<Result<Vec<_>, _>>()?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let version = data
        .documents()
        .save(crate::notes::Save {
            doc_id,
            parents,
            title: req.title,
            body: req.body.into_bytes(),
        })
        .await?;
    Ok(Json(DocSaved {
        version: hex::encode(version),
    }))
}

#[derive(Serialize)]
struct DocSummary {
    doc_id: String,
    title: String,
    /// The default head's version hash - what an editor opens, and the parent of its next save.
    head: String,
    heads: usize,
    diverged: bool,
    updated_ms: i64,
}

#[derive(Serialize)]
struct DocListResponse {
    docs: Vec<DocSummary>,
    undecryptable: usize,
}

/// Every document, newest first: the note list.
async fn docs_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<DocListResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let view = data.documents().all().await?;
    let mut docs: Vec<DocSummary> = view
        .docs
        .iter()
        .filter_map(|(id, doc)| {
            let head = doc.display_head()?;
            Some(DocSummary {
                doc_id: hex::encode(id),
                title: head.header.title.clone(),
                head: hex::encode(head.hash),
                heads: doc.logical_heads.len(),
                diverged: doc.diverged(),
                updated_ms: head.timestamp_ms,
            })
        })
        .collect();
    docs.sort_by_key(|d| std::cmp::Reverse(d.updated_ms));
    Ok(Json(DocListResponse {
        docs,
        undecryptable: view.undecryptable,
    }))
}

#[derive(Serialize)]
struct DocHead {
    version: String,
    title: String,
    timestamp_ms: i64,
    /// Absent when this node can't produce the body (not fetched yet, or outside our key era).
    body: Option<String>,
}

#[derive(Serialize)]
struct DocDetail {
    doc_id: String,
    diverged: bool,
    /// The document's current title after field-wise resolution (a rename on one side wins).
    title: String,
    /// The synthesized current text - what an editor opens: one head verbatim ("single"), a
    /// clean three-way merge ("merged"), or the conflict inline, git-style with device labels
    /// ("conflict"). Null only when needed bodies aren't on this node yet.
    body: Option<String>,
    resolution: &'static str,
    /// Every *logical* head, bodies included - divergence means more than one, all kept, all
    /// shown (never-lose-words is a UI obligation too). Heads that carry no distinct words
    /// (identical twins, ancestor echoes) are folded at read time and don't appear here.
    heads: Vec<DocHead>,
    /// What the next save must list as `parents`: ALL the DAG's true heads, folded ones
    /// included, so the fork heals through an ordinary write.
    save_parents: Vec<String>,
}

/// One document: all its heads, with bodies.
async fn docs_get_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Json<DocDetail>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let view = data.documents().all().await?;
    let doc = view
        .docs
        .get(&doc_id)
        .ok_or_else(|| AppError::NotFound("document not found".into()))?;

    let mut heads = Vec::new();
    for h in &doc.logical_heads {
        let Some(version) = doc.versions.get(h) else {
            continue;
        };
        let body = data
            .documents()
            .body(version)
            .await?
            .map(|b| String::from_utf8_lossy(&b).into_owned());
        heads.push(DocHead {
            version: hex::encode(version.hash),
            title: version.header.title.clone(),
            timestamp_ms: version.timestamp_ms,
            body,
        });
    }
    heads.sort_by(|a, b| (b.timestamp_ms, &b.version).cmp(&(a.timestamp_ms, &a.version)));
    let mut save_parents: Vec<String> = doc.heads.iter().map(hex::encode).collect();
    save_parents.sort();

    let resolved = data.documents().resolved(doc).await?;
    Ok(Json(DocDetail {
        doc_id: hex::encode(doc_id),
        diverged: doc.diverged(),
        title: resolved.title,
        body: resolved.body,
        resolution: match resolved.resolution {
            crate::notes::Resolution::Single => "single",
            crate::notes::Resolution::Merged => "merged",
            crate::notes::Resolution::Conflict => "conflict",
        },
        heads,
        save_parents,
    }))
}

#[derive(Serialize)]
struct PrivateSetListResponse {
    elements: Vec<private::SetElement>,
    undecryptable: u64,
}

/// The present elements of one private set.
async fn private_set_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, collection)): Path<(String, String)>,
) -> Result<Json<PrivateSetListResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (elements, undecryptable) = data.private_set(&collection).elements().await?;
    Ok(Json(PrivateSetListResponse {
        elements,
        undecryptable,
    }))
}
