//! Crawling (plans/CRAWLING.md): the public site, readable by search engines. Who is indexed, and
//! the doors a crawler reads besides the pages themselves - `/robots.txt`, the sitemap, the
//! node-wide feed - and the structured data a page's head carries.
//!
//! **Who is indexed** (rulings 2 and 3): a persona this node hosts, on a node with a public URL
//! (a sitemap's addresses must be absolute and the site's own), unless the node's operator says no
//! (`search_policy`), the persona says no (their profile's `search = no`), or they're off the
//! node's front page (`node_listing`). Everything else answers `noindex` and stays out of the
//! sitemap - though its pages still read the same to anyone who opens them.
//!
//! Owns the `search_policy` SQL (tests/conventions.rs).

use anyhow::Context;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use crate::error::AppError;
use crate::AppState;

/// The profile field a persona says no to search engines with, and the word for no.
pub const SEARCH_FIELD: &str = "search";
pub const SEARCH_NO: &str = "no";

/// A sitemap holds at most this many addresses (the protocol's own limit).
const SITEMAP_MAX: usize = 50_000;
/// The node-wide feed's window: its newest this many posts, as a person's is (rss.rs).
const FEED_ITEMS: i64 = 50;

/// Is the node open to search engines? Yes unless its operator said no.
pub async fn node_indexed(state: &AppState) -> bool {
    let row: Option<(i64,)> = state
        .node_db
        .fetch_optional("SELECT indexed FROM search_policy WHERE id = 1", ())
        .await
        .ok()
        .flatten();
    row.is_none_or(|(on,)| on != 0)
}

/// Is a persona's public face indexed? Hosted here (the caller's to know), on a node with a public
/// URL that's open to search engines, listed on its front page, and not opted out by their profile.
pub async fn indexable(
    state: &AppState,
    root_hex: &str,
    fields: &[crate::record::imaol::ProfileField],
) -> bool {
    crate::webpath::has_public_url(state)
        && crate::idface::profile_value(fields, SEARCH_FIELD) != Some(SEARCH_NO)
        && crate::nodeshelf::listed(&state.node_db, root_hex).await.unwrap_or(true)
        && node_indexed(state).await
}

/// The head's word to a crawler that a page isn't to be indexed.
pub const NOINDEX: &str = "\n<meta name=\"robots\" content=\"noindex\">";

/// Structured data for a head (JSON-LD), with `</` kept out of the script.
pub fn json_ld(value: &serde_json::Value) -> String {
    format!(
        "\n<script type=\"application/ld+json\">{}</script>",
        value.to_string().replace("</", "<\\/")
    )
}

/// A moment as a sitemap and JSON-LD write it: RFC 3339, UTC.
pub fn iso(ms: i64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .ok()
        .and_then(|t| t.format(&time::format_description::well_known::Rfc3339).ok())
        .unwrap_or_default()
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(serde::Deserialize)]
pub struct SetPolicy {
    pub indexed: bool,
}

/// GET `/api/admin/search-policy` - the Server app: whether search engines are welcome, and
/// whether the question means anything here (a node with no public URL is never indexed).
pub async fn policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::json!({
        "indexed": node_indexed(&state).await,
        "public": crate::webpath::has_public_url(&state),
    })))
}

/// PUT `/api/admin/search-policy` - welcome search engines here, or turn them away.
pub async fn set_policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
    Json(req): Json<SetPolicy>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO search_policy (id, indexed, updated_ms) VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET indexed = excluded.indexed, updated_ms = excluded.updated_ms",
            (i64::from(req.indexed), crate::clock::now_ms()),
        )
        .await
        .context("writing the search policy")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "indexed": req.indexed })))
}

fn text(status: StatusCode, content_type: &'static str, body: String) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, content_type), (header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
        body,
    )
        .into_response()
}

/// GET `/robots.txt` - the public pages welcome, the app and its doors not; the sitemap named.
/// A node with no public URL, or whose operator said no, turns every crawler away.
pub async fn robots_handler(State(state): State<AppState>) -> Response {
    let open = crate::webpath::has_public_url(&state) && node_indexed(&state).await;
    let body = if open {
        format!(
            "User-agent: *\n\
             Allow: /ringtome/user/\n\
             Disallow: /api/\n\
             Disallow: /ringtome/\n\
             Disallow: /home\n\
             Disallow: /upload/\n\
             \n\
             Sitemap: {}/sitemap.xml\n",
            crate::webpath::public_url(&state)
        )
    } else {
        "User-agent: *\nDisallow: /\n".to_string()
    };
    text(StatusCode::OK, "text/plain; charset=utf-8", body)
}

/// The personas whose pages are indexed, each with its root and profile.
async fn indexed_personas(
    state: &AppState,
) -> Vec<(String, [u8; 32], Vec<crate::record::imaol::ProfileField>)> {
    if !crate::webpath::has_public_url(state) || !node_indexed(state).await {
        return Vec::new();
    }
    let mut out = Vec::new();
    for root_hex in crate::identity::hosted_roots(&state.node_db).await.unwrap_or_default() {
        let Some(root) = crate::pubkey::decode(&root_hex) else { continue };
        let fields = crate::idface::public_profile(state, &root_hex).await.unwrap_or_default();
        if indexable(state, &root_hex, &fields).await {
            out.push((root_hex, root, fields));
        }
    }
    out
}

/// GET `/sitemap.xml` - the index: the node's own pages, and one sitemap per indexed person.
pub async fn sitemap_index_handler(State(state): State<AppState>) -> Result<Response, AppError> {
    if !crate::webpath::has_public_url(&state) || !node_indexed(&state).await {
        return Err(AppError::NotFound(crate::msg!(
            "crawl.no-sitemap",
            "this node keeps no sitemap"
        )));
    }
    let base = crate::webpath::public_url(&state);
    let mut maps =
        format!("<sitemap><loc>{}</loc></sitemap>\n", xml(&format!("{base}/sitemap/node.xml")));
    for (_, root, _) in indexed_personas(&state).await {
        maps.push_str(&format!(
            "<sitemap><loc>{}</loc></sitemap>\n",
            xml(&format!("{base}/sitemap/{}.xml", crate::webpath::short_of(&root)))
        ));
    }
    Ok(text(
        StatusCode::OK,
        "application/xml; charset=utf-8",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <sitemapindex xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{maps}</sitemapindex>\n"
        ),
    ))
}

/// GET `/sitemap/{name}.xml` - `node.xml`, the front page and the people page; or a person's, by
/// their short address: their page, and every post a stranger may read that has a page of its
/// own - posts, books and a book's pages, never a reply, a room or a sealed post.
pub async fn sitemap_handler(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Result<Response, AppError> {
    let missing = || AppError::NotFound(crate::msg!("crawl.no-such-sitemap", "no such sitemap"));
    let Some(name) = name.strip_suffix(".xml") else { return Err(missing()) };
    if !crate::webpath::has_public_url(&state) || !node_indexed(&state).await {
        return Err(missing());
    }
    let base = crate::webpath::public_url(&state);
    let url = |loc: &str, lastmod: Option<i64>| match lastmod {
        Some(ms) => format!(
            "<url><loc>{}</loc><lastmod>{}</lastmod></url>\n",
            xml(&format!("{base}{loc}")),
            iso(ms)
        ),
        None => format!("<url><loc>{}</loc></url>\n", xml(&format!("{base}{loc}"))),
    };
    let mut urls = String::new();
    if name == "node" {
        urls.push_str(&url("/feed", None));
        urls.push_str(&url("/people", None));
    } else {
        let Some(crate::speakable::Parsed::Ok(root)) = crate::speakable::parse(name) else {
            return Err(missing());
        };
        let root_hex = hex::encode(root);
        if !crate::idface::hosted_here(&state, &root_hex).await? {
            return Err(missing());
        }
        let fields = crate::idface::public_profile(&state, &root_hex).await.unwrap_or_default();
        if !indexable(&state, &root_hex, &fields).await {
            return Err(missing());
        }
        let Some(db) = state.user_dbs.get(&root_hex).await.map_err(AppError::Internal)? else {
            return Err(missing());
        };
        urls.push_str(&url(&crate::webpath::person_address(&state, &root).await, None));
        let mut after = None;
        let mut count = 1usize;
        'pages: loop {
            let page = crate::record::documents::public_docs(&db, after, 500).await?;
            let full = page.len() == 500;
            after = page.last().map(|p| (p.display_ms(), p.doc_id));
            for post in &page {
                if post.trusted_only
                    || post.reply_to.is_some()
                    || post.format == Some(ringtome_proto::registry::doc_format::ROOM)
                {
                    continue;
                }
                let doc_hex = hex::encode(post.doc_id);
                let loc = crate::webpath::post_address(&state, &root, &doc_hex).await;
                urls.push_str(&url(&loc, Some(post.head_ms)));
                count += 1;
                if count >= SITEMAP_MAX {
                    break 'pages;
                }
            }
            if !full {
                break;
            }
        }
    }
    Ok(text(
        StatusCode::OK,
        "application/xml; charset=utf-8",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>\n"
        ),
    ))
}

/// GET `/feed.xml` - the node's front page as RSS (ruling 4): its newest posts, every listed
/// person's, open ones only - the recent window, as a person's own feed is; the sitemap is the
/// whole archive. Read from the node's own shelf memo alone (nodeshelf.rs), never a person's
/// database per item (tests/conventions.rs `user_db_opens_are_deliberate`): each item is a title,
/// an author, a date and the post's address, which a reader follows for the words.
pub async fn node_feed_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
) -> Result<Response, AppError> {
    let base = crate::nodeface::public_base(&state, &headers);
    let rows = crate::nodeshelf::page(&state.node_db, None, FEED_ITEMS * 2)
        .await
        .map_err(AppError::Internal)?;
    let roots: Vec<String> = rows.iter().map(|r| r.author_root.clone()).collect();
    let names = crate::profiles::bylines(&state.node_db, &roots).await.unwrap_or_default();
    let mut items = String::new();
    let mut taken = 0;
    for row in rows {
        if taken >= FEED_ITEMS
            || row.via_root.is_some()
            || row.reply_to.is_some()
            || row.format.as_deref() == Some("room")
        {
            continue;
        }
        let Some(root) = crate::pubkey::decode(&row.author_root) else { continue };
        let name = names
            .get(&row.author_root)
            .and_then(|b| b.name.clone())
            .unwrap_or_else(|| crate::speakable::speakable(&root));
        let title = if row.title.trim().is_empty() {
            format!("A post by {name}")
        } else {
            row.title.clone()
        };
        let link =
            format!("{base}{}", crate::webpath::post_address(&state, &root, &row.doc_id).await);
        items.push_str(&format!(
            "<item><title>{}</title><link>{}</link><guid isPermaLink=\"true\">{}</guid><pubDate>{}</pubDate><dc:creator>{}</dc:creator></item>\n",
            xml(&title),
            xml(&link),
            xml(&link),
            crate::rss::rfc822(row.dated_ms.unwrap_or(row.published_ms)),
            xml(&name),
        ));
        taken += 1;
    }
    let host = crate::webpath::public_url(&state);
    let title = if host.is_empty() { "Horse Drawing Tycoon 2".to_string() } else { host.clone() };
    Ok(text(
        StatusCode::OK,
        "application/rss+xml; charset=utf-8",
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
             <rss version=\"2.0\" xmlns:atom=\"http://www.w3.org/2005/Atom\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n<channel>\n\
             <title>{}</title>\n<link>{}</link>\n<description>{}</description>\n\
             <atom:link href=\"{}\" rel=\"self\" type=\"application/rss+xml\"/>\n{items}</channel>\n</rss>\n",
            xml(&title),
            xml(&format!("{base}/feed")),
            xml("everything new on this node"),
            xml(&format!("{base}/feed.xml")),
        ),
    ))
}

/// The head of one of the node's own pages: its title and description, its canonical address, the
/// node-wide feed, and `noindex` where search engines aren't welcome.
async fn node_head(state: &AppState, title: &str, description: &str, path: &str) -> String {
    let base = crate::webpath::public_url(state);
    let mut head = format!(
        "<title>{}</title>\n<meta property=\"og:title\" content=\"{}\">\n<meta name=\"description\" content=\"{}\">\n<meta property=\"og:description\" content=\"{}\">\n<link rel=\"alternate\" type=\"application/rss+xml\" title=\"{}\" href=\"{base}/feed.xml\">",
        xml(title),
        xml(title),
        xml(description),
        xml(description),
        xml(title),
    );
    if crate::webpath::has_public_url(state) {
        head.push_str(&format!(
            "\n<link rel=\"canonical\" href=\"{}\">",
            xml(&format!("{base}{path}"))
        ));
    }
    if !crate::webpath::has_public_url(state) || !node_indexed(state).await {
        head.push_str(NOINDEX);
    }
    head
}

/// GET `/feed` - the node's front page: the app, under a head of its own, with its newest posts as
/// a reading copy (`?before=` pages back).
pub async fn front_page(
    State(state): State<AppState>,
    axum::extract::RawQuery(query): axum::extract::RawQuery,
) -> Response {
    let before = url::form_urlencoded::parse(query.as_deref().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "before")
        .and_then(|(_, v)| {
            let (ms, doc) = v.split_once('.')?;
            Some((ms.parse::<i64>().ok()?, doc.to_string()))
        });
    let head = node_head(
        &state,
        "Horse Drawing Tycoon 2",
        "Drawings, posts and books from the people on this node.",
        "/feed",
    )
    .await;
    let body = crate::reading::front_copy(&state, before).await;
    axum::response::Html(crate::ui::app_page_with(&state, &head, &body)).into_response()
}

/// GET `/people` - the node's people page, with everyone listed as a reading copy.
pub async fn people_page(State(state): State<AppState>) -> Response {
    let head = node_head(
        &state,
        "People - Horse Drawing Tycoon 2",
        "The people who post on this node.",
        "/people",
    )
    .await;
    let body = crate::reading::people_copy(&state).await;
    axum::response::Html(crate::ui::app_page_with(&state, &head, &body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_data_never_closes_its_own_script() {
        let out = json_ld(&serde_json::json!({ "headline": "</script><b>" }));
        assert!(!out.contains("</script><b>"), "{out}");
        assert!(out.starts_with("\n<script type=\"application/ld+json\">"));
    }

    #[test]
    fn a_moment_reads_as_rfc3339() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_791_676_800_000), "2026-10-11T00:00:00Z");
    }
}
