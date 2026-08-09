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
use std::collections::BTreeMap;

use serde::Serialize;

use crate::message::UserMessage;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    BadRequest(UserMessage),

    #[error("{0}")]
    Unauthorized(UserMessage),

    #[error("{0}")]
    Forbidden(UserMessage),

    /// This node's own key for the identity has been revoked (retired or repudiated): it may
    /// read its era, but every signing act is refused. Carries a stable `code` in the body so
    /// the UI can tell "no longer you" from an ordinary 403 and start the farewell.
    #[error("{0}")]
    RevokedSigner(UserMessage),

    #[error("{0}")]
    NotFound(UserMessage),

    /// The request was understood but the underlying entity can't be produced - e.g. an upload
    /// whose transcode terminally failed. Carries the human tombstone.
    #[error("{0}")]
    Unprocessable(UserMessage),

    #[error("{0}")]
    TooManyRequests(UserMessage),

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
    ///
    /// Deliberately NOT the same thing as `key` below: this answers "which failure is this", and
    /// the UI branches on it (`revoked-signer` starts the farewell). `key` answers "which sentence
    /// is this". One failure can be told in several sentences, so collapsing the two would tie the
    /// UI's control flow to its copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<&'static str>,
    /// The catalog key for `message` - what the browser looks up to say this in another language,
    /// falling back to `message` when it has no entry (see js/i18n.js).
    #[serde(skip_serializing_if = "Option::is_none")]
    key: Option<&'static str>,
    /// The values that filled `message`'s holes, kept apart so another language can reorder them.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    params: BTreeMap<&'static str, String>,
}

impl AppError {
    /// The user-facing sentence, for everything except an `Internal` - which has none by design.
    fn user_message(&self) -> Option<&UserMessage> {
        match self {
            AppError::BadRequest(m)
            | AppError::Unauthorized(m)
            | AppError::Forbidden(m)
            | AppError::RevokedSigner(m)
            | AppError::NotFound(m)
            | AppError::Unprocessable(m)
            | AppError::TooManyRequests(m) => Some(m),
            AppError::Internal(_) => None,
        }
    }
}

/// What a reader is told when this node breaks. Deliberately not the failure's own words: an
/// `Internal` is by definition something no reader can act on, and its outermost anyhow context
/// is a note the code left for the person debugging it. "storing entry" reached a user in the
/// middle of posting (2026-08-04) and told them nothing except that something called an entry
/// had failed to store. The full chain still goes to the log at error level, which is where the
/// person who can act on it is looking.
const INTERNAL_MESSAGE: &str = "something went wrong inside this node - it's been logged";
/// Its catalog key: an internal failure is still a sentence someone reads.
const INTERNAL_KEY: &str = "error.something-went-wrong-inside-this-node";

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status();
        let user = self.user_message();
        let message = user.map_or_else(|| INTERNAL_MESSAGE.to_string(), |m| m.english.clone());
        // The internal message is copy too, and a reader deserves it in their own language.
        let key = Some(user.map_or(INTERNAL_KEY, |m| m.code));
        let params = user.map(|m| m.params.clone()).unwrap_or_default();
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

        (status, Json(ErrorBody { message, code, key, params })).into_response()
    }
}
