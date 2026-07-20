//! HTTP routes for identities: create one, list the caller's, and work with an identity's
//! chains - profile get/set, view rebuild, and the raw entry log.
//!
//! Everything under `/api/identity/{root}/...` is owner-gated for M1: the session's account must
//! own the identity. (Public serving of profiles is an M3/M4 concern, arriving with sync.)

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::imaol;
use crate::record::private;
use crate::record::store;
use crate::AppState;

/// Per-route request-body ceilings, from config. Two `usize`s that must not get swapped, so they
/// travel as named fields.
pub struct BodyLimits {
    /// Raw media uploads (pre-crunch) - the binary routes.
    pub upload: usize,
    /// Text/marquee document bodies (the distribution cap; text isn't crushed) - the JSON doc routes.
    pub document: usize,
}

pub fn router(limits: BodyLimits) -> Router<AppState> {
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
        // Text/marquee document routes carry the whole body as JSON, so they lift the limit to the
        // ~10MB document cap (a novel-stuffer's ceiling); GET is unaffected, but a shared limit on
        // the method-router is harmless since reads have no body.
        .route(
            "/api/identity/{root}/docs",
            get(docs_list_handler)
                .post(docs_create_handler)
                .layer(DefaultBodyLimit::max(limits.document)),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}",
            get(docs_get_handler)
                .put(docs_save_handler)
                .layer(DefaultBodyLimit::max(limits.document)),
        )
        // Binary document bodies (images, etc.): metadata rides the query string, raw bytes ride
        // the request/response body - a webp can't live in a JSON string.
        // The binary upload routes carry raw media, so they lift the body limit to the pre-crunch
        // cap; every other route keeps Axum's small default, so a note-save can't be an abuse
        // vector. An upload past the cap is rejected with 413 before it's ever quarantined.
        .route(
            "/api/identity/{root}/docs/binary",
            post(docs_create_binary_handler).layer(DefaultBodyLimit::max(limits.upload)),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/binary",
            put(docs_save_binary_handler).layer(DefaultBodyLimit::max(limits.upload)),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/body",
            get(docs_body_handler),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/thumb",
            get(docs_thumb_handler),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/preview",
            get(docs_preview_handler),
        )
        // Media ingest progress: the owner's transcode queue for this identity.
        .route(
            "/api/identity/{root}/ingest",
            get(docs_ingest_status_handler),
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
    stats: Option<crate::net::sync::ExchangeStats>,
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
    let peers = crate::net::sync::peers_for(&state.node_db, &root)
        .await
        .map_err(AppError::Internal)?;

    let mut results = Vec::new();
    for peer_id in peers {
        // Resolve at dial time: id -> addresses via the directory (or iroh's own discovery).
        let attempt = async {
            let addr = crate::net::sync::dial_addr(&state, &peer_id).await?;
            crate::net::sync::sync_with_peer(&state, &root, addr).await
        };
        match attempt.await {
            Ok(stats) => {
                crate::net::sync::mark_synced(&state.node_db, &root, &peer_id)
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
struct CrownResponse {
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
) -> Result<Json<CrownResponse>, AppError> {
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

    Ok(Json(CrownResponse {
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

/// Parse the wire `format` string ("plaintext" | "marquee"), defaulting to plaintext when absent.
fn parse_format(s: &Option<String>) -> Result<crate::record::documents::Format, AppError> {
    match s {
        None => Ok(crate::record::documents::Format::Plaintext),
        Some(s) => crate::record::documents::Format::parse(s)
            .ok_or_else(|| AppError::BadRequest(format!("unknown format {s:?} (plaintext | marquee)"))),
    }
}

#[derive(Deserialize)]
struct DocCreate {
    title: String,
    body: String,
    format: Option<String>,
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
    let format = parse_format(&req.format)?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let (doc_id, version) = data
        .documents()
        .create(&req.title, req.body.as_bytes(), format)
        .await?;
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
    /// The document's format, carried unchanged from create; defaults to plaintext.
    format: Option<String>,
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
    let format = parse_format(&req.format)?;
    let parents = req
        .parents
        .iter()
        .map(|p| hex_fixed::<32>(p, "parent version hash"))
        .collect::<Result<Vec<_>, _>>()?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let version = data
        .documents()
        .save(crate::record::documents::Save {
            doc_id,
            parents,
            title: req.title,
            body: req.body.into_bytes(),
            format,
            media: None,
        })
        .await?;
    Ok(Json(DocSaved {
        version: hex::encode(version),
    }))
}

// --- binary bodies (images) ---------------------------------------------------------------

#[derive(Deserialize)]
struct BinaryMeta {
    title: String,
    /// Comma-separated parent version hashes (empty for a create). No `format`: every bitmap
    /// upload is transcoded to canonical AVIF regardless of what arrived.
    #[serde(default)]
    parents: String,
}

fn parse_parents(csv: &str) -> Result<Vec<[u8; 32]>, AppError> {
    csv.split(',')
        .filter(|s| !s.is_empty())
        .map(|p| hex_fixed::<32>(p.trim(), "parent version hash"))
        .collect()
}

/// The `202` for a queued upload: the (version-less, pending) document id and the job to poll.
#[derive(Serialize)]
struct DocQueued {
    doc_id: String,
    job_id: String,
    status: &'static str,
}

/// Upload a binary document (an image): metadata in the query, raw bytes in the body. The bytes
/// don't enter the record or the blob store synchronously - they're quarantined and queued for
/// transcode to AVIF. Returns `202 Accepted` with the doc_id immediately; the document has no
/// version until the worker finishes (a version-less doc_id IS the pending state), and a permanent
/// failure surfaces only in the progress view, never as a ghost document.
async fn docs_create_binary_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(meta): Query<BinaryMeta>,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    // Owner gate: opening the store enforces that this account owns this identity.
    store::open(&state, &session.account.id, &root).await?;
    let doc_id = crate::record::documents::new_doc_id();
    let job_id = state
        .ingest
        .enqueue(
            &state.node_db,
            crate::ingest::Upload {
                account: &session.account.id.to_string(),
                root: &root,
                doc_id,
                parents: &[],
                title: &meta.title,
                bytes: &body,
            },
        )
        .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(DocQueued {
            doc_id: hex::encode(doc_id),
            job_id,
            status: "pending",
        }),
    ))
}

/// Upload a new binary version of an existing document. Same async path; the existing doc_id and
/// asserted parents ride the queue.
async fn docs_save_binary_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
    Query(meta): Query<BinaryMeta>,
    body: Bytes,
) -> Result<impl IntoResponse, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let parents = parse_parents(&meta.parents)?;
    store::open(&state, &session.account.id, &root).await?;
    let job_id = state
        .ingest
        .enqueue(
            &state.node_db,
            crate::ingest::Upload {
                account: &session.account.id.to_string(),
                root: &root,
                doc_id,
                parents: &parents,
                title: &meta.title,
                bytes: &body,
            },
        )
        .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(DocQueued {
            doc_id: hex::encode(doc_id),
            job_id,
            status: "pending",
        }),
    ))
}

/// The media ingest progress view for this identity's owner: every queued upload, newest first,
/// with its status and (on failure) the tombstone message.
async fn docs_ingest_status_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<crate::ingest::JobStatus>>, AppError> {
    // Owner gate before exposing this account's queue.
    store::open(&state, &session.account.id, &root).await?;
    let jobs = crate::ingest::jobs_for_account(&state.node_db, &session.account.id.to_string()).await?;
    Ok(Json(jobs))
}

/// Serve a document body as raw bytes (the display head), with the format's Content-Type. This
/// is how a browser fetches an image; for text docs it returns the head's bytes too.
///
/// **Self-describing about pending/failed ingest.** A media `doc_id` exists (returned in the
/// upload's `202`) before its transcode lands - and may never land if the upload was bad. Rather
/// than a bare 404 that can't tell "processing" from "impossible" from "never existed", a
/// version-less doc_id is explained from the ingest queue: `202` while still transcoding, `422`
/// with the tombstone message if it terminally failed, `404` only when genuinely unknown. A body
/// whose version exists but hasn't been fetched to this node yet is still a 404.
///
/// **Isolation, because even a private body may be hostile.** A compromised-not-yet-revoked
/// member can inject a polyglot claiming an image type; served same-origin and content-sniffed,
/// an HTML polyglot could execute in the app origin - which holds signing authority. `nosniff`
/// pins the declared type; `sandbox` gives an opaque origin if the response is ever navigated to.
/// (The fuller measure - a separate serving origin/port and `Content-Disposition` for
/// non-renderable types - is PROJECT_PLAN's blob-serving target, due with the render path and
/// public media.)
async fn docs_body_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let view = data.documents().all().await?;

    // Version-less: not a real document (yet, or ever). Let the ingest queue explain why.
    let Some(doc) = view.docs.get(&doc_id) else {
        return version_less_body_status(&state, &session.account.id.to_string(), doc_id).await;
    };

    let head = doc
        .display_head()
        .ok_or_else(|| AppError::NotFound("document has no readable head".into()))?;
    let format = crate::record::documents::Format::from_wire(head.header.format);
    let bytes = data
        .documents()
        .body(head)
        .await?
        .ok_or_else(|| AppError::NotFound("body not on this node yet".into()))?;
    Ok((
        [
            (CONTENT_TYPE, format.mime()),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (CONTENT_SECURITY_POLICY, "sandbox"),
        ],
        bytes,
    )
        .into_response())
}

/// Explain a version-less doc_id from the ingest queue: `202` still processing, `422` + tombstone
/// on a terminal failure, `404` when this account never queued it (or any other state).
async fn version_less_body_status(
    state: &AppState,
    account: &str,
    doc_id: [u8; 16],
) -> Result<Response, AppError> {
    match crate::ingest::latest_job_for_doc(&state.node_db, account, &hex::encode(doc_id)).await? {
        Some((status, _)) if status == "pending" || status == "processing" => {
            Ok((StatusCode::ACCEPTED, "still processing").into_response())
        }
        Some((status, error)) if status == "failed" => Err(AppError::Unprocessable(
            error.unwrap_or_else(|| "upload could not be processed".into()),
        )),
        // A 'done' job always has its version (so it's in the view above, not here); anything else,
        // or no job at all, is genuinely not found.
        _ => Err(AppError::NotFound("document not found".into())),
    }
}

/// Serve a media document's thumbnail (the display head's small AVIF), for gallery/list views
/// that shouldn't pull full-size bodies. Same isolation as the body handler. `404` for a text
/// document (no thumbnail), a version-less/pending doc, or a thumb not yet fetched to this node.
async fn docs_thumb_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let view = data.documents().all().await?;
    let doc = view
        .docs
        .get(&doc_id)
        .ok_or_else(|| AppError::NotFound("document not found".into()))?;
    let head = doc
        .display_head()
        .ok_or_else(|| AppError::NotFound("document has no readable head".into()))?;
    let thumb_hash = head
        .header
        .thumb_hash
        .ok_or_else(|| AppError::NotFound("document has no thumbnail".into()))?;
    let bytes = data
        .documents()
        .blob(thumb_hash)
        .await?
        .ok_or_else(|| AppError::NotFound("thumbnail not on this node yet".into()))?;
    Ok((
        [
            (CONTENT_TYPE, crate::record::documents::Format::Avif.mime()),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (CONTENT_SECURITY_POLICY, "sandbox"),
        ],
        bytes,
    ))
}

/// Serve a video document's silent hover-preview clip (the display head's small AV1-in-WebM), a
/// sibling blob to the poster thumbnail. Only WebM-output video carries one, so this is `404` for
/// every other kind - an image, an audio doc, a self-animating APNG, a text note, a version-less
/// doc, or a preview not yet fetched to this node. Same isolation and headers as `/thumb`.
async fn docs_preview_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let view = data.documents().all().await?;
    let doc = view
        .docs
        .get(&doc_id)
        .ok_or_else(|| AppError::NotFound("document not found".into()))?;
    let head = doc
        .display_head()
        .ok_or_else(|| AppError::NotFound("document has no readable head".into()))?;
    let preview_hash = head
        .header
        .preview_hash
        .ok_or_else(|| AppError::NotFound("document has no preview clip".into()))?;
    let bytes = data
        .documents()
        .blob(preview_hash)
        .await?
        .ok_or_else(|| AppError::NotFound("preview not on this node yet".into()))?;
    Ok((
        [
            (
                CONTENT_TYPE,
                crate::record::documents::Format::WebmAv1.mime(),
            ),
            (X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (CONTENT_SECURITY_POLICY, "sandbox"),
        ],
        bytes,
    ))
}

/// The media facts a client needs to render a document's body: the element to emit (`<img>` vs
/// `<video>` vs `<audio>` follows from `format`), its intrinsic size, its duration, and whether the
/// sibling `/thumb` and `/preview` blobs exist. `None` for a text document - it has no media.
#[derive(Serialize)]
struct MediaInfo {
    /// Intrinsic pixel width of the body (image/video); `None` for audio.
    width: Option<u32>,
    /// Intrinsic pixel height of the body (image/video); `None` for audio.
    height: Option<u32>,
    /// Playback length in milliseconds (audio/video); `None` for a still.
    duration_ms: Option<u64>,
    /// A `/thumb` blob exists: an image thumbnail, an audio waveform, or a video poster frame.
    has_thumb: bool,
    /// A `/preview` blob exists: a silent hover-preview clip (WebM-output video only).
    has_preview: bool,
}

impl MediaInfo {
    /// Media facts for a display head, or `None` when the head is a mergeable-text format (which
    /// has no dimensions, duration, thumbnail, or preview - it is served and rendered as text).
    fn of(head: &crate::record::documents::Version) -> Option<Self> {
        let format = crate::record::documents::Format::from_wire(head.header.format);
        if format.is_mergeable_text() {
            return None;
        }
        Some(MediaInfo {
            width: head.header.width,
            height: head.header.height,
            duration_ms: head.header.duration_ms,
            has_thumb: head.header.thumb_hash.is_some(),
            has_preview: head.header.preview_hash.is_some(),
        })
    }
}

#[derive(Serialize)]
struct DocSummary {
    doc_id: String,
    title: String,
    /// The default head's version hash - what an editor opens, and the parent of its next save.
    head: String,
    /// The stored format: "plaintext" | "marquee" | "avif" | "apng" | "webm" | "opus". Governs
    /// which renderer/element the client picks and how a divergence is presented.
    format: &'static str,
    /// Media facts for rendering this doc's body (size, duration, sibling blobs); `null` for text.
    media: Option<MediaInfo>,
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
                format: crate::record::documents::Format::from_wire(head.header.format).as_str(),
                media: MediaInfo::of(head),
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
    /// The stored format: "plaintext" | "marquee" | "avif" | "apng" | "webm" | "opus" - which
    /// renderer/element the client uses, and the shape of any conflict.
    format: &'static str,
    /// Media facts for rendering this doc's body (size, duration, sibling blobs); `null` for text.
    media: Option<MediaInfo>,
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

    // Media facts for the display head. Its presence also decides body inlining: a media body is
    // opaque bytes served via `/body`, never UTF-8-mangled into this JSON (a webp is not a string).
    let media = doc.display_head().and_then(MediaInfo::of);
    let inline_bodies = media.is_none();

    let mut heads = Vec::new();
    for h in &doc.logical_heads {
        let Some(version) = doc.versions.get(h) else {
            continue;
        };
        let body = if inline_bodies {
            data.documents()
                .body(version)
                .await?
                .map(|b| String::from_utf8_lossy(&b).into_owned())
        } else {
            None
        };
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
    let format = doc
        .display_head()
        .map(|v| crate::record::documents::Format::from_wire(v.header.format).as_str())
        .unwrap_or("plaintext");
    Ok(Json(DocDetail {
        doc_id: hex::encode(doc_id),
        diverged: doc.diverged(),
        format,
        media,
        title: resolved.title,
        body: resolved.body,
        resolution: match resolved.resolution {
            crate::record::documents::Resolution::Single => "single",
            crate::record::documents::Resolution::Merged => "merged",
            crate::record::documents::Resolution::Conflict => "conflict",
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

#[cfg(test)]
mod media_info_tests {
    use super::MediaInfo;
    use crate::record::documents::Version;
    use ringtome_proto::registry::doc_format;
    use ringtome_proto::DocHeaderPlain;

    /// A minimal header carrying just the fields `MediaInfo::of` reads; everything else is inert.
    fn header(
        format: Option<u64>,
        width: Option<u32>,
        height: Option<u32>,
        duration_ms: Option<u64>,
        thumb_hash: Option<[u8; 32]>,
        preview_hash: Option<[u8; 32]>,
    ) -> Version {
        Version {
            hash: [0u8; 32],
            timestamp_ms: 0,
            author: [0u8; 32],
            header: DocHeaderPlain {
                doc_id: [0u8; 16],
                parents: vec![],
                file_hash: [0u8; 32],
                body_hash: [0u8; 32],
                title: String::new(),
                format,
                width,
                height,
                duration_ms,
                thumb_hash,
                preview_hash,
            },
        }
    }

    /// A text document has no media facts at all - the serialized `media` is `null`, and the
    /// handler reads that absence as "inline the body as text".
    #[test]
    fn text_has_no_media() {
        assert!(MediaInfo::of(&header(None, None, None, None, None, None)).is_none());
        let marquee = header(Some(doc_format::MARQUEE), None, None, None, None, None);
        assert!(MediaInfo::of(&marquee).is_none());
    }

    /// A still image (the AVIF lane): dimensions and a thumbnail, no duration, no preview.
    #[test]
    fn still_image_facts() {
        let v = header(Some(doc_format::AVIF), Some(800), Some(600), None, Some([1u8; 32]), None);
        let m = MediaInfo::of(&v).expect("image is media");
        assert_eq!((m.width, m.height), (Some(800), Some(600)));
        assert_eq!(m.duration_ms, None);
        assert!(m.has_thumb, "the image lane always makes a thumbnail");
        assert!(!m.has_preview, "a still has no hover-preview clip");
    }

    /// Audio (the Opus lane): a duration and a waveform thumbnail, but no dimensions and no preview.
    #[test]
    fn audio_facts() {
        let v = header(Some(doc_format::OGG_OPUS), None, None, Some(90_000), Some([2u8; 32]), None);
        let m = MediaInfo::of(&v).expect("audio is media");
        assert_eq!((m.width, m.height), (None, None), "audio has no dimensions");
        assert_eq!(m.duration_ms, Some(90_000));
        assert!(m.has_thumb, "the decode lane draws a waveform");
        assert!(!m.has_preview);
    }

    /// WebM video (the AV1 lane): the only kind that carries a hover-preview - poster AND preview.
    #[test]
    fn video_has_preview() {
        let v = header(
            Some(doc_format::WEBM_AV1),
            Some(320),
            Some(180),
            Some(12_000),
            Some([3u8; 32]),
            Some([4u8; 32]),
        );
        let m = MediaInfo::of(&v).expect("video is media");
        assert_eq!(m.duration_ms, Some(12_000));
        assert!(m.has_thumb, "video fills the thumbnail slot with a poster");
        assert!(m.has_preview, "WebM-output video carries a hover-preview clip");
    }

    /// A self-animating APNG (transparent silent animation): a poster, but never a preview clip.
    #[test]
    fn apng_has_poster_no_preview() {
        let v = header(Some(doc_format::APNG), Some(256), Some(256), Some(3_000), Some([5u8; 32]), None);
        let m = MediaInfo::of(&v).expect("apng is media");
        assert!(m.has_thumb, "the APNG lane still produces a poster");
        assert!(!m.has_preview, "APNG animates itself; no separate preview clip");
    }
}
