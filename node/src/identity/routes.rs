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
        .route("/api/identity/{root}/peers", get(peers_handler))
        .route("/api/identity/{root}/docs/{doc_id}/publish", post(publish_handler))
        .route("/api/identity/{root}/posts/{post_id}", delete(unpublish_handler))
        .route(
            "/api/identity/{root}/rebroadcasts",
            get(rebroadcasts_handler).post(rebroadcast_handler),
        )
        .route(
            "/api/identity/{root}/public-annotations/{author}/{doc}",
            get(public_annotations_handler).put(public_annotation_put_handler),
        )
        .route(
            "/api/identity/{root}/public-annotations/{author}/{doc}/{key}/{value}",
            axum::routing::delete(public_annotation_delete_handler),
        )
        .route(
            "/api/identity/{root}/avatar",
            post(set_avatar_handler).layer(axum::extract::DefaultBodyLimit::max(limits.upload)),
        )
        // M3: multi-node.
        .route("/api/identity/adopt/begin", post(adopt_begin_handler))
        .route("/api/identity/adopt/complete", post(adopt_complete_handler))
        .route("/api/identity/{root}/nodes", post(authorize_node_handler))
        .route("/api/identity/{root}/sync", post(sync_handler))
        .route("/api/identity/{root}/feed", get(feed_handler))
        .route(
            "/api/identity/{root}/notifications",
            get(notifications_handler),
        )
        .route("/api/identity/{root}/serve", post(serve_handler))
        .route(
            "/api/identity/{root}/keys/{target}/revoke",
            post(revoke_key_handler),
        )
        // Private chains: the member-only KV + set store (encrypted at rest, synced only to the
        // identity's own nodes).
        // The implicit set: what this persona's friends vouch for, composed with their own
        // dials (edgegraph). Raw per-introducer rows - rollup and discounts are the UI's.
        .route(
            "/api/identity/{root}/implicit",
            get(implicit_list_handler),
        )
        // The People page's suggested shelf: the demand rollup filtered to landed mirrors,
        // bylines attached (speculative::suggested_for - "reading is not serving").
        .route(
            "/api/identity/{root}/suggested",
            get(suggested_list_handler),
        )
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
            "/api/identity/{root}/posts/{post_id}/replies",
            get(own_post_replies_handler),
        )
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
    // Participation implies locatability (the discoverability doctrine): a newborn identity
    // publishes its serving record now, not at some later "act of publication".
    super::serving::publish_best_effort(&state, &created.root_pubkey).await;
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
        return Err(AppError::NotFound(crate::msg!("identity.routes.not-found", "not found")));
    }
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .held(&root)
        .await
        .map_err(AppError::Internal)?;
    let entries_replayed = imaol::rebuild_views(&db).await?;
    Ok(Json(RebuildResponse { entries_replayed }))
}

#[derive(serde::Deserialize)]
struct EntriesQuery {
    /// Resume after this row - the previous page's `next`, spelled out as three params so the
    /// surface stays curl-able.
    after_author: Option<String>,
    after_service: Option<u32>,
    after_seq: Option<u64>,
    limit: Option<u32>,
}

/// The raw entry log, hex-encoded - the debug surface (`ringtome inspect` eats the hex).
///
/// PAGED, and explicitly so: `more` says whether the log continues and `next` is the cursor to
/// continue from. It used to hand back every entry a persona had ever written, envelopes
/// included, which is a fine demo and a bad promise at the scale this system targets. Truncating
/// silently would be worse than either - an inspection tool that lies by omission is how you
/// spend an afternoon debugging the wrong thing.
async fn entries_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    axum::extract::Query(q): axum::extract::Query<EntriesQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .held(&root)
        .await
        .map_err(AppError::Internal)?;
    let after = match (q.after_author, q.after_service, q.after_seq) {
        (Some(author), Some(service), Some(seq)) => Some(imaol::EntryCursor {
            author,
            service,
            seq,
        }),
        _ => None,
    };
    let (items, more) = imaol::list_entries(
        &db,
        q.limit.unwrap_or(imaol::ENTRIES_PAGE),
        after.as_ref(),
    )
    .await?;
    let next = items.last().map(|e| imaol::EntryCursor {
        author: e.author.clone(),
        service: e.service,
        seq: e.seq,
    });
    Ok(Json(serde_json::json!({
        "items": items,
        "more": more,
        "next": if more { next } else { None },
    })))
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
    // The newborn device is locatable from its first breath (discoverability doctrine), and
    // immediately derives its peer view from the tree it just received - the ceremony's
    // pairwise knowledge is the seed, not the ceiling.
    super::serving::publish_best_effort(&state, &identity.root_pubkey).await;
    crate::net::sync::derive_peers_for(&state, &identity.root_pubkey).await;
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

#[derive(serde::Deserialize)]
struct FeedQuery {
    before_ms: Option<i64>,
    before_doc: Option<String>,
}

#[derive(Serialize)]
struct FeedItem {
    author: String,
    doc_id: String,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<String>,
    published_ms: i64,
    updated_ms: i64,
    arrived_ms: i64,
    /// The author turned off rebroadcast and comment (PROJECT_PLAN's Post visibility); the card hides those
    /// affordances. Absent when open, so older clients change nothing.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    settled: bool,
    /// The author shares the body with trusted readers only (PROJECT_PLAN's Post visibility slice 2): the
    /// card says why a body will not arrive. Absent when open.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    trusted_only: bool,
    /// The reader wrote this one themselves.
    mine: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_avatar: Option<String>,
    /// Who shared this into the feed, when it arrived by rebroadcast rather than by a follow.
    /// Absent on the ordinary case, so a client that knows nothing about sharing renders every
    /// row exactly as it did before.
    #[serde(skip_serializing_if = "Option::is_none")]
    via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    via_name: Option<String>,
    /// The sharer's avatar, so the chip beside their name shows a face rather than an
    /// identicon. From the same byline cache as the author's - one lookup, both people.
    #[serde(skip_serializing_if = "Option::is_none")]
    via_avatar: Option<String>,
    /// Everyone ELSE the reader follows who also passed this along - `via` excluded, since it
    /// leads the line, and capped at `fanout::VIA_OTHERS_CAP` because a list is a payload.
    /// Most recently shared first.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    via_others: Vec<Sharer>,
    /// How many people the reader follows shared this, `via` included - **exact**, even when
    /// `via_others` was capped, so "and 200 others" stays sayable. Absent unless more than one
    /// person shared it, which keeps the ordinary single-sharer row byte-identical to before.
    #[serde(skip_serializing_if = "Option::is_none")]
    via_count: Option<usize>,
    /// The introducer whose vouch journaled this row speculatively (PROJECT_PLAN's Discovery, slice 2) -
    /// mutually exclusive with `via`, absent on every real row so old clients render
    /// unchanged. The name rides beside it for the byline, same discipline as the sharer's.
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_via: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_via_name: Option<String>,
    /// The demand rollup's discounted band for this author, read-time joined - the slider's
    /// `path` provenance rung. Absent on real rows and on suggested rows whose demand has
    /// since receded (which the slider treats as the weakest path, honestly).
    #[serde(skip_serializing_if = "Option::is_none")]
    suggested_level: Option<String>,
    /// How many replies this node THINKS the post has (`replies::known_counts`) - the
    /// foot line's number, honest-partial like the thread it summarizes. Absent when
    /// zero.
    #[serde(skip_serializing_if = "Option::is_none")]
    replies: Option<i64>,
    /// This post is a REPLY, and this is its parent - the quote-card's whole payload
    /// (PROJECT_PLAN's Replies slice 3). From the node's replies memo, so it is exactly as partial as
    /// the thread view: a reply whose link this node never verified renders as an ordinary
    /// post, honestly. Absent on every non-reply so old clients render unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    reply_to: Option<ReplyCard>,
    /// The thread's ROOT, when this reply sits deeper than depth one - absent when the
    /// parent IS the root, so a depth-one reply carries one card, not the same card
    /// twice (Curtis, 2026-08-28).
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_root: Option<ReplyCard>,
    /// Every label this node knows on the post (ANNOTATIONS.md slice 2): the author's own
    /// first, then others' with the annotator's byline. All of them - the reader's display
    /// register decides at the client which annotators render.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    annotations: Vec<AnnotationCard>,
}

#[derive(Serialize)]
struct AnnotationCard {
    annotator: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    annotator_name: Option<String>,
    key: String,
    value: String,
}

/// A reply row's parent, dressed for the mini-card: the link always, the trimmings when the
/// reader's own journal or the byline cache happens to know them.
#[derive(Serialize)]
struct ReplyCard {
    author: String,
    doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_ms: Option<i64>,
}

/// One of the other people who passed a document along, dressed like the lead sharer so the
/// client renders them with the same widget rather than a second, thinner one.
#[derive(Serialize)]
struct Sharer {
    root: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
}

/// GET `/api/identity/{root}/feed` - one page of the reader's arrival journal, strictly
/// chronological, dressed with everything a row needs to render: byline from the cache (never
/// a database per face) and `mine` for the reader's own posts (which appear like anyone
/// else's - they follow themselves by hosting).
///
/// What is deliberately NOT here: ranking. How a good feed orders is a research problem this
/// draft does not attempt; the interest dials shape RENDERING only, client-side, off the
/// reader's own mirror.
///
/// Also deliberately not here, as of 2026-08-09: **read state**. A feed has no unread count,
/// no dot, and no "only what's new" - see PROJECT_PLAN, One Cursor. The bell keeps its
/// watermark; a chronological river does not get a chore attached.
async fn feed_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    axum::extract::Query(q): axum::extract::Query<FeedQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Ownership is the only reason to open the reader's own store here (the feed itself is a
    // node.db memo), and `store::open` is that check.
    let _owned = store::open(&state, &session.account.id, &root).await?;
    let before = match (q.before_ms, q.before_doc) {
        (Some(ms), Some(doc)) => Some((ms, doc)),
        _ => None,
    };
    let page = crate::idface::POSTS_PAGE;
    let mut rows = crate::fanout::feed_page(&state.node_db, &root, before, page + 1)
        .await
        .map_err(AppError::Internal)?;
    let more = rows.len() as i64 > page;
    rows.truncate(page as usize);

    // A sealed post this reader cannot open is not SHOWN at all (Curtis, 2026-09-02: "I'd
    // prefer it if the feed didn't show feed items I can't see") - a hollow card is just an
    // advertisement for a refusal. Checked live against the author's published trust, so
    // the row appears the moment the author trusts this reader; fails closed when the
    // author's chains are not mirrored here, exactly as the body gate would. The author-db
    // opens are bounded by the page's DISTINCT flagged authors - ordinarily zero.
    {
        let mut trusted_here: std::collections::HashMap<String, bool> = Default::default();
        let mut keep = Vec::with_capacity(rows.len());
        for r in rows {
            if !r.trusted_only || r.author_root == root {
                keep.push(r);
                continue;
            }
            let ok = match trusted_here.get(&r.author_root) {
                Some(v) => *v,
                None => {
                    let v = match state.user_dbs.get(&r.author_root).await {
                        Ok(Some(db)) => crate::record::imaol::published_edges(&db)
                            .await
                            .map(|e| e.get(&root).is_some_and(|row| row.edge.trust.is_some()))
                            .unwrap_or(false),
                        _ => false,
                    };
                    trusted_here.insert(r.author_root.clone(), v);
                    v
                }
            };
            if ok {
                keep.push(r);
            }
        }
        rows = keep;
    }

    // Who else passed each of these along - two indexed node.db reads for the whole page, never
    // per row (`fanout::followed_sharers` argues for deriving this rather than storing it).
    let sharers = crate::fanout::followed_sharers(&state.node_db, &root, &rows)
        .await
        .map_err(AppError::Internal)?;

    // Which of the page's rows are replies, and each parent's journal dressing - two
    // page-scoped node.db reads, the sharers read's discipline (never per row).
    let reply_links = crate::replies::links_for(
        &state.node_db,
        &rows
            .iter()
            .map(|r| (r.author_root.clone(), r.doc_id.clone()))
            .collect::<Vec<_>>(),
    )
    .await
    .map_err(AppError::Internal)?;
    // Parents and roots alike get the journal's dressing, one read for both.
    let parents: Vec<(String, String)> = reply_links
        .values()
        .flat_map(|l| [l.parent.clone(), l.root.clone()])
        .collect();
    let parent_cards = crate::fanout::journal_cards(&state.node_db, &root, &parents)
        .await
        .map_err(AppError::Internal)?;
    let page_pairs: Vec<(String, String)> = rows
        .iter()
        .map(|r| (r.author_root.clone(), r.doc_id.clone()))
        .collect();
    let known_labels = crate::annotations::for_posts(&state.node_db, &page_pairs)
        .await
        .map_err(AppError::Internal)?;
    let reply_counts = crate::replies::known_counts(
        &state.node_db,
        &rows
            .iter()
            .map(|r| (r.author_root.clone(), r.doc_id.clone()))
            .collect::<Vec<_>>(),
    )
    .await
    .map_err(AppError::Internal)?;

    // Bylines for authors AND sharers: "X shared Y's post" needs two names, and asking for
    // them in one lookup beats a second round of database opens at render time. The other
    // sharers ride the same lookup for the same reason - a hover list of twelve faces must not
    // become twelve queries.
    let mut authors: Vec<String> = rows.iter().map(|r| r.author_root.clone()).collect();
    authors.extend(
        reply_links
            .values()
            .flat_map(|l| [l.parent.0.clone(), l.root.0.clone()]),
    );
    authors.extend(known_labels.values().flatten().map(|a| a.annotator.clone()));
    authors.extend(rows.iter().filter_map(|r| r.via_root.clone()));
    authors.extend(rows.iter().filter_map(|r| r.suggested_via.clone()));
    authors.extend(sharers.values().flatten().cloned());
    let bylines = crate::profiles::bylines(&state.node_db, &authors)
        .await
        .map_err(AppError::Internal)?;
    // The path bands, only when a page actually carries suggested rows - the common page
    // costs nothing new.
    let levels = if rows.iter().any(|r| r.suggested_via.is_some()) {
        crate::speculative::levels_for(&state.node_db, &root)
            .await
            .map_err(AppError::Internal)?
    } else {
        Default::default()
    };

    let items: Vec<FeedItem> = rows
        .into_iter()
        .map(|r| {
            let mine = r.author_root == root;
            let byline = bylines.get(&r.author_root).cloned().unwrap_or_default();

            // Who leads the line. `feed_shares` is earliest-first and is the LIVE list, so its
            // head is the introducer - and when that person has since withdrawn, the head becomes
            // whoever is earliest among those still sharing it. That distinction is the point:
            // `feed_journal.via_root` remembers who brought this row and never changes, which is
            // right for the row's history and wrong for a byline, because a byline is a claim in
            // the present tense and nobody should be credited with a recommendation they took back.
            //
            // The row's own memory is the fallback for the one case the live list cannot answer:
            // nobody the reader follows shares it any more, and yet the row is still here. That
            // state is arguably a row that should have been retired rather than re-bylined, and
            // deciding so is a question for the retraction rules rather than for this handler -
            // until then, how it reached you is the truest thing left to say about it.
            let crowd = sharers.get(&(r.author_root.clone(), r.doc_id.clone()));
            let lead = crowd
                .and_then(|list| list.first())
                .or(r.via_root.as_ref())
                .cloned();
            let via_byline = lead.as_ref().and_then(|v| bylines.get(v));
            let via_name = via_byline.and_then(|b| b.name.clone());
            let via_avatar = via_byline.and_then(|b| b.avatar.clone());
            // Everyone but the lead. The count is what is actually shown plus the lead, so the
            // number and the names can never disagree.
            let others: Vec<&String> = crowd
                .map(|list| list.iter().skip(1).collect())
                .unwrap_or_default();
            let via_count = match (&lead, others.len()) {
                (Some(_), n) if n > 0 => Some(n + 1),
                _ => None,
            };
            let via_others: Vec<Sharer> = others
                .into_iter()
                .take(crate::fanout::VIA_OTHERS_CAP)
                .map(|holder| {
                    let b = bylines.get(holder).cloned().unwrap_or_default();
                    Sharer {
                        root: holder.clone(),
                        name: b.name,
                        avatar: b.avatar,
                    }
                })
                .collect();
            let suggested_via_name = r
                .suggested_via
                .as_ref()
                .and_then(|v| bylines.get(v))
                .and_then(|b| b.name.clone());
            let suggested_level = r
                .suggested_via
                .as_ref()
                .and_then(|_| levels.get(&r.author_root).cloned());
            let replies = reply_counts
                .get(&(r.author_root.clone(), r.doc_id.clone()))
                .copied()
                .filter(|n| *n > 0);
            let dress = |(pa, pd): &(String, String)| {
                let card = parent_cards.get(&(pa.clone(), pd.clone()));
                ReplyCard {
                    author: pa.clone(),
                    doc_id: pd.clone(),
                    name: bylines.get(pa).and_then(|b| b.name.clone()),
                    title: card.map(|(t, _)| t.clone()).filter(|t| !t.is_empty()),
                    published_ms: card.map(|(_, ms)| *ms),
                }
            };
            let annotations: Vec<AnnotationCard> = known_labels
                .get(&(r.author_root.clone(), r.doc_id.clone()))
                .map(|list| {
                    list.iter()
                        .map(|a| AnnotationCard {
                            annotator_name: bylines.get(&a.annotator).and_then(|b| b.name.clone()),
                            annotator: a.annotator.clone(),
                            key: a.key.clone(),
                            value: a.value.clone(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let links = reply_links.get(&(r.author_root.clone(), r.doc_id.clone()));
            let reply_to = links.map(|l| dress(&l.parent));
            let thread_root = links
                .filter(|l| l.root != l.parent)
                .map(|l| dress(&l.root));
            FeedItem {
                mine,
                author_name: byline.name,
                author_avatar: byline.avatar,
                author: r.author_root,
                doc_id: r.doc_id,
                title: r.title,
                format: r.format,
                published_ms: r.published_ms,
                updated_ms: r.updated_ms,
                arrived_ms: r.arrived_ms,
                settled: r.settled,
                trusted_only: r.trusted_only,
                via: lead,
                via_name,
                via_avatar,
                via_others,
                via_count,
                suggested_level,
                suggested_via: r.suggested_via,
                suggested_via_name,
                replies,
                reply_to,
                thread_root,
                annotations,
            }
        })
        .collect();
    Ok(Json(serde_json::json!({ "items": items, "more": more })))
}

/// One page of notifications, dressed like feed rows: byline from the cache, seen-state from
/// the reader's own private chain. The page is small by construction - the memo collapses per
/// (author, kind), so its size is the reader's social circle, not their history.
const NOTIFICATIONS_PAGE: u32 = 100;

#[derive(Serialize)]
struct NotificationItem {
    author: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    trust: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    interest: Option<String>,
    /// The row's own words, for kinds that carry some - 'tagged': the label(s) themselves.
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    /// The referenced post's title and date, joined server-side for the bell's mini-card
    /// (2026-08-26): the doc is the READER's own post, so their open store answers in one
    /// read - no client fan-out, and the bell renders instantly. Absent when the row names
    /// no doc, or the post has since left the public shelf (the card degrades to a bare
    /// link whose 404 is the honest answer).
    #[serde(skip_serializing_if = "Option::is_none")]
    doc_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    doc_published_ms: Option<i64>,
    updated_ms: i64,
    /// Above or below the reader's seen-watermark - their private-chain fact, so read-on-the-
    /// phone is read-on-the-laptop.
    seen: bool,
    /// This one ARRIVED (an envelope from someone the reader does not sync) rather than being
    /// derived from chains the reader already pulls. The client renders a stranger from their
    /// root alone - see the byline note on the handler.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    stranger: bool,
    /// Which document, for kinds about one (a share). Empty for relationship kinds.
    #[serde(skip_serializing_if = "String::is_empty")]
    doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author_avatar: Option<String>,
    /// What a STRANGER says they are called - a claim off the envelope, never a fetched
    /// profile. Kept in its own field rather than folded into `author_name` precisely so the
    /// client cannot render it where a verified name goes: it is shown beside the identity
    /// derived from their root, never in place of it.
    #[serde(skip_serializing_if = "Option::is_none")]
    claimed_name: Option<String>,
}

/// GET `/api/identity/{root}/notifications` - one list, two sources.
///
/// **Derived** rows come from the node's `notifications` memo: things people the reader
/// already syncs did, folded locally. **Delivered** rows come from the reader's own inbox
/// chains: envelopes handed to one of their nodes by someone they do *not* sync. The reader
/// should not have to care which path a fact took, so both render in one stream ordered by
/// time (PROJECT_PLAN, Arrival and Attention).
///
/// **Delivered rows get no byline, deliberately.** An unadmitted stranger renders as derived
/// identity only - identicon and speakable words computed from their root - because claimed
/// identity costs a sync and you pay it only for people you have answered. That is one rule
/// serving two purposes: it bounds fan-out, and it stops a stranger putting a chosen name and
/// picture in front of you. Answering the door (following them) converts them to the derived
/// path, and the byline arrives with the relationship - including for a notice that arrived
/// *before* you answered, which [`undelivered_twice`] is what makes true.
///
/// Seen-state is a single watermark register (`notifications_seen/watermark`, a PUT to the
/// existing private KV surface): rows newer than it are unseen, and "mark read" is one write
/// that travels to every device. Per-row seen granularity waits for a kind that needs it.
async fn notifications_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let (mut items, watermark) = notification_items(&state, &data, &root).await?;

    // The mini-card join: every row that names a doc names one of the READER's own posts,
    // and their store is already open - one shelf read per doc'd row, page-bounded.
    for item in items.iter_mut().filter(|i| !i.doc_id.is_empty()) {
        let Some(doc_id) = hex::decode(&item.doc_id)
            .ok()
            .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
        else {
            continue;
        };
        if let Some(p) = crate::record::documents::public_doc(data.db(), &doc_id).await? {
            item.doc_title = Some(p.title);
            item.doc_published_ms = Some(p.genesis_ms);
        }
    }

    Ok(Json(serde_json::json!({ "items": items, "watermark": watermark })))
}

/// How many of the bell's rows the reader has not seen - the dock badge's number
/// (2026-08-28), computed from exactly the rows the bell would show, so the badge and the
/// bell can never disagree.
async fn unread_count(state: &AppState, data: &store::Store, root: &str) -> Result<u64, AppError> {
    let (items, _) = notification_items(state, data, root).await?;
    Ok(items.iter().filter(|i| !i.seen).count() as u64)
}

/// The bell's rows, assembled: derived beside delivered, deduped by the follow-edge rule
/// (present twin, or owned sender), seen-state from the reader's watermark. The mini-card
/// dressing is the handler's own step - the badge count has no use for titles.
async fn notification_items(
    state: &AppState,
    data: &store::Store,
    root: &str,
) -> Result<(Vec<NotificationItem>, i64), AppError> {
    let derived = crate::notifications::page(&state.node_db, root, NOTIFICATIONS_PAGE)
        .await
        .map_err(AppError::Internal)?;
    let delivered = data.inbox().page(NOTIFICATIONS_PAGE).await?;

    let (regs, _) = data.private_registers("notifications_seen").all().await?;
    let watermark: i64 = regs
        .iter()
        .find(|r| r.key == "watermark")
        .and_then(|r| r.value.parse().ok())
        .unwrap_or(0);

    let authors: Vec<String> = derived.iter().map(|r| r.author_root.clone()).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &authors)
        .await
        .map_err(AppError::Internal)?;

    let mut items: Vec<NotificationItem> = derived
        .into_iter()
        .map(|r| {
            let byline = bylines.get(&r.author_root).cloned().unwrap_or_default();
            NotificationItem {
                seen: r.updated_ms <= watermark,
                stranger: false,
                claimed_name: None,
                doc_id: r.doc_id,
                doc_title: None,
                doc_published_ms: None,
                author_name: byline.name,
                author_avatar: byline.avatar,
                author: r.author_root,
                kind: r.kind,
                trust: r.trust,
                interest: r.interest,
                detail: r.detail,
                updated_ms: r.updated_ms,
            }
        })
        .collect();
    // `items` is exactly the derived rows at this point, which is what the dedup keys off.
    let delivered = undelivered_twice(&items, delivered);
    // The follow-edge rule, applied at READ (2026-08-27, caught by the deleted-reply case):
    // for a sender the reader now pulls, the derived path owns every fact - including a
    // fact's ABSENCE. A delivered row transcribed back when they were a stranger must not
    // resurface just because its derived twin receded; the twin receding IS the news (the
    // reply was deleted, the edge withdrawn), and the stale envelope would resurrect it.
    // Same sentence as the gate's own ("a second surface for a fact the pull path owns"),
    // applied to the copies that got in before the follow began.
    let mut delivered_unowned = Vec::new();
    for n in delivered {
        if !crate::net::subscriptions::follows(&state.node_db, root, &n.sender_root)
            .await
            .map_err(AppError::Internal)?
        {
            delivered_unowned.push(n);
        }
    }
    items.extend(delivered_unowned.into_iter().map(|n| NotificationItem {
        seen: n.timestamp_ms <= watermark,
        stranger: true,
        // The delivered path's inbox rows collapse per (sender, kind) by design - a bounded
        // pool cannot key on every object a stranger might mention - but the evidence names
        // its document, so a murmur carries its MOST RECENT share's doc (2026-08-25):
        // "which post" beats "some post", and the collapse semantics are unchanged.
        doc_id: n.doc_id.unwrap_or_default(),
        // The one thing a stranger's row now says out loud - and the ONLY name on it, since
        // author_name stays None: nothing has been fetched about them.
        claimed_name: n.display_name,
        author_name: None,
        author_avatar: None,
        author: n.sender_root,
        kind: n.kind,
        trust: n.trust,
        interest: n.interest,
        detail: n.detail,
        doc_title: None,
        doc_published_ms: None,
        updated_ms: n.timestamp_ms,
    }));
    items.sort_by_key(|i| std::cmp::Reverse(i.updated_ms));
    items.truncate(NOTIFICATIONS_PAGE as usize);
    Ok((items, watermark))
}

/// The follow-edge rule, applied after the fact: **where the derived path already carries a
/// fact, the delivered copy of it is not shown.**
///
/// The gate enforces "a follow-edge produces no inbox row, ever" at transcription, which is the
/// only moment it can - but the relationship outlives the moment. A stranger knocks, their
/// notice is transcribed correctly, and then you follow them back; now you sync the very chain
/// the envelope was quoting, the fold derives its own row, and the reader sees the same event
/// twice - once with a byline and once as "(stranger)". That is not two facts.
///
/// The derived row wins, and not by coincidence of ordering: it is folded from the author's own
/// chain under the sync gate rather than transcribed from a stranger's envelope, it is current
/// where the envelope is a snapshot of whatever they claimed when they knocked, and it carries
/// the byline that answering the door is what buys.
///
/// `seen` is a single time watermark rather than per-row state, so dropping a row cannot strand
/// an unread marker (Seen-state, on the handler).
fn undelivered_twice(
    derived: &[NotificationItem],
    delivered: Vec<crate::inbox::Notice>,
) -> Vec<crate::inbox::Notice> {
    let known: std::collections::HashSet<(&str, &str)> = derived
        .iter()
        .map(|i| (i.author.as_str(), i.kind.as_str()))
        .collect();
    delivered
        .into_iter()
        .filter(|n| !known.contains(&(n.sender_root.as_str(), n.kind.as_str())))
        .collect()
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
            return Err(AppError::BadRequest(crate::msg!("identity.routes.unknown-disposition-other-retirement-repudiation", "unknown disposition {other:?} (retirement | repudiation)", other = other)));
        }
    };
    let cut = match (req.cut.as_deref(), disposition) {
        (None | Some("now"), _) => super::Cut::Now,
        (Some("genesis"), ringtome_proto::Disposition::Repudiation) => super::Cut::Genesis,
        (Some("genesis"), ringtome_proto::Disposition::Retirement) => {
            // A retirement IS the honoring of history - "it was never me" contradicts it.
            return Err(AppError::BadRequest(crate::msg!("identity.routes.cut-genesis-only-applies-to", "cut \"genesis\" only applies to repudiation")));
        }
        (Some(other), _) => {
            return Err(AppError::BadRequest(crate::msg!("identity.routes.unknown-cut-other-now-genesis", "unknown cut {other:?} (now | genesis)", other = other)));
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
#[derive(serde::Serialize)]
struct PublishResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    post_id: Option<String>,
    /// Media still preparing (or failed): the modal's list. Present only with a 202.
    #[serde(skip_serializing_if = "Option::is_none")]
    baking: Option<Vec<crate::record::bake::BakeItem>>,
}

/// Publish a note: mint (or extend) its public post. The deliberate act the whole membrane
/// rests on - there is no flag to set, only this call to make.
/// A reply's target, as the publish request names it (PROJECT_PLAN's Replies slice 1).
#[derive(serde::Deserialize, Default)]
struct PublishRequest {
    reply_to: Option<ReplyRef>,
    /// The author's no-shares-no-replies wish (PROJECT_PLAN's Post visibility): set at publish, carried
    /// forward on re-publication like the reply link.
    settled: Option<bool>,
    /// Trusted readers only (PROJECT_PLAN's Post visibility slice 2), carried the same way.
    trusted_only: Option<bool>,
}

#[derive(serde::Deserialize)]
struct ReplyRef {
    author: String,
    doc_id: String,
}

/// The PARENT's own held header, mirror shelf first, fragment shelf second - the shared
/// lookup for every honest door that must honor the header's own flags.
async fn held_public_header(
    state: &AppState,
    author_hex: &str,
    doc_hex: &str,
) -> Result<Option<ringtome_proto::registry::DocHeaderPlain>, AppError> {
    if let Ok(Some(db)) = state.user_dbs.get(author_hex).await {
        if let Ok(doc) = hex::decode(doc_hex) {
            if let Ok(doc) = <[u8; 16]>::try_from(doc.as_slice()) {
                if let Some(entry) =
                    crate::record::documents::public_header_entry(&db, &doc).await?
                {
                    if let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload {
                        if let Ok(h) = ringtome_proto::registry::DocHeaderPlain::decode(payload) {
                            return Ok(Some(h));
                        }
                    }
                }
            }
        }
    }
    crate::fragments::held_header(&state.node_db, author_hex, doc_hex)
        .await
        .map_err(AppError::Internal)
}

/// Resolve a reply's links from the PARENT's own held header: the mirror's public shelf
/// first (a followed or visited persona), the fragment shelf second (a post met as a
/// share). The thread root is the parent's own claim when the parent is itself a reply,
/// else the parent - parent-plus-root, never the ancestor path. A parent this computer
/// does not hold refuses with words: a reply minted blind could neither copy the root
/// claim nor honor the pin.
async fn resolve_reply_link(
    state: &AppState,
    parent: &ReplyRef,
) -> Result<crate::record::documents::ReplyLinks, AppError> {
    let author = hex_fixed::<32>(&parent.author, "reply author root")?;
    let doc = hex_fixed::<16>(&parent.doc_id, "reply doc id")?;
    let author_hex = hex::encode(author);
    let doc_hex = hex::encode(doc);
    let header = match state.user_dbs.get(&author_hex).await {
        Ok(Some(db)) => match crate::record::documents::public_header_entry(&db, &doc).await? {
            Some(entry) => match &entry.entry().payload {
                ringtome_proto::Payload::Inline(payload) => {
                    ringtome_proto::registry::DocHeaderPlain::decode(payload).ok()
                }
                _ => None,
            },
            None => None,
        },
        _ => None,
    };
    let header = match header {
        Some(h) => Some(h),
        None => crate::fragments::held_header(&state.node_db, &author_hex, &doc_hex)
            .await
            .map_err(AppError::Internal)?,
    };
    let Some(header) = header else {
        return Err(AppError::BadRequest(crate::msg!(
            "identity.routes.cant-reply-to-a-post",
            "can't reply to a post this computer doesn't hold - visit it first"
        )));
    };
    // The author's wish, honored at the honest door (PROJECT_PLAN's Post visibility): a settled post takes
    // no replies, and the refusal has words rather than a quietly orphaned comment.
    if header.settled {
        return Err(AppError::BadRequest(crate::msg!(
            "identity.routes.settled-no-replies",
            "the author turned off comments for this post"
        )));
    }
    let parent_link = (author, doc);
    let root_link = header.thread_root.unwrap_or(parent_link);
    Ok((parent_link, root_link))
}

async fn publish_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc_id)): Path<(String, String)>,
    body: Option<Json<PublishRequest>>,
) -> Result<Response, AppError> {
    let doc_id = hex_fixed::<16>(&doc_id, "doc id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    let req = body.map(|Json(b)| b);
    let reply = match req.as_ref().and_then(|b| b.reply_to.as_ref()) {
        Some(parent) => Some(resolve_reply_link(&state, parent).await?),
        None => None,
    };
    let settled = req.as_ref().and_then(|b| b.settled).unwrap_or(false);
    let trusted_only = req.as_ref().and_then(|b| b.trusted_only).unwrap_or(false);
    // Publication goes through the media pre-pass (record::bake): embedded private media
    // bakes inline; external media bakes in the background, and until it lands the answer
    // is 202 with the modal's item list - re-POST to check again (idempotent).
    match crate::record::bake::publish(&state, &data, &root, &doc_id, reply, settled, trusted_only).await? {
        crate::record::bake::Outcome::Posted(post_id) => {
            // The pins: a reply IS a recommendation (PROJECT_PLAN's Replies, Curtis's ruling) - the
            // parent and the thread root are shared outright, ordinary pointers, crowd
            // counts and all. Deduped when the parent is the root; your OWN posts pin
            // nothing (they are already yours to serve, and a persona does not rebroadcast
            // itself). Best-effort: the reply is on the chain either way, and a failed pin
            // is re-mintable by sharing - a pin failure must not unsay the words.
            if let Some((parent, root_link)) = reply {
                let self_root = hex_fixed::<32>(&root, "root")?;
                // The parent pin is QUIET (announce: false): the comment notice below is
                // the same act said properly. The root pin - the nested case's second
                // pointer - announces as an ordinary share when the root's author is
                // somebody ELSE (for them the news IS "your post got passed along"), and
                // stays quiet when the parent's author owns the root too (Curtis,
                // 2026-08-29: answering someone's reply in their own thread rang them
                // twice - "replied" and "shared" - for one act).
                for (author, doc, announce) in [
                    (parent.0, parent.1, false),
                    (root_link.0, root_link.1, root_link.0 != parent.0),
                ] {
                    if author == self_root || (announce && (author, doc) == parent) {
                        continue;
                    }
                    if let Err(e) = share_one(&state, &data, &root, author, doc, announce).await {
                        tracing::warn!(author = %hex::encode(author), error = ?e,
                            "a reply's pin did not mint; the reply stands, share by hand");
                    }
                }
                // The comment notice (PROJECT_PLAN's Replies slice 4): first-class, to the PARENT's
                // author, carrying the reply's own signed header as evidence - the claim
                // verify_claim checks against the recipient's name. Best-effort like the
                // pins: the reply is on the chain either way. The follow-edge gate at the
                // recipient drops this when they already pull us (the derived fold speaks
                // there), so queueing unconditionally is correct, not chatty.
                if parent.0 != self_root {
                    match crate::record::documents::public_header_entry(data.db(), &post_id).await {
                        Ok(Some(entry)) => {
                            let parent_hex = hex::encode(parent.0);
                            match data
                                .notices()
                                .seal(
                                    &parent.0,
                                    &entry,
                                    ringtome_proto::deliver::notice_kind::COMMENT,
                                    state.config.pow_requested_bits,
                                )
                                .await
                            {
                                Ok(envelope) => {
                                    if let Err(e) = crate::outbox::queue(
                                        &state.node_db,
                                        &root,
                                        &parent_hex,
                                        &envelope,
                                    )
                                    .await
                                    {
                                        tracing::warn!(author = %parent_hex, error = ?e,
                                            "could not queue a comment notice");
                                    }
                                }
                                Err(e) => tracing::warn!(author = %parent_hex, error = ?e,
                                    "could not seal a comment notice"),
                            }
                        }
                        Ok(None) => tracing::warn!(
                            "the reply's own header is not readable; no comment notice"
                        ),
                        Err(e) => tracing::warn!(error = ?e,
                            "could not read the reply's header for its comment notice"),
                    }
                    // Knock now, the share path's eager idiom.
                    let eager = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = crate::outbox::sweep(eager).await {
                            tracing::debug!(error = ?e, "eager comment-notice delivery failed");
                        }
                    });
                }
            }
            // The sealing key's node memo (PROJECT_PLAN's Post visibility slice 2b): the author's node
            // remembers at mint so the body door and the key lane answer without a
            // private-chain read per request. Best-effort: the draft's copy is durable.
            if trusted_only {
                if let Ok(Some(k)) = data.annotations().field(&doc_id, store::TRUSTED_KEY).await {
                    if let Some(key) = hex::decode(&k)
                        .ok()
                        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
                    {
                        if let Err(e) = crate::postkeys::remember(
                            &state.node_db,
                            &root,
                            &hex::encode(post_id),
                            &key,
                        )
                        .await
                        {
                            tracing::warn!(error = ?e, "post key memo write failed");
                        }
                        // The twins seal under the same key: memo it under THEIR ids too,
                        // so the key doors (HTTP and WantKey alike) answer for a picture
                        // exactly as they answer for the words.
                        if let Ok(Some(entry)) =
                            crate::record::documents::public_header_entry(data.db(), &post_id).await
                        {
                            if let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload {
                                if let Ok(h) = ringtome_proto::registry::DocHeaderPlain::decode(payload) {
                                    for r in &h.refs {
                                        if let Err(e) = crate::postkeys::remember(
                                            &state.node_db,
                                            &root,
                                            &hex::encode(r),
                                            &key,
                                        )
                                        .await
                                        {
                                            tracing::warn!(error = ?e, "twin key memo write failed");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // The draft's annotations, restated in public about the new post (ANNOTATIONS.md
            // slice 1) - best-effort, like the pins: a label must not unsay the words.
            {
                let self_root = hex_fixed::<32>(&root, "root")?;
                if let Err(e) = replicate_annotations(&data, &self_root, &doc_id, &post_id).await {
                    tracing::warn!(error = ?e, "annotation replication failed; the post stands");
                }
            }
            Ok(Json(PublishResponse {
                post_id: Some(hex::encode(post_id)),
                baking: None,
            })
            .into_response())
        }
        crate::record::bake::Outcome::Baking(items) => Ok((
            axum::http::StatusCode::ACCEPTED,
            Json(PublishResponse {
                post_id: None,
                baking: Some(items),
            }),
        )
            .into_response()),
    }
}

/// GET `/api/identity/{root}/posts/{post_id}/replies` - the AUTHOR's view of their own
/// post's thread index (PROJECT_PLAN's Replies slice 6): every reply this node knows, including the
/// strangers' held for the nod, each row carrying `served` - the curation bit as it stands.
/// The public read (idface) shows only what `served` is true of; this surface exists so the
/// author can see what is waiting and nod it in (a `comments` register PUT, which drains
/// the fold so the door speaks the new bit on the next ask).
async fn own_post_replies_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, post_id)): Path<(String, String)>,
    axum::extract::Query(q): axum::extract::Query<OwnRepliesQuery>,
) -> Result<Json<serde_json::Value>, AppError> {
    let _owned = store::open(&state, &session.account.id, &root).await?;
    if hex::decode(&post_id).map(|b| b.len()) != Ok(16) {
        return Err(AppError::BadRequest(crate::msg!(
            "identity.routes.that-isnt-a-document-id",
            "that isn't a document id"
        )));
    }
    let after = match (q.after_ms, q.after_doc) {
        (Some(ms), Some(d)) => Some((ms, d)),
        _ => None,
    };
    let (replies, more) = crate::replies::replies_of(&state.node_db, &root, &post_id, after)
        .await
        .map_err(AppError::Internal)?;
    let mut rows = Vec::with_capacity(replies.len());
    for r in replies {
        let served = crate::replies::servable(&state, &root, &r.author, &r.doc_id).await;
        let verdict =
            crate::replies::curation_verdict(&state.node_db, &root, &r.author, &r.doc_id).await;
        rows.push(serde_json::json!({
            "author": r.author,
            "doc_id": r.doc_id,
            "claimed_ms": r.claimed_ms,
            "served": served,
            "verdict": verdict,
        }));
    }
    let mode = crate::replies::curation_mode(&state.node_db, &root).await;
    Ok(Json(serde_json::json!({ "replies": rows, "more": more, "mode": mode })))
}

#[derive(Deserialize)]
struct OwnRepliesQuery {
    after_ms: Option<i64>,
    after_doc: Option<String>,
}

/// DELETE `/api/identity/{root}/posts/{post_id}` - take a published post back off the network.
///
/// **The public counterpart to deleting a note, and deliberately its own gesture.** A note and
/// its post are two documents (Copy, Don't Flip): publishing mints the post beside the note
/// rather than flipping the note public, so removing one has no business removing the other.
/// Deleting your draft is housekeeping in your own drawer and leaves the post standing; this is
/// the act that changes what other people can see, and it takes the PUBLIC document's id because
/// that is the thing it destroys.
///
/// What it mints is a content-free tombstone on the posts chain, which travels wherever the post
/// travelled: off the author's shelf, out of every follower's journal on the next public move,
/// and - for anyone holding only a fragment - `Gone` on their next revalidation, all the way
/// down the share tree.
///
/// Idempotent: retracting an already-retracted post writes another tombstone saying the same
/// thing, and the fold is LWW.
async fn unpublish_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, post_id)): Path<(String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let post_id = hex_fixed::<16>(&post_id, "post id")?;
    let data = store::open(&state, &session.account.id, &root).await?;
    if !data.documents().is_public(&post_id).await? {
        return Err(AppError::NotFound(crate::msg!(
            "identity.routes.that-post-isnt-on-your-shelf",
            "that post isn't on your public shelf - it may already be taken down"
        )));
    }
    // The pin lives and dies with the comment (PROJECT_PLAN's Replies): read the post's own thread
    // links BEFORE the tombstone lands, so a deleted reply retracts the pointers it
    // minted. Retraction is the silent pointer write, exactly like un-sharing by hand -
    // and it IS un-sharing: one pointer per (author, doc), so a manual share of the same
    // parent goes with it, a named consequence of "a reply is a recommendation".
    let reply_pins = crate::record::documents::public_doc(data.db(), &post_id)
        .await?
        .map(|p| (p.reply_to, p.thread_root));
    let signed = data.documents().retract_public(&post_id).await?;
    if let Some((reply_to, thread_root)) = reply_pins {
        let mut pins: Vec<(String, String)> = Vec::new();
        pins.extend(reply_to);
        pins.extend(thread_root);
        pins.dedup();
        for (author_hex, doc_hex) in pins {
            let (Some(author), Ok(doc)) = (
                crate::pubkey::decode(&author_hex),
                hex::decode(&doc_hex).map(|b| <[u8; 16]>::try_from(b.as_slice())),
            ) else {
                continue;
            };
            let Ok(doc) = doc else { continue };
            if author_hex == root {
                continue; // your own posts were never pinned
            }
            if let Err(e) = data.rebroadcasts().share(&author, &doc, None).await {
                tracing::debug!(author = %author_hex, error = ?e,
                    "a deleted reply's pin retraction failed; un-share by hand");
            }
        }
    }
    // Release the note that claimed this post. A tombstone is final for the POST's id, and the
    // recourse for a typo is delete-and-repost under a new one - but `publish` reuses whatever
    // id `published_as` names, so leaving the annotation standing made the canonical recourse
    // impossible: the draft went on reading "posted", stayed sealed, and re-posting it minted
    // versions into the buried id - a 200 that nobody would ever see (found 2026-08-13 by
    // reading, confirmed the day the take-it-down button became reachable). Cleared, the note
    // is honestly a draft again and the next publish mints the fresh id finality requires.
    if let Some(note) = data.annotations().note_claiming(&post_id).await? {
        data.annotations()
            .clear_field(&note, crate::record::store::PUBLISHED_AS)
            .await?;
    }
    // The public lane moved: `retract_vanished` reconciles every reader's journal against the
    // shelf this post has just left, and every fragment holder hears `Gone` when they next ask.
    // Through the fold lane, DRAINED: the person who pressed "take it down" reads their own
    // feed next, and the 200 must mean the journal sweep already ran.
    let generation = crate::fold::nudge(&state, &root);
    crate::fold::drain(&root, generation).await;
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

#[derive(serde::Deserialize)]
struct RebroadcastRequest {
    /// Root pubkey of the document's author, hex. Never the sharer - that is `{root}`.
    author: String,
    /// Which document of theirs, hex (16 bytes).
    doc_id: String,
    /// The version being endorsed, hex (32 bytes). Omit and this node resolves what it
    /// currently holds - which is the honest answer to "what did the sharer see", since the
    /// bytes they read were served from exactly that head. A client passing a hash it read on
    /// an earlier page load would be endorsing something staler than what it showed.
    #[serde(default)]
    version: Option<String>,
    /// Withdraw the share instead of making one. An explicit word rather than "no version",
    /// because absence now means "resolve it for me" and one field cannot mean both.
    #[serde(default)]
    retract: bool,
}

#[derive(serde::Serialize)]
struct RebroadcastItem {
    author: String,
    doc_id: String,
    /// Absent on a withdrawn share, which is why the list can be read as "what I share now".
    #[serde(skip_serializing_if = "Option::is_none")]
    version_seen: Option<String>,
    shared_at_ms: i64,
}

/// POST `/api/identity/{root}/rebroadcasts` - share one of someone else's documents, or
/// withdraw a share with `retract`.
///
/// The pointer is all this handler writes, and that has stopped meaning what it used to. The
/// **pin** - the obligation to keep a fresh copy of what the pointer points at - is not written
/// here but folded out of the chain by `rebroadcast::refresh_from` (hosted-only, on the frontier
/// move this append causes), and the copy is already in hand: resolving `version` below reads
/// `fragments`, so the ordinary path can only share a document this node already holds and can
/// already serve on the fragment ALPN. A reader no longer needs the author's chain to resolve a
/// share, which is the whole of *Pointer Plus Pinned Replica* and the reason a fourth hop exists.
/// One share, end to end: resolve the held version, append the pointer, tell the author,
/// journal to the sharer's rebroadcast-followers, knock eagerly. The rebroadcast POST's
/// core and the reply pin's (PROJECT_PLAN's Replies: a reply IS a recommendation, so a pin is this
/// exact act - one pointer kind, one semantics).
async fn share_one(
    state: &AppState,
    data: &store::Store,
    root: &str,
    author: [u8; 32],
    doc_id: [u8; 16],
    announce: bool,
) -> Result<(), AppError> {
    let version = crate::fragments::current_version(state, &author, &doc_id)
        .await
        .ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "identity.routes.this-computer-doesnt-have-that-post-2",
                "this computer doesn't have that post yet - it can't share what it hasn't read"
            ))
        })?;
    let entry = data.rebroadcasts().share(&author, &doc_id, Some(version)).await?;
    let author_hex = hex::encode(author);
    // `announce: false` is the reply's PARENT pin (PROJECT_PLAN's Replies slice 4): the COMMENT notice
    // minted beside it says everything "shared your post" would and more, so the murmur
    // stays unminted rather than arriving as the same act said twice. The share itself is
    // identical either way - only the envelope differs.
    if announce {
        match data
            .notices()
            .seal(
                &author,
                &entry,
                ringtome_proto::deliver::notice_kind::REBROADCAST,
                state.config.pow_requested_bits,
            )
            .await
        {
            Ok(envelope) => {
                if let Err(e) =
                    crate::outbox::queue(&state.node_db, root, &author_hex, &envelope).await
                {
                    tracing::warn!(author = %author_hex, error = ?e, "could not queue a share notice");
                }
            }
            Err(e) => tracing::warn!(author = %author_hex, error = ?e, "could not seal a share notice"),
        }
    }
    crate::fanout::backfill_share(state, root, &author_hex, &doc_id).await;
    // Knock NOW rather than at the next backstop beat (the eager-knock idiom). Spawned:
    // the sharer should not wait on a stranger's node to answer.
    let eager = state.clone();
    tokio::spawn(async move {
        if let Err(e) = crate::outbox::sweep(eager).await {
            tracing::debug!(error = ?e, "eager share-notice delivery failed");
        }
    });
    Ok(())
}

async fn rebroadcast_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<RebroadcastRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let author = hex_fixed::<32>(&req.author, "author root")?;
    let doc_id = hex_fixed::<16>(&req.doc_id, "doc id")?;
    if author == hex_fixed::<32>(&root, "root")? {
        return Err(AppError::BadRequest(crate::msg!(
            "identity.routes.rebroadcast-is-for-other-peoples-documents",
            "a persona rebroadcasts other people's documents; publish your own"
        )));
    }
    let data = store::open(&state, &session.account.id, &root).await?;
    let version = if req.retract {
        None
    } else {
        match req.version.as_deref() {
            Some(v) => Some(hex_fixed::<32>(v, "version hash")?),
            None => Some(crate::fragments::current_version(&state, &author, &doc_id).await.ok_or_else(|| {
                AppError::BadRequest(crate::msg!(
                    "identity.routes.this-computer-doesnt-have-that-post",
                    "this computer doesn't have that post yet - it can't share what it hasn't read"
                ))
            })?),
        }
    };
    // A settled post is not passed along (PROJECT_PLAN's Post visibility): every honest node that can see
    // the header refuses the mint with words. A node that holds nothing of the post already
    // refused above; malicious clients exist, and this door is not for them.
    if version.is_some() {
        if let Some(h) =
            held_public_header(&state, &hex::encode(author), &hex::encode(doc_id)).await?
        {
            if h.settled {
                return Err(AppError::BadRequest(crate::msg!(
                    "identity.routes.settled-no-shares",
                    "the author turned off rebroadcasts for this post"
                )));
            }
        }
    }
    let entry = data.rebroadcasts().share(&author, &doc_id, version).await?;

    // Tell the author, if there is anything to tell. A withdrawal is deliberately silent -
    // "I stopped sharing your post" is an absence, and `verify_claim` refuses to carry it.
    //
    // Queued ALWAYS when it is a real share, exactly as the follow notice is: whether the
    // author already syncs us is a fact only their node holds, and their gate discards a
    // redundant notice and answers "accepted". A sender that guesses here either misses people
    // silently or interrogates strangers about their follow lists.
    if version.is_some() {
        let author_hex = hex::encode(author);
        match data
            .notices()
            .seal(
                &author,
                &entry,
                ringtome_proto::deliver::notice_kind::REBROADCAST,
                state.config.pow_requested_bits,
            )
            .await
        {
            Ok(envelope) => {
                if let Err(e) =
                    crate::outbox::queue(&state.node_db, &root, &author_hex, &envelope).await
                {
                    tracing::warn!(author = %author_hex, error = ?e, "could not queue a share notice");
                }
            }
            Err(e) => {
                tracing::warn!(author = %author_hex, error = ?e, "could not seal a share notice")
            }
        }
    }

    // Journal it to the sharer's rebroadcast-followers now, rather than whenever the original
    // author next posts - the `backfill_follow` gesture, for shares.
    if version.is_some() {
        crate::fanout::backfill_share(&state, &root, &hex::encode(author), &doc_id).await;
        // And knock NOW rather than at the next backstop beat. The periodic outbox sweep shares
        // the body sweep's cadence - five minutes - which is the right number for "keep knocking
        // politely at machines that are mostly asleep" and the wrong one for "tell this person
        // their post was shared". The public-edge mint already does exactly this for the same
        // reason: the sweep exists for the doors that were shut, not as the normal path to an
        // open one. Spawned, because the sharer should not wait on a stranger's node to answer.
        let state = state.clone();
        tokio::spawn(async move {
            if let Err(e) = crate::outbox::sweep(state).await {
                tracing::debug!(error = ?e, "eager share-notice delivery failed");
            }
        });
    }

    Ok(Json(serde_json::json!({
        "entry_hash": hex::encode(entry.hash()),
        "retracted": version.is_none(),
    })))
}

/// GET `/api/identity/{root}/rebroadcasts` - what this persona currently shares.
///
/// Withdrawn pointers are filtered here rather than returned with a flag: the fold keeps them as
/// LWW tombstones because it must, and that is a storage concern no reader should inherit.
async fn rebroadcasts_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let items: Vec<RebroadcastItem> = data
        .rebroadcasts()
        .all()
        .await?
        .into_iter()
        .filter(|r| !r.is_retracted())
        .map(|r| RebroadcastItem {
            author: r.author_root,
            doc_id: hex::encode(r.doc_id),
            version_seen: r.version_seen.map(hex::encode),
            shared_at_ms: r.received_at_ms,
        })
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

/// GET `/api/identity/{root}/public-annotations/{author}/{doc}` - this persona's PRESENT
/// public statements about one post (ANNOTATIONS.md slice 1): their own labels on their
/// own post, or what they say about somebody else's.
async fn public_annotations_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, author, doc)): Path<(String, String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let target_doc = hex_fixed::<16>(&doc, "doc id")?;
    hex_fixed::<32>(&author, "author root")?;
    let items: Vec<serde_json::Value> = data
        .public_annotations()
        .of(&author, &target_doc)
        .await?
        .into_iter()
        .map(|r| serde_json::json!({ "key": r.key, "value": r.value, "said_ms": r.received_at_ms }))
        .collect();
    Ok(Json(serde_json::json!({ "items": items })))
}

#[derive(Deserialize)]
struct PublicAnnotationPut {
    key: String,
    value: String,
}

/// PUT - state `key = value` about the post. A tag is `key: "tag", value: "saucy"`; a
/// single-valued key is the key and its value.
async fn public_annotation_put_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, author, doc)): Path<(String, String, String)>,
    Json(req): Json<PublicAnnotationPut>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let target_author = hex_fixed::<32>(&author, "author root")?;
    let target_doc = hex_fixed::<16>(&doc, "doc id")?;
    let signed = data
        .public_annotations()
        .say(&target_author, &target_doc, req.key.trim(), req.value.trim(), true)
        .await?;
    // The 200 means the label SHOWS (Curtis, 2026-08-31: a tag on someone else's post
    // vanished on refresh): the memo every surface reads is fed by the fold lane, and
    // nothing rang it for this append - the memo waited for the frontier sweep. Drain it
    // here, the contact-dial's read-your-writes idiom.
    crate::fold::fold_now(&state, &root).await;
    // The tagged notice (ANNOTATIONS.md slice 4), to the post's author when that is
    // somebody else: the annotation entry itself is the evidence, and the recipient's gate
    // drops it when they already pull us (the derived fold speaks there). A murmur, so
    // best-effort beside the statement, and knocked eagerly like a share's.
    if author != root {
        match data
            .notices()
            .seal(
                &target_author,
                &signed,
                ringtome_proto::deliver::notice_kind::TAGGED,
                state.config.pow_requested_bits,
            )
            .await
        {
            Ok(envelope) => {
                if let Err(e) = crate::outbox::queue(&state.node_db, &root, &author, &envelope).await {
                    tracing::warn!(author = %author, error = ?e, "could not queue a tagged notice");
                }
                let eager = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = crate::outbox::sweep(eager).await {
                        tracing::debug!(error = ?e, "eager tagged-notice delivery failed");
                    }
                });
            }
            Err(e) => tracing::warn!(author = %author, error = ?e, "could not seal a tagged notice"),
        }
    }
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// DELETE - retract one statement: restate it absent, so an older copy cannot win it back.
async fn public_annotation_delete_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, author, doc, key, value)): Path<(String, String, String, String, String)>,
) -> Result<Json<PrivateWriteResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let target_author = hex_fixed::<32>(&author, "author root")?;
    let target_doc = hex_fixed::<16>(&doc, "doc id")?;
    let signed = data
        .public_annotations()
        .say(&target_author, &target_doc, &key, &value, false)
        .await?;
    crate::fold::fold_now(&state, &root).await; // the retraction shows on the same 200
    Ok(Json(PrivateWriteResponse {
        seq: signed.entry().seq,
        entry_hash: hex::encode(signed.hash()),
    }))
}

/// Caps on what publish replicates (ANNOTATIONS.md: "within reason" is counts and lengths,
/// never a category exclusion). Past the cap, the rest is skipped with a warning - the words
/// must not fail with a label.
const REPLICATED_TAGS_CAP: usize = 32;

/// Publish-time replication (ANNOTATIONS.md slice 1): every annotation the draft carries -
/// tags, every set field (description, the claimed date), and its buckets - restated as
/// public statements on this persona's chain, about the freshly minted post. Copy, don't
/// flip: the draft keeps its private facts. Best-effort beside the publish, like the pins.
///
/// A DIFF, not a dump (the publication suite's "says nothing new when nothing changed"
/// caught the first cut appending the whole set on every re-publish): only statements the
/// chain does not already make are minted, and statements the draft no longer carries are
/// retracted - so a re-publish with untouched labels grows the chain by nothing, and
/// removing a tag from the draft and posting again takes it back in public.
async fn replicate_annotations(
    data: &store::Store,
    self_root: &[u8; 32],
    draft_id: &[u8; 16],
    post_id: &[u8; 16],
) -> Result<(), AppError> {
    // Refuse, never truncate (2026-08-31): a label past its cap is skipped with a warning
    // rather than quietly shortened - the draft's word is the author's word or nothing.
    // Tags cap at 32 characters, everything else at the wire's value cap.
    let fits = |k: &str, v: &str| -> bool {
        let ok = v.len() <= ringtome_proto::PublicAnnotation::MAX_VALUE_LEN
            && (k != ringtome_proto::PublicAnnotation::TAG_KEY
                || v.chars().count() <= ringtome_proto::PublicAnnotation::MAX_TAG_CHARS);
        if !ok {
            tracing::warn!(key = %k, chars = v.chars().count(),
                "a draft label is past its cap and stays private");
        }
        ok
    };
    let mut desired: std::collections::BTreeSet<(String, String)> = Default::default();
    let tags = data.annotations().tags(draft_id).await?;
    if tags.len() > REPLICATED_TAGS_CAP {
        tracing::warn!(cap = REPLICATED_TAGS_CAP, have = tags.len(),
            "a draft carries more tags than publish replicates; the rest stay private");
    }
    for tag in tags.iter().take(REPLICATED_TAGS_CAP) {
        if !tag.trim().is_empty() && fits("tag", tag) {
            desired.insert(("tag".into(), tag.clone()));
        }
    }
    for (field, value) in data.annotations().fields(draft_id).await? {
        // `published_as` is the draft's private bookkeeping (which post it minted) - a
        // fact about the draft, not a label on the post.
        if field == store::PUBLISHED_AS
            || field == store::TRUSTED_KEY
            || value.trim().is_empty()
            || !fits(&field, &value)
        {
            continue;
        }
        desired.insert((field, value));
    }
    let buckets = bucket_map(data).await?;
    for bucket in buckets.get(&hex::encode(draft_id)).cloned().unwrap_or_default() {
        if fits("bucket", &bucket) {
            desired.insert(("bucket".into(), bucket));
        }
    }
    let stated: std::collections::BTreeSet<(String, String)> = data
        .public_annotations()
        .of(&hex::encode(self_root), post_id)
        .await?
        .into_iter()
        .map(|r| (r.key, r.value))
        .collect();
    for (k, v) in desired.difference(&stated) {
        data.public_annotations().say(self_root, post_id, k, v, true).await?;
    }
    for (k, v) in stated.difference(&desired) {
        data.public_annotations().say(self_root, post_id, k, v, false).await?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct PeersResponse {
    /// Known peer endpoint ids for this identity, liveliest first (most recently synced,
    /// never-synced last). The client's `?via=` hints come from the head of this list;
    /// serving a few extra leaves the cap (a URL-length and linkage dial, not a data one)
    /// where it belongs, in the minting code.
    peers: Vec<String>,
}

/// The identity's known peers, for minting `?via=` hints (Addressing: hints are keys, never
/// addresses, biased toward nodes recently seen alive). Session-gated like `/api/node`: only
/// this node's own users compose addresses here.
async fn peers_handler(
    _session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<PeersResponse>, AppError> {
    // Any persona this node HOSTS, not just this account's: a member minting an address for
    // someone their node serves needs that persona's entry points too, and these are
    // transport keys that serving records publish anyway. A root we don't host has no
    // honest answer here.
    if !super::is_hosted(&state.node_db, &root).await? {
        return Err(AppError::NotFound(crate::msg!("identity.routes.this-node-doesnt-host-that", "this node doesn't host that persona")));
    }
    let peers = crate::net::sync::liveliest_peers(&state.node_db, &root, 16).await?;
    Ok(Json(PeersResponse { peers }))
}

async fn keys_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<CrownResponse>, AppError> {
    super::require_owned(&state.node_db, &session.account.id, &root).await?;
    let db = state
        .user_dbs
        .held(&root)
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
    // A contact dial's 200 means the dial COUNTS (2026-08-25): the memo derives from this
    // write asynchronously (the nudged sweep), and "follow, then open your feed" raced it -
    // on a slow machine a publish could fire into a follower list that did not yet name the
    // person who just followed. Drain the fold lane before answering, for exactly the
    // memo-bearing collections; every other private register keeps the fast path.
    if collection.starts_with("contact:") || collection == "comments" {
        crate::fold::fold_now(&state, &root).await;
    }
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
#[derive(serde::Serialize)]
struct ImplicitListResponse {
    edges: Vec<crate::edgegraph::ImplicitRow>,
}

/// The persona's implicit relationships - the friend-of-friend fold, served raw so the UI
/// can explain a suggestion ("high-trust connection of X, who vouches for 400 people")
/// rather than assert a score.
async fn implicit_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<ImplicitListResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let edges = crate::edgegraph::implicit_of(data.db())
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(ImplicitListResponse { edges }))
}

#[derive(serde::Serialize)]
struct SuggestedListResponse {
    suggestions: Vec<crate::speculative::Suggested>,
}

/// The suggested shelf: friends-of-friends this reader's rollup admits AND whose chains the
/// acquisition pass has landed. `store::open` is the ownership gate, same as `implicit` -
/// the rollup composed through this reader's private dials, so only this reader reads it.
async fn suggested_list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<SuggestedListResponse>, AppError> {
    store::open(&state, &session.account.id, &root).await?;
    let suggestions = crate::speculative::suggested_for(&state.node_db, &root)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(SuggestedListResponse { suggestions }))
}

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
        .ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.bad-what-expected-hex-chars", "bad {what} (expected {chars} hex chars)", what = what, chars = N * 2)))
}

/// Parse the wire `format` string ("plaintext" | "marquee"), defaulting to plaintext when absent.
fn parse_format(s: &Option<String>) -> Result<crate::record::documents::Format, AppError> {
    match s {
        None => Ok(crate::record::documents::Format::Plaintext),
        Some(s) => crate::record::documents::Format::parse(s).ok_or_else(|| {
            AppError::BadRequest(crate::msg!("identity.routes.unknown-format-s-plaintext-marquee", "unknown format {s:?} (plaintext | marquee)", s = s))
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
            refs: Vec::new(), // derived in Store::save, never client-asserted
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
///
/// **It does NOT touch anything published** (settled 2026-08-11). A note and its post are two
/// documents - publishing MINTS a public artifact beside the note rather than flipping the note
/// public (Copy, Don't Flip), and the note only remembers which post is its own through the
/// `published_as` annotation. Deleting the note is housekeeping in your own drawer; recalling
/// something you published is a separate, public act with its own gesture
/// (`unpublish_handler`), because it changes what other people can see.
///
/// The first cut of the tombstone work coupled them - delete the note, retract the post - and it
/// was wrong twice: as doctrine, because a crossing of the membrane must be a deliberate act
/// rather than a side effect; and in fact, because it asked `is_public` about the NOTE's id,
/// which is never on the public shelf, so the retraction it promised never fired for anybody.
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
        .map_err(|e| AppError::BadRequest(crate::msg!("identity.routes.bad-multipart-body-e", "bad multipart body: {e}", e = e)))?
    {
        let name = field.name().unwrap_or("").to_string();
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(crate::msg!("identity.routes.bad-multipart-part-name-e", "bad multipart part {name:?}: {e}", name = name, e = e)))?;
        match name.as_str() {
            "video" => video = Some(bytes),
            "audio" => audio = Some(bytes),
            _ => {} // unknown parts are ignored, not fatal
        }
    }
    let video = video.ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.missing-video-part", "missing `video` part")))?;
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

#[derive(Serialize)]
struct AvatarResponse {
    doc_id: String,
}

/// Set the persona's avatar: multipart part `image`, crushed inline (the image lane is
/// quick - no queue ceremony for a thumbnail-sized public act), stored as a BORN-PUBLIC
/// media document on the POSTS lane, and pointed at by the profile's `avatar` field (a
/// register holds the pointer; the document holds the file - each doing its own job). The
/// upload IS the deliberate public act; there is no draft to cross a membrane from.
async fn set_avatar_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    mut parts: axum::extract::Multipart,
) -> Result<Json<AvatarResponse>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let mut image: Option<Bytes> = None;
    while let Some(field) = parts
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(crate::msg!("identity.routes.bad-multipart-body-e-2", "bad multipart body: {e}", e = e)))?
    {
        if field.name().unwrap_or("") == "image" {
            image = Some(field.bytes().await.map_err(|e| {
                AppError::BadRequest(crate::msg!("identity.routes.bad-multipart-part-image-e", "bad multipart part `image`: {e}", e = e))
            })?);
        }
    }
    let image = image.ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.missing-image-part", "missing `image` part")))?;

    // The same laundering every upload gets - decode, re-encode, never trust the bytes.
    let bytes = image.to_vec();
    let ingested = tokio::task::spawn_blocking(move || {
        crate::media::crush_with_progress(&bytes, &|_| {})
    })
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("avatar crush task: {e}")))?
    .map_err(|e| AppError::BadRequest(crate::msg!("identity.routes.that-doesnt-work-as-an", "that doesn't work as an avatar: {e}", e = e)))?;
    if !matches!(
        ingested.format,
        crate::record::documents::Format::Avif | crate::record::documents::Format::Apng
    ) {
        return Err(AppError::BadRequest(crate::msg!("identity.routes.an-avatar-should-be-a", "an avatar should be a picture - a still image or a small animation")));
    }

    let db = state.user_dbs.held(&root).await.map_err(AppError::Internal)?;
    let signer = super::load_signing_key(&state.node_db, &state.keystore, &session.account.id, &root)
        .await?;
    let doc_id =
        crate::record::documents::save_public_media(&db, &signer, &state.files, "avatar", ingested, None)
            .await?;
    data.profile().set("avatar", &hex::encode(doc_id)).await?;
    Ok(Json(AvatarResponse {
        doc_id: hex::encode(doc_id),
    }))
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
        crate::ingest::jobs_for_account(&state.node_db, &state.ingest, &session.account.id.to_string())
            .await?;
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
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-has-no-readable-head", "document has no readable head")))?;
    let format = crate::record::documents::Format::from_wire(head.header.format);
    let bytes = data
        .documents()
        .body(head)
        .await?
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.body-not-on-this-node", "body not on this node yet")))?;
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
        Some((status, error)) if status == "failed" => Err(AppError::Unprocessable(match error {
            // The tombstone passes through VERBATIM - it is already a whole sentence written for
            // the reader (ingest.rs), and this endpoint's contract is that its message IS the
            // queue's `error`, pinned by integration/test/docs.cjs. Hence a message that is
            // nothing but its hole: framing it ("upload could not be processed: {reason}") reads
            // as a stutter in front of a sentence that already explains itself, and breaks that
            // equality. The words themselves are not translatable from here; they are stored
            // prose, and making stored prose translatable is a data-format question.
            Some(reason) => crate::msg!("identity.routes.upload-tombstone", "{reason}", reason = reason),
            None => crate::msg!(
                "identity.routes.upload-could-not-be-processed",
                "upload could not be processed"
            ),
        })),
        // A 'done' job always has its version (so it's in the view above, not here); anything else,
        // or no job at all, is genuinely not found.
        _ => Err(AppError::NotFound(crate::msg!("identity.routes.document-not-found", "document not found"))),
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
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-not-found-2", "document not found")))?;
    let head = doc
        .display_head()
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-has-no-readable-head-2", "document has no readable head")))?;
    let thumb_hash = head
        .header
        .thumb_hash
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-has-no-thumbnail", "document has no thumbnail")))?;
    let bytes = data
        .documents()
        .blob(thumb_hash)
        .await?
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.thumbnail-not-on-this-node", "thumbnail not on this node yet")))?;
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
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-not-found-3", "document not found")))?;
    let head = doc
        .display_head()
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-has-no-readable-head-3", "document has no readable head")))?;
    let preview_hash = head
        .header
        .preview_hash
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-has-no-preview-clip", "document has no preview clip")))?;
    let bytes = data
        .documents()
        .blob(preview_hash)
        .await?
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.preview-not-on-this-node", "preview not on this node yet")))?;
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
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-not-found-4", "document not found")))?;

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
            return Err(AppError::BadRequest(crate::msg!("identity.routes.unknown-order-other-modified-created", "unknown order {other:?} (modified | created)", other = other)));
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
            return Err(AppError::BadRequest(crate::msg!("identity.routes.unknown-order-other-modified-created-2", "unknown order {other:?} (modified | created)", other = other)));
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
        .ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.bad-root-pubkey", "bad root pubkey")))?;

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
            .ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.bad-member-root-pubkey", "bad member root pubkey")))?,
        None => crate::pubkey::decode(&root)
            .ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.bad-root-pubkey-2", "bad root pubkey")))?,
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
            .ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.bad-member-root-pubkey-2", "bad member root pubkey")))?,
        None => crate::pubkey::decode(&root)
            .ok_or_else(|| AppError::BadRequest(crate::msg!("identity.routes.bad-root-pubkey-3", "bad root pubkey")))?,
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
        .ok_or_else(|| AppError::NotFound(crate::msg!("identity.routes.document-not-found-5", "document not found")))?;
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

/// One streamed payload. `snapshot` tells the browser to clear-and-replace every kind (its
/// cursor was absent or doubtful); `update` refreshes only the kinds whose chains moved (the
/// per-kind stamps below) - an absent kind means "unchanged", never "empty"; `live` is "your
/// cursor still holds, nothing to send".
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
    contacts: Option<Vec<ContactRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    buckets: Option<Vec<BucketRow>>,
    /// Update-path deltas for the keyed kinds (contacts by root; docs and search by doc_id):
    /// the tables that grow with popularity or account lifetime ship changed-or-new rows and
    /// removed keys instead of themselves, and the client upserts/deletes WITHOUT clearing.
    /// A snapshot always carries the whole kind instead - as does the first movement of a
    /// kind after a "live" reconnect, because a fresh socket has no diff baseline and a
    /// whole-kind refresh is the one shape that carries removals without one.
    #[serde(skip_serializing_if = "Option::is_none")]
    contacts_changed: Option<Vec<ContactRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    contacts_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    docs_changed: Option<Vec<DocSummary>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    docs_removed: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_changed: Option<Vec<crate::record::documents::SearchRow>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_removed: Option<Vec<String>>,
    /// The bell's unread count (2026-08-28, the dock badge) - sent on every snapshot and
    /// whenever it changes, alone on a `live` frame when nothing else did. Not a view of
    /// the user db like the kinds above: derived rows live in node.db, so the fold nudges
    /// the stream when it writes them, and the loop recounts on every wake.
    #[serde(skip_serializing_if = "Option::is_none")]
    unread: Option<u64>,
}

impl StreamMessage {
    /// A payload carrying nothing but the verdict and the cursor.
    fn quiet(kind: &'static str, cursor: String) -> Self {
        StreamMessage {
            kind,
            cursor,
            profile: None,
            docs: None,
            taxonomies: None,
            search: None,
            contacts: None,
            buckets: None,
            contacts_changed: None,
            contacts_removed: None,
            docs_changed: None,
            docs_removed: None,
            search_changed: None,
            search_removed: None,
            unread: None,
        }
    }
}

/// The stream's change detector, split BY KIND: one frontier read (resync's fingerprint -
/// sorted `(author, service, floor, head)` rows, plus the view epoch for changes frontiers
/// can't see, like a body arriving by backfill) feeds four group stamps, so an update
/// regathers only the kinds whose chains actually moved. A contact dial no longer re-runs
/// the search indexer; a note save no longer re-serializes the roster. The public cursor
/// token hashes all four, so its equality semantics are exactly the old single cursor's.
#[derive(Clone, PartialEq)]
struct StreamStamp {
    profile: [u8; 32],
    /// docs + search: the two wire kinds that move together (versions, annotations, bodies).
    documents: [u8; 32],
    /// taxonomies + buckets: the doc-meta organizers.
    organizers: [u8; 32],
    contacts: [u8; 32],
}

impl StreamStamp {
    fn token(&self) -> String {
        let mut hasher = blake3::Hasher::new();
        for part in [
            &self.profile,
            &self.documents,
            &self.organizers,
            &self.contacts,
        ] {
            hasher.update(part);
        }
        hasher.finalize().to_hex().to_string()
    }
}

async fn stream_stamp(db: &crate::db::Db, view_epoch: u64) -> Result<StreamStamp, AppError> {
    use ringtome_proto::registry::service;
    let mut frontiers = crate::net::sync::local_frontiers(db, true)
        .await
        .map_err(AppError::Internal)?;
    frontiers.sort_by_key(|f| (f.author, f.service));
    // Which groups one service's movement can influence - CONSERVATIVE by construction:
    // identity chains and unknown services touch everything (a key-epoch entry can unlock
    // private folds anywhere), because a wrong "nothing" is a stale mirror while a wrong
    // "everything" is one extra gather.
    let mut parts: [Vec<u8>; 4] = Default::default(); // profile, documents, organizers, contacts
    for f in &frontiers {
        let touched: &[usize] = match f.service {
            service::PROFILE_PUBLIC => &[0],
            service::POSTS | service::DOCUMENTS_PRIVATE => &[1],
            service::DOC_META_PRIVATE => &[1, 2],
            service::GENERAL_PRIVATE => &[3],
            // A published edge moves no group. It is an ECHO of a ledger write that already
            // fired its own contacts update, and nothing the stream ships is derived from it -
            // so counting it would emit a second update carrying an empty delta. (It shared
            // the contacts group until 2026-08-09, harmlessly, because the follows-public
            // chain had no writers; public-by-default gave it some and the spurious update
            // appeared immediately, as a live-cache test failure.)
            service::FOLLOWS_PUBLIC => &[],
            // Inbox notices likewise: the bell polls its own endpoint, and no streamed view
            // reads them. Named explicitly so they do not fall to the catch-all below and
            // spuriously invalidate documents and the profile on every delivery.
            service::INBOX_TRUSTED | service::INBOX_STRANGER => &[],
            _ => &[0, 1, 2, 3],
        };
        for &i in touched {
            parts[i].extend_from_slice(&f.author);
            parts[i].extend_from_slice(&f.service.to_be_bytes());
            parts[i].extend_from_slice(&f.floor.to_be_bytes());
            parts[i].extend_from_slice(&f.head.to_be_bytes());
        }
    }
    parts[1].extend_from_slice(&view_epoch.to_be_bytes());
    let stamp = |i: usize| *blake3::hash(&parts[i]).as_bytes();
    Ok(StreamStamp {
        profile: stamp(0),
        documents: stamp(1),
        organizers: stamp(2),
        contacts: stamp(3),
    })
}

#[derive(Serialize)]
struct ContactRow {
    /// The other persona's root, hex - the row key, and what /id/<root> opens.
    root: String,
    /// The persona's SELF-CONFIGURED display name, joined from their own profile when this
    /// node happens to hold it (hosted, or foreign-fetched) - absent otherwise, honestly.
    /// One of the three names a person wears (self-name / your nickname / the speakable
    /// words); the nickname rides `facts` like every other private judgment.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    /// Their avatar's public doc_id, same join, same honesty.
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar: Option<String>,
    /// The ledger's facts for them, as written (trust, interest, interest_rebroadcasts,
    /// edges_public, blocked, nickname - and whatever future dials add).
    facts: std::collections::BTreeMap<String, String>,
}

// The self-claims join used to live here as `contact_self_claims`, opening each contact's
// database per gather - every stream snapshot re-opened every contact's encrypted file to
// re-learn a name that almost never changes. The byline cache (src/profiles.rs) is that join
// materialized at node level, refreshed on the frontier map's edge; the roster now reads one
// table for the whole list.

/// Which stamp groups moved - the gather below reads only these.
struct Moved {
    profile: bool,
    documents: bool,
    organizers: bool,
    contacts: bool,
}

impl Moved {
    fn all() -> Self {
        Moved {
            profile: true,
            documents: true,
            organizers: true,
            contacts: true,
        }
    }

    fn since(prev: &StreamStamp, now: &StreamStamp) -> Self {
        Moved {
            profile: prev.profile != now.profile,
            documents: prev.documents != now.documents,
            organizers: prev.organizers != now.organizers,
            contacts: prev.contacts != now.contacts,
        }
    }
}

/// The roster as the stream ships it.
async fn contact_rows(
    state: &AppState,
    data: &store::Store,
) -> Result<Vec<ContactRow>, AppError> {
    let ledger = data.contacts().await?;
    let roots: Vec<String> = ledger.iter().map(|(root, _)| root.clone()).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &roots)
        .await
        .unwrap_or_default();
    Ok(ledger
        .into_iter()
        .map(|(root, facts)| {
            let byline = bylines.get(&root).cloned().unwrap_or_default();
            ContactRow {
                root,
                name: byline.name,
                avatar: byline.avatar,
                facts,
            }
        })
        .collect())
}

/// This socket's diff baselines for the keyed kinds: per row, a FINGERPRINT of what was last
/// shipped, never the row itself - search token bags are the stream's biggest rows, and the
/// socket must not hold a second copy of the store. `None` means unprimed (a fresh socket, or
/// a snapshot forcing whole): the kind's next movement ships whole and primes the baseline,
/// which is also what makes removals sound across a "live" reconnect - a whole-kind refresh
/// is the one shape that carries removals without a baseline to diff against.
#[derive(Default)]
struct Baselines {
    contacts: Option<std::collections::BTreeMap<String, [u8; 32]>>,
    docs: Option<std::collections::BTreeMap<String, [u8; 32]>>,
    search: Option<std::collections::BTreeMap<String, [u8; 32]>>,
}

/// What one keyed kind ships this frame: itself, or its diff.
enum KindShip<T> {
    Whole(Vec<T>),
    Delta { changed: Vec<T>, removed: Vec<String> },
}

/// Diff one keyed kind against the socket's baseline fingerprints and advance them. An
/// unprimed baseline ships whole; a primed one ships changed-or-new rows (fingerprint moved)
/// plus removed keys. A stamp that moved without visible change (a seen mark riding the same
/// service as the roster) diffs to an empty delta, and the caller ships nothing - the diff
/// is the filter the fingerprint is too coarse to be.
fn ship_kind<T: Serialize>(
    baseline: &mut Option<std::collections::BTreeMap<String, [u8; 32]>>,
    rows: Vec<T>,
    key_of: impl Fn(&T) -> String,
) -> Result<KindShip<T>, AppError> {
    let mut next = std::collections::BTreeMap::new();
    let mut keyed: Vec<(String, [u8; 32], T)> = Vec::with_capacity(rows.len());
    for row in rows {
        let bytes = serde_json::to_vec(&row)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("fingerprinting a stream row: {e}")))?;
        let hash = *blake3::hash(&bytes).as_bytes();
        let key = key_of(&row);
        next.insert(key.clone(), hash);
        keyed.push((key, hash, row));
    }
    let ship = match baseline.take() {
        None => KindShip::Whole(keyed.into_iter().map(|(_, _, row)| row).collect()),
        Some(prev) => {
            let removed: Vec<String> = prev
                .keys()
                .filter(|key| !next.contains_key(*key))
                .cloned()
                .collect();
            let changed: Vec<T> = keyed
                .into_iter()
                .filter(|(key, hash, _)| prev.get(key) != Some(hash))
                .map(|(_, _, row)| row)
                .collect();
            KindShip::Delta { changed, removed }
        }
    };
    *baseline = Some(next);
    Ok(ship)
}

/// Gather the moved kinds into one payload. `baselines` is this socket's memory of what it
/// last shipped (fingerprints, per row) for the kinds big enough to earn diffs - the roster
/// scales with popularity, docs and search with account lifetime, and re-shipping either
/// whole because one row moved was most of the stream's byte bill.
async fn gather(
    state: &AppState,
    data: &store::Store,
    kind: &'static str,
    cursor: String,
    moved: Moved,
    baselines: &mut Baselines,
) -> Result<StreamMessage, AppError> {
    let mut msg = StreamMessage::quiet(kind, cursor);
    if kind == "snapshot" {
        // A snapshot is clear-and-replace on the client, so every kind ships whole and the
        // baselines re-prime from what it carried.
        *baselines = Baselines::default();
    }
    if moved.profile {
        msg.profile = Some(data.profile().all().await?);
    }
    if moved.documents {
        let (rows, _undecryptable) = data.documents().summaries().await?;
        let annots = annotation_map(data).await?;
        let buckets = bucket_map(data).await?;
        let pinned = data.documents().pinned().await?;
        let docs: Vec<DocSummary> = rows
            .into_iter()
            .map(|r| summarize(r, &annots, &buckets, &pinned))
            .collect();
        match ship_kind(&mut baselines.docs, docs, |d| d.doc_id.clone())? {
            KindShip::Whole(rows) => msg.docs = Some(rows),
            KindShip::Delta { changed, removed } => {
                msg.docs_changed = (!changed.is_empty()).then_some(changed);
                msg.docs_removed = (!removed.is_empty()).then_some(removed);
            }
        }
        let search = data.documents().search_rows().await?;
        match ship_kind(&mut baselines.search, search, |s| s.doc_id.clone())? {
            KindShip::Whole(rows) => msg.search = Some(rows),
            KindShip::Delta { changed, removed } => {
                msg.search_changed = (!changed.is_empty()).then_some(changed);
                msg.search_removed = (!removed.is_empty()).then_some(removed);
            }
        }
    }
    if moved.organizers {
        msg.taxonomies = Some(
            data.taxonomies()
                .all()
                .await?
                .into_iter()
                .map(|t| TaxonomyRow {
                    taxonomy_id: hex::encode(t.taxonomy_id),
                    title: t.title,
                    members: t.members,
                })
                .collect(),
        );
        msg.buckets = Some(
            data.buckets()
                .roster()
                .await?
                .into_iter()
                .map(|b| BucketRow {
                    name: b.name,
                    app: b.app,
                    members: b.members,
                })
                .collect(),
        );
    }
    if moved.contacts {
        let rows = contact_rows(state, data).await?;
        match ship_kind(&mut baselines.contacts, rows, |c| c.root.clone())? {
            KindShip::Whole(rows) => msg.contacts = Some(rows),
            KindShip::Delta { changed, removed } => {
                msg.contacts_changed = (!changed.is_empty()).then_some(changed);
                msg.contacts_removed = (!removed.is_empty()).then_some(removed);
            }
        }
    }
    Ok(msg)
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
        .held(&root)
        .await
        .map_err(|e| anyhow::anyhow!("opening db for stream: {e}"))?;

    let mut stamp = stream_stamp(&db, state.view_epochs.get(&root))
        .await
        .map_err(anyhow::Error::new)?;
    // This socket's per-row fingerprints of what it last shipped, per keyed kind. Fresh
    // sockets start unprimed on purpose - a kind's first movement ships whole (see
    // `Baselines`), which is what keeps removals sound across a "live" reconnect without
    // the connect paying a priming read.
    let mut baselines = Baselines::default();

    // First word: live if the client's cursor still holds, a full snapshot on any doubt.
    let mut first = if client_cursor.as_deref() == Some(stamp.token().as_str()) {
        StreamMessage::quiet("live", stamp.token())
    } else {
        gather(
            &state,
            &data,
            "snapshot",
            stamp.token(),
            Moved::all(),
            &mut baselines,
        )
        .await
        .map_err(anyhow::Error::new)?
    };
    // The badge's number rides the first frame whatever its kind: a reconnect whose
    // cursor still holds has no snapshot, but its badge may be stale.
    let mut last_unread = unread_count(&state, &data, &root)
        .await
        .map_err(anyhow::Error::new)?;
    first.unread = Some(last_unread);
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
    // The tick's stat-guard (the sweeps' idiom): a quiet persona's tick is two syscalls, not
    // a stamp over the whole entries table - per second, per open socket, that was most of
    // the stream's idle cost. Recorded BEFORE stamping, so a write landing mid-stamp moves
    // mtime past the guard and the next tick re-runs one round instead of skipping a change.
    let mut guard: Option<(Option<i64>, u64)> = None;
    loop {
        tokio::select! {
            _ = tick.tick() => {
                let now_guard = (state.user_dbs.db_mtime_ms(&root), state.view_epochs.get(&root));
                if guard == Some(now_guard) { continue; }
                guard = Some(now_guard);
            }
            // Only OUR identity's writes. The nudge names who wrote, so a node carrying many
            // personas no longer wakes every open stream whenever anyone anywhere saves; a
            // lagged nudge (None) still wakes us, because a receiver that missed pings cannot
            // rule itself out. A nudge always re-stamps (guard cleared): it is the write's
            // own announcement, and the guard exists only to spare quiet ticks.
            who = crate::db::await_write_nudge(&mut nudge) => {
                if who.is_some_and(|w| w != root) { continue; }
                guard = None;
            }
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
        // Reached after a guarded tick or a nudge: re-stamp, and push only what moved.
        let now = stream_stamp(&db, state.view_epochs.get(&root))
            .await
            .map_err(anyhow::Error::new)?;
        // The badge recounts on every wake - the derived fold's nudge is a wake with no
        // stamp change behind it, and the watermark write is a wake with one.
        let unread = unread_count(&state, &data, &root)
            .await
            .map_err(anyhow::Error::new)?;
        let unread_changed = unread != last_unread;
        last_unread = unread;
        if now != stamp {
            let moved = Moved::since(&stamp, &now);
            stamp = now;
            let mut update = gather(&state, &data, "update", stamp.token(), moved, &mut baselines)
                .await
                .map_err(anyhow::Error::new)?;
            if unread_changed {
                update.unread = Some(unread);
            }
            socket
                .send(Message::Text(serde_json::to_string(&update)?.into()))
                .await?;
        } else if unread_changed {
            let mut quiet = StreamMessage::quiet("live", stamp.token());
            quiet.unread = Some(unread);
            socket
                .send(Message::Text(serde_json::to_string(&quiet)?.into()))
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
                trusted_only: false,
                settled: false,
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
                refs: Vec::new(),
                genesis_ms: None,
                reply_to: None,
                thread_root: None,
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

#[cfg(test)]
mod notification_dedup_tests {
    use super::*;

    fn derived(author: &str, kind: &str) -> NotificationItem {
        NotificationItem {
            author: author.to_string(),
            kind: kind.to_string(),
            doc_id: String::new(),
            doc_title: None,
            doc_published_ms: None,
            claimed_name: None,
            trust: None,
            interest: None,
            detail: None,
            updated_ms: 1,
            seen: false,
            stranger: false,
            author_name: None,
            author_avatar: None,
        }
    }

    fn arrived(sender: &str, kind: &str) -> crate::inbox::Notice {
        crate::inbox::Notice {
            sender_root: sender.to_string(),
            kind: kind.to_string(),
            trust: None,
            interest: None,
            doc_id: None,
            detail: None,
            timestamp_ms: 1,
            display_name: None,
            service: ringtome_proto::registry::service::INBOX_STRANGER,
        }
    }

    #[test]
    fn a_fact_the_fold_already_derived_is_not_shown_twice() {
        let derived_rows = vec![derived("aaa", "public-edge")];
        let kept = undelivered_twice(&derived_rows, vec![arrived("aaa", "public-edge")]);
        assert!(kept.is_empty(), "the same fact from both paths renders once");
    }

    #[test]
    fn dedup_is_per_fact_not_per_person() {
        let derived_rows = vec![derived("aaa", "public-edge")];
        let kept = undelivered_twice(
            &derived_rows,
            vec![arrived("aaa", "some-other-kind"), arrived("bbb", "public-edge")],
        );
        assert_eq!(
            kept.len(),
            2,
            "a different kind from the same sender, and the same kind from a different sender, \
             are both facts the fold did not derive"
        );
    }

    /// The dedup above matches on a string that two modules declare independently - the fold's
    /// own constant and the wire kind's name. They agree today, and if they ever stop the
    /// symptom is not a crash but the exact bug this fixes, quietly back. So: pin them equal.
    #[test]
    fn both_paths_spell_the_same_fact_the_same_way() {
        use ringtome_proto::deliver::notice_kind;
        for (derived, delivered) in [
            (crate::notifications::KIND_PUBLIC_EDGE, notice_kind::PUBLIC_EDGE),
            (crate::notifications::KIND_REBROADCAST, notice_kind::REBROADCAST),
        ] {
            assert_eq!(
                derived,
                notice_kind::name(delivered),
                "the derived fold and the delivered envelope must name this fact identically, \
                 or the notification dedup silently stops matching"
            );
        }
    }
}
