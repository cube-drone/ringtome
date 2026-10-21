//! The turbolink unfurl endpoint's engine: fetch a foreign page, read its OpenGraph card.
//!
//! Browsers can't do this themselves - CORS forbids reading arbitrary sites' HTML - so the
//! node fetches on the browser's behalf. That makes the node an outbound HTTP client on
//! user-controlled URLs, which drags in exactly two obligations, both enforced here:
//!
//!   - **No reaching inward (SSRF)**: only http/https, every DNS answer for every hop of a
//!     redirect chain must be a public address, and the connection is pinned to the vetted
//!     address (no rebinding between our check and reqwest's dial). A node must never be a
//!     periscope into its own LAN.
//!   - **No reaching outward too hard**: one global token bucket, generous but real, so a
//!     link-stuffed document (or a hostile script hammering the endpoint) can't turn a
//!     Ringtome node into a load test against a foreign server. Cache hits don't spend.
//!
//! The privacy call is deliberate and Curtis's (2026-07-25): unfurling links in private
//! notes does tell target sites the node is interested in them, and that's accepted -
//! deanonymization-via-OpenGraph is a niche threat, the fetch comes from the node (not the
//! browser), and the per-URL cache keeps repeat renders from re-announcing anything.
//!
//! The parse mirrors marquee-turbolink's `parseOpenGraph` (same fields, same fallbacks, same
//! bounded read) so the browser plugin can hand the result straight to `renderCard`.

use std::net::IpAddr;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;

/// The OpenGraph card, field-for-field what marquee-turbolink's `TurbolinkSummary` carries.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Summary {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site: Option<String>,
}

/// Why an unfurl was refused without fetching. The route maps these to status codes.
#[derive(Debug, PartialEq)]
pub enum Refusal {
    /// Not a fetchable public http(s) URL (bad syntax, wrong scheme, private/loopback
    /// address, unresolvable host, too many redirects).
    BadTarget(crate::message::UserMessage),
    /// The global outbound budget is spent right now.
    RateLimited,
}

/// Fallback outbound budget when config hands us nonsense: see `Config::unfurl_rate_per_min`
/// for the real knob (single-user nodes are fine at the default 30/min; a many-user node
/// raises it).
const DEFAULT_RATE_PER_MIN: f64 = 30.0;
/// Bounded download: OpenGraph metadata lives at the top of the document.
const MAX_BODY_BYTES: usize = 128 * 1024;
const MAX_REDIRECTS: usize = 4;
const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
/// Cached per URL for a day; a page's card does not change often enough to matter.
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const CACHE_CAP: u64 = 2048;
/// Some sites serve bots an empty shell; a desktop UA gets the page humans get (same call
/// marquee-turbolink makes).
const UA: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/// The token bucket: burst capacity equals one minute's allowance (an intuitive single
/// knob - "unfurls per minute" is both the sustained rate and how much slack a paste-storm
/// gets up front).
struct Bucket {
    per_min: f64,
    tokens: f64,
    last_ms: i64,
}

impl Bucket {
    fn new(per_min: f64) -> Self {
        let per_min =
            if per_min.is_finite() && per_min >= 1.0 { per_min } else { DEFAULT_RATE_PER_MIN };
        Self { per_min, tokens: per_min, last_ms: 0 }
    }

    fn take(&mut self, now_ms: i64) -> bool {
        let elapsed = (now_ms - self.last_ms).max(0) as f64 / 1000.0;
        self.tokens = (self.tokens + elapsed * self.per_min / 60.0).min(self.per_min);
        self.last_ms = now_ms;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
pub struct Unfurler {
    cache: moka::future::Cache<String, Option<Summary>>,
    bucket: std::sync::Arc<Mutex<Bucket>>,
}

impl Unfurler {
    /// `rate_per_min` comes from config (`RINGTOME_UNFURL_RATE_PER_MIN`); nonsense values
    /// fall back to the default rather than disabling the brake.
    pub fn new(rate_per_min: f64) -> Self {
        Self {
            cache: moka::future::Cache::builder()
                .max_capacity(CACHE_CAP)
                .time_to_live(CACHE_TTL)
                .build(),
            bucket: std::sync::Arc::new(Mutex::new(Bucket::new(rate_per_min))),
        }
    }
}

impl Unfurler {
    /// Fetch and parse one URL's OpenGraph card. `Ok(Some)` is a card, `Ok(None)` is an
    /// honest "the page has none" (cached) or a transient fetch failure (not cached, so a
    /// hiccup doesn't wear a day-long scar). `Err` is a refusal - nothing was fetched.
    pub async fn unfurl(&self, raw: &str) -> Result<Option<Summary>, Refusal> {
        let parsed = url::Url::parse(raw.trim()).map_err(|e| {
            Refusal::BadTarget(crate::msg!(
                "net.unfurl.not-a-url",
                "not a URL: {reason}",
                reason = e
            ))
        })?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(Refusal::BadTarget(crate::msg!(
                "net.unfurl.only-http-and-https-unfurl",
                "only http and https unfurl"
            )));
        }
        let key = parsed.to_string();
        if let Some(hit) = self.cache.get(&key).await {
            return Ok(hit);
        }
        if !self.bucket.lock().expect("unfurl bucket poisoned").take(crate::clock::now_ms()) {
            return Err(Refusal::RateLimited);
        }
        match self.fetch(parsed).await {
            Ok(summary) => {
                self.cache.insert(key, summary.clone()).await;
                Ok(summary)
            }
            Err(FetchEnd::Refused(r)) => Err(r),
            Err(FetchEnd::Failed(e)) => {
                tracing::debug!(url = %key, "unfurl fetch failed: {e:#}");
                Ok(None)
            }
        }
    }

    /// The redirect-following fetch, every hop re-vetted and address-pinned.
    async fn fetch(&self, mut url: url::Url) -> Result<Option<Summary>, FetchEnd> {
        for _ in 0..=MAX_REDIRECTS {
            let addr = vetted_addr(&url).await.map_err(FetchEnd::Refused)?;
            let host = url.host_str().unwrap_or_default().to_string();
            let port = url.port_or_known_default().unwrap_or(80);
            // A fresh client per hop so the connection is PINNED to the address we vetted -
            // the classic rebinding trick is a hostname whose DNS answer changes between
            // the check and the dial. Cheap at this endpoint's bounded rate.
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                // An HTTP(S)_PROXY in the environment would dial the proxy, not the pinned
                // address, and the proxy would resolve the name again: rebinding, reopened.
                .no_proxy()
                .timeout(FETCH_TIMEOUT)
                .resolve(&host, std::net::SocketAddr::new(addr, port))
                .build()
                .map_err(|e| FetchEnd::Failed(anyhow::anyhow!(e)))?;
            let res = client
                .get(url.clone())
                .header(reqwest::header::USER_AGENT, UA)
                .header(reqwest::header::ACCEPT, "text/html")
                .send()
                .await
                .map_err(|e| FetchEnd::Failed(anyhow::anyhow!(e)))?;

            if res.status().is_redirection() {
                let location = res
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| {
                        FetchEnd::Failed(anyhow::anyhow!("redirect without location"))
                    })?;
                url = url
                    .join(location)
                    .map_err(|e| FetchEnd::Failed(anyhow::anyhow!("bad redirect target: {e}")))?;
                if url.scheme() != "http" && url.scheme() != "https" {
                    return Err(FetchEnd::Refused(Refusal::BadTarget(crate::msg!(
                        "net.unfurl.redirected-off-the-web",
                        "redirected off the web"
                    ))));
                }
                continue;
            }
            if !res.status().is_success() {
                return Err(FetchEnd::Failed(anyhow::anyhow!("status {}", res.status())));
            }
            let body = read_capped(res, MAX_BODY_BYTES).await.map_err(FetchEnd::Failed)?;
            return Ok(parse_open_graph(&body));
        }
        Err(FetchEnd::Refused(Refusal::BadTarget(crate::msg!(
            "net.unfurl.too-many-redirects",
            "too many redirects"
        ))))
    }
}

enum FetchEnd {
    Refused(Refusal),
    Failed(anyhow::Error),
}

/// Resolve the URL's host and return one vetted PUBLIC address - or refuse. Every address
/// the name resolves to must be public: a name that answers with one public and one private
/// address is exactly the SSRF shape this exists to stop.
async fn vetted_addr(url: &url::Url) -> Result<IpAddr, Refusal> {
    let host = url
        .host_str()
        .ok_or_else(|| Refusal::BadTarget(crate::msg!("net.unfurl.no-host", "no host")))?;
    let port = url.port_or_known_default().unwrap_or(80);
    // A literal IP skips DNS but not the vetting.
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if is_public(ip) {
            Ok(ip)
        } else {
            Err(Refusal::BadTarget(crate::msg!(
                "net.unfurl.address-is-not-public",
                "address is not public"
            )))
        };
    }
    let addrs: Vec<IpAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| {
            Refusal::BadTarget(crate::msg!(
                "net.unfurl.host-does-not-resolve",
                "host does not resolve"
            ))
        })?
        .map(|sa| sa.ip())
        .collect();
    if addrs.is_empty() {
        return Err(Refusal::BadTarget(crate::msg!(
            "net.unfurl.host-does-not-resolve-2",
            "host does not resolve"
        )));
    }
    if addrs.iter().any(|ip| !is_public(*ip)) {
        return Err(Refusal::BadTarget(crate::msg!(
            "net.unfurl.address-is-not-public-2",
            "address is not public"
        )));
    }
    Ok(addrs[0])
}

/// Download a media file from the open web for the publication bake (record::bake): the same
/// SSRF posture as unfurling - vetted public address, pinned resolution, no automatic
/// redirects - but returning the raw bytes under a hard cap instead of parsing HTML.
///
/// `allow_loopback` exists for the integration rigs, where "the open web" is the other test
/// node on 127.0.0.1; it is passed `config.local_test` and nothing else, so a production node
/// can never be talked into fetching from inside its own network.
pub async fn fetch_media_bytes(
    raw_url: &str,
    max_bytes: usize,
    allow_loopback: bool,
) -> Result<Vec<u8>, String> {
    let mut url = url::Url::parse(raw_url).map_err(|_| "that isn't a URL".to_string())?;
    for _hop in 0..3 {
        if !matches!(url.scheme(), "http" | "https") {
            return Err("only http(s) can be fetched".into());
        }
        let addr = if allow_loopback {
            // Test rigs only: resolve without the public-address demand.
            let host = url.host_str().ok_or_else(|| "no host".to_string())?;
            let port = url.port_or_known_default().unwrap_or(80);
            tokio::net::lookup_host((host, port))
                .await
                .ok()
                .and_then(|mut a| a.next())
                .map(|sa| sa.ip())
                .ok_or_else(|| "host does not resolve".to_string())?
        } else {
            vetted_addr(&url).await.map_err(|r| format!("{r:?}"))?
        };
        let host = url.host_str().unwrap_or_default().to_string();
        let port = url.port_or_known_default().unwrap_or(80);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy() // the pin above holds only for a direct dial
            .resolve(&host, std::net::SocketAddr::new(addr, port))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("client: {e}"))?;
        let resp = client
            .get(url.clone())
            .header(reqwest::header::USER_AGENT, UA)
            .send()
            .await
            .map_err(|e| format!("fetch failed: {e}"))?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect without a location".to_string())?;
            // Each hop re-vets: a public host redirecting inward is the classic bounce.
            url = url.join(loc).map_err(|_| "unfollowable redirect".to_string())?;
            continue;
        }
        if !resp.status().is_success() {
            return Err(format!("the server answered {}", resp.status()));
        }
        if let Some(len) = resp.content_length() {
            if len as usize > max_bytes {
                return Err(format!("file is larger than the {max_bytes}-byte cap"));
            }
        }
        let mut bytes = Vec::new();
        let mut stream = resp;
        loop {
            match stream.chunk().await {
                Ok(Some(chunk)) => {
                    if bytes.len() + chunk.len() > max_bytes {
                        return Err(format!("file exceeded the {max_bytes}-byte cap mid-read"));
                    }
                    bytes.extend_from_slice(&chunk);
                }
                Ok(None) => return Ok(bytes),
                Err(e) => return Err(format!("read failed: {e}")),
            }
        }
    }
    Err("too many redirects".into())
}

/// Public-internet address check: everything a node must refuse to dial on a user's say-so.
///
/// An IPv6 address that carries an IPv4 one is judged by the IPv4 address inside it (security
/// pass, 2026-10-21): on a NAT64 network - an IPv6-only phone's, or a home router's -
/// `64:ff9b::c0a8:0101` IS 192.168.1.1, and 6to4 (`2002:c0a8:0101::`) and the old
/// IPv4-compatible form (`::c0a8:0101`) are the same trick. The reserved IPv4 blocks no
/// internet host lives in (0/8, 192.0.0/24, the 198.18/15 benchmarking range, 240/4) and IPv6's
/// retired site-local fec0::/10 are refused with the private ranges.
pub(crate) fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // Carrier-grade NAT (100.64/10): inside somebody's network, not the internet.
                || (a == 100 && (b & 0xC0) == 64)
                // "This network" (0/8): 0.x.y.z dials the local host on Linux.
                || a == 0
                // IETF protocol assignments (192.0.0/24) and benchmarking (198.18/15).
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b & 0xFE) == 18)
                // Reserved (240/4), never assigned.
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(mapped));
            }
            if let Some(carried) = carried_ipv4(&v6) {
                return is_public(IpAddr::V4(carried));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Unique-local fc00::/7, link-local fe80::/10, and retired site-local fec0::/10.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xffc0) == 0xfec0)
        }
    }
}

/// The IPv4 address an IPv6 one is a wrapper for, by NAT64 (64:ff9b::/96 and the local-use
/// 64:ff9b:1::/48, the address in the last 32 bits), 6to4 (2002::/16, in bits 16-48) or the
/// deprecated IPv4-compatible form (::/96). `is_public` judges the IPv4 address instead.
fn carried_ipv4(v6: &std::net::Ipv6Addr) -> Option<std::net::Ipv4Addr> {
    let s = v6.segments();
    let tail =
        || std::net::Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8);
    if s[0] == 0x64 && s[1] == 0xff9b && (s[2..6] == [0, 0, 0, 0] || s[2] == 1) {
        return Some(tail());
    }
    if s[0] == 0x2002 {
        return Some(std::net::Ipv4Addr::new(
            (s[1] >> 8) as u8,
            s[1] as u8,
            (s[2] >> 8) as u8,
            s[2] as u8,
        ));
    }
    // ::/96 holds :: and ::1 too, which the checks after this already refuse by name.
    if s[0..6] == [0, 0, 0, 0, 0, 0] && !(s[6] == 0 && s[7] <= 1) {
        return Some(tail());
    }
    None
}

/// Read at most `cap` bytes of the body, then hang up - a huge or hostile page can't balloon
/// memory, and the metadata we want lives up top anyway.
async fn read_capped(res: reqwest::Response, cap: usize) -> anyhow::Result<String> {
    use n0_future::StreamExt;
    let mut out: Vec<u8> = Vec::new();
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        let room = cap - out.len();
        out.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if out.len() >= cap {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&out).into_owned())
}

/// The OpenGraph parse: marquee-markup's `parse_open_graph`, the same rules and entity
/// table as the npm turbolink package (og:title else `<title>` required; og:description
/// else `name=description`, og:image and og:site_name ride along; numeric and named
/// references decode in one pass). This was a hand-rolled port from 2026-07-25, before the
/// Rust crate carried it; the port grew a third copy of the entity table on 2026-09-03 and
/// was retired the same day (Curtis: "why did we have to hand-roll a port of this other
/// code that we... already have?"). Ringtome keeps the fetch, its byte budget, the
/// private-address guard, the rate bucket, and the cache around it.
pub fn parse_open_graph(html: &str) -> Option<Summary> {
    let s = marquee_markup::opengraph::parse_open_graph(html)?;
    let title = s.title.filter(|t| !t.is_empty())?;
    Some(Summary { title, description: s.description, image: s.image, site: s.site })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The crate's own parse budget (marquee-markup reads 64 KiB of head, as the npm
    /// package does); the byte-budget claim below pins that ringtome still gets it.
    const MAX_PARSE_BYTES: usize = 65536;

    #[test]
    fn opengraph_tags_win_and_entities_decode() {
        let html = r#"<html><head>
            <title>Fallback</title>
            <meta property="og:title" content="Ringtome &amp; Friends" />
            <meta property="og:description" content="a &quot;cozy&quot; p2p web"/>
            <meta property="og:image" content="https://example.com/cover.png">
            <meta property="og:site_name" content='Example'>
        </head></html>"#;
        let s = parse_open_graph(html).expect("a card");
        assert_eq!(s.title, "Ringtome & Friends");
        assert_eq!(s.description.as_deref(), Some("a \"cozy\" p2p web"));
        assert_eq!(s.image.as_deref(), Some("https://example.com/cover.png"));
        assert_eq!(s.site.as_deref(), Some("Example"));
    }

    #[test]
    fn numeric_and_named_references_decode_through_the_crate() {
        // The CBC case (Curtis, 2026-09-03): React/Helmet heads write apostrophes as hex
        // references, and the card read "Trump&#x27;s". The decoding is the crate's; this
        // claim is that ringtome's door reaches it.
        let html = r#"<head>
            <meta property="og:title" content="Republicans are blaming Canada for Trump&#x27;s trade war">
            <meta property="og:description" content="Carney&#39;s government &ldquo;walked&rdquo; &amp;#x27; &bogus;">
        </head>"#;
        let s = parse_open_graph(html).expect("a card");
        assert_eq!(s.title, "Republicans are blaming Canada for Trump's trade war");
        assert_eq!(
            s.description.as_deref(),
            Some("Carney's government \u{201c}walked\u{201d} &#x27; &bogus;"),
            "decimal and named decode; an escaped reference stays literal; an unknown name stays as written"
        );
    }

    #[test]
    fn title_tag_and_meta_description_are_the_fallbacks() {
        let html = r#"<head><TITLE> Plain Page </TITLE>
            <meta name="description" content="no opengraph here"></head>"#;
        let s = parse_open_graph(html).expect("a card");
        assert_eq!(s.title, "Plain Page");
        assert_eq!(s.description.as_deref(), Some("no opengraph here"));
        assert_eq!(s.image, None);
    }

    #[test]
    fn a_titleless_page_is_no_card_at_all() {
        assert_eq!(parse_open_graph("<p>just a body</p>"), None);
        let empty_title = r#"<meta property="og:title" content="">"#;
        assert_eq!(parse_open_graph(empty_title), None);
    }

    #[test]
    fn attribute_order_and_case_do_not_matter() {
        let html = r#"<META CONTENT="Reversed" PROPERTY="og:title">"#;
        assert_eq!(parse_open_graph(html).unwrap().title, "Reversed");
    }

    #[test]
    fn a_content_that_merely_mentions_property_is_not_fooled() {
        // "property" appearing inside another attribute's value must not match.
        let html = r#"<meta data-x="property" name="og:title" content="Real">"#;
        assert_eq!(parse_open_graph(html).unwrap().title, "Real");
    }

    #[test]
    fn the_parse_stays_inside_its_byte_budget() {
        // A huge preamble pushes the meta past the cap: no card, no panic - and a multibyte
        // char straddling the cap boundary must not split.
        let mut html = "x".repeat(MAX_PARSE_BYTES - 1);
        html.push('é');
        html.push_str(r#"<meta property="og:title" content="Too Deep">"#);
        assert_eq!(parse_open_graph(&html), None);
    }

    #[test]
    fn private_addresses_are_not_public() {
        for bad in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "0.0.0.0",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:192.168.1.1",
            // IPv4 inside IPv6: NAT64 (both prefixes), 6to4, IPv4-compatible.
            "64:ff9b::c0a8:101",
            "64:ff9b::7f00:1",
            "64:ff9b:1::a00:1",
            "2002:c0a8:101::1",
            "2002:7f00:1::",
            "::c0a8:101",
            // Reserved IPv4 and retired site-local IPv6.
            "0.1.2.3",
            "192.0.0.8",
            "198.18.0.1",
            "198.19.255.255",
            "240.0.0.1",
            "255.255.255.255",
            "fec0::1",
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad} must be refused");
        }
        for good in [
            "93.184.216.34",
            "2606:2800:220:1:248:1893:25c8:1946",
            "1.1.1.1",
            // A wrapped PUBLIC address is still public: NAT64 networks must keep their previews.
            "64:ff9b::101:101",
            "2002:101:101::1",
            "198.20.0.1",
        ] {
            assert!(is_public(good.parse().unwrap()), "{good} must pass");
        }
    }

    #[test]
    fn the_bucket_grants_a_burst_then_meters() {
        let mut b = Bucket::new(30.0); // 30/min = one token per 2s sustained
        for _ in 0..30 {
            assert!(b.take(1_000));
        }
        assert!(!b.take(1_000), "the burst is spent");
        assert!(!b.take(2_000), "half a second short of a token");
        assert!(b.take(3_100), "refilled at the sustained rate");
        assert!(!b.take(3_200), "and only that one");
    }

    #[test]
    fn a_bigger_node_gets_a_bigger_budget_and_nonsense_gets_the_default() {
        let mut big = Bucket::new(300.0);
        for _ in 0..300 {
            assert!(big.take(1_000), "a many-user node's burst matches its rate");
        }
        assert!(!big.take(1_000));

        // Zero, negative, and NaN must not disable the brake.
        for bad in [0.0, -5.0, f64::NAN] {
            let b = Bucket::new(bad);
            assert_eq!(b.per_min, DEFAULT_RATE_PER_MIN, "{bad} falls back");
        }
    }
}
