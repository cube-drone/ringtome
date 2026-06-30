use uuid::Uuid;
use axum::Json;
use axum::extract::{State, Path, Query};
use serde::{Deserialize};

use crate::{AppState, AppError};
use crate::modules::session::extractors::AdminSessionExtractor;

use super::Audit;

#[derive(Debug, Clone, Deserialize)]
pub struct AuditQueryOptions {
    pub user_id: Option<Uuid>,
    pub system: Option<String>,
    pub action: Option<String>,
    pub triggered_by: Option<String>,
    pub ip: Option<String>,
    pub forwarded_for: Option<String>,
    pub fingerprint: Option<String>,
    pub n: Option<u32>,
    pub offset: Option<u32>,
}

// GET /api/community/{:slug}/audit
//  Get the audit log for a community
#[axum::debug_handler]
pub async fn get_audit_logs(
    AdminSessionExtractor{session: _}: AdminSessionExtractor,
    Path(slug): Path<String>,
    Query(audit_query_options): Query<AuditQueryOptions>,
    State(state): State<AppState>,
) -> Result<Json<Vec<Audit>>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let audit_service = community_db.audit_service.clone();

    let audit_logs = audit_service.get_audit_logs(audit_query_options).await?;

    Ok(Json(audit_logs))
}
