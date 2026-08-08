//! DANGEROUS test-only endpoints, mounted ONLY when `config.local_test` is set.
//!
//! These exist so the black-box integration suite can inspect and manipulate node state directly
//! (e.g. read the `boot_timestamps` table, reset state between tests) without us having to expose
//! that surface through the real API. The raw SQL passthrough here is a total security hole by
//! design - it must never be reachable on any node that is not a developer's local test target.
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

    let mut fetched = state
        .node_db
        .query(&req.sql, ())
        .await
        .map_err(|e| AppError::BadRequest(format!("sql error: {e}")))?;
    let column_names = fetched.column_names();

    let mut rows = Vec::new();
    loop {
        match fetched.next().await {
            Ok(Some(row)) => rows.push(row_to_json(&row, &column_names)),
            Ok(None) => break,
            Err(e) => return Err(AppError::BadRequest(format!("sql error: {e}"))),
        }
    }

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

/// Convert a database row into a JSON object. The stored value's own type drives the JSON shape
/// (SQLite values are self-describing, so computed expressions like `COUNT(*)` come through as
/// what they are); blobs become arrays of byte values, since JSON has no bytes type.
fn row_to_json(row: &turso::Row, column_names: &[String]) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::new();
    for (idx, name) in column_names.iter().enumerate() {
        let value = match row.get_value(idx) {
            Ok(turso::Value::Integer(i)) => Value::from(i),
            Ok(turso::Value::Real(f)) => Value::from(f),
            Ok(turso::Value::Text(s)) => Value::from(s),
            Ok(turso::Value::Blob(b)) => Value::from(b),
            Ok(turso::Value::Null) | Err(_) => Value::Null,
        };
        obj.insert(name.clone(), value);
    }
    obj
}
