//! DANGEROUS test-only endpoints, mounted ONLY when `config.local_test` is set.
//!
//! These exist so the black-box integration suite can inspect and manipulate node state directly
//! (e.g. read the `boot_timestamps` table, reset state between tests) without us having to expose
//! that surface through the real API. The raw SQL passthrough here is a total security hole by
//! design - it must never be reachable on any node that is not a developer's local test target.
//! `/test/unplug` is the other dangerous one: it makes a node refuse its peers while looking
//! perfectly healthy over HTTP, which is a partition simulator in a test rig and a silent outage
//! anywhere else. It carries a second lock for that reason ([`crate::net::p2p::Unplugged`]).
//!
//! Safety posture: the route is not even registered unless local-test mode is on, so on a normal
//! node the path simply does not exist (404), rather than existing-but-forbidden. There is no code
//! path from the router to the SQL executor unless the node was deliberately armed.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct SqlRequest {
    pub sql: String,
}

#[derive(Serialize)]
pub struct SqlResponse {
    /// Rows returned, each a map of column name to JSON value. Empty for non-SELECT statements.
    pub rows: Vec<serde_json::Map<String, Value>>,
    /// Rows affected (for INSERT/UPDATE/DELETE); null for queries that return rows.
    pub rows_affected: Option<u64>,
}

/// Execute arbitrary SQL against the node database and return the results as JSON.
///
/// Tries the statement as a row-returning query first; if it returns no rows we cannot tell a
/// zero-row SELECT from a mutation, so we always report both `rows` and `rows_affected` and let the
/// caller use whichever is meaningful.
pub async fn raw_sql(
    State(state): State<AppState>,
    Json(req): Json<SqlRequest>,
) -> Result<Json<SqlResponse>, AppError> {
    tracing::warn!(sql = %req.sql, "LOCAL_TEST raw SQL passthrough");

    let (column_names, raw) = state
        .node_db
        .query_drained(&req.sql, ())
        .await
        .map_err(|e| AppError::BadRequest(crate::msg!("test_endpoints.sql-error-e", "sql error: {e}", e = e)))?;
    let rows: Vec<serde_json::Map<String, Value>> = raw
        .into_iter()
        .map(|values| row_to_json(&values, &column_names))
        .collect();

    Ok(Json(SqlResponse {
        rows,
        rows_affected: None,
    }))
}

#[derive(Serialize)]
pub struct ResolveServingResponse {
    pub found: bool,
    /// Fields of the resolved record, hex-encoded; absent when `found` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_key: Option<String>,
    /// The serving node's iroh endpoint id, in iroh's own string form (comparable with
    /// `/api/node`'s `endpoint_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

/// Resolve a serving record through this node's directory (the same path a stranger node would
/// take). The mainline field test uses this to prove records published by one node come back
/// out of the real DHT through another node's client; `resolve_serving` has no production
/// caller yet, so without this route the resolve half of the directory is unreachable from
/// outside.
pub async fn resolve_serving(
    State(state): State<AppState>,
    Path(leaf_hex): Path<String>,
) -> Result<Json<ResolveServingResponse>, AppError> {
    let leaf = crate::pubkey::require(&leaf_hex, "leaf pubkey")?;
    let resolved = state
        .directory
        .resolve_serving(&leaf)
        .await
        .map_err(AppError::Internal)?;
    let Some(signed) = resolved else {
        return Ok(Json(ResolveServingResponse {
            found: false,
            root: None,
            node_key: None,
            endpoint_id: None,
            timestamp_ms: None,
        }));
    };
    let record = signed.record();
    let endpoint_id = iroh::PublicKey::from_bytes(&record.endpoint_id)
        .map(|k| k.to_string())
        .unwrap_or_else(|_| hex::encode(record.endpoint_id));
    Ok(Json(ResolveServingResponse {
        found: true,
        root: Some(hex::encode(record.root)),
        node_key: Some(hex::encode(record.node_key)),
        endpoint_id: Some(endpoint_id),
        timestamp_ms: Some(record.timestamp_ms),
    }))
}

// ---------------------------------------------------------------------------------------------
// The transport gate: /test/unplug.
//
// Simulating a partition without killing a process. The rig's four nodes are shared by the whole
// suite, so a spec that wants "these two are unreachable" cannot stop them. [`crate::net::p2p`]'s
// `Unplugged` carries the design argument and the safety posture; this is its door.

#[derive(Deserialize, Default)]
pub struct UnplugRequest {
    /// House ALPN names to refuse (`sync`, `blob`, `adopt`, `deliver`, `fragment`). Omitted or
    /// null means ALL of them, which is what "unplug this node" ordinarily means.
    #[serde(default)]
    pub alpns: Option<Vec<String>>,
    /// `both` (the default), `inbound`, or `outbound`. One-directional is an ASYMMETRIC partition -
    /// a real and interesting thing to test, and a confusing default, so it must be asked for.
    #[serde(default)]
    pub direction: Option<String>,
}

/// What the node is refusing now - the answer to every call here, so a test can assert the gate
/// rather than trust it, and a human can ask a rig some spec left unplugged what is wrong with it.
#[derive(Serialize)]
pub struct UnplugResponse {
    pub inbound: Vec<String>,
    pub outbound: Vec<String>,
}

impl From<crate::net::p2p::Refusals> for UnplugResponse {
    fn from(refusals: crate::net::p2p::Refusals) -> Self {
        Self {
            inbound: refusals.inbound.iter().map(|n| n.to_string()).collect(),
            outbound: refusals.outbound.iter().map(|n| n.to_string()).collect(),
        }
    }
}

/// Refuse connections on the named ALPNs (default: all of them) in the named direction (default:
/// both). **Replaces** the previous refusal set rather than adding to it.
///
/// An unknown ALPN name or direction is a 400 rather than a no-op: a typo that silently refused
/// nothing would produce a test that passes while proving nothing, which is worse than a red one.
pub async fn unplug(
    State(state): State<AppState>,
    body: Option<Json<UnplugRequest>>,
) -> Result<Json<UnplugResponse>, AppError> {
    let req = body.map(|Json(req)| req).unwrap_or_default();

    let names: Vec<&'static str> = match req.alpns {
        None => crate::net::p2p::ALPNS
            .iter()
            .map(|(name, _)| *name)
            .collect(),
        Some(asked) => {
            let mut resolved = Vec::with_capacity(asked.len());
            for name in &asked {
                let known = crate::net::p2p::alpn_named(name).ok_or_else(|| {
                    AppError::BadRequest(crate::msg!(
                        "test_endpoints.unplug-unknown-alpn",
                        "no such protocol {name}; this node speaks {known}",
                        name = name,
                        known = crate::net::p2p::ALPNS
                            .iter()
                            .map(|(house, _)| *house)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?;
                resolved.push(known);
            }
            resolved
        }
    };

    let direction = req.direction.as_deref().unwrap_or("both");
    let (gate_inbound, gate_outbound) = match direction {
        "both" => (true, true),
        "inbound" => (true, false),
        "outbound" => (false, true),
        other => {
            return Err(AppError::BadRequest(crate::msg!(
                "test_endpoints.unplug-bad-direction",
                "no such direction {other}; use both, inbound or outbound",
                other = other
            )))
        }
    };

    let refusals = crate::net::p2p::Refusals {
        inbound: if gate_inbound {
            names.iter().copied().collect()
        } else {
            Default::default()
        },
        outbound: if gate_outbound {
            names.iter().copied().collect()
        } else {
            Default::default()
        },
    };
    tracing::warn!(
        inbound = ?refusals.inbound,
        outbound = ?refusals.outbound,
        "LOCAL_TEST transport gate armed"
    );
    state
        .unplugged
        .arm(&state.config, refusals)
        .map_err(AppError::Internal)?;
    Ok(Json(state.unplugged.refusals().into()))
}

/// Plug the node back in: refuse nothing. Idempotent, and safe to call on a node that was never
/// unplugged - which is what lets the suite's root hook fire it without asking first.
pub async fn plug_in(State(state): State<AppState>) -> Result<Json<UnplugResponse>, AppError> {
    state
        .unplugged
        .arm(&state.config, Default::default())
        .map_err(AppError::Internal)?;
    Ok(Json(state.unplugged.refusals().into()))
}

/// Read the gate without touching it.
pub async fn unplug_state(State(state): State<AppState>) -> Json<UnplugResponse> {
    Json(state.unplugged.refusals().into())
}

/// Run one peer-derive pass on demand (`net::sync::derive_peers`). The derive beat is
/// recovery-paced (minutes), and its lag behind a revocation is the strike's DELIVERY window,
/// not slack - so a probe that wants to watch revocation reach routing must ring this beat
/// itself: shortening the beat globally races every strike test's own choreography (the
/// prune lands mid-test and the struck peer vanishes before the strike is delivered).
pub async fn derive_pass(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    crate::net::sync::derive_peers(state)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "derived": true })))
}

/// Ring one reap on demand (`fragments::reap` - the death-cursor pass). The `derive_pass`
/// idiom, for the same reason: the reap rides the sweep beat, and a test proving "the batch
/// carried this, not the queue" needs to ring exactly one batch at a chosen moment rather than
/// race a cadence.
pub async fn reap_pass(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    crate::fragments::reap(&state)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "reaped": true })))
}

#[derive(Deserialize)]
pub struct EditWindowRequest {
    /// Milliseconds; 0 restores the boot default.
    pub ms: i64,
}

/// Override the edit window at runtime - the `/test/revalidation` idiom, for the same reason:
/// a suite cannot wait a day to watch a post freeze, and a boot-wide tiny window would freeze
/// every OTHER test's posts mid-flight.
pub async fn edit_window(Json(req): Json<EditWindowRequest>) -> Result<Json<Value>, AppError> {
    crate::record::documents::EDIT_WINDOW_OVERRIDE
        .store(req.ms.max(0), std::sync::atomic::Ordering::Relaxed);
    tracing::warn!(ms = req.ms, "LOCAL_TEST edit window override");
    Ok(Json(serde_json::json!({ "ms": req.ms })))
}

/// Does the blob store hold these bytes right now? The reaper's observability: a takedown's
/// serving stops when the fragment dies, and THIS is how a test watches the bytes themselves
/// go on the next GC round.
pub async fn blob_present(
    State(state): State<AppState>,
    axum::extract::Path(hash_hex): axum::extract::Path<String>,
) -> Result<Json<Value>, AppError> {
    let bytes = hex::decode(&hash_hex)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
        .ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "test.endpoints.not-a-blob-hash",
                "not a blob hash: 64 hex characters expected"
            ))
        })?;
    let present = state.files.has(iroh_blobs::Hash::from_bytes(bytes)).await;
    Ok(Json(serde_json::json!({ "present": present })))
}

/// Convert a database row into a JSON object. The stored value's own type drives the JSON shape
/// (SQLite values are self-describing, so computed expressions like `COUNT(*)` come through as
/// what they are); blobs become arrays of byte values, since JSON has no bytes type.
fn row_to_json(values: &[turso::Value], column_names: &[String]) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::new();
    for (idx, name) in column_names.iter().enumerate() {
        let value = match values.get(idx) {
            Some(turso::Value::Integer(i)) => Value::from(*i),
            Some(turso::Value::Real(f)) => Value::from(*f),
            Some(turso::Value::Text(s)) => Value::from(s.clone()),
            Some(turso::Value::Blob(b)) => Value::from(b.clone()),
            Some(turso::Value::Null) | None => Value::Null,
        };
        obj.insert(name.clone(), value);
    }
    obj
}

#[derive(Deserialize)]
pub struct RevalidationModeRequest {
    /// "tree" | "fast" | "none" | "default"
    pub mode: String,
}

/// Override which lane fragment revalidation takes, for the duration of the process (or until
/// set back to "default"). Exists so ONE booted harness can prove the same cascade through both
/// lanes - the boot env can pin only one, and whichever it pins, the other rots unexercised.
pub async fn revalidation_mode(
    Json(req): Json<RevalidationModeRequest>,
) -> Result<Json<Value>, AppError> {
    let value = match req.mode.as_str() {
        "tree" => 1,
        "fast" => 2,
        // Per-document revalidation parked entirely; the reap alone moves anything. For the
        // test that proves a death arrived by the cursor and not the queue - which needs the
        // queue provably off, not merely slow.
        "none" => 3,
        "default" => 0,
        other => {
            return Err(AppError::BadRequest(crate::msg!(
                "test.endpoints.unknown-revalidation-mode",
                "unknown revalidation mode {other:?} (tree | fast | none | default)",
                other = other
            )))
        }
    };
    crate::net::fragment::REVALIDATION_MODE.store(value, std::sync::atomic::Ordering::Relaxed);
    tracing::warn!(mode = %req.mode, "LOCAL_TEST revalidation mode override");
    Ok(Json(serde_json::json!({ "mode": req.mode })))
}
