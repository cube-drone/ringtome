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
    BadTarget(String),
    /// The global outbound budget is spent right now.
    RateLimited,
}

/// Fallback outbound budget when config hands us nonsense: see `Config::unfurl_rate_per_min`
/// for the real knob (single-user nodes are fine at the default 30/min; a many-user node
/// raises it).
const DEFAULT_RATE_PER_MIN: f64 = 30.0;
/// Bounded download: OpenGraph metadata lives at the top of the document.
const MAX_BODY_BYTES: usize = 128 * 1024;
/// And the parse looks at even less (matches marquee-turbolink).
const MAX_PARSE_BYTES: usize = 65536;
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
        let per_min = if per_min.is_finite() && per_min >= 1.0 {
            per_min
        } else {
            DEFAULT_RATE_PER_MIN
        };
        Self {
            per_min,
            tokens: per_min,
            last_ms: 0,
        }
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
        let parsed = url::Url::parse(raw.trim())
            .map_err(|e| Refusal::BadTarget(format!("not a URL: {e}")))?;
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return Err(Refusal::BadTarget("only http and https unfurl".into()));
        }
        let key = parsed.to_string();
        if let Some(hit) = self.cache.get(&key).await {
            return Ok(hit);
        }
        if !self
            .bucket
            .lock()
            .expect("unfurl bucket poisoned")
            .take(crate::clock::now_ms())
        {
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
                    .ok_or_else(|| FetchEnd::Failed(anyhow::anyhow!("redirect without location")))?;
                url = url
                    .join(location)
                    .map_err(|e| FetchEnd::Failed(anyhow::anyhow!("bad redirect target: {e}")))?;
                if url.scheme() != "http" && url.scheme() != "https" {
                    return Err(FetchEnd::Refused(Refusal::BadTarget(
                        "redirected off the web".into(),
                    )));
                }
                continue;
            }
            if !res.status().is_success() {
                return Err(FetchEnd::Failed(anyhow::anyhow!("status {}", res.status())));
            }
            let body = read_capped(res, MAX_BODY_BYTES)
                .await
                .map_err(FetchEnd::Failed)?;
            return Ok(parse_open_graph(&body));
        }
        Err(FetchEnd::Refused(Refusal::BadTarget("too many redirects".into())))
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
        .ok_or_else(|| Refusal::BadTarget("no host".into()))?;
    let port = url.port_or_known_default().unwrap_or(80);
    // A literal IP skips DNS but not the vetting.
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if is_public(ip) {
            Ok(ip)
        } else {
            Err(Refusal::BadTarget("address is not public".into()))
        };
    }
    let addrs: Vec<IpAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| Refusal::BadTarget("host does not resolve".into()))?
        .map(|sa| sa.ip())
        .collect();
    if addrs.is_empty() {
        return Err(Refusal::BadTarget("host does not resolve".into()));
    }
    if addrs.iter().any(|ip| !is_public(*ip)) {
        return Err(Refusal::BadTarget("address is not public".into()));
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
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                // Carrier-grade NAT (100.64/10): inside somebody's network, not the internet.
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64))
        }
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(mapped));
            }
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                // Unique-local fc00::/7 and link-local fe80::/10.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80)
        }
    }
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

/// The OpenGraph parse, semantics matched to marquee-turbolink's `parseOpenGraph`: og:title
/// (else `<title>`) is required; og:description (else `name=description`), og:image and
/// og:site_name ride along; the five standard entities decode. Hand-rolled scanning rather
/// than a regex dependency - the grammar is just "meta tags near the top".
pub fn parse_open_graph(html: &str) -> Option<Summary> {
    let mut end = html.len().min(MAX_PARSE_BYTES);
    while end < html.len() && !html.is_char_boundary(end) {
        end += 1;
    }
    let head = &html[..end];

    let meta = |prop: &str| -> Option<String> {
        meta_content(head, prop).map(|v| decode_entities(&v))
    };
    let title = meta("og:title")
        .or_else(|| title_tag(head).map(|t| decode_entities(t.trim())))
        .filter(|t| !t.is_empty())?;
    Some(Summary {
        title,
        description: meta("og:description").or_else(|| meta("description")),
        image: meta("og:image"),
        site: meta("og:site_name"),
    })
}

/// Find `<meta ... property|name="prop" ... content="...">` (attribute order and quote style
/// free, ASCII case-insensitive) and return the raw content value.
fn meta_content(head: &str, prop: &str) -> Option<String> {
    let lower = head.to_ascii_lowercase();
    let mut from = 0;
    while let Some(pos) = lower[from..].find("<meta") {
        let start = from + pos;
        let end = lower[start..].find('>').map(|e| start + e)?;
        let tag = &head[start..end];
        let tag_lower = &lower[start..end];
        let named = attr_value(tag, tag_lower, "property")
            .or_else(|| attr_value(tag, tag_lower, "name"));
        if named.is_some_and(|v| v.eq_ignore_ascii_case(prop)) {
            if let Some(content) = attr_value(tag, tag_lower, "content") {
                if !content.is_empty() {
                    return Some(content.to_string());
                }
            }
        }
        from = end;
    }
    None
}

/// A quoted attribute's value within one tag. `tag_lower` is the same slice lowercased (so
/// the search is case-insensitive while the returned value keeps its case).
fn attr_value<'a>(tag: &'a str, tag_lower: &str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    loop {
        let pos = tag_lower[from..].find(name)? + from;
        // Must be a standalone attribute name: preceded by whitespace, followed by `=`.
        let before_ok = tag[..pos]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_whitespace());
        let rest = &tag[pos + name.len()..];
        let rest_trim = rest.trim_start();
        if before_ok && rest_trim.starts_with('=') {
            let after_eq = rest_trim[1..].trim_start();
            let quote = after_eq.chars().next()?;
            if quote == '"' || quote == '\'' {
                let value = &after_eq[1..];
                let close = value.find(quote)?;
                return Some(&value[..close]);
            }
        }
        from = pos + name.len();
    }
}

fn title_tag(head: &str) -> Option<&str> {
    let lower = head.to_ascii_lowercase();
    let open = lower.find("<title")?;
    let open_end = lower[open..].find('>').map(|e| open + e + 1)?;
    let close = lower[open_end..].find("</title").map(|e| open_end + e)?;
    Some(&head[open_end..close])
}

fn decode_entities(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;

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
        ] {
            assert!(!is_public(bad.parse().unwrap()), "{bad} must be refused");
        }
        for good in ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "1.1.1.1"] {
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
