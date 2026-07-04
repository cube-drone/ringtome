//! Per-request context, extracted from an incoming HTTP request.
//!
//! Mints a correlation id and records the request's identifying fields into the current tracing
//! span, so every log line emitted while handling a request is tagged with who/where it came from.
//! Implemented as an Axum `FromRequestParts` extractor: add `ctx: RequestContext` to a handler
//! signature to get one.

use std::net::{IpAddr, SocketAddr};

use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::request::Parts,
};
use serde::{Deserialize, Serialize};
use tracing::Span;
use uuid::Uuid;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RequestContext {
    pub remote_ip: IpAddr,
    pub forwarded_for: String,
    pub user_agent: String,
    pub correlation_id: Uuid,
}

impl RequestContext {
    /// Stable-ish identifier for rate limiting: remote IP plus any forwarding header.
    pub fn rate_limit_identifier(&self) -> String {
        format!("{}-{}", self.remote_ip, self.forwarded_for)
    }
}

impl<S> FromRequestParts<S> for RequestContext
where
    S: Send + Sync,
{
    type Rejection = (axum::http::StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let remote_ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0.ip())
            .ok_or((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "missing ConnectInfo<SocketAddr>",
            ))?;

        let header = |name: &str, fallback: &'static str| -> String {
            parts
                .headers
                .get(name)
                .and_then(|h| h.to_str().ok())
                .unwrap_or(fallback)
                .to_string()
        };

        let forwarded_for = header("x-forwarded-for", "--not-forwarded--");
        let user_agent = header("user-agent", "--no-user-agent--");
        let correlation_id = Uuid::new_v4();

        let span = Span::current();
        span.record("c_id", tracing::field::display(&correlation_id));
        span.record("remote_ip", tracing::field::display(&remote_ip));
        span.record("forwarded_for", tracing::field::display(&forwarded_for));

        Ok(RequestContext {
            remote_ip,
            forwarded_for,
            user_agent,
            correlation_id,
        })
    }
}
