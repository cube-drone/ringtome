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

/// The sentinel `forwarded_for` carries when no X-Forwarded-For header arrived. Shared with
/// the loopback exemption below, which must never fire for a proxied request.
pub const NOT_FORWARDED: &str = "--not-forwarded--";

impl RequestContext {
    /// Stable-ish identifier for rate limiting: remote IP plus any forwarding header.
    pub fn rate_limit_identifier(&self) -> String {
        format!("{}-{}", self.remote_ip, self.forwarded_for)
    }

    /// Is this the operator's own machine talking to the node DIRECTLY - loopback socket, no
    /// forwarding header? The audience-aware relaxation the password floor established
    /// (`Config::password_min_len`: strict facing the network, relaxed on loopback), asked
    /// per-request because the limiter's question is per-request.
    ///
    /// The forwarding check is load-bearing, not paranoia: behind a reverse proxy EVERY
    /// request arrives from loopback, and exempting them would turn "no rate limits for the
    /// operator" into "no rate limits for the world". A proxy that strips X-Forwarded-For
    /// would still fool this - which is one more reason the security pass gates any public
    /// exposure (NEXT_STEPS, Tier 6).
    pub fn is_direct_loopback(&self) -> bool {
        self.remote_ip.is_loopback() && self.forwarded_for == NOT_FORWARDED
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn ctx(ip: &str, forwarded: &str) -> RequestContext {
        RequestContext {
            remote_ip: ip.parse().unwrap(),
            forwarded_for: forwarded.into(),
            user_agent: "test".into(),
            correlation_id: Uuid::nil(),
        }
    }

    #[test]
    fn the_operators_own_machine_is_direct() {
        assert!(ctx("127.0.0.1", NOT_FORWARDED).is_direct_loopback());
        assert!(ctx("::1", NOT_FORWARDED).is_direct_loopback(), "v6 loopback counts too");
    }

    #[test]
    fn a_proxied_request_is_never_direct_even_from_loopback() {
        // Behind nginx, everyone is 127.0.0.1 - the forwarding header is what says so.
        assert!(!ctx("127.0.0.1", "203.0.113.9").is_direct_loopback());
    }

    #[test]
    fn the_network_is_the_network() {
        assert!(!ctx("203.0.113.9", NOT_FORWARDED).is_direct_loopback());
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

        let forwarded_for = header("x-forwarded-for", NOT_FORWARDED);
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
