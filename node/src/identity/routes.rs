//! HTTP routes for identities: create one, list the caller's, and work with an identity's
//! chains - profile get/set, view rebuild, and the raw entry log.
//!
//! Everything under `/api/identity/{root}/...` is owner-gated for M1: the session's account must
//! own the identity. (Public serving of profiles is an M3/M4 concern, arriving with sync.)

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use ringtome_proto::crown::KeyStatus;
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
        .route("/api/identity/{root}/detach", post(detach_handler))
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
                .delete(docs_delete_handler)
                .layer(DefaultBodyLimit::max(limits.document)),
        )
        // Rename without touching content: a media-safe retitle (a new version reusing the
        // head's blobs). The rename path for processed uploads; sound for text docs too.
        .route(
            "/api/identity/{root}/docs/{doc_id}/title",
            patch(docs_retitle_handler),
        )
        // Pin a document to the top of its list (PUT) or release it (DELETE) - a doc-meta flag,
        // like delete but opposite in effect.
        .route(
            "/api/identity/{root}/docs/{doc_id}/pin",
            put(pin_put_handler).delete(pin_delete_handler),
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
        // Browser-pre-encoded video (the video-ingest intermediary contract): multipart `video`
        // (AV1-WebM or the fallback lane's APNG frames) + optional `audio` (the fallback's
        // separate Ogg Opus sidecar). Same 202/queue contract as the plain binary route.
        .route(
            "/api/identity/{root}/docs/binary/video",
            post(docs_create_video_handler).layer(DefaultBodyLimit::max(limits.upload)),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/binary",
            put(docs_save_binary_handler).layer(DefaultBodyLimit::max(limits.upload)),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/body",
            get(docs_body_handler),
        )
        // The same bytes under a decorative filename: a marquee embed target needs an
        // EXTENSION for the renderer's media-kind sniff (`![t](.../body/photo.avif)`); the
        // name is ignored, the response's real Content-Type (nosniff-pinned) is authoritative.
        .route(
            "/api/identity/{root}/docs/{doc_id}/body/{filename}",
            get(docs_body_named_handler),
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
        // Rename a still-queued upload (the title is baked into the version at transcode).
        .route(
            "/api/identity/{root}/ingest/{job_id}",
            patch(ingest_retitle_handler),
        )
        // Annotations: private facts about documents - per-doc fields (LWW registers) and tags
        // (LWW set-elements) on the doc-meta chain, read/written through the store handle.
        .route(
            "/api/identity/{root}/docs/{doc_id}/annotations",
            get(annotations_get_handler),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/annotations/fields/{field}",
            put(annotation_field_put_handler).delete(annotation_field_delete_handler),
        )
        .route(
            "/api/identity/{root}/docs/{doc_id}/annotations/tags/{tag}",
            put(annotation_tag_put_handler).delete(annotation_tag_delete_handler),
        )
        // The inverted read: this identity's documents currently carrying a tag, in the docs-list
        // per-doc shape. (`tagged` is a static segment, so it never shadows a 32-hex doc_id.)
        .route(
            "/api/identity/{root}/docs/tagged/{tag}",
            get(docs_by_tag_handler),
        )
        // Buckets: which project(s)/notebook(s) a document belongs to - the tag mechanism in
        // its own namespace, the axis search and tags are scoped to.
        .route(
            "/api/identity/{root}/docs/{doc_id}/buckets/{bucket}",
            put(bucket_put_handler).delete(bucket_delete_handler),
        )
        .route(
            "/api/identity/{root}/buckets",
            get(buckets_roster_handler).post(bucket_define_handler),
        )
        .route(
            "/api/identity/{root}/buckets/{bucket}",
            axum::routing::delete(bucket_undefine_handler),
        )
        .route(
            "/api/identity/{root}/docs/bucketed/{bucket}",
            get(docs_by_bucket_handler),
        )
        // Taxonomies: user-defined ordered lists of document references on the doc-meta chain.
        // Rename/describe ride the annotations routes above (a taxonomy id is annotatable like
        // any doc id); membership and order live here.
        .route(
            "/api/identity/{root}/taxonomies",
            post(taxonomy_create_handler).get(taxonomies_list_handler),
        )
        .route(
            "/api/identity/{root}/taxonomies/{taxonomy_id}",
            get(taxonomy_get_handler).delete(taxonomy_delete_handler),
        )
        .route(
            "/api/identity/{root}/taxonomies/{taxonomy_id}/members/{doc_id}",
            put(taxonomy_member_put_handler).delete(taxonomy_member_delete_handler),
        )
        // The live cache (PROJECT_PLAN, The Browser Is a View): a read-only WebSocket that
        // streams the identity's view rows to the browser's Dexie mirror. Downstream only -
        // every mutation stays an HTTP POST above.
        .route("/api/identity/{root}/stream", get(stream_handler))
        // TEMPORARY debug surface (2026-07-25, field-testing the merge machinery): the whole
        // version DAG of one document, bodies included, owner-gated like everything else.
        // Slated for removal once the thorny-merge era ends.
        .route(
            "/api/identity/{root}/docs/{doc_id}/debug",
            get(docs_debug_handler),
        )
}

#[derive(Serialize)]
struct IdentityInfo {
    root_pubkey: String,
    created_at_ms: i64,
    /// This node's own standing in the persona's key tree ("active" | "retired" |
    /// "repudiated" | ...) - how a well-intentioned node discovers it has been let go, and
    /// what starts the UI's farewell.
    standing: &'static str,
}

impl IdentityInfo {
    fn new(i: super::Identity, standing: &'static str) -> Self {
        Self {
            root_pubkey: i.root_pubkey,
            created_at_ms: i.created_at_ms,
            standing,
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
        &state.config.node_name,
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
    let mut out = Vec::with_capacity(identities.len());
    for identity in identities {
        let standing = super::standing(&state, &session.account.id, &identity.root_pubkey).await;
        out.push(IdentityInfo::new(identity, standing));
    }
    Ok(Json(out))
}

#[derive(Serialize)]
struct DetachResponse {
    detached: bool,
}

/// Unlink a persona from this account on THIS node - node-local, nothing signed or synced.
/// The farewell flow's last step (a revoked computer letting go), and the future
/// multi-persona "drop this one" action. Deliberately not standing-gated: a user may detach
/// a perfectly active persona from a node they no longer want agenting it.
async fn detach_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<DetachResponse>, AppError> {
    super::detach(&state.node_db, &session.account.id, &root).await?;
    Ok(Json(DetachResponse { detached: true }))
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
    let code = super::adoption::pack(&request)?;
    Ok(Json(CodeResponse { code }))
}

/// Step 2 (granting node): authorize the requesting node's leaf into the tree; returns the
/// grant code to carry back.
async fn authorize_node_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<CodeRequest>,
) -> Result<Json<GrantResponse>, AppError> {
    let request: super::adoption::RequestCode =
        super::adoption::unpack(&req.code, "request code")?;
    let (requester_endpoint, requester_addrs) =
        (request.endpoint_id.clone(), request.addrs.clone());
    let grant =
        super::adoption::authorize_node(&state, &session.account.id, &root, request).await?;

    // One-trip: try to hand the grant straight to the requester over the wire. Best-effort by
    // design - every failure (unreachable, timeout, refused) degrades identically to the
    // carried-code ceremony. The ack arrives only after the requester fully completed, so
    // `delivered: true` means the persona has already moved in.
    let delivered = match tokio::time::timeout(
        std::time::Duration::from_secs(60),
        crate::net::adopt::deliver_grant(&state, &requester_endpoint, &requester_addrs, &grant),
    )
    .await
    {
        Ok(Ok(ack)) if ack.ok => true,
        Ok(Ok(ack)) => {
            tracing::info!(message = %ack.message, "grant delivery refused; falling back to code");
            false
        }
        Ok(Err(e)) => {
            tracing::info!("grant delivery failed; falling back to code: {e:#}");
            false
        }
        Err(_) => {
            tracing::info!("grant delivery timed out; falling back to code");
            false
        }
    };

    let code = super::adoption::pack(&grant)?;
    Ok(Json(GrantResponse { code, delivered }))
}

#[derive(Serialize)]
struct GrantResponse {
    /// The grant code - always present, so the carried-code ceremony survives as the fallback
    /// (and as what tests exercise directly).
    code: String,
    /// True when the grant was handed to the requester over the wire and it completed - the
    /// persona has already moved in; nobody needs to carry anything back.
    delivered: bool,
}

/// Step 3 (joining node): sync from the granter, verify our authorization, start agenting.
async fn adopt_complete_handler(
    session: Session,
    State(state): State<AppState>,
    Json(req): Json<CodeRequest>,
) -> Result<Json<IdentityInfo>, AppError> {
    let grant: super::adoption::GrantCode = super::adoption::unpack(&req.code, "grant code")?;
    let identity = super::adoption::complete(&state, &session.account.id, grant).await?;
    // A just-adopted leaf is Active by construction; no need to resolve the tree to say so.
    Ok(Json(IdentityInfo::new(identity, "active")))
}

/// Run a full exchange with every known peer of this identity. Per-peer failures are reported,
/// not fatal - an unreachable peer is a normal day on a p2p network.
async fn sync_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<Vec<crate::net::sync::PeerSyncResult>>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let peers = crate::net::sync::peers_for(&state.node_db, &root)
        .await
        .map_err(AppError::Internal)?;
    let results = crate::net::sync::sync_peers(&state, &root, &peers)
        .await
        .map_err(AppError::Internal)?;
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
    /// Where the cut-point falls, repudiation only: "now" (default) anchors the target's
    /// current heads - it was you until this moment; "genesis" anchors nothing - it was never
    /// you, and no history is credited.
    cut: Option<String>,
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
            )));
        }
    };
    let cut = match (req.cut.as_deref(), disposition) {
        (None | Some("now"), _) => super::Cut::Now,
        (Some("genesis"), ringtome_proto::Disposition::Repudiation) => super::Cut::Genesis,
        (Some("genesis"), ringtome_proto::Disposition::Retirement) => {
            // A retirement IS the honoring of history - "it was never me" contradicts it.
            return Err(AppError::BadRequest(
                "cut \"genesis\" only applies to repudiation".into(),
            ));
        }
        (Some(other), _) => {
            return Err(AppError::BadRequest(format!(
                "unknown cut {other:?} (now | genesis)"
            )));
        }
    };
    let entry_hash =
        super::revoke_key(&state, &session.account.id, &root, &target, disposition, cut).await?;
    Ok(Json(RevokeResponse { entry_hash }))
}

#[derive(Serialize)]
struct KeyInfo {
    pubkey: String,
    status: &'static str,
    rank_path: Vec<u64>,
    /// The key's device name (PROJECT_PLAN, Device Names) - a private label, absent when
    /// unnamed. Rendering only: the pubkey is always alongside, because names are pointers,
    /// never authority.
    name: Option<String>,
    /// What THIS node may do about the key, decided here so the client never re-derives
    /// authority: "self" (it is this node's own active leaf - self-retirement only), "senior"
    /// (this node is strictly senior to an active key - lock out, or have it leave), absent
    /// otherwise. Display gating only; the revoke route re-checks on POST.
    #[serde(skip_serializing_if = "Option::is_none")]
    removal: Option<&'static str>,
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

    // Device names, best-effort: the labels are decoration on this response, so a store that
    // won't open (no epoch keys yet, say) degrades to unnamed keys, never to a failed read.
    let names = match store::open(&state, &session.account.id, &root).await {
        Ok(data) => data.devices().all().await.unwrap_or_default(),
        Err(_) => Default::default(),
    };

    // This node's own leaf, best-effort for the same reason: without it, keys render with no
    // removal affordance rather than failing the screen.
    let this_leaf = super::load_signing_key(&state.node_db, &state.keystore, &session.account.id, &root)
        .await
        .ok()
        .map(|k| k.verifying_key().to_bytes());

    let mut keys: Vec<KeyInfo> = tree
        .members()
        .map(|(pk, status)| {
            let pubkey = hex::encode(pk);
            let name = names.get(&pubkey).cloned();
            // Removal is an authority fact, so the crown decides it: self-retirement for this
            // node's own leaf, either disposition for keys it is strictly senior to - and only
            // over active keys, because the revoked have nothing left to remove.
            let removal = match (status, this_leaf) {
                (KeyStatus::Active, Some(me)) if *pk == me => Some("self"),
                (KeyStatus::Active, Some(me)) if tree.is_senior(&me, pk) => Some("senior"),
                _ => None,
            };
            KeyInfo {
                pubkey,
                status: status.name(),
                rank_path: tree.rank_path(pk).unwrap_or_default().to_vec(),
                name,
                removal,
            }
        })
        .collect();
    // Responsibility order: lexicographic rank paths ARE the tree's seniority order, and they
    // put every parent immediately before its subtree - root first, spare key second, each
    // inviter directly above the computers it vouched for. The canonical display order for
    // every key screen, decided once here.
    keys.sort_by(|a, b| a.rank_path.cmp(&b.rank_path));

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
        Some(s) => crate::record::documents::Format::parse(s).ok_or_else(|| {
            AppError::BadRequest(format!("unknown format {s:?} (plaintext | marquee)"))
        }),
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

#[derive(Deserialize)]
struct DocRetitle {
    title: String,
}

/// Rename a document without touching its words or media: a new version reusing the display
/// head's content blobs. The upload modal's post-processing rename lands here (the JSON save
/// route writes a text body and would clobber a media document).
async fn docs_retitle_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
    Json(req): Json<DocRetitle>,
) -> Result<Json<DocSaved>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let version = data.documents().retitle(&doc_id, &req.title).await?;
    Ok(Json(DocSaved {
        version: hex::encode(version),
    }))
}

/// Delete a document: a tombstone on the doc-meta chain (an LWW set-add) that hides it from
/// every list and search. The version chain is untouched - a `restore` would bring it back with
/// its history - so this is reversible-by-design, not an erasure (Immutable Chains ≠ Immutable
/// Content). Idempotent: deleting an already-deleted doc is a no-op re-add.
async fn docs_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.documents().delete(&doc_id).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Pin a document (LWW set-add): it sorts to the top of every list until unpinned. Idempotent.
async fn pin_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.documents().pin(&doc_id).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Unpin a document (LWW set-remove: a pin/unpin race resolves by timestamp).
async fn pin_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.documents().unpin(&doc_id).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
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
                audio: None,
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

/// Upload a browser-pre-encoded video (the video-ingest intermediary): multipart part `video`
/// (AV1-in-WebM from the happy lane, or the fallback lane's APNG frames) plus optional `audio`
/// (the fallback's separate Ogg Opus - APNG can't carry sound). Metadata rides the query like
/// the plain binary route; same 202-and-queue contract. The server still validates everything -
/// a modified client could send anything - it just never has to decode a foreign codec.
async fn docs_create_video_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(meta): Query<BinaryMeta>,
    mut parts: axum::extract::Multipart,
) -> Result<impl IntoResponse, AppError> {
    store::open(&state, &session.account.id, &root).await?;
    let mut video: Option<Bytes> = None;
    let mut audio: Option<Bytes> = None;
    while let Some(field) = parts
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("bad multipart body: {e}")))?
    {
        let name = field.name().unwrap_or("").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("bad multipart part {name:?}: {e}")))?;
        match name.as_str() {
            "video" => video = Some(bytes),
            "audio" => audio = Some(bytes),
            _ => {} // unknown parts are ignored, not fatal
        }
    }
    let video = video.ok_or_else(|| AppError::BadRequest("missing `video` part".into()))?;
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
                bytes: &video,
                audio: audio.as_deref(),
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
                audio: None,
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
    let jobs =
        crate::ingest::jobs_for_account(&state.node_db, &session.account.id.to_string()).await?;
    Ok(Json(jobs))
}

#[derive(Deserialize)]
struct IngestRetitle {
    title: String,
}

#[derive(Serialize)]
struct IngestRetitled {
    /// False when the job was already claimed (or done, failed, or someone else's): the old
    /// title is baked into (or heading for) the version, and pretending otherwise would lie.
    applied: bool,
}

/// Rename a QUEUED upload before its transcode claims it - the upload modal's "set the file's
/// name while it processes". Owner-gated; honest about arriving too late.
async fn ingest_retitle_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, job_id)): Path<(String, String)>,
    Json(req): Json<IngestRetitle>,
) -> Result<Json<IngestRetitled>, AppError> {
    // Owner gate before touching this account's queue.
    store::open(&state, &session.account.id, &root).await?;
    let applied = crate::ingest::retitle_job(
        &state.node_db,
        &session.account.id.to_string(),
        &job_id,
        &req.title,
    )
    .await?;
    Ok(Json(IngestRetitled { applied }))
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
    docs_body_impl(session, state, root, doc_id).await
}

/// The decorative-filename twin (`…/body/{filename}`): the name is ignored entirely - it exists
/// so an embed target can carry an extension for kind-sniffing renderers. The upload flow
/// writes references in this form.
async fn docs_body_named_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, _filename)): Path<(String, String, String)>,
) -> Result<Response, AppError> {
    docs_body_impl(session, state, root, doc_id).await
}

async fn docs_body_impl(
    session: Session,
    state: AppState,
    root: String,
    doc_id: String,
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
            // The sidebar requests thumbs as `/thumb?v=<head>` - the URL changes when the
            // display head does - so the response is safely immutable: a list of fifty media
            // rows costs fifty requests once, then none.
            (CACHE_CONTROL, "private, max-age=31536000, immutable"),
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
#[derive(Serialize, Clone)]
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

    /// The same facts off a memoized `doc_heads` row (which carries the display head's fields).
    fn of_row(row: &crate::record::documents::DocHeadRow) -> Option<Self> {
        let format = crate::record::documents::Format::from_wire(row.format);
        if format.is_mergeable_text() {
            return None;
        }
        Some(MediaInfo {
            width: row.width,
            height: row.height,
            duration_ms: row.duration_ms,
            has_thumb: row.thumb_hash.is_some(),
            has_preview: row.preview_hash.is_some(),
        })
    }
}

#[derive(Serialize, Clone)]
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
    /// Claimed stamp of the earliest (parentless) version - the CREATED ordering, distinct from
    /// `updated_ms`. The Journal app stacks entries by this.
    created_ms: i64,
    /// The document's annotations, joined onto its list row at the stream boundary (they fold
    /// from a different chain than the resolution memo, so they're attached here rather than
    /// baked into `doc_heads`). Tags drive list filtering; `fields` carries `description` and
    /// any other named annotation. Empty when the doc has none.
    tags: Vec<String>,
    fields: std::collections::BTreeMap<String, String>,
    /// The document's bucket memberships (its projects/notebooks) - the axis the client scopes
    /// search and tag-filters to. Joined here like tags, from a separate namespace. Empty when
    /// the doc is in no bucket.
    buckets: Vec<String>,
    /// Pinned to the top of the list (a doc-meta roster flag). Sorting is the client's; the
    /// server only reports the fact.
    pinned: bool,
}

#[derive(Serialize)]
struct DocListResponse {
    docs: Vec<DocSummary>,
    undecryptable: usize,
}

/// One list entry off a memoized `doc_heads` row, with its annotations joined in from the
/// doc-meta view (keyed by doc_id hex). The resolution facts come from `doc_heads`; the tags
/// and fields come from the separate annotation chain - assembled here so the mirror's docs
/// row is everything the list needs to show and filter a document.
fn summarize(
    row: crate::record::documents::DocHeadRow,
    annots: &std::collections::BTreeMap<String, crate::record::store::AnnotationRow>,
    buckets: &std::collections::BTreeMap<String, Vec<String>>,
    pinned: &std::collections::BTreeSet<[u8; 16]>,
) -> DocSummary {
    let is_pinned = pinned.contains(&row.doc_id);
    let doc_id = hex::encode(row.doc_id);
    let (tags, fields) = annots
        .get(&doc_id)
        .map(|a| (a.tags.clone(), a.fields.clone()))
        .unwrap_or_default();
    let buckets = buckets.get(&doc_id).cloned().unwrap_or_default();
    DocSummary {
        media: MediaInfo::of_row(&row),
        title: row.title,
        head: hex::encode(row.head),
        format: crate::record::documents::Format::from_wire(row.format).as_str(),
        heads: row.logical_heads,
        diverged: row.diverged,
        updated_ms: row.head_ms,
        created_ms: row.genesis_ms,
        doc_id,
        tags,
        fields,
        buckets,
        pinned: is_pinned,
    }
}

/// The doc-meta annotations for every document, keyed by doc_id hex - the join input for
/// `summarize`, read once per list/stream build.
async fn annotation_map(
    data: &store::Store,
) -> Result<std::collections::BTreeMap<String, crate::record::store::AnnotationRow>, AppError> {
    Ok(data
        .annotations()
        .all()
        .await?
        .into_iter()
        .map(|a| (a.doc_id.clone(), a))
        .collect())
}

/// Each document's bucket memberships, keyed by doc_id hex - the other `summarize` join input.
async fn bucket_map(
    data: &store::Store,
) -> Result<std::collections::BTreeMap<String, Vec<String>>, AppError> {
    Ok(data
        .buckets()
        .all()
        .await?
        .into_iter()
        .map(|(doc_id, names)| (hex::encode(doc_id), names))
        .collect())
}

/// Every document, newest first: the note list. Reads the memoized `doc_heads` rows (one query
/// after catch-up) instead of folding the full view; the response shape is unchanged.
async fn docs_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<DocListResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (rows, undecryptable) = data.documents().summaries().await?;
    let annots = annotation_map(&data).await?;
    let buckets = bucket_map(&data).await?;
    let pinned = data.documents().pinned().await?;
    Ok(Json(DocListResponse {
        docs: rows.into_iter().map(|r| summarize(r, &annots, &buckets, &pinned)).collect(),
        undecryptable,
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

// ---------------------------------------------------------------------------------------------
// Annotations: private facts about documents - per-doc fields (LWW registers) and tags (LWW
// set-elements) on the doc-meta chain. The store's Annotations handle owns the semantics (the
// per-doc collection convention, the value cap); these routes are plumbing.

#[derive(Serialize)]
struct AnnotationsResponse {
    /// Every set field, merged (cleared/empty fields absent).
    fields: std::collections::BTreeMap<String, String>,
    /// Every present tag, sorted.
    tags: Vec<String>,
}

/// One document's annotations: fields and tags in one response.
async fn annotations_get_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Json<AnnotationsResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let fields = data.annotations().fields(&doc_id).await?;
    let tags = data.annotations().tags(&doc_id).await?;
    Ok(Json(AnnotationsResponse { fields, tags }))
}

#[derive(Deserialize)]
struct AnnotationFieldPut {
    value: String,
}

/// Set one annotation field (LWW per field). The handle enforces the value cap; past it, the
/// refusal (400) says the description should become a document.
async fn annotation_field_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, field)): Path<(String, String, String)>,
    Json(req): Json<AnnotationFieldPut>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data
        .annotations()
        .set_field(&doc_id, &field, &req.value)
        .await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Clear one annotation field - itself an LWW write (absent value), so it beats older sets.
async fn annotation_field_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, field)): Path<(String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.annotations().clear_field(&doc_id, &field).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Tag a document (LWW set-element add; the merge unit is the `(doc, tag)` pair).
async fn annotation_tag_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, tag)): Path<(String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.annotations().tag(&doc_id, &tag).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Untag a document (LWW set-element remove: a tag/untag race resolves by timestamp).
async fn annotation_tag_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, tag)): Path<(String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.annotations().untag(&doc_id, &tag).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Deserialize)]
struct TaggedQuery {
    /// "modified" (display head's claimed stamp, default) or "created" (genesis claimed stamp).
    order: Option<String>,
}

#[derive(Serialize)]
struct TaggedDocsResponse {
    docs: Vec<DocSummary>,
}

/// This identity's documents currently tagged `tag`, in the docs-list per-doc shape. Ordering
/// is over claimed stamps only - received_at is not replay-stable and the sync model must not
/// leak into display ordering.
async fn docs_by_tag_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, tag)): Path<(String, String)>,
    Query(query): Query<TaggedQuery>,
) -> Result<Json<TaggedDocsResponse>, AppError> {
    enum Order {
        Modified,
        Created,
    }
    let order = match query.order.as_deref() {
        None | Some("modified") => Order::Modified,
        Some("created") => Order::Created,
        Some(other) => {
            return Err(AppError::BadRequest(format!(
                "unknown order {other:?} (modified | created)"
            )));
        }
    };
    let data = store::open(&state, &session.account.id, &root).await?;
    let doc_ids = data.annotations().own_docs_tagged(&tag).await?;
    let mut rows = data.documents().summaries_for(&doc_ids).await?;
    rows.sort_by_key(|r| {
        (
            std::cmp::Reverse(match order {
                Order::Modified => r.head_ms,
                Order::Created => r.genesis_ms,
            }),
            r.doc_id,
        )
    });
    let annots = annotation_map(&data).await?;
    let buckets = bucket_map(&data).await?;
    let pinned = data.documents().pinned().await?;
    Ok(Json(TaggedDocsResponse {
        docs: rows.into_iter().map(|r| summarize(r, &annots, &buckets, &pinned)).collect(),
    }))
}

/// Put a document in a bucket (LWW set-element add; the merge unit is the `(doc, bucket)` pair,
/// so two devices bucketing at once union). Idempotent.
async fn bucket_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, bucket)): Path<(String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.buckets().place(&doc_id, &bucket).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Take a document out of a bucket (LWW set-element remove; a place/remove race resolves by
/// timestamp).
async fn bucket_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id, bucket)): Path<(String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.buckets().remove(&doc_id, &bucket).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Serialize)]
struct BucketRow {
    name: String,
    /// The app-type meant to open this bucket (empty if unregistered).
    app: String,
    members: usize,
}

#[derive(Serialize)]
struct BucketRosterResponse {
    buckets: Vec<BucketRow>,
}

/// Every bucket - name, its registered app-type, and this identity's member count - the
/// notebook roster. Registered-but-empty buckets are included.
async fn buckets_roster_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<BucketRosterResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let buckets = data
        .buckets()
        .roster()
        .await?
        .into_iter()
        .map(|b| BucketRow {
            name: b.name,
            app: b.app,
            members: b.members,
        })
        .collect();
    Ok(Json(BucketRosterResponse { buckets }))
}

#[derive(Deserialize)]
struct BucketDefine {
    name: String,
    /// The application meant to open this bucket ("recipes", "journal", ...); client vocabulary.
    #[serde(default)]
    app: String,
}

/// Create/define a bucket and the app that opens it (an LWW register, `name -> app`). This is
/// how an empty bucket is born - it exists before its first document.
async fn bucket_define_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<BucketDefine>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.buckets().define(&req.name, &req.app).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Forget a bucket's registry entry. Its members' tags stay; a bucket still holding documents
/// remains in the roster (without an app-type) until re-defined.
async fn bucket_undefine_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, bucket)): Path<(String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.buckets().undefine(&bucket).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// This identity's documents currently in `bucket`, in the docs-list per-doc shape - the app
/// view's server spine (client filtering off the mirror row is the usual path; this is the
/// direct query). Same claimed-stamp ordering as the tagged listing.
async fn docs_by_bucket_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, bucket)): Path<(String, String)>,
    Query(query): Query<TaggedQuery>,
) -> Result<Json<TaggedDocsResponse>, AppError> {
    let by_created = match query.order.as_deref() {
        None | Some("modified") => false,
        Some("created") => true,
        Some(other) => {
            return Err(AppError::BadRequest(format!(
                "unknown order {other:?} (modified | created)"
            )));
        }
    };
    let data = store::open(&state, &session.account.id, &root).await?;
    let doc_ids = data.buckets().own_docs_in(&bucket).await?;
    let mut rows = data.documents().summaries_for(&doc_ids).await?;
    rows.sort_by_key(|r| {
        (
            std::cmp::Reverse(if by_created { r.genesis_ms } else { r.head_ms }),
            r.doc_id,
        )
    });
    let annots = annotation_map(&data).await?;
    let buckets = bucket_map(&data).await?;
    let pinned = data.documents().pinned().await?;
    Ok(Json(TaggedDocsResponse {
        docs: rows.into_iter().map(|r| summarize(r, &annots, &buckets, &pinned)).collect(),
    }))
}

#[derive(Deserialize)]
struct TaxonomyCreate {
    title: String,
}

#[derive(Serialize)]
struct TaxonomyCreateResponse {
    taxonomy_id: String,
}

/// Create a taxonomy (an ordered list of document references - PROJECT_PLAN, Taxonomies).
/// Rename/describe afterwards ride the ordinary annotations routes: taxonomy-level facts are
/// annotations on the taxonomy's own id.
async fn taxonomy_create_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<TaxonomyCreate>,
) -> Result<Json<TaxonomyCreateResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let taxonomy_id = data.taxonomies().create(&req.title).await?;
    Ok(Json(TaxonomyCreateResponse {
        taxonomy_id: hex::encode(taxonomy_id),
    }))
}

#[derive(Serialize)]
struct TaxonomyRow {
    taxonomy_id: String,
    title: String,
    members: usize,
}

#[derive(Serialize)]
struct TaxonomiesResponse {
    taxonomies: Vec<TaxonomyRow>,
}

/// Every taxonomy on the roster, title-sorted.
async fn taxonomies_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<TaxonomiesResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let taxonomies = data
        .taxonomies()
        .all()
        .await?
        .into_iter()
        .map(|t| TaxonomyRow {
            taxonomy_id: hex::encode(t.taxonomy_id),
            title: t.title,
            members: t.members,
        })
        .collect();
    Ok(Json(TaxonomiesResponse { taxonomies }))
}

#[derive(Serialize)]
struct TaxonomyMemberEntry {
    root: String,
    doc_id: String,
    /// The docs-list summary for members whose documents this node holds; `null` for another
    /// identity's document (representable in the list, renderable when 4S serves it) - and for
    /// a member that is a taxonomy (see `taxonomy`).
    doc: Option<DocSummary>,
    /// Present when this member is one of the identity's own taxonomies: the tree, expanded in
    /// place (trees are composition - PROJECT_PLAN, Taxonomies).
    taxonomy: Option<TaxonomyResponse>,
}

/// One taxonomy in a tree read. `members: null` marks a stub: this taxonomy appears (again)
/// at this position - a diamond's other parent, or a merge-created cycle - and its expansion
/// lives at its first encounter. Render a stub as a link.
#[derive(Serialize)]
struct TaxonomyResponse {
    taxonomy_id: String,
    title: String,
    members: Option<Vec<TaxonomyMemberEntry>>,
}

/// One taxonomy as its expanded tree: members in list order, nested taxonomies expanded in
/// place (visited-set stubbed), every reachable own document joined against the memoized doc
/// rows in one query. A flat list is just the depth-1 case of this response.
async fn taxonomy_get_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, taxonomy_id)): Path<(String, String)>,
) -> Result<Json<TaxonomyResponse>, AppError> {
    let taxonomy_id = hex_fixed::<16>(&taxonomy_id, "taxonomy id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let own_root = crate::pubkey::decode(&root)
        .ok_or_else(|| AppError::BadRequest("bad root pubkey".into()))?;

    let tree = data.taxonomies().tree(&taxonomy_id).await?;

    // One summaries query for every own document in the whole tree.
    let mut own_ids = Vec::new();
    collect_doc_ids(&tree, &own_root, &mut own_ids);
    let annots = annotation_map(&data).await?;
    let buckets = bucket_map(&data).await?;
    let pinned = data.documents().pinned().await?;
    let rows: std::collections::BTreeMap<[u8; 16], DocSummary> = data
        .documents()
        .summaries_for(&own_ids)
        .await?
        .into_iter()
        .map(|r| (r.doc_id, summarize(r, &annots, &buckets, &pinned)))
        .collect();

    Ok(Json(render_tree(tree, &rows)))
}

/// Every own-root, non-taxonomy member id in the tree - the ids `doc_heads` can answer for.
fn collect_doc_ids(
    node: &crate::record::store::TaxonomyNode,
    own_root: &[u8; 32],
    out: &mut Vec<[u8; 16]>,
) {
    for m in node.members.iter().flatten() {
        match &m.taxonomy {
            Some(nested) => collect_doc_ids(nested, own_root, out),
            None if m.root == *own_root => out.push(m.doc_id),
            None => {}
        }
    }
}

fn render_tree(
    node: crate::record::store::TaxonomyNode,
    rows: &std::collections::BTreeMap<[u8; 16], DocSummary>,
) -> TaxonomyResponse {
    TaxonomyResponse {
        taxonomy_id: hex::encode(node.taxonomy_id),
        title: node.title,
        members: node.members.map(|members| {
            members
                .into_iter()
                .map(|m| TaxonomyMemberEntry {
                    root: hex::encode(m.root),
                    doc_id: hex::encode(m.doc_id),
                    doc: match m.taxonomy {
                        Some(_) => None,
                        // get, not remove: composition allows the same document in two
                        // sections, and both occurrences deserve their summary.
                        None => rows.get(&m.doc_id).cloned(),
                    },
                    taxonomy: m.taxonomy.map(|t| render_tree(t, rows)),
                })
                .collect()
        }),
    }
}

/// Delete a taxonomy: one roster remove; the member facts stay on the chain unsurfaced.
async fn taxonomy_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, taxonomy_id)): Path<(String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let taxonomy_id = hex_fixed::<16>(&taxonomy_id, "taxonomy id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data.taxonomies().delete(&taxonomy_id).await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Deserialize)]
struct TaxonomyPlace {
    /// Position to arrive at, counted without the member itself (drag-and-drop semantics);
    /// absent or out-of-range appends.
    index: Option<usize>,
    /// The member document's identity; absent means the caller's own (the common case).
    member_root: Option<String>,
}

/// Place a document in the list at an index - add and move are the same operation (a set
/// re-add updates the rank under the same LWW stamp).
async fn taxonomy_member_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, taxonomy_id, doc_id)): Path<(String, String, String)>,
    Json(req): Json<TaxonomyPlace>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let taxonomy_id = hex_fixed::<16>(&taxonomy_id, "taxonomy id")?;
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let member_root = match &req.member_root {
        Some(hex) => crate::pubkey::decode(hex)
            .ok_or_else(|| AppError::BadRequest("bad member root pubkey".into()))?,
        None => crate::pubkey::decode(&root)
            .ok_or_else(|| AppError::BadRequest("bad root pubkey".into()))?,
    };
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data
        .taxonomies()
        .place(&taxonomy_id, &member_root, &doc_id, req.index)
        .await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(Deserialize)]
struct TaxonomyMemberQuery {
    /// The member document's identity; absent means the caller's own (mirrors the PUT body).
    member_root: Option<String>,
}

/// Remove a member from the list.
async fn taxonomy_member_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, taxonomy_id, doc_id)): Path<(String, String, String)>,
    Query(query): Query<TaxonomyMemberQuery>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let taxonomy_id = hex_fixed::<16>(&taxonomy_id, "taxonomy id")?;
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let member_root = match &query.member_root {
        Some(hex) => crate::pubkey::decode(hex)
            .ok_or_else(|| AppError::BadRequest("bad member root pubkey".into()))?,
        None => crate::pubkey::decode(&root)
            .ok_or_else(|| AppError::BadRequest("bad root pubkey".into()))?,
    };
    let data = store::open(&state, &session.account.id, &root).await?;
    let signed = data
        .taxonomies()
        .remove(&taxonomy_id, &member_root, &doc_id)
        .await?;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
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

// ---------------------------------------------------------------------------------------------
// TEMPORARY: the document-history debug dump. Everything the merge machinery sees, as JSON a
// human can paste into a bug report: every version (parents, author + device name, stamps,
// fingerprints, full body text), the head bookkeeping, fork points between logical heads, and
// what resolve() synthesizes right now on THIS node. Owner-gated; remove when the thorny-merge
// era ends.

#[derive(Serialize)]
struct DebugVersion {
    hash: String,
    parents: Vec<String>,
    author: String,
    author_name: Option<String>,
    timestamp_ms: i64,
    timestamp_utc: String,
    title: String,
    format: &'static str,
    body_hash: String,
    body: Option<String>,
    is_head: bool,
    is_logical_head: bool,
}

#[derive(Serialize)]
struct DebugDump {
    node_name: String,
    doc_id: String,
    heads: Vec<String>,
    logical_heads: Vec<String>,
    display_head: Option<String>,
    fork_points_of_logical_heads: Vec<String>,
    resolution: &'static str,
    resolved_body: Option<String>,
    versions: Vec<DebugVersion>,
}

async fn docs_debug_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
) -> Result<Json<DebugDump>, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let view = data.documents().all().await?;
    let doc = view
        .docs
        .get(&doc_id)
        .ok_or_else(|| AppError::NotFound("document not found".into()))?;
    let names = data.devices().all().await.unwrap_or_default();

    let mut versions = Vec::new();
    for v in doc.versions.values() {
        let body = data
            .documents()
            .body(v)
            .await
            .ok()
            .flatten()
            .map(|b| String::from_utf8_lossy(&b).into_owned());
        versions.push(DebugVersion {
            hash: hex::encode(v.hash),
            parents: v.header.parents.iter().map(hex::encode).collect(),
            author: hex::encode(v.author),
            author_name: names.get(&hex::encode(v.author)).cloned(),
            timestamp_ms: v.timestamp_ms,
            timestamp_utc: crate::record::documents::civil_utc(v.timestamp_ms),
            title: v.header.title.clone(),
            format: crate::record::documents::Format::from_wire(v.header.format).as_str(),
            body_hash: hex::encode(v.header.body_hash),
            body,
            is_head: doc.heads.contains(&v.hash),
            is_logical_head: doc.logical_heads.contains(&v.hash),
        });
    }
    versions.sort_by_key(|v| (v.timestamp_ms, v.hash.clone()));

    let fork_points_of_logical_heads = if doc.logical_heads.len() >= 2 {
        doc.fork_points_of_heads(&doc.logical_heads)
            .iter()
            .map(hex::encode)
            .collect()
    } else {
        Vec::new()
    };
    let resolved = data.documents().resolved(doc).await?;

    Ok(Json(DebugDump {
        node_name: state.config.node_name.clone(),
        doc_id: hex::encode(doc_id),
        heads: doc.heads.iter().map(hex::encode).collect(),
        logical_heads: doc.logical_heads.iter().map(hex::encode).collect(),
        display_head: doc.display_head().map(|v| hex::encode(v.hash)),
        fork_points_of_logical_heads,
        resolution: match resolved.resolution {
            crate::record::documents::Resolution::Single => "single",
            crate::record::documents::Resolution::Merged => "merged",
            crate::record::documents::Resolution::Conflict => "conflict",
        },
        resolved_body: resolved.body,
        versions,
    }))
}

// ---------------------------------------------------------------------------------------------
// The live cache stream (PROJECT_PLAN, The Browser Is a View - Stage 1 as built).
//
// A read-only WebSocket per identity, downstream only: the node streams the same view rows the
// HTTP reads serve - profile fields, doc summaries, the taxonomy roster - and the browser
// mirrors them into Dexie. The v1 simplifications, named:
//
// - **Whole-kind refresh, not row deltas**: an update carries every row of each kind (the
//   degenerate delta - same shapes, idempotent to apply). Row-level deltas are a refinement
//   for when a library is big enough to care.
// - **The cursor is a frontier fingerprint** (BLAKE3 over the identity's sorted chain heads -
//   resync's change detector, hashed). A reconnect whose cursor still matches goes straight to
//   live; ANY doubt - absent, stale, garbage - gets a full snapshot. "Drop the cache and
//   re-stream" is the design's own answer, so incremental catch-up beyond nothing-changed is
//   deliberately not built.
// - **Change detection is a 1s poll per socket** (recompute the fingerprint, compare). One
//   tiny query per second per open tab; a write lands on the browser within ~1-2s. A
//   node-internal broadcast bus is the refinement if per-socket polling ever shows up in a
//   profile.
//
// Client messages are ignored (the socket is read-only by doctrine - mutations are POSTs);
// reading them anyway is what lets tungstenite answer pings and notice close frames.

#[derive(Deserialize)]
struct StreamQuery {
    cursor: Option<String>,
}

/// One streamed payload: everything the mirror holds, refreshed whole. `snapshot` tells the
/// browser to clear-and-replace (its cursor was absent or doubtful); `update` is the same
/// operation while live; `live` is "your cursor still holds, nothing to send".
#[derive(Serialize)]
struct StreamMessage {
    #[serde(rename = "type")]
    kind: &'static str,
    cursor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<Vec<imaol::ProfileField>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    docs: Option<Vec<DocSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    taxonomies: Option<Vec<TaxonomyRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search: Option<Vec<crate::record::documents::SearchRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    buckets: Option<Vec<BucketRow>>,
}

/// The stream cursor: resync's frontier fingerprint (sorted `(author, service, floor, head)`
/// rows - the same equality that drives eager push), hashed to an opaque token - PLUS the
/// root's view epoch, so changes frontiers can't see (a body arriving by backfill, which
/// moves resolution and the search index without moving any chain) still tick the cursor.
async fn stream_cursor(
    db: &crate::db::Db,
    view_epoch: u64,
) -> Result<String, AppError> {
    let mut frontiers = crate::net::sync::local_frontiers(db, true)
        .await
        .map_err(AppError::Internal)?;
    frontiers.sort_by_key(|f| (f.author, f.service));
    let mut hasher = blake3::Hasher::new();
    for f in &frontiers {
        hasher.update(&f.author);
        hasher.update(&f.service.to_be_bytes());
        hasher.update(&f.floor.to_be_bytes());
        hasher.update(&f.head.to_be_bytes());
    }
    hasher.update(&view_epoch.to_be_bytes());
    Ok(hasher.finalize().to_hex().to_string())
}

async fn gather(
    data: &store::Store,
    kind: &'static str,
    cursor: String,
) -> Result<StreamMessage, AppError> {
    let profile = data.profile().all().await?;
    let (rows, _undecryptable) = data.documents().summaries().await?;
    let annots = annotation_map(data).await?;
    let buckets = bucket_map(data).await?;
    let pinned = data.documents().pinned().await?;
    let docs = rows.into_iter().map(|r| summarize(r, &annots, &buckets, &pinned)).collect();
    let taxonomies = data
        .taxonomies()
        .all()
        .await?
        .into_iter()
        .map(|t| TaxonomyRow {
            taxonomy_id: hex::encode(t.taxonomy_id),
            title: t.title,
            members: t.members,
        })
        .collect();
    let search = data.documents().search_rows().await?;
    let buckets = data
        .buckets()
        .roster()
        .await?
        .into_iter()
        .map(|b| BucketRow {
            name: b.name,
            app: b.app,
            members: b.members,
        })
        .collect();
    Ok(StreamMessage {
        kind,
        cursor,
        profile: Some(profile),
        docs: Some(docs),
        taxonomies: Some(taxonomies),
        search: Some(search),
        buckets: Some(buckets),
    })
}

async fn stream_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(query): Query<StreamQuery>,
    ws: axum::extract::ws::WebSocketUpgrade,
) -> Result<Response, AppError> {
    // Gate BEFORE upgrading: a stranger never gets a socket at all.
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let account_id = session.account.id;
    Ok(ws.on_upgrade(move |socket| async move {
        if let Err(e) = serve_stream(socket, state, account_id, root.clone(), query.cursor).await
        {
            tracing::debug!(%root, "live-cache stream ended: {e:#}");
        }
    }))
}

async fn serve_stream(
    mut socket: axum::extract::ws::WebSocket,
    state: AppState,
    account_id: uuid::Uuid,
    root: String,
    client_cursor: Option<String>,
) -> anyhow::Result<()> {
    use axum::extract::ws::Message;

    // Opened once and held: keystore unseal per message would be silly.
    let data = store::open(&state, &account_id, &root)
        .await
        .map_err(|e| anyhow::anyhow!("opening store for stream: {e}"))?;
    let db = state
        .user_dbs
        .get(&root)
        .await
        .map_err(|e| anyhow::anyhow!("opening db for stream: {e}"))?;

    let mut cursor = stream_cursor(&db, state.view_epochs.get(&root))
        .await
        .map_err(anyhow::Error::new)?;

    // First word: live if the client's cursor still holds, a full snapshot on any doubt.
    let first = if client_cursor.as_deref() == Some(cursor.as_str()) {
        StreamMessage {
            kind: "live",
            cursor: cursor.clone(),
            profile: None,
            docs: None,
            taxonomies: None,
            search: None,
            buckets: None,
        }
    } else {
        gather(&data, "snapshot", cursor.clone())
            .await
            .map_err(anyhow::Error::new)?
    };
    socket
        .send(Message::Text(serde_json::to_string(&first)?.into()))
        .await?;

    // A local write pings the write-nudge bus (Db::nudge_sync), so a save reflects in every
    // open browser in a round-trip instead of up to a full tick later. The tick stays as the
    // backstop - it catches anything the nudge misses (a write during a send, a body arriving
    // by backfill that bumped view_epochs) - so nudging is pure latency, never correctness.
    let mut nudge = Some(state.user_dbs.subscribe_writes());
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = tick.tick() => {}
            _ = crate::db::await_write_nudge(&mut nudge) => {}
            incoming = socket.recv() => {
                match incoming {
                    None | Some(Err(_)) => return Ok(()), // gone
                    Some(Ok(Message::Close(_))) => return Ok(()),
                    // Read-only socket: client payloads are ignored, not honored - mutations
                    // are HTTP POSTs. (Ping/pong is handled inside the websocket layer.)
                    Some(Ok(_)) => continue, // a client message never triggers a gather
                }
            }
        }
        // Reached after a tick or a nudge: re-check the cursor and push an update if it moved.
        let now = stream_cursor(&db, state.view_epochs.get(&root))
            .await
            .map_err(anyhow::Error::new)?;
        if now != cursor {
            cursor = now;
            let update = gather(&data, "update", cursor.clone())
                .await
                .map_err(anyhow::Error::new)?;
            socket
                .send(Message::Text(serde_json::to_string(&update)?.into()))
                .await?;
        }
    }
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
        let v = header(
            Some(doc_format::AVIF),
            Some(800),
            Some(600),
            None,
            Some([1u8; 32]),
            None,
        );
        let m = MediaInfo::of(&v).expect("image is media");
        assert_eq!((m.width, m.height), (Some(800), Some(600)));
        assert_eq!(m.duration_ms, None);
        assert!(m.has_thumb, "the image lane always makes a thumbnail");
        assert!(!m.has_preview, "a still has no hover-preview clip");
    }

    /// Audio (the Opus lane): a duration and a waveform thumbnail, but no dimensions and no preview.
    #[test]
    fn audio_facts() {
        let v = header(
            Some(doc_format::OGG_OPUS),
            None,
            None,
            Some(90_000),
            Some([2u8; 32]),
            None,
        );
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
        assert!(
            m.has_preview,
            "WebM-output video carries a hover-preview clip"
        );
    }

    /// A self-animating APNG (transparent silent animation): a poster, but never a preview clip.
    #[test]
    fn apng_has_poster_no_preview() {
        let v = header(
            Some(doc_format::APNG),
            Some(256),
            Some(256),
            Some(3_000),
            Some([5u8; 32]),
            None,
        );
        let m = MediaInfo::of(&v).expect("apng is media");
        assert!(m.has_thumb, "the APNG lane still produces a poster");
        assert!(
            !m.has_preview,
            "APNG animates itself; no separate preview clip"
        );
    }
}
