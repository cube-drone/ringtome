use axum::{
    response::{IntoResponse, Response},
    http::{StatusCode, HeaderMap},
};
use serde::Serialize;

// make our own error that wraps anyhow::Error (thx: https://github.com/tokio-rs/axum/blob/main/examples/anyhow-error-response/src/main.rs)
pub struct AppError(pub anyhow::Error);

#[derive(Debug, Serialize)]
pub struct ErrorStruct {
    pub message: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = ErrorStruct{ message: self.0.to_string()};
        let mut body_string = serde_json::to_string(&body).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("Content-Type", "application/json".parse().unwrap());
        // check if the error message contains "404" or "not found"
        if self.0.to_string().contains("deserialize the JSON") {
            tracing::info!("400 error: {}", body_string);
            (StatusCode::BAD_REQUEST, headers, body_string).into_response()
        }
        else if self.0.to_string().contains("403") || self.0.to_string().contains("forbidden") {
            body_string = body_string.replace("403 ", "");
            tracing::info!("403 error: {}", body_string);
            (StatusCode::FORBIDDEN, headers, body_string).into_response()
        }
        else if self.0.to_string().contains("404") || self.0.to_string().contains("not found") {
            body_string = body_string.replace("404 ", "");
            tracing::info!("404 error: {}", body_string);
            (StatusCode::NOT_FOUND, headers, body_string).into_response()
        }
        else if self.0.to_string().contains("400") {
            body_string = body_string.replace("400 ", "");
            tracing::info!("400 error: {}", body_string);
            (StatusCode::BAD_REQUEST, headers, body_string).into_response()
        }
        else if self.0.to_string().contains("429") || self.0.to_string().contains("too_many_requests") {
            body_string = body_string.replace("429 ", "");
            tracing::info!("429 error: {}", body_string);
            (StatusCode::TOO_MANY_REQUESTS, headers, body_string).into_response()
        }
        else {
            tracing::error!("500 error: {}", body_string);
            (StatusCode::INTERNAL_SERVER_ERROR, headers, body_string).into_response()
        }
    }
}

impl std::fmt::Debug for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AppError: {:?}", self.0)
    }
}

// This enables using `?` on functions that return `Result<_, anyhow::Error>` to turn them into
// `Result<_, AppError>`. That way you don't need to do that manually.
impl<E> From<E> for AppError
where
    E: Into<anyhow::Error>,
{
    fn from(err: E) -> Self {
        Self(err.into())
    }
}