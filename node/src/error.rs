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

    #[error("{0}")]
    NotFound(String),

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
            AppError::NotFound(_) => StatusCode::NOT_FOUND,
            AppError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let message = self.to_string();

        // Server errors are worth an error-level log with the full chain; client errors are noise
        // at info level.
        if status.is_server_error() {
            tracing::error!(%status, error = ?self, "request failed");
        } else {
            tracing::info!(%status, %message, "request rejected");
        }

        (status, Json(ErrorBody { message })).into_response()
    }
}
