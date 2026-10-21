//! Per-request context, extracted from an incoming HTTP request.
//!
//! Mints a correlation id and records the request's identifying fields into the current tracing
//! span, so every log line emitted while handling a request is tagged with who/where it came from.
//! Implemented as an Axum `FromRequestParts` extractor: add `ctx: RequestContext` to a handler
//! signature to get one.
//!
//! **Who is asking** (security pass, 2026-10-21) is two separate questions, and both used to be
//! answered from the raw `X-Forwarded-For` string - which the visitor writes the left end of:
//!
//! - _Which address do we rate-limit?_ `client_ip`: count `Config::proxy_hops` addresses in from
//!   the right of the header, because each proxy we trust appends exactly one and nothing to
//!   their left is anything but the visitor's say-so. Keying on the whole string gave every
//!   request with a made-up header a bucket of its own: no limit at all.
//! - _Is this the operator's own machine?_ `is_direct_loopback`: a loopback socket and NO
//!   forwarding header of any kind - present, not parseable. A header of non-ASCII bytes once
//!   failed to parse, read as "not forwarded", and made any visitor behind a same-machine proxy
//!   the operator: no rate limits, and the backup door open.

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
    /// The socket's peer: the visitor when nothing stands in front of the node, the innermost
    /// proxy when something does.
    pub remote_ip: IpAddr,
    /// The `X-Forwarded-For` header as it arrived (lossily decoded, for the log), or
    /// `NOT_FORWARDED`. The visitor writes its left end - see `client_ip` before trusting it.
    pub forwarded_for: String,
    /// Did ANY forwarding header arrive (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) - whether
    /// or not its value parses. The loopback exemption hangs on this.
    pub forwarded: bool,
    pub user_agent: String,
    pub correlation_id: Uuid,
    /// `arrived_over_https`: the session cookie is `Secure` when this says so.
    pub https: bool,
}

/// The sentinel `forwarded_for` carries when no X-Forwarded-For header arrived - for the log.
/// The loopback exemption asks `forwarded` instead, which a malformed header can't fool.
pub const NOT_FORWARDED: &str = "--not-forwarded--";

/// The headers a proxy announces itself with. Any one of them present means "not the operator
/// at the machine": nginx sets `X-Real-IP` as often as `X-Forwarded-For`.
const FORWARDING_HEADERS: [&str; 3] = ["x-forwarded-for", "x-real-ip", "forwarded"];

/// A request's address as the log keeps it: an upload link's token - its whole capability, in the
/// path (`uploadlink.rs`) - shown as `…`. The log is journald's, readable by anyone with the
/// machine's adm group, and kept far longer than the link lives.
pub fn loggable_uri(uri: &axum::http::Uri) -> String {
    let path = uri.path();
    let masked = match path.split_once("/upload/") {
        Some((before, _)) if before.is_empty() || before == "/api" => format!("{before}/upload/…"),
        _ => return uri.to_string(),
    };
    match uri.query() {
        Some(q) => format!("{masked}?{q}"),
        None => masked,
    }
}

/// Did the visitor reach us over HTTPS - a proxy's `X-Forwarded-Proto` says so. Believed from
/// anyone: it decides only whether the session cookie is `Secure`, and a visitor who lies about
/// it gets a cookie their own browser won't send back.
pub fn arrived_over_https(headers: &axum::http::HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.split(',').any(|p| p.trim().eq_ignore_ascii_case("https")))
}

impl RequestContext {
    /// The visitor's address, as far as the proxies we trust can vouch for it.
    ///
    /// With `proxy_hops` proxies in front of the node, each appending the address it heard
    /// from, the visitor is the `proxy_hops`-th entry from the right; everything further left
    /// is whatever the visitor sent. Fewer entries than that means the request skipped the
    /// outer proxies, and the leftmost entry is the one a trusted proxy wrote. The header is
    /// read only when the socket peer is loopback or a private network - a proxy's address;
    /// a peer on the public internet IS the visitor, and its header is just a claim. An entry
    /// that isn't an address (a misconfigured proxy) falls back to the socket peer: one shared
    /// bucket, which fails safe.
    pub fn client_ip(&self, proxy_hops: usize) -> IpAddr {
        if proxy_hops == 0
            || self.forwarded_for == NOT_FORWARDED
            || crate::net::unfurl::is_public(self.remote_ip)
        {
            return self.remote_ip;
        }
        let entries: Vec<&str> = self.forwarded_for.split(',').map(str::trim).collect();
        let index = entries.len().saturating_sub(proxy_hops);
        entries[index].parse::<IpAddr>().unwrap_or(self.remote_ip)
    }

    /// The identifier the rate limiter counts against: the visitor's address (`client_ip`).
    pub fn rate_limit_identifier(&self, proxy_hops: usize) -> String {
        self.client_ip(proxy_hops).to_string()
    }

    /// Is this the operator's own machine talking to the node DIRECTLY - loopback socket, no
    /// forwarding header? The audience-aware relaxation the password floor established
    /// (`Config::password_min_len`: strict facing the network, relaxed on loopback), asked
    /// per-request because the limiter's question is per-request.
    ///
    /// The forwarding check is load-bearing, not paranoia: behind a reverse proxy EVERY
    /// request arrives from loopback, and exempting them would turn "no rate limits for the
    /// operator" into "no rate limits for the world". A proxy that sends no forwarding header
    /// at all would still fool this; SERVER.md's proxy configurations all send one.
    pub fn is_direct_loopback(&self) -> bool {
        self.remote_ip.is_loopback() && !self.forwarded
    }
}

impl<S> FromRequestParts<S> for RequestContext
where
    S: Send + Sync,
{
    type Rejection = (axum::http::StatusCode, &'static str);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let remote_ip =
            parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|ci| ci.0.ip()).ok_or((
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "missing ConnectInfo<SocketAddr>",
            ))?;

        let header = |name: &str, fallback: &'static str| -> String {
            parts
                .headers
                .get(name)
                .map(|h| String::from_utf8_lossy(h.as_bytes()).into_owned())
                .unwrap_or_else(|| fallback.to_string())
        };

        let forwarded_for = header("x-forwarded-for", NOT_FORWARDED);
        let forwarded = FORWARDING_HEADERS.iter().any(|name| parts.headers.contains_key(*name));
        let user_agent = header("user-agent", "--no-user-agent--");
        let https = arrived_over_https(&parts.headers);
        let correlation_id = Uuid::new_v4();

        let span = Span::current();
        span.record("c_id", tracing::field::display(&correlation_id));
        span.record("remote_ip", tracing::field::display(&remote_ip));
        span.record("forwarded_for", tracing::field::display(&forwarded_for));

        Ok(RequestContext { remote_ip, forwarded_for, forwarded, user_agent, correlation_id, https })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn ctx(ip: &str, forwarded_for: &str) -> RequestContext {
        RequestContext {
            remote_ip: ip.parse().unwrap(),
            forwarded_for: forwarded_for.into(),
            forwarded: forwarded_for != NOT_FORWARDED,
            user_agent: "test".into(),
            correlation_id: Uuid::nil(),
            https: false,
        }
    }

    #[test]
    fn an_upload_links_token_stays_out_of_the_log() {
        let uri = |s: &str| loggable_uri(&s.parse().unwrap());
        assert_eq!(uri("/upload/0123abcd"), "/upload/…");
        assert_eq!(uri("/api/upload/0123abcd?x=1"), "/api/upload/…?x=1");
        assert_eq!(uri("/api/identity/abc/docs?q=upload"), "/api/identity/abc/docs?q=upload");
        assert_eq!(uri("/api/identity/abc/upload/x"), "/api/identity/abc/upload/x", "only the link's own paths");
    }

    #[test]
    fn https_is_whatever_a_proxy_said() {
        let mut headers = axum::http::HeaderMap::new();
        assert!(!arrived_over_https(&headers), "no proxy, no TLS: a node on plain http");
        headers.insert("x-forwarded-proto", "https".parse().unwrap());
        assert!(arrived_over_https(&headers));
        headers.insert("x-forwarded-proto", "http".parse().unwrap());
        assert!(!arrived_over_https(&headers));
        headers.insert("x-forwarded-proto", "https, http".parse().unwrap());
        assert!(arrived_over_https(&headers), "a CDN's https, then a gateway's http hop");
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
    fn a_forwarding_header_that_wont_parse_still_says_forwarded() {
        // The 2026-10-21 hole: `X-Forwarded-For: \xff` failed `to_str`, read as absent, and
        // made the visitor the operator. Presence is the question, and X-Real-IP alone counts.
        let mut request = ctx("127.0.0.1", "\u{fffd}");
        assert!(!request.is_direct_loopback());
        request.forwarded_for = NOT_FORWARDED.into();
        request.forwarded = true; // X-Real-IP, no X-Forwarded-For
        assert!(!request.is_direct_loopback());
    }

    #[test]
    fn the_network_is_the_network() {
        assert!(!ctx("203.0.113.9", NOT_FORWARDED).is_direct_loopback());
    }

    #[test]
    fn one_proxy_vouches_for_the_rightmost_address_only() {
        // Caddy on the same machine: the visitor's own header, then the address Caddy heard.
        let request = ctx("127.0.0.1", "6.6.6.6, 203.0.113.9");
        assert_eq!(request.client_ip(1), "203.0.113.9".parse::<IpAddr>().unwrap());
        // The made-up left end changes nothing: same bucket every time.
        let forged = ctx("127.0.0.1", "1.2.3.4, 203.0.113.9");
        assert_eq!(forged.rate_limit_identifier(1), request.rate_limit_identifier(1));
    }

    #[test]
    fn a_chain_of_proxies_counts_in_from_the_right() {
        // A CDN, a gateway and a local proxy: the visitor (198.51.100.7) is third from the
        // right; the CDN's edge appears twice because the inner proxy resolved it as the
        // real address before appending. The forged left end is ignored.
        let request = ctx("127.0.0.1", "6.6.6.6, 198.51.100.7, 192.0.2.50, 192.0.2.50");
        assert_eq!(request.client_ip(3), "198.51.100.7".parse::<IpAddr>().unwrap());
        // Fewer entries than hops: the request skipped the outer proxies, and the leftmost
        // entry is still one a trusted proxy wrote.
        let short = ctx("127.0.0.1", "198.51.100.7");
        assert_eq!(short.client_ip(3), "198.51.100.7".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn a_public_peer_is_the_visitor_whatever_its_header_says() {
        // A node bound to the internet, reached directly: the header is only a claim. (A
        // routable address: `is_public` counts the documentation ranges as not-the-internet.)
        let request = ctx("8.8.4.4", "1.2.3.4");
        assert_eq!(request.client_ip(1), "8.8.4.4".parse::<IpAddr>().unwrap());
        // ...while a proxy in a container or across a private network is believed.
        let docker = ctx("172.17.0.2", "203.0.113.9");
        assert_eq!(docker.client_ip(1), "203.0.113.9".parse::<IpAddr>().unwrap());
    }

    #[test]
    fn no_hops_or_no_header_or_garbage_means_the_socket_peer() {
        let request = ctx("127.0.0.1", "203.0.113.9");
        assert_eq!(request.client_ip(0), "127.0.0.1".parse::<IpAddr>().unwrap());
        let bare = ctx("127.0.0.1", NOT_FORWARDED);
        assert_eq!(bare.client_ip(1), "127.0.0.1".parse::<IpAddr>().unwrap());
        let garbage = ctx("127.0.0.1", "unknown");
        assert_eq!(garbage.client_ip(1), "127.0.0.1".parse::<IpAddr>().unwrap());
    }
}
