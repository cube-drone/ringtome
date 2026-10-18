//! Custom domains, slice 3: serving one (plans/CUSTOM_DOMAINS.md, section 3). A request whose
//! `Host` is a domain this node serves is that persona's website: `/` their page, `/<path>` a post
//! or a folder as under `/@name/`, their feed and sitemap at the usual names, and their
//! `/.well-known/ringtome` saying the domain is served (ruling 7). Everything else a page needs -
//! the API, the app's own files, pictures - passes through untouched.
//!
//! A node serves a domain when custom domains are on (`RINGTOME_CUSTOM_DOMAINS`, ruling 3), the
//! persona claiming it is served from here, and its claim is proved by TXT (the well-known file
//! earns only the ✓, ruling 4). The front in front of the node gets the certificate and forwards
//! the `Host` header (section 6); the node never sees HTTPS.
//!
//! The domain is a reading site, never a second front door (section 5): it takes GET and HEAD
//! only, sets no cookie, and the node's own pages - signing in, the console, other people - are
//! sent to the node's public URL.
//!
//! The router runs before routing, as the service around the whole app (lib.rs): it rewrites
//! `/leek-soup` to `/ringtome/user/<them>/leek-soup` and lets the router do the rest, with the site
//! in [`current`] for whatever draws the page.
use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;
use axum::extract::{Request, State};
use axum::http::{header, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Redirect, Response};
use axum::Json;

use crate::error::AppError;
use crate::AppState;

/// A domain this node serves, and whose it is.
#[derive(Debug, Clone)]
pub struct Site {
    pub domain: String,
    pub root: [u8; 32],
    /// The persona's short address, which the node's own paths take.
    pub seg: String,
    pub verified_ms: Option<i64>,
}

tokio::task_local! {
    static SITE: Site;
}

/// The site the request being answered arrived at, if it came by a persona's own domain.
pub fn current() -> Option<Site> {
    SITE.try_with(|s| s.clone()).ok()
}

/// Every domain this node serves, by domain - a few rows, read once and kept while the memo and
/// the identities stand (`db::writes_to`, as `identity::hosted` keeps its own).
async fn sites(state: &AppState) -> Arc<HashMap<String, Site>> {
    type Kept = HashMap<String, (u64, Arc<HashMap<String, Site>>)>;
    static KEPT: std::sync::LazyLock<std::sync::Mutex<Kept>> =
        std::sync::LazyLock::new(Default::default);
    if !state.config.custom_domains {
        return Arc::default();
    }
    let key = state.node_db.writes_key().to_string();
    let at = crate::db::writes_to(&key, "domain_proofs")
        + crate::db::writes_to(&key, "identities")
        + crate::db::writes_to(&key, "accounts")
        + crate::db::writes_to(&key, "account_tags");
    if let Some((kept_at, sites)) = KEPT.lock().expect("sites poisoned").get(&key) {
        if *kept_at == at {
            return sites.clone();
        }
    }
    let sites = match read_sites(state).await {
        Ok(sites) => Arc::new(sites),
        Err(e) => {
            tracing::warn!(error = ?e, "reading the served domains");
            return Arc::default();
        }
    };
    KEPT.lock().expect("sites poisoned").insert(key, (at, sites.clone()));
    sites
}

async fn read_sites(state: &AppState) -> anyhow::Result<HashMap<String, Site>> {
    let rows: Vec<(String, String, Option<i64>)> = state
        .node_db
        .fetch_all(
            "SELECT root, domain, verified_ms FROM domain_proofs
             WHERE state = 'verified' AND proof = 'txt'",
            (),
        )
        .await
        .context("listing proved domains")?;
    // Any persona hosted here: its `/@name` page answers already, and the claim is its consent.
    // (Not `served_roots`: that flag is the retired publication act, which the app never sets -
    // 2026-10-18, a proved domain no node would serve.)
    // And for now, only an administrator's (`domains::allowed`).
    let admins = crate::auth::accounts_tagged(&state.node_db, crate::auth::TAG_NODE_ADMIN)
        .await
        .map_err(|e| anyhow::anyhow!("listing administrators: {e:?}"))?;
    let hosted: Vec<String> = crate::identity::hosted_roots_with_accounts(&state.node_db)
        .await
        .map_err(|e| anyhow::anyhow!("listing hosted personas: {e:?}"))?
        .into_iter()
        .filter(|(_, account)| admins.contains(account))
        .map(|(root, _)| root)
        .collect();
    Ok(rows
        .into_iter()
        .filter(|(root, _, _)| hosted.contains(root))
        .filter_map(|(root_hex, domain, verified_ms)| {
            let root = crate::pubkey::decode(&root_hex)?;
            let seg = crate::webpath::short_of(&root);
            Some((domain.clone(), Site { domain, root, seg, verified_ms }))
        })
        .collect())
}

/// The domain `root_hex` is served at here, if it is.
pub async fn site_of_root(state: &AppState, root_hex: &str) -> Option<Site> {
    let root = crate::pubkey::decode(root_hex)?;
    sites(state).await.values().find(|s| s.root == root).cloned()
}

/// On the node serving `root_hex`'s domain, its `/@name/<rest>` goes there (section 4) - once the
/// domain says it's served (ruling 7), so never to a site that isn't ours yet. Temporary, because
/// a domain can lapse, and a browser keeps a permanent redirect for good.
pub async fn sent_home(
    state: &AppState,
    root_hex: &str,
    rest: &str,
    query: Option<&str>,
) -> Option<Response> {
    let site = site_of_root(state, root_hex).await?;
    crate::domains::canonical(&state.node_db, root_hex).await.filter(|d| *d == site.domain)?;
    let query = query.map(|q| format!("?{q}")).unwrap_or_default();
    let rest = rest.trim_matches('/');
    Some(Redirect::temporary(&format!("https://{}/{rest}{query}", site.domain)).into_response())
}

/// The hostname a request asked for, lowercase, without its port.
fn host_of(req: &Request) -> Option<String> {
    let raw = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_string)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_string()))?;
    let host = raw.rsplit_once(':').filter(|(_, port)| port.parse::<u16>().is_ok());
    let host = host.map(|(h, _)| h).unwrap_or(&raw);
    Some(host.trim_end_matches('.').to_ascii_lowercase())
}

/// The site a request arrived at: a served domain, or None for the node's own name and anything
/// else.
async fn site_for(state: &AppState, host: Option<String>) -> Option<Site> {
    let host = host?;
    // Cheap refusals first: what a claim can never be, and the node's own name.
    if !host.contains('.') || host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let own = state.config.public_url.as_deref().and_then(|u| url::Url::parse(u).ok());
    if own.as_ref().and_then(|u| u.host_str()) == Some(host.as_str()) {
        return None;
    }
    sites(state).await.get(&host).cloned()
}

/// Where a path on a persona's domain goes.
#[derive(Debug, PartialEq)]
enum Place {
    /// The node's own files - the API, the app, pictures: untouched.
    Through,
    /// The persona's: this, under their address.
    Persona(String),
    /// Their feed (`/feed.xml`, and `/index.xml`, Hugo's: ruling 6).
    Feed,
    /// Their address in the node's own form: here, at this.
    Home(String),
    /// An @name: theirs is here, anyone else's is the node's.
    AtName(String, String),
    /// The node's own pages: at its public URL.
    Node,
}

/// Where `path` on `site`'s domain goes. Pure.
fn place(site_root: &[u8; 32], path: &str) -> Place {
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let through_root = ["favicon.ico", "favicon.svg", "apple-touch-icon.png", "health"]
        .contains(&path.trim_start_matches('/'));
    match parts.as_slice() {
        _ if through_root => Place::Through,
        ["api" | "static" | "fonts", _, ..] => Place::Through,
        ["feed.xml" | "index.xml"] => Place::Feed,
        // A picture or a post's words, anyone's: what a page shows is fetched from where it is.
        ["ringtome", "user", _, "doc", _, "body" | "thumb", ..]
        | ["ringtome", "user", _, "post", _, "epub"]
        | ["ringtome", "user", _, "rss.xml"]
        | ["id", _, "docs", _, "body" | "thumb", ..] => Place::Through,
        ["ringtome", "user", seg, rest @ ..] if matches!(crate::speakable::parse(seg), Some(crate::speakable::Parsed::Ok(r)) if r == *site_root) => {
            Place::Home(format!("/{}", rest.join("/")))
        }
        ["ringtome", ..] | ["id", ..] | ["upload", ..] => Place::Node,
        [at, rest @ ..] if at.starts_with('@') => {
            Place::AtName(at.trim_start_matches('@').to_string(), rest.join("/"))
        }
        [""] => Place::Persona(String::new()),
        _ => Place::Persona(path.trim_end_matches('/').to_string()),
    }
}

/// The router: a request to a served domain answered as that persona's website, anything else
/// passed on as it came. Runs around the whole app (lib.rs), before routing.
pub async fn route(State(state): State<AppState>, req: Request, next: Next) -> Response {
    // The host read first: a request isn't Sync, so it can't be held across a wait.
    let host = host_of(&req);
    let Some(site) = site_for(&state, host).await else {
        return next.run(req).await;
    };
    let mut response = SITE.scope(site.clone(), answer(&state, &site, req, next)).await;
    // A reading site: no cookie of the node's is ever set on it (section 5).
    response.headers_mut().remove(header::SET_COOKIE);
    response
}

async fn answer(state: &AppState, site: &Site, mut req: Request, next: Next) -> Response {
    if !matches!(*req.method(), Method::GET | Method::HEAD) {
        return AppError::Forbidden(crate::msg!(
            "domainsite.reading-only",
            "a person's own domain is for reading"
        ))
        .into_response();
    }
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
    match path.as_str() {
        "/.well-known/ringtome" => {
            return crate::crawl::for_anyone(Json(crate::domains::well_known_body(&site.root)))
        }
        "/robots.txt" => return crate::crawl::domain_robots(state, &site.root, &site.domain).await,
        "/sitemap.xml" => {
            return crate::crawl::domain_sitemap(state, &site.root, &site.domain).await
        }
        _ => {}
    }
    let to = match place(&site.root, &path) {
        Place::Through => None,
        Place::Persona(rest) => Some(format!("/ringtome/user/{}{rest}{query}", site.seg)),
        Place::Feed => Some(format!("/ringtome/user/{}/rss.xml", site.seg)),
        Place::Home(rest) => return Redirect::permanent(&format!("{rest}{query}")).into_response(),
        Place::AtName(slug, rest) => {
            let theirs = crate::slugs::resolve(&state.node_db, &slug)
                .await
                .ok()
                .flatten()
                .is_some_and(|(root, _)| crate::pubkey::decode(&root) == Some(site.root));
            if theirs {
                return Redirect::permanent(&format!("/{rest}{query}")).into_response();
            }
            return to_node(state, &path, &query);
        }
        Place::Node => return to_node(state, &path, &query),
    };
    if let Some(to) = to {
        match Uri::try_from(to) {
            Ok(uri) => *req.uri_mut() = uri,
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        }
    }
    next.run(req).await
}

/// The node's own page, at the node's own address - or nothing, for a node without one.
fn to_node(state: &AppState, path: &str, query: &str) -> Response {
    if !crate::webpath::has_public_url(state) {
        return StatusCode::NOT_FOUND.into_response();
    }
    Redirect::to(&format!("{}{path}{query}", crate::webpath::public_url(state))).into_response()
}

/// `GET /api/node/domains`: the domains this node serves, for whatever keeps the front's
/// certificates in step (section 6) - each with the persona's root and when its claim was last
/// proved. What DNS already says to anyone who asks.
pub async fn domains_handler(State(state): State<AppState>) -> Result<Response, AppError> {
    let sites = sites(&state).await;
    let mut domains: Vec<&Site> = sites.values().collect();
    domains.sort_by(|a, b| a.domain.cmp(&b.domain));
    let domains: Vec<serde_json::Value> = domains
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "domain": s.domain,
                "root": hex::encode(s.root),
                "verified_ms": s.verified_ms,
            })
        })
        .collect();
    Ok(crate::crawl::for_anyone(Json(serde_json::json!({ "domains": domains }))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_on_the_domain_is_the_persona_s_unless_it_is_the_node_s() {
        let root = [7u8; 32];
        let seg = crate::webpath::short_of(&root);
        let other = crate::webpath::short_of(&[8u8; 32]);
        assert_eq!(place(&root, "/"), Place::Persona(String::new()));
        assert_eq!(place(&root, "/leek-soup"), Place::Persona("/leek-soup".into()));
        assert_eq!(place(&root, "/recipes/leek/"), Place::Persona("/recipes/leek".into()));
        assert_eq!(place(&root, "/post/ab12"), Place::Persona("/post/ab12".into()));
        assert_eq!(
            place(&root, "/home"),
            Place::Persona("/home".into()),
            "a post may be called that"
        );
        assert_eq!(place(&root, "/api"), Place::Persona("/api".into()), "...and that");
        assert_eq!(place(&root, "/api/node"), Place::Through);
        assert_eq!(place(&root, "/static/1/app.js"), Place::Through);
        assert_eq!(place(&root, "/favicon.svg"), Place::Through);
        assert_eq!(place(&root, "/index.xml"), Place::Feed);
        assert_eq!(place(&root, "/feed.xml"), Place::Feed);
        assert_eq!(place(&root, &format!("/ringtome/user/{other}/doc/ab/thumb")), Place::Through);
        assert_eq!(
            place(&root, &format!("/ringtome/user/{seg}/leek")),
            Place::Home("/leek".into())
        );
        assert_eq!(place(&root, &format!("/ringtome/user/{seg}")), Place::Home("/".into()));
        assert_eq!(place(&root, &format!("/ringtome/user/{other}")), Place::Node);
        assert_eq!(place(&root, "/ringtome/settings"), Place::Node);
        assert_eq!(place(&root, "/@ada/leek"), Place::AtName("ada".into(), "leek".into()));
        assert_eq!(
            place(&root, "/sw.js"),
            Place::Persona("/sw.js".into()),
            "no service worker here"
        );
    }
}
