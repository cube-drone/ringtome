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

use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Column, Row, TypeInfo};

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

    let fetched = sqlx::query(&req.sql)
        .fetch_all(&state.node_db)
        .await
        .map_err(|e| AppError::BadRequest(format!("sql error: {e}")))?;

    let rows = fetched.iter().map(row_to_json).collect::<Vec<_>>();

    Ok(Json(SqlResponse {
        rows,
        rows_affected: None,
    }))
}

/// Convert a SQLite row into a JSON object, decoding each column by its declared type.
fn row_to_json(row: &sqlx::sqlite::SqliteRow) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::new();
    for col in row.columns() {
        let name = col.name().to_string();
        let idx = col.ordinal();
        let type_name = col.type_info().name().to_uppercase();

        let value = if type_name.contains("INT") {
            row.try_get::<Option<i64>, _>(idx)
                .ok()
                .flatten()
                .map(Value::from)
                .unwrap_or(Value::Null)
        } else if type_name.contains("REAL")
            || type_name.contains("FLOA")
            || type_name.contains("DOUB")
        {
            row.try_get::<Option<f64>, _>(idx)
                .ok()
                .flatten()
                .map(Value::from)
                .unwrap_or(Value::Null)
        } else {
            // Text / blob / unknown: fall back to a string, then null.
            row.try_get::<Option<String>, _>(idx)
                .ok()
                .flatten()
                .map(Value::from)
                .unwrap_or(Value::Null)
        };

        obj.insert(name, value);
    }
    obj
}
