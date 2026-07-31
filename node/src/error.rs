//! Application error type.
//!
//! Wraps `anyhow::Error` for convenient `?` propagation from any fallible call, but carries an
//! explicit HTTP status rather than sniffing it out of the error message (which the old codebase
//! did, and which was fragile). Handlers return `Result<T, AppError>`; anything that isn't
//! deliberately classified becomes a 500.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(String),

    #[error("{0}")]
    Unauthorized(String),

    #[error("{0}")]
    Forbidden(String),

    /// This node's own key for the identity has been revoked (retired or repudiated): it may
    /// read its era, but every signing act is refused. Carries a stable `code` in the body so
    /// the UI can tell "no longer you" from an ordinary 403 and start the farewell.
    #[error("{0}")]
    RevokedSigner(String),

    #[error("{0}")]
    NotFound(String),

    /// The request was understood but the underlying entity can't be produced - e.g. an upload
    /// whose transcode terminally failed. Carries the human tombstone.
    #[error("{0}")]
    Unprocessable(String),

    #[error("too many requests: {0}")]
    TooManyRequests(String),

    /// Anything not deliberately classified: rendered as a 500 and logged at error level.
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    fn status(&self) -> StatusCode {
        match self {
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AppError::Forbidden(_) => StatusCode::FORBIDDEN,
            AppError::RevokedSigner(_) => StatusCode::FORBIDDEN,
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::Unprocessable(_) => StatusCode::UNPROCESSABLE_ENTITY,
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    message: String,
    /// A stable, machine-readable discriminator for the errors the UI must react to
    /// structurally (not just display). Absent for ordinary errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let message = self.to_string();
        let code = match self {
            AppError::RevokedSigner(_) => Some("revoked-signer"),
            _ => None,
        };

        // Server errors are worth an error-level log with the full chain; client errors are noise
        // at info level.
        if status.is_server_error() {
            tracing::error!(%status, error = ?self, "request failed");
        } else {
            tracing::info!(%status, %message, "request rejected");
        }

        (status, Json(ErrorBody { message, code })).into_response()
    }
}
