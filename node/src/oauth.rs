//! OAuth for AI assistants (plans/MCP.md, Slice 5): how claude.ai, ChatGPT and their kind connect
//! to `/mcp` without anyone pasting a key into them.
//!
//! The node is its own authorization server, and the token it issues is **an ordinary API key**
//! (auth/keys.rs `mint`), named after the client and listed under API keys with the rest. That one
//! choice keeps three rules where they already are: keys are made from a signed-in browser (the
//! consent page is that browser, and the consent door refuses a key); a key is revoked in one place;
//! and `/mcp`'s door is unchanged - it takes `rtk_` keys, and this only mints them.
//!
//! The flow is the one the MCP authorization spec asks for (2026-07-28 revision, as rmcp 3.5's
//! client follows it): a 401 from `/mcp` names the protected-resource metadata (RFC 9728), which
//! names this node as the authorization server, whose metadata (RFC 8414) names the doors. A client
//! identifies itself by a **Client ID Metadata Document** - its id is an HTTPS URL describing it,
//! fetched here with the unfurler's SSRF posture (net/unfurl.rs) - or, failing that, by **Dynamic
//! Client Registration** (RFC 7591) into `oauth_clients`. Authorization is the code flow with PKCE,
//! S256 only (the spec's clients refuse a server without it). Codes are single-use, minutes long,
//! and kept by their hash.
//!
//! No refresh tokens, and no expiry: an API key lives until it's revoked, which is what a person
//! connecting their assistant expects, and what the settings page already shows them how to undo.
//!
//! Owns the `oauth_clients` and `oauth_codes` SQL (tests/conventions.rs).

pub mod routes;

use anyhow::Context;
use base64::Engine;
use rand::RngCore;
use serde::Deserialize;
use sha2::Digest;

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// How long a code waits for the token request.
const CODE_LIFE_MS: i64 = 5 * 60 * 1000;
/// A registered client's id starts so, as a key's starts `rtk_` - recognisable in a log.
const CLIENT_PREFIX: &str = "rtc_";
/// The most clients that may register themselves on one node. The door is open to anyone (the
/// spec's dynamic registration is unauthenticated), so it is bounded.
const CLIENTS_MAX: i64 = 5_000;
/// The most redirect URIs one client may name.
const REDIRECTS_MAX: usize = 8;
/// A client's name, at most - it becomes the name of the key it is given.
const NAME_MAX: usize = 60;
/// A Client ID Metadata Document, at most: a short JSON description.
const METADATA_DOC_MAX: usize = 16 * 1024;

/// An OAuth refusal, in the protocol's words (RFC 6749 §5.2): a code and a description, for a
/// client program rather than a person.
#[derive(Debug)]
pub struct Refusal {
    pub error: &'static str,
    pub description: String,
}

impl Refusal {
    fn new(error: &'static str, description: impl Into<String>) -> Self {
        Self { error, description: description.into() }
    }
}

/// A client, however it is known: registered here, or described by its metadata document.
#[derive(Debug, Clone, PartialEq)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub redirect_uris: Vec<String>,
}

/// What a client asked to be authorized for (the authorization request's query, RFC 6749 §4.1.1
/// with PKCE, RFC 7636): carried from the consent page to the consent door unchanged.
#[derive(Debug, Clone, Deserialize)]
pub struct Ask {
    pub response_type: Option<String>,
    pub client_id: String,
    pub redirect_uri: String,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub state: Option<String>,
    pub resource: Option<String>,
}

/// The PKCE check (RFC 7636 §4.6, S256): the verifier, hashed and base64url'd, is the challenge.
pub fn pkce_matches(verifier: &str, challenge: &str) -> bool {
    // A verifier is 43-128 unreserved characters; anything else is not one.
    let well_formed = (43..=128).contains(&verifier.len())
        && verifier.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~".contains(&b));
    if !well_formed {
        return false;
    }
    let hashed = sha2::Sha256::digest(verifier.as_bytes());
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hashed);
    crate::auth::secret_eq(&encoded, challenge)
}

/// May a code go to `asked`, for a client that registered `registered`? Exactly one of them - or,
/// for a loopback address, one of them on any port (RFC 8252 §7.3: a native app takes whatever port
/// its machine gives it, and can't register it ahead of time).
pub fn redirect_allowed(registered: &[String], asked: &str) -> bool {
    if registered.iter().any(|r| r == asked) {
        return true;
    }
    let Ok(asked) = url::Url::parse(asked) else { return false };
    if !is_loopback(&asked) {
        return false;
    }
    registered.iter().filter_map(|r| url::Url::parse(r).ok()).any(|r| {
        is_loopback(&r)
            && r.scheme() == asked.scheme()
            && r.host_str() == asked.host_str()
            && r.path() == asked.path()
    })
}

fn is_loopback(url: &url::Url) -> bool {
    url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
}

/// Is this a redirect URI a client may register? An absolute URL, and never one that runs or
/// reads something on arrival: `https`, `http` to the machine itself, or an app's own scheme
/// (RFC 8252 §7.1).
pub fn redirect_registrable(uri: &str) -> bool {
    let Ok(url) = url::Url::parse(uri) else { return false };
    if url.fragment().is_some() {
        return false; // RFC 6749 §3.1.2
    }
    match url.scheme() {
        "https" => true,
        "http" => is_loopback(&url),
        "javascript" | "data" | "file" | "blob" | "about" | "vbscript" | "ws" | "wss" => false,
        _ => true,
    }
}

fn random_hex() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash(code: &str) -> String {
    blake3::hash(code.as_bytes()).to_hex().to_string()
}

/// A client's name, trimmed to what a key's name holds.
fn name_of(given: Option<&str>) -> String {
    let name: String = given.unwrap_or_default().trim().chars().take(NAME_MAX).collect();
    if name.is_empty() {
        "an AI assistant".into()
    } else {
        name
    }
}

/// What a client sends to register (RFC 7591 §2): the fields this node reads; the rest it ignores.
#[derive(Debug, Deserialize)]
pub struct Registration {
    #[serde(default)]
    pub redirect_uris: Vec<String>,
    pub client_name: Option<String>,
}

/// Register a client (RFC 7591): every redirect URI checked, the node's cap kept.
pub async fn register(db: &Db, req: &Registration) -> Result<Client, Refusal> {
    if req.redirect_uris.is_empty() || req.redirect_uris.len() > REDIRECTS_MAX {
        return Err(Refusal::new(
            "invalid_redirect_uri",
            format!("name between 1 and {REDIRECTS_MAX} redirect URIs"),
        ));
    }
    if let Some(bad) = req.redirect_uris.iter().find(|u| !redirect_registrable(u)) {
        return Err(Refusal::new("invalid_redirect_uri", format!("{bad} can't be a redirect URI")));
    }
    let (held,): (i64,) = db
        .fetch_one("SELECT COUNT(*) FROM oauth_clients", ())
        .await
        .map_err(|e| Refusal::new("server_error", format!("{e:#}")))?;
    if held >= CLIENTS_MAX {
        return Err(Refusal::new(
            "temporarily_unavailable",
            "this node has registered all the clients it will",
        ));
    }
    let client = Client {
        id: format!("{CLIENT_PREFIX}{}", &random_hex()[..32]),
        name: name_of(req.client_name.as_deref()),
        redirect_uris: req.redirect_uris.clone(),
    };
    let uris = serde_json::to_string(&client.redirect_uris).unwrap_or_else(|_| "[]".into());
    db.execute(
        "INSERT INTO oauth_clients (client_id, name, redirect_uris, created_ms) VALUES (?1, ?2, ?3, ?4)",
        (client.id.as_str(), client.name.as_str(), uris, now_ms()),
    )
    .await
    .map_err(|e| Refusal::new("server_error", format!("{e:#}")))?;
    tracing::info!(client = %client.id, name = %client.name, "an OAuth client registered");
    Ok(client)
}

/// The client a `client_id` names: a URL is a Client ID Metadata Document, fetched and checked; an
/// `rtc_` id is one registered here.
pub async fn client(state: &AppState, client_id: &str) -> Result<Client, Refusal> {
    if client_id.starts_with("https://") || client_id.starts_with("http://") {
        return described(state, client_id).await;
    }
    let row: Option<(String, String)> = state
        .node_db
        .fetch_optional(
            "SELECT name, redirect_uris FROM oauth_clients WHERE client_id = ?1",
            (client_id,),
        )
        .await
        .map_err(|e| Refusal::new("server_error", format!("{e:#}")))?;
    let Some((name, uris)) = row else {
        return Err(Refusal::new("invalid_client", "no such client here"));
    };
    Ok(Client {
        id: client_id.to_string(),
        name,
        redirect_uris: serde_json::from_str(&uris).unwrap_or_default(),
    })
}

/// A Client ID Metadata Document (the MCP spec's preferred registration): the client's id is the
/// URL of a JSON document describing it, which must name itself by that same URL. HTTPS only - plain
/// HTTP for the test rig alone, whose "web" is its own loopback (net/unfurl.rs `fetch_media_bytes`).
async fn described(state: &AppState, url: &str) -> Result<Client, Refusal> {
    let local = state.config.local_test;
    if !url.starts_with("https://") && !local {
        return Err(Refusal::new(
            "invalid_client",
            "a client's metadata document is served over https",
        ));
    }
    let bytes =
        crate::net::unfurl::fetch_media_bytes(url, METADATA_DOC_MAX, local).await.map_err(|e| {
            Refusal::new(
                "invalid_client",
                format!("the client's metadata document didn't load: {e}"),
            )
        })?;
    #[derive(Deserialize)]
    struct Document {
        client_id: String,
        client_name: Option<String>,
        #[serde(default)]
        redirect_uris: Vec<String>,
    }
    let doc: Document = serde_json::from_slice(&bytes)
        .map_err(|_| Refusal::new("invalid_client", "the client's metadata document isn't JSON"))?;
    if doc.client_id != url {
        return Err(Refusal::new(
            "invalid_client",
            "the client's metadata document names another client",
        ));
    }
    if doc.redirect_uris.is_empty() || !doc.redirect_uris.iter().all(|u| redirect_registrable(u)) {
        return Err(Refusal::new(
            "invalid_client",
            "the client's metadata document names no usable redirect URI",
        ));
    }
    Ok(Client {
        id: doc.client_id,
        name: name_of(doc.client_name.as_deref()),
        redirect_uris: doc.redirect_uris,
    })
}

/// Check an authorization request as far as it can be checked without a person: the client, where
/// the code would go, and the PKCE challenge. What it answers is the client the consent page names.
pub async fn check(state: &AppState, ask: &Ask) -> Result<Client, Refusal> {
    let client = client(state, &ask.client_id).await?;
    if !redirect_allowed(&client.redirect_uris, &ask.redirect_uri) {
        return Err(Refusal::new(
            "invalid_request",
            "that redirect URI isn't one this client registered",
        ));
    }
    if ask.response_type.as_deref() != Some("code") {
        return Err(Refusal::new("unsupported_response_type", "only the code flow"));
    }
    if ask.code_challenge_method.as_deref() != Some("S256") {
        return Err(Refusal::new("invalid_request", "PKCE with S256 is required"));
    }
    let challenge = ask.code_challenge.as_deref().unwrap_or_default();
    if !(43..=128).contains(&challenge.len()) {
        return Err(Refusal::new("invalid_request", "a code_challenge is required"));
    }
    Ok(client)
}

/// The person said yes: a code for this client, to this redirect, under this challenge, for this
/// account. Expired codes are swept on the way.
pub async fn issue(db: &Db, client: &Client, ask: &Ask, account: &str) -> anyhow::Result<String> {
    let now = now_ms();
    db.execute("DELETE FROM oauth_codes WHERE expires_ms < ?1", (now,))
        .await
        .context("sweeping old OAuth codes")?;
    let code = random_hex();
    db.execute(
        "INSERT INTO oauth_codes (code_hash, client_id, client_name, redirect_uri, code_challenge, account_id, expires_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        (
            hash(&code),
            client.id.as_str(),
            client.name.as_str(),
            ask.redirect_uri.as_str(),
            ask.code_challenge.as_deref().unwrap_or_default(),
            account,
            now + CODE_LIFE_MS,
        ),
    )
    .await
    .context("keeping an OAuth code")?;
    Ok(code)
}

/// What a code was issued for, when it is redeemed.
pub struct Redeemed {
    pub account: String,
    pub client_name: String,
}

/// Redeem a code (RFC 6749 §4.1.3): once only - it is gone before anything is checked, so a stolen
/// one and its owner can't both succeed - unexpired, and for exactly the client, redirect and
/// verifier it was issued under.
pub async fn redeem(
    db: &Db,
    code: &str,
    client_id: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<Redeemed, Refusal> {
    let server = |e: anyhow::Error| Refusal::new("server_error", format!("{e:#}"));
    let row: Option<(String, String, String, String, String, i64)> = db
        .fetch_optional(
            "SELECT client_id, client_name, redirect_uri, code_challenge, account_id, expires_ms
             FROM oauth_codes WHERE code_hash = ?1",
            (hash(code),),
        )
        .await
        .map_err(server)?;
    let taken = db
        .execute("DELETE FROM oauth_codes WHERE code_hash = ?1", (hash(code),))
        .await
        .map_err(server)?;
    let invalid = || Refusal::new("invalid_grant", "that code isn't good");
    let Some((client, client_name, redirect, challenge, account, expires)) = row else {
        return Err(invalid());
    };
    if taken == 0 || expires < now_ms() || client != client_id || redirect != redirect_uri {
        return Err(invalid());
    }
    if !pkce_matches(verifier, &challenge) {
        return Err(Refusal::new("invalid_grant", "the code_verifier doesn't match"));
    }
    Ok(Redeemed { account, client_name })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_is_the_rfcs_own_example() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert!(pkce_matches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
        assert!(!pkce_matches(verifier, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cX"));
        assert!(!pkce_matches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    }

    #[test]
    fn a_code_goes_only_where_the_client_said_or_to_its_loopback_on_any_port() {
        let registered = vec![
            "https://claude.ai/api/mcp/auth_callback".to_string(),
            "http://127.0.0.1:33418/cb".to_string(),
        ];
        assert!(redirect_allowed(&registered, "https://claude.ai/api/mcp/auth_callback"));
        assert!(
            redirect_allowed(&registered, "http://127.0.0.1:50123/cb"),
            "loopback, another port"
        );
        assert!(
            !redirect_allowed(&registered, "http://127.0.0.1:50123/elsewhere"),
            "not another path"
        );
        assert!(!redirect_allowed(
            &registered,
            "https://claude.ai.evil.example/api/mcp/auth_callback"
        ));
        assert!(!redirect_allowed(&registered, "https://claude.ai/api/mcp/auth_callback?x=1"));
    }

    #[test]
    fn only_a_redirect_that_runs_nothing_registers() {
        assert!(redirect_registrable("https://example.com/cb"));
        assert!(redirect_registrable("http://localhost:8080/cb"));
        assert!(redirect_registrable("cursor://anysphere.cursor-retrieval/oauth/callback"));
        assert!(
            !redirect_registrable("http://example.com/cb"),
            "plain http only to the machine itself"
        );
        assert!(!redirect_registrable("javascript:alert(1)"));
        assert!(!redirect_registrable("https://example.com/cb#frag"));
        assert!(!redirect_registrable("not a url"));
    }
}
