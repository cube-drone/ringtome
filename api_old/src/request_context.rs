use std::net::IpAddr;
use std::net::SocketAddr;
use uuid::Uuid;
use axum::{
    extract::{FromRequestParts, ConnectInfo},
    http::{request::Parts},
};
use tracing::Span;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RequestContext {
    pub remote_ip: IpAddr,
    pub forwarded_for: String,
    pub user_agent: String,
    pub correlation_id: Uuid,
    pub fingerprint: String,
}

impl<S> FromRequestParts<S> for RequestContext
where
    S: Send + Sync,
{
    type Rejection = (axum::http::StatusCode, &'static str);

    async fn from_request_parts(
            parts: &mut Parts,
            _state: &S
        ) -> Result<Self, Self::Rejection> {
        // Try to get remote IP from ConnectInfo
        let remote_ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|ci| ci.0.ip())
            .ok_or_else(|| {
                (
                    axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                    "Missing ConnectInfo<SocketAddr>",
                )
            })?;

        // Get X-Forwarded-For if present
        let forwarded_for = parts
            .headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("--not forwarded--")
            .to_string();

        // Get User-Agent if present
        let user_agent = parts
            .headers
            .get("user-agent")
            .and_then(|h| h.to_str().ok())
            .unwrap_or("--no user agent--")
            .to_string();

        // fingerprint is a hash of the remote IP, forwarded_for, and user_agent
        let fingerprint = format!("{}:{}:{}", remote_ip, forwarded_for, user_agent);

        let correlation_id = Uuid::new_v4();
        Span::current().record("c_id", &tracing::field::display(&correlation_id));
        Span::current().record("remote_ip", &tracing::field::display(&remote_ip));
        Span::current().record("forwarded_for", &tracing::field::display(&forwarded_for));
        Span::current().record("user_agent", &tracing::field::display(&user_agent));

        Ok(RequestContext {
            remote_ip,
            forwarded_for,
            user_agent,
            correlation_id,
            fingerprint
        })
    }
}

impl RequestContext {
    pub fn rate_limit_identifier(&self) -> String {
        format!("{}-{}", self.remote_ip, self.forwarded_for)
    }
}