//! Horse's RSS, the feed reader (plans/RSS.md), slice 1: following feeds, and the node's cache of
//! what they say. Not rss.rs, which is the other direction - a person's own posts, served as a
//! feed for anybody's reader.
//!
//! **Who follows what** is a fact of the persona's private chain: one `rss_feeds` register per
//! feed, keyed by [`feed_id`], its value the feed's address, name and tags as JSON (empty when
//! unfollowed, as saved feeds and rooms do). It travels to every computer the persona is on.
//! How far the persona has read each feed is another register, `rss_seen`, keyed the same way:
//! one watermark per feed (Curtis, 2026-10-27), like the bell's and the rooms'.
//!
//! **What the feeds say** is this node's cache, not anybody's chain (Curtis, 2026-10-27, taking
//! the plan's proposal): `rss_feeds` and `rss_items` in node.db, one copy of a feed however many
//! people here follow it, refreshed about every three hours by [`pass`]. Each node keeps its own
//! and asks for itself, so two servers never have to agree on an item. `rss_follows` is this
//! node's note of the registers, so the refresh never opens a persona's database; it is brought
//! up to date whenever the persona's reader asks for its feeds ([`feeds_get`]), which is how a
//! feed followed on another computer starts being fetched here.
//!
//! **An item is a post** (plans/RSS.md, _Feed items are posts_): it wears a post's automatic tags,
//! kept with it ([`Item::tags`]), and it is journalled into each follower's `feed_journal` as the
//! post of an author spelled `rss:<feed id>` ([`AUTHOR`]) - a string no root can be - with its item
//! id in the doc id's place and format `rss`. The main feed, its paging and its filters then take
//! it as they take a post; the few places that ask an author's chain ask this module instead
//! ([`bylines`], [`labels`], [`tagged`], [`words`], [`cards`]). A reader's own tags on an item are
//! private (Curtis, 2026-10-27) until they rebroadcast it: `rss_tags` registers on their private
//! chain, noted in node.db's `rss_tags` as follows are in `rss_follows`.
//!
//! An item's words are someone else's HTML, translated into Marquee by `marquee_html_import` -
//! never sanitized and shown - and every fetch goes through `net::unfurl::guarded_get`, which
//! holds the node to public addresses on every hop.
use std::collections::{HashMap, HashSet};
use std::time::Duration;

use anyhow::{Context, Result};
use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Json,
};
use reqwest::header::{HeaderMap, HeaderValue};
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::clock::now_ms;
use crate::error::AppError;
use crate::message::UserMessage;
use crate::net::unfurl::{self, Refusal};
use crate::record::store::{self, Store};
use crate::AppState;

/// The private collection a persona's feeds are registers in (js/apps/rss.js reads it through
/// [`feeds_get`], never directly).
pub const SUBSCRIPTIONS: &str = "rss_feeds";
/// The private collection of how far the persona has read each feed: the newest item's date,
/// in ms, by feed id (js/apps/rss.js writes it).
pub const SEEN: &str = "rss_seen";
/// The private collection of the persona's own tags on items: keyed by feed id then item id, the
/// value the tags as a JSON list (empty when none are left).
pub const TAGS: &str = "rss_tags";
/// How a feed is spelled where a post's author would be: the journal's, the card's and the
/// filters'.
pub const AUTHOR: &str = "rss:";
/// The most of a feed's logo fetched, and how often it is looked for again.
const LOGO_BYTES: usize = 256 * 1024;
const LOGO_EVERY_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// The most feeds a persona may follow: past a few hundred, one account would be using the node
/// as its crawler.
pub const MAX_FEEDS: usize = 300;
/// The tags one feed may wear, and how long each may be (js/apps/rss.js says the same).
pub const MAX_TAGS: usize = 24;
pub const MAX_TAG_CHARS: usize = 32;
/// The longest feed address followed: a register's value holds 4096 bytes, and the address
/// shares it with the feed's name and tags.
const MAX_URL: usize = 2048;
/// The most of a feed fetched.
const FEED_BYTES: usize = 5 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// The items a feed keeps here, newest first.
const ITEMS_KEPT: usize = 200;
/// How often a feed is asked again.
const REFRESH_MS: i64 = 3 * 60 * 60 * 1000;
/// The longest a feed's own `<ttl>`, `Cache-Control` or `Retry-After` may put it off.
const LONGEST_MS: i64 = 24 * 60 * 60 * 1000;
/// A feed whose asks have all failed for this long is quiet: asked weekly, and marked so.
const QUIET_AFTER_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const QUIET_EVERY_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// The most feeds one refresh pass asks, so a node that has been off doesn't wake to a storm.
const PASS_FEEDS: i64 = 40;
/// The most pictures of one item the node fetches (plans/RSS.md, slice 7): past them, a picture
/// is a link to where it lives.
const PICTURES_PER_ITEM: usize = 20;
/// The most pictures one pass fetches and crushes - a crush is seconds of CPU, on the media lane.
const PICTURES_PER_PASS: usize = 24;
/// Where the app asks for a feed's pictures, by key.
const PICTURE_PATH: &str = "/api/rss/pictures/";
/// How soon "refresh now" asks again: sooner, it answers with what it has.
const AGAIN_GAP_MS: i64 = 60 * 1000;
/// How much of an item its summary keeps.
const SUMMARY_CHARS: usize = 300;
/// Before this (1995), an item's date is a mistake, not a date.
const EARLIEST_MS: i64 = 788_918_400_000;

// ---------------------------------------------------------------------------------------------
// Addresses and ids.

/// A feed address as followed: http or https (`https://` assumed when none is given), the
/// fragment dropped, the scheme and host lowercased (by the URL parser).
pub fn normalise(raw: &str) -> Result<url::Url, UserMessage> {
    let raw = raw.trim();
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    let mut url = url::Url::parse(&with_scheme).map_err(|_| {
        crate::msg!(
            "feedreader.not-a-url",
            "that isn't a web address - paste the feed's, or its site's"
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(crate::msg!(
            "feedreader.only-the-web",
            "only http and https feeds can be followed"
        ));
    }
    url.set_fragment(None);
    if url.as_str().len() > MAX_URL {
        return Err(crate::msg!("feedreader.url-too-long", "that address is too long to follow"));
    }
    Ok(url)
}

/// A feed's id: the hash of its normalised address, so every node and every computer agrees on
/// it, and a private address with a token in it is only ever the same feed as itself.
pub fn feed_id(url: &url::Url) -> String {
    hex::encode(&blake3::hash(url.as_str().as_bytes()).as_bytes()[..16])
}

/// An item's id: the hash of the id the feed gives it (feed-rs: its guid or Atom id, else one
/// made from its link and title), so it is the same item on every node.
fn item_id(entry_id: &str) -> String {
    hex::encode(&blake3::hash(entry_id.as_bytes()).as_bytes()[..16])
}

fn is_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// ---------------------------------------------------------------------------------------------
// The persona's own facts.

/// One followed feed, as its register holds it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Subscription {
    pub url: String,
    /// The feed's name when it was followed, for a computer that hasn't fetched it yet.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Every feed the persona follows, by id.
async fn subscriptions(data: &Store) -> Result<Vec<(String, Subscription)>, AppError> {
    let (registers, _) = data.private_registers(SUBSCRIPTIONS).all().await?;
    Ok(registers
        .into_iter()
        .filter(|r| is_id(&r.key) && !r.value.is_empty())
        .filter_map(|r| Some((r.key, serde_json::from_str(&r.value).ok()?)))
        .collect())
}

/// Tags as a feed wears them: trimmed, lowercased, short, each once, and not too many.
fn tidy_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tag in tags {
        let tag: String = tag.trim().to_lowercase().chars().take(MAX_TAG_CHARS).collect();
        if !tag.is_empty() && !out.contains(&tag) && out.len() < MAX_TAGS {
            out.push(tag);
        }
    }
    out
}

async fn write_subscription(data: &Store, id: &str, sub: &Subscription) -> Result<(), AppError> {
    let value = serde_json::to_string(sub).map_err(|e| AppError::Internal(e.into()))?;
    data.private_registers(SUBSCRIPTIONS).set(id, &value).await?;
    Ok(())
}

/// Bring this node's note of who follows what up to date with the persona's registers: a feed
/// followed on another computer starts being fetched here, and one let go stops.
async fn note_follows(state: &AppState, root: &str, subs: &[(String, Subscription)]) -> Result<()> {
    let db = &state.node_db;
    let now = now_ms();
    let noted: Vec<(String,)> = db
        .fetch_all("SELECT feed_id FROM rss_follows WHERE root = ?1", (root,))
        .await
        .context("listing a persona's noted feeds")?;
    let noted: HashSet<String> = noted.into_iter().map(|(id,)| id).collect();
    let wanted: HashSet<&str> = subs.iter().map(|(id, _)| id.as_str()).collect();
    for (id, sub) in subs {
        if noted.contains(id) {
            continue;
        }
        let Ok(url) = normalise(&sub.url) else { continue };
        if feed_id(&url) != *id {
            continue;
        }
        db.execute(
            "INSERT OR IGNORE INTO rss_feeds (feed_id, url) VALUES (?1, ?2)",
            (id.as_str(), url.as_str()),
        )
        .await
        .context("noting a followed feed")?;
        db.execute(
            "INSERT OR IGNORE INTO rss_follows (feed_id, root, since_ms) VALUES (?1, ?2, ?3)",
            (id.as_str(), root, now),
        )
        .await
        .context("noting a follow")?;
        journal(state, id, Some(root)).await?;
    }
    for id in noted.iter().filter(|id| !wanted.contains(id.as_str())) {
        db.execute("DELETE FROM rss_follows WHERE feed_id = ?1 AND root = ?2", (id.as_str(), root))
            .await
            .context("forgetting a follow")?;
        unjournal(state, root, id).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Fetching.

/// What one ask of a feed found.
enum Answer {
    /// A feed, parsed, from where the redirects ended, with the validators and the feed's own
    /// hint (ms) about how often to ask.
    Feed {
        feed: Box<feed_rs::model::Feed>,
        url: url::Url,
        etag: Option<String>,
        modified: Option<String>,
        hint_ms: i64,
    },
    /// Nothing new since the validators we sent.
    Unchanged { hint_ms: i64 },
    /// A web page, not a feed: the feed it names as its own, if it names one.
    Page(Option<url::Url>),
    /// The source said to come back later (`429`, `503`), in ms from now.
    Busy(i64),
}

/// Ask a feed once, under the guards. `etag` and `modified` are its last answer's validators.
async fn ask(
    state: &AppState,
    url: &str,
    etag: Option<&str>,
    modified: Option<&str>,
) -> Result<Answer, String> {
    let mut headers = HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static(
            "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5",
        ),
    );
    if let Some(v) = etag.and_then(|e| HeaderValue::from_str(e).ok()) {
        headers.insert(reqwest::header::IF_NONE_MATCH, v);
    }
    if let Some(v) = modified.and_then(|m| HeaderValue::from_str(m).ok()) {
        headers.insert(reqwest::header::IF_MODIFIED_SINCE, v);
    }
    let got = unfurl::guarded_get(url, headers, FEED_BYTES, FETCH_TIMEOUT, state.config.local_test)
        .await?;
    let header = |name| {
        got.headers.get(name).and_then(|v: &HeaderValue| v.to_str().ok()).map(str::to_string)
    };
    let max_age = header(reqwest::header::CACHE_CONTROL).and_then(|c| max_age_ms(&c)).unwrap_or(0);
    match got.status {
        StatusCode::NOT_MODIFIED => return Ok(Answer::Unchanged { hint_ms: max_age }),
        StatusCode::TOO_MANY_REQUESTS | StatusCode::SERVICE_UNAVAILABLE => {
            let after =
                header(reqwest::header::RETRY_AFTER).and_then(|r| r.trim().parse::<i64>().ok());
            return Ok(Answer::Busy(after.map(|s| s * 1000).unwrap_or(REFRESH_MS)));
        }
        s if !s.is_success() => return Err(format!("the feed's server answered {s}")),
        _ => {}
    }
    let parser = feed_rs::parser::Builder::new().base_uri(Some(got.url.as_str())).build();
    let parsed =
        parser.parse(got.body.as_slice()).or_else(|e| match news_sitemap(&got.body, &got.url) {
            Some(atom) => parser.parse(atom.as_bytes()),
            None => Err(e),
        });
    match parsed {
        Ok(feed) => {
            let hint_ms = (feed.ttl.unwrap_or(0) as i64 * 60 * 1000).max(max_age);
            Ok(Answer::Feed {
                feed: Box::new(feed),
                url: got.url,
                etag: header(reqwest::header::ETAG),
                modified: header(reqwest::header::LAST_MODIFIED),
                hint_ms,
            })
        }
        Err(_) => Ok(Answer::Page(alternate(&String::from_utf8_lossy(&got.body), &got.url))),
    }
}

/// A Google News sitemap read as the feed it nearly is (Curtis, 2026-10-27, on Serious Eats
/// offering one where its feed would be): Atom, one entry per `<url>` that has a `<news:title>` -
/// its title, its address, its dates, and its picture as the entry's only words. `None` for
/// anything else, a plain sitemap included: a site's every page, untitled, is not a feed.
///
/// The same quick-xml feed-rs reads with, and as warily: the five predefined entities and
/// character references only, never a DTD.
fn news_sitemap(body: &[u8], at: &url::Url) -> Option<String> {
    use quick_xml::events::Event;
    #[derive(Default)]
    struct Entry {
        link: String,
        title: String,
        published: String,
        updated: String,
        picture: String,
    }
    let text = std::str::from_utf8(body).ok()?;
    let mut reader = quick_xml::Reader::from_str(text);
    let mut path: Vec<String> = Vec::new();
    let mut said = String::new();
    let mut publication = String::new();
    let mut entry: Option<Entry> = None;
    let mut entries = Vec::new();
    loop {
        match reader.read_event().ok()? {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_string();
                if path.is_empty() && name != "urlset" {
                    return None;
                }
                if name == "url" {
                    entry = Some(Entry::default());
                }
                path.push(name);
                said.clear();
            }
            Event::Text(t) => said.push_str(&t.xml10_content()),
            Event::CData(t) => said.push_str(&t),
            Event::GeneralRef(r) => {
                let name = r.xml10_content();
                said.push_str(&quick_xml::escape::unescape(&format!("&{name};")).ok()?);
            }
            Event::End(_) => {
                let name = path.pop()?;
                let parent = path.last().map(String::as_str).unwrap_or_default();
                let value = said.trim().to_string();
                said.clear();
                match (parent, name.as_str()) {
                    (_, "url") => entries.extend(entry.take()),
                    ("publication", "name") if publication.is_empty() => publication = value,
                    (_, field) => {
                        let Some(entry) = entry.as_mut() else { continue };
                        match (parent, field) {
                            ("url", "loc") => entry.link = value,
                            ("url", "lastmod") => entry.updated = value,
                            ("news", "title") => entry.title = value,
                            ("news", "publication_date") => entry.published = value,
                            ("image", "loc") if entry.picture.is_empty() => entry.picture = value,
                            _ => {}
                        }
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let entries: Vec<Entry> =
        entries.into_iter().filter(|e| !e.title.is_empty() && !e.link.is_empty()).collect();
    if entries.is_empty() {
        return None;
    }
    let x = crate::rss::xml;
    let site = url::Url::parse(&entries[0].link)
        .map(|u| u.origin().ascii_serialization() + "/")
        .unwrap_or_default();
    let name = if publication.is_empty() {
        url::Url::parse(&site)
            .ok()
            .and_then(|u| u.host_str().map(str::to_string))
            .unwrap_or_default()
    } else {
        publication
    };
    let mut atom = format!(
        "<feed xmlns=\"http://www.w3.org/2005/Atom\"><title>{}</title><link href=\"{}\"/><id>{}</id>",
        x(&name),
        x(&site),
        x(at.as_str())
    );
    for e in entries {
        let published = if e.published.is_empty() { &e.updated } else { &e.published };
        let updated = if e.updated.is_empty() { published } else { &e.updated };
        atom.push_str(&format!(
            "<entry><title>{}</title><link href=\"{}\"/><id>{}</id>",
            x(&e.title),
            x(&e.link),
            x(&e.link)
        ));
        if !published.is_empty() {
            atom.push_str(&format!("<published>{}</published>", x(published)));
        }
        if !updated.is_empty() {
            atom.push_str(&format!("<updated>{}</updated>", x(updated)));
        }
        if !e.picture.is_empty() {
            let html = format!("<p><img src=\"{}\" alt=\"\"></p>", x(&e.picture));
            atom.push_str(&format!("<content type=\"html\">{}</content>", x(&html)));
        }
        atom.push_str("</entry>");
    }
    atom.push_str("</feed>");
    Some(atom)
}

/// `max-age` from a `Cache-Control` header, in ms.
fn max_age_ms(cache_control: &str) -> Option<i64> {
    cache_control.split(',').find_map(|d| {
        let (k, v) = d.trim().split_once('=')?;
        (k.eq_ignore_ascii_case("max-age"))
            .then(|| v.trim().parse::<i64>().ok().map(|s| s * 1000))?
    })
}

/// The feed a web page names as its own: its first `<link rel="alternate">` of a feed type -
/// the tag our own person pages carry for their `rss.xml`.
fn alternate(html: &str, page: &url::Url) -> Option<url::Url> {
    // A page's links are in its head: only that much is read, and not at all past the guard.
    let cut = &html[..floor_char(html, PAGE_HEAD_BYTES)];
    let head = match cut.to_ascii_lowercase().find("</head") {
        Some(end) => &cut[..end],
        None => cut,
    };
    if too_much(head) {
        return None;
    }
    let doc = scraper::Html::parse_document(head);
    let links = scraper::Selector::parse("link[rel~=alternate][href]").ok()?;
    doc.select(&links).find_map(|link| {
        let kind = link.value().attr("type").unwrap_or_default().to_ascii_lowercase();
        let feedish = [
            "application/rss+xml",
            "application/atom+xml",
            "application/feed+json",
            "application/json",
        ]
        .contains(&kind.trim());
        let url = page.join(link.value().attr("href")?.trim()).ok()?;
        (feedish && matches!(url.scheme(), "http" | "https")).then_some(url)
    })
}

/// When to ask again after an answer: about every three hours, or less often if the feed asks
/// (never more than a day), give or take an eighth so a node's feeds don't all go at once.
fn next_due(now: i64, hint_ms: i64) -> i64 {
    use rand::RngExt;
    let base = REFRESH_MS.max(hint_ms.min(LONGEST_MS));
    now + base + rand::rng().random_range(-base / 8..=base / 8)
}

/// When to ask again after `failures` failed asks in a row, the first of them at
/// `failing_since`: three hours, then six, twelve, and daily; weekly once it has been quiet a
/// month.
fn backoff_due(now: i64, failures: i64, failing_since: i64) -> i64 {
    if now - failing_since >= QUIET_AFTER_MS {
        return now + QUIET_EVERY_MS;
    }
    let doublings = (failures - 1).clamp(0, 3) as u32;
    now + (REFRESH_MS << doublings).min(LONGEST_MS)
}

/// A feed's row, as [`refresh`] reads it: its address, its validators, and its run of failures.
type RefreshRow = (String, Option<String>, Option<String>, i64, Option<i64>);

/// Ask a feed this node caches, and keep what it says. Never fails the caller for the feed's
/// sake: what went wrong is kept on its row, for the reader to show.
async fn refresh(state: &AppState, id: &str) -> Result<()> {
    let db = &state.node_db;
    let row: Option<RefreshRow> = db
        .fetch_optional(
            "SELECT url, etag, modified, failures, failing_since_ms FROM rss_feeds WHERE feed_id = ?1",
            (id,),
        )
        .await
        .context("reading a feed to refresh")?;
    let Some((url, etag, modified, failures, failing_since)) = row else { return Ok(()) };
    let now = now_ms();
    match ask(state, &url, etag.as_deref(), modified.as_deref()).await {
        Ok(Answer::Feed { feed, url: at, etag, modified, hint_ms }) => {
            keep(state, id, &feed, &at, now).await?;
            logo(state, id, &feed, now).await?;
            db.execute(
                "UPDATE rss_feeds SET title = ?2, site = ?3, etag = ?4, modified = ?5, checked_ms = ?6,
                 fetched_ms = ?6, due_ms = ?7, failures = 0, failing_since_ms = NULL, error = NULL
                 WHERE feed_id = ?1",
                (id, feed_title(&feed, &at), feed_site(&feed), etag, modified, now, next_due(now, hint_ms)),
            )
            .await
            .context("noting a feed's answer")?;
        }
        Ok(Answer::Unchanged { hint_ms }) => {
            db.execute(
                "UPDATE rss_feeds SET checked_ms = ?2, due_ms = ?3, failures = 0, failing_since_ms = NULL,
                 error = NULL WHERE feed_id = ?1",
                (id, now, next_due(now, hint_ms)),
            )
            .await
            .context("noting an unchanged feed")?;
        }
        Ok(Answer::Busy(after_ms)) => {
            db.execute(
                "UPDATE rss_feeds SET checked_ms = ?2, due_ms = ?3 WHERE feed_id = ?1",
                (id, now, now + after_ms.clamp(REFRESH_MS, LONGEST_MS)),
            )
            .await
            .context("noting a busy feed")?;
        }
        Ok(Answer::Page(_)) => {
            failed(
                state,
                id,
                now,
                failures,
                failing_since,
                "that address is a web page, not a feed",
            )
            .await?
        }
        Err(e) => failed(state, id, now, failures, failing_since, &e).await?,
    }
    Ok(())
}

async fn failed(
    state: &AppState,
    id: &str,
    now: i64,
    failures: i64,
    failing_since: Option<i64>,
    error: &str,
) -> Result<()> {
    let since = failing_since.unwrap_or(now);
    let failures = failures + 1;
    state
        .node_db
        .execute(
            "UPDATE rss_feeds SET checked_ms = ?2, due_ms = ?3, failures = ?4, failing_since_ms = ?5,
             error = ?6 WHERE feed_id = ?1",
            (id, now, backoff_due(now, failures, since), failures, since, error),
        )
        .await
        .context("noting a feed's failure")?;
    Ok(())
}

/// The refresh (lib.rs, every few minutes): forget the feeds nobody here follows any more, then
/// ask the ones that are due, oldest due first.
pub async fn pass(state: AppState) -> Result<()> {
    let db = &state.node_db;
    db.execute("DELETE FROM rss_items WHERE feed_id NOT IN (SELECT feed_id FROM rss_follows)", ())
        .await
        .context("forgetting unfollowed items")?;
    db.execute("DELETE FROM rss_feeds WHERE feed_id NOT IN (SELECT feed_id FROM rss_follows)", ())
        .await
        .context("forgetting unfollowed feeds")?;
    forget_pictures(db).await?;
    let due: Vec<(String,)> = db
        .fetch_all(
            "SELECT feed_id FROM rss_feeds WHERE due_ms <= ?1 ORDER BY due_ms LIMIT ?2",
            (now_ms(), PASS_FEEDS),
        )
        .await
        .context("listing feeds due a refresh")?;
    for (id,) in due {
        if let Err(e) = refresh(&state, &id).await {
            tracing::debug!(feed = %id, error = ?e, "feed refresh failed");
        }
    }
    pictures_pass(&state).await
}

// ---------------------------------------------------------------------------------------------
// Keeping what a feed says.

/// A feed's own name, as plain text; its address's host when it gives none.
fn feed_title(feed: &feed_rs::model::Feed, at: &url::Url) -> String {
    feed.title
        .as_ref()
        .map(text_of)
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| at.host_str().unwrap_or_default().to_string())
}

/// The website a feed says it belongs to: its first link that isn't itself.
fn feed_site(feed: &feed_rs::model::Feed) -> String {
    feed.links
        .iter()
        .find(|l| l.rel.as_deref() != Some("self"))
        .map(|l| l.href.clone())
        .unwrap_or_default()
}

/// A feed's text as plain text: HTML read for its words, plain text as it is, whitespace
/// collapsed either way.
fn text_of(text: &feed_rs::model::Text) -> String {
    if is_html(text.content_type.subty().as_str()) {
        plain(&text.content)
    } else {
        squash(&text.content)
    }
}

fn is_html(subtype: &str) -> bool {
    subtype.eq_ignore_ascii_case("html") || subtype.eq_ignore_ascii_case("xhtml+xml")
}

/// HTML's words, as a browser would show them, on one line.
fn plain(html: &str) -> String {
    if too_much(html) {
        return squash(&stripped(html));
    }
    let fragment = scraper::Html::parse_fragment(html);
    squash(&fragment.root_element().text().collect::<Vec<_>>().join(" "))
}

/// How deep someone else's HTML may nest before the node stops parsing it (2026-10-28).
/// html5ever slows quadratically with depth - a 5 MiB item of nested lists took two minutes of
/// CPU - while real writing nests a few dozen deep. Past this, an item keeps its words, unparsed.
const DEEPEST: usize = 512;

/// How many attributes one tag may carry: html5ever checks each against those before it.
const MOST_ATTRIBUTES: usize = 256;

/// How much HTML one item may be before it is kept as its words, unparsed, whatever the scan says:
/// the scan estimates the parser, and this bounds what an estimate that's wrong could cost.
const PARSED_BYTES: usize = 512 * 1024;

/// How much of a page is read for its head when it never closes one.
const PAGE_HEAD_BYTES: usize = 256 * 1024;

/// Elements that never hold others (void), or that the parser closes for themselves when their
/// like comes along (`<p>`, `<li>`, a table's cells): a run of them is never deep.
const FLAT: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track",
    "wbr", "p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody",
    "tfoot", "rb", "rt", "rp", "colgroup", "caption",
];

/// Elements whose insides are text to the parser, up to their own closing tag - outside SVG and
/// MathML, where a `<title>` or a `<style>` holds elements. `noscript` too: html5ever parses as a
/// browser running scripts does.
const RAW: &[&str] = &[
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "plaintext",
];

/// Elements a closing tag can't reach past unless it closes them: the parser's scope boundaries.
const SCOPES: &[&str] = &[
    "applet", "caption", "html", "table", "td", "th", "marquee", "object", "template", "svg",
    "math",
];

/// Whether someone else's HTML is too much to parse: too big, too deep, or a tag with too many
/// attributes. Depth is a scan of its tags, read as the parser's tokenizer reads them, that never
/// builds a tree: an opening tag of anything but [`FLAT`] goes one deeper, and a closing tag goes
/// back to its opening one unless a scope boundary is in the way. Where the scan and the parser
/// could differ, the scan errs deep: a closing tag nothing opened closes nothing, and `<div/>` is
/// an opening tag, since HTML ignores that slash.
fn too_much(html: &str) -> bool {
    if html.len() > PARSED_BYTES {
        return true;
    }
    let bytes = html.as_bytes();
    let n = bytes.len();
    let find = |from: usize, needle: &[u8]| -> usize {
        bytes[from.min(n)..]
            .windows(needle.len())
            .position(|w| w.eq_ignore_ascii_case(needle))
            .map_or(n, |at| from + at)
    };
    // What is open, where each name is open, and where the scope boundaries are: a closing tag
    // finds its element in one look, so a flood of them costs no more than the bytes they take.
    let mut open: Vec<String> = Vec::new();
    let mut at_depth: HashMap<String, Vec<usize>> = HashMap::new();
    let mut scopes: Vec<usize> = Vec::new();
    let mut i = 0;
    while let Some(at) = memchr(b'<', &bytes[i..]) {
        i += at + 1;
        // A comment, a doctype, CDATA or a processing instruction: no tags inside.
        if bytes[i..].starts_with(b"!--") {
            i = find(i + 3, b"-->");
            continue;
        }
        if matches!(bytes.get(i), Some(b'!' | b'?')) {
            i = find(i, b">");
            continue;
        }
        let closing = bytes.get(i) == Some(&b'/');
        let start = i + usize::from(closing);
        if !bytes.get(start).is_some_and(u8::is_ascii_alphabetic) {
            continue;
        }
        let mut end = start;
        while end < n && !matches!(bytes[end], b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>')
        {
            end += 1;
        }
        let name = html[start..end].to_ascii_lowercase();
        // Its attributes, to its end, as the tokenizer reads them.
        let (mut j, mut attributes) = (end, 0);
        while j < n && bytes[j] != b'>' {
            match bytes[j] {
                b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' => j += 1,
                _ => {
                    attributes += 1;
                    if attributes > MOST_ATTRIBUTES {
                        return true;
                    }
                    j += 1;
                    while j < n
                        && !matches!(
                            bytes[j],
                            b'\t' | b'\n' | b'\x0c' | b'\r' | b' ' | b'/' | b'>' | b'='
                        )
                    {
                        j += 1;
                    }
                    while j < n && bytes[j].is_ascii_whitespace() {
                        j += 1;
                    }
                    if bytes.get(j) == Some(&b'=') {
                        j += 1;
                        while j < n && bytes[j].is_ascii_whitespace() {
                            j += 1;
                        }
                        match bytes.get(j) {
                            Some(&q @ (b'"' | b'\'')) => {
                                j = memchr(q, &bytes[j + 1..]).map_or(n, |e| j + 1 + e + 1)
                            }
                            _ => {
                                while j < n && !bytes[j].is_ascii_whitespace() && bytes[j] != b'>' {
                                    j += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        i = j;
        if closing {
            let opened = at_depth.get(&name).and_then(|d| d.last().copied());
            if let Some(at) = opened.filter(|&at| scopes.last().is_none_or(|&s| at >= s)) {
                while open.len() > at {
                    let gone = open.pop().expect("deeper than at");
                    at_depth.get_mut(&gone).and_then(Vec::pop);
                    if scopes.last() == Some(&open.len()) {
                        scopes.pop();
                    }
                }
            }
            continue;
        }
        let foreign =
            ["svg", "math"].iter().any(|f| at_depth.get(*f).is_some_and(|d| !d.is_empty()));
        if RAW.contains(&name.as_str()) && !foreign {
            i = find(i, format!("</{name}").as_bytes());
            continue;
        }
        if FLAT.contains(&name.as_str()) {
            continue;
        }
        if SCOPES.contains(&name.as_str()) {
            scopes.push(open.len());
        }
        at_depth.entry(name.clone()).or_default().push(open.len());
        open.push(name);
        if open.len() > DEEPEST {
            return true;
        }
    }
    false
}

fn memchr(needle: u8, hay: &[u8]) -> Option<usize> {
    hay.iter().position(|&b| b == needle)
}

/// The largest char boundary at or before `at`.
fn floor_char(s: &str, at: usize) -> usize {
    let mut at = at.min(s.len());
    while !s.is_char_boundary(at) {
        at -= 1;
    }
    at
}

/// HTML's text without a parser: every tag a space, the common entities read. For what is too
/// deep to parse, so rough is fine.
fn stripped(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Plain text, as HTML the importer will read back as the same words.
fn as_html(text: &str) -> String {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    escaped.split("\n\n").map(|p| format!("<p>{}</p>", p.trim())).collect::<Vec<_>>().join("\n")
}

/// One item, ready to keep.
#[derive(Debug, PartialEq)]
struct Item {
    id: String,
    link: String,
    title: String,
    author: String,
    summary: String,
    body: String,
    /// The item's own date, if it has a believable one.
    dated_ms: Option<i64>,
    /// Its automatic tags, as a post's: what it carries, then how long it is.
    tags: Vec<&'static str>,
}

impl Item {
    fn hash(&self, dated_ms: i64) -> String {
        let mut h = blake3::Hasher::new();
        for part in [&self.link, &self.title, &self.author, &self.summary, &self.body] {
            h.update(part.as_bytes());
            h.update(&[0]);
        }
        h.update(self.tags.join(" ").as_bytes());
        h.update(&dated_ms.to_le_bytes());
        hex::encode(&h.finalize().as_bytes()[..16])
    }
}

/// An item as this node keeps it: its words translated to Marquee, its links resolved against
/// its own address, its summary plain text.
fn item(entry: &feed_rs::model::Entry, feed_at: &url::Url, now: i64) -> Item {
    let link = entry
        .links
        .iter()
        .find(|l| matches!(l.rel.as_deref(), None | Some("alternate")))
        .or(entry.links.first())
        .map(|l| l.href.clone())
        .unwrap_or_default();
    let html = match (&entry.content, &entry.summary) {
        (Some(content), _) if content.body.as_deref().is_some_and(|b| !b.trim().is_empty()) => {
            let body = content.body.clone().unwrap_or_default();
            if is_html(content.content_type.subty().as_str())
                || content.content_type.subty().as_str() == "xml"
            {
                body
            } else {
                as_html(&body)
            }
        }
        (_, Some(summary)) if is_html(summary.content_type.subty().as_str()) => {
            summary.content.clone()
        }
        (_, Some(summary)) => as_html(&summary.content),
        _ => String::new(),
    };
    // Too much to parse: its words, flattened to a paragraph the importer reads in no time.
    let html = if too_much(&html) { as_html(&squash(&stripped(&html))) } else { html };
    let tags = automatic_tags(entry, &html);
    let base = if link.is_empty() { feed_at.to_string() } else { link.clone() };
    let body = marquee_html_import::to_marquee_with(
        &html,
        &marquee_html_import::Options { base_url: Some(base), ..Default::default() },
    );
    let summary = entry
        .summary
        .as_ref()
        .map(text_of)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| plain(&html));
    let dated_ms = entry
        .published
        .or(entry.updated)
        .map(|d| d.timestamp_millis())
        .filter(|&ms| ms >= EARLIEST_MS && ms <= now + 24 * 60 * 60 * 1000);
    Item {
        id: item_id(&entry.id),
        link,
        title: entry.title.as_ref().map(text_of).unwrap_or_default(),
        author: entry
            .authors
            .first()
            .and_then(|a| a.name.clone())
            .map(|n| squash(&n))
            .unwrap_or_default(),
        summary: crate::idface::clip(&summary, SUMMARY_CHARS),
        body,
        dated_ms,
        tags,
    }
}

/// An item's automatic tags, as a post's are worked out (documents.rs `IMPLICIT_TAGS`): audio or
/// video for what it encloses (a podcast's episode), image for a picture in its words or enclosed,
/// and its length from the words a reader would see.
fn automatic_tags(entry: &feed_rs::model::Entry, html: &str) -> Vec<&'static str> {
    let mut kinds: HashSet<&'static str> = HashSet::new();
    for content in entry.media.iter().flat_map(|m| &m.content) {
        match content.content_type.as_ref().map(|t| t.ty().as_str().to_ascii_lowercase()) {
            Some(t) if t == "audio" => kinds.insert("audio"),
            Some(t) if t == "video" => kinds.insert("video"),
            Some(t) if t == "image" => kinds.insert("image"),
            _ => false,
        };
    }
    let fragment = scraper::Html::parse_fragment(html);
    let img = scraper::Selector::parse("img").expect("a fixed selector");
    if fragment.select(&img).next().is_some() {
        kinds.insert("image");
    }
    let words = crate::record::documents::word_count(&plain(html));
    crate::record::documents::IMPLICIT_TAGS
        .iter()
        .copied()
        .filter(|t| kinds.contains(t) || crate::record::documents::length_tag(words) == Some(*t))
        .collect()
}

/// Keep a feed's items: new ones added, changed ones replaced, and only the newest
/// [`ITEMS_KEPT`] kept - then the followers' feeds told.
async fn keep(
    state: &AppState,
    id: &str,
    feed: &feed_rs::model::Feed,
    at: &url::Url,
    now: i64,
) -> Result<()> {
    let db = &state.node_db;
    let known: Vec<(String, String, i64)> = db
        .fetch_all("SELECT item_id, hash, fetched_ms FROM rss_items WHERE feed_id = ?1", (id,))
        .await
        .context("reading a feed's items")?;
    let known: HashMap<String, (String, i64)> =
        known.into_iter().map(|(item, hash, fetched)| (item, (hash, fetched))).collect();
    // Translating someone else's HTML is CPU work a feed's author chooses the size of: off the
    // threads that answer requests.
    let entries: Vec<feed_rs::model::Entry> =
        feed.entries.iter().take(ITEMS_KEPT).cloned().collect();
    let feed_at = at.clone();
    let items = tokio::task::spawn_blocking(move || {
        entries.iter().map(|entry| item(entry, &feed_at, now)).collect::<Vec<_>>()
    })
    .await
    .context("translating a feed's items")?;
    let mut noted: Vec<(String, Vec<String>)> = Vec::new();
    for item in items {
        match known.get(&item.id) {
            Some((hash, fetched)) => {
                // An item with no believable date stays where it was first filed.
                let dated = item.dated_ms.unwrap_or(*fetched);
                let new_hash = item.hash(dated);
                if *hash == new_hash {
                    continue;
                }
                db.execute(
                    "UPDATE rss_items SET link = ?3, title = ?4, author = ?5, summary = ?6, body = ?7,
                     hash = ?8, dated_ms = ?9, updated_ms = ?10, tags = ?11 WHERE feed_id = ?1 AND item_id = ?2",
                    (id, item.id.as_str(), item.link.as_str(), item.title.as_str(), item.author.as_str(),
                     item.summary.as_str(), item.body.as_str(), new_hash, dated, now, item.tags.join(" ")),
                )
                .await
                .context("replacing a changed item")?;
                noted.push((item.id.clone(), embedded_pictures(&item.body)));
            }
            None => {
                let dated = item.dated_ms.unwrap_or(now);
                db.execute(
                    "INSERT OR IGNORE INTO rss_items (feed_id, item_id, link, title, author, summary, body,
                     hash, dated_ms, fetched_ms, updated_ms, tags) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, ?11)",
                    (id, item.id.as_str(), item.link.as_str(), item.title.as_str(), item.author.as_str(),
                     item.summary.as_str(), item.body.as_str(), item.hash(dated), dated, now, item.tags.join(" ")),
                )
                .await
                .context("keeping a new item")?;
                noted.push((item.id.clone(), embedded_pictures(&item.body)));
            }
        }
    }
    let kept: Vec<(String,)> = db
        .fetch_all("SELECT item_id FROM rss_items WHERE feed_id = ?1 ORDER BY dated_ms DESC", (id,))
        .await
        .context("counting a feed's items")?;
    for (old,) in kept.iter().skip(ITEMS_KEPT) {
        db.execute("DELETE FROM rss_items WHERE feed_id = ?1 AND item_id = ?2", (id, old.as_str()))
            .await
            .context("dropping an old item")?;
    }
    note_pictures(db, id, &noted, now).await?;
    forget_pictures(db).await?;
    journal(state, id, None).await
}

// ---------------------------------------------------------------------------------------------
// Pictures through the node (plans/RSS.md, slice 7, 2026-10-28). An item's words keep the
// addresses its feed gave its pictures; the node fetches each, crushes it to its own formats and
// keeps it as a public blob, and the body door (`body_get`) swaps each address for this node's
// copy as it hands the words out - or, for a picture that isn't here, a link to where it lives.
// A reader's browser never loads a picture from a feed's site, so no tracking pixel learns who
// read what. Copying and rebroadcasting read the words as the feed gave them: publication bakes
// a post's web pictures itself (record::bake).

/// The key the app asks for a picture by: the first sixteen bytes of its address's BLAKE3.
fn picture_key(url: &str) -> String {
    hex::encode(&blake3::hash(url.as_bytes()).as_bytes()[..16])
}

/// The web pictures an item's words embed, each once, in order.
fn embedded_pictures(body: &str) -> Vec<String> {
    let Ok(doc) = marquee_parser::parse(body) else { return Vec::new() };
    let mut found: Vec<String> = Vec::new();
    crate::record::bake::each_embed(&doc, &mut |target| {
        let web = target.starts_with("https://") || target.starts_with("http://");
        if web && !found.iter().any(|f| f == target) {
            found.push(target.to_string());
        }
    });
    found
}

/// Note which pictures these items embed - their first [`PICTURES_PER_ITEM`] - and ask for any
/// this node hasn't met.
async fn note_pictures(
    db: &crate::db::Db,
    feed: &str,
    items: &[(String, Vec<String>)],
    now: i64,
) -> Result<()> {
    for (item, pictures) in items {
        db.execute(
            "DELETE FROM rss_item_pictures WHERE feed_id = ?1 AND item_id = ?2",
            (feed, item.as_str()),
        )
        .await
        .context("forgetting an item's pictures")?;
        for url in pictures.iter().take(PICTURES_PER_ITEM) {
            db.execute(
                "INSERT OR IGNORE INTO rss_item_pictures (feed_id, item_id, source_url) VALUES (?1, ?2, ?3)",
                (feed, item.as_str(), url.as_str()),
            )
            .await
            .context("noting an item's picture")?;
            db.execute(
                "INSERT OR IGNORE INTO rss_pictures (key, source_url, status, created_ms)
                 VALUES (?1, ?2, 'pending', ?3)",
                (picture_key(url), url.as_str(), now),
            )
            .await
            .context("asking for a picture")?;
        }
    }
    Ok(())
}

/// Forget what no kept item embeds: its row goes, and the blob reaper takes its bytes.
async fn forget_pictures(db: &crate::db::Db) -> Result<()> {
    db.execute(
        "DELETE FROM rss_item_pictures WHERE NOT EXISTS (SELECT 1 FROM rss_items i
         WHERE i.feed_id = rss_item_pictures.feed_id AND i.item_id = rss_item_pictures.item_id)",
        (),
    )
    .await
    .context("forgetting gone items' pictures")?;
    db.execute(
        "DELETE FROM rss_pictures WHERE source_url NOT IN (SELECT source_url FROM rss_item_pictures)",
        (),
    )
    .await
    .context("forgetting pictures nothing embeds")?;
    Ok(())
}

/// The pictures' blobs, for the reaper (reaper.rs `live_set`): every ready picture is a
/// reference.
pub async fn blob_refs(node_db: &crate::db::Db) -> Result<Vec<[u8; 32]>> {
    let rows: Vec<(Vec<u8>,)> = node_db
        .fetch_all("SELECT hash FROM rss_pictures WHERE hash IS NOT NULL", ())
        .await
        .context("reading the feed pictures' blob references")?;
    rows.into_iter()
        .map(|(h,)| {
            <[u8; 32]>::try_from(h.as_slice())
                .map_err(|_| anyhow::anyhow!("corrupt hash on a feed picture"))
        })
        .collect()
}

/// Fetch and crush the pictures waiting, [`PICTURES_PER_PASS`] at most, oldest first: after each
/// refresh pass, and when somebody follows a feed. One at a time across the node.
async fn pictures_pass(state: &AppState) -> Result<()> {
    static RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    let done = pictures_pass_inner(state).await;
    RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
    done
}

async fn pictures_pass_inner(state: &AppState) -> Result<()> {
    let db = &state.node_db;
    for _ in 0..PICTURES_PER_PASS {
        let next: Option<(String, String)> = db
            .fetch_optional(
                "SELECT key, source_url FROM rss_pictures WHERE status = 'pending'
                 ORDER BY created_ms DESC LIMIT 1",
                (),
            )
            .await
            .context("finding a picture to fetch")?;
        let Some((key, url)) = next else { break };
        match fetch_picture(state, &url).await {
            Ok(Some((put, format, width, height))) => {
                db.execute(
                    "UPDATE rss_pictures SET status = 'ready', hash = ?2, format = ?3, width = ?4,
                     height = ?5, error = NULL WHERE key = ?1",
                    (key.as_str(), put.hash.as_bytes().to_vec(), format, width, height),
                )
                .await
                .context("keeping a picture")?;
                drop(put);
            }
            Ok(None) => {
                db.execute(
                    "UPDATE rss_pictures SET status = 'dropped' WHERE key = ?1",
                    (key.as_str(),),
                )
                .await
                .context("dropping a tracking pixel")?;
            }
            Err(why) => {
                db.execute(
                    "UPDATE rss_pictures SET status = 'failed', error = ?2 WHERE key = ?1",
                    (key.as_str(), why),
                )
                .await
                .context("noting a picture's failure")?;
            }
        }
    }
    Ok(())
}

/// One picture: downloaded under the guards, crushed on the media lane, and kept as a public
/// blob - with its format and size. `None` for a tracking pixel; `Err` for anything that isn't a
/// picture the node can show.
async fn fetch_picture(
    state: &AppState,
    url: &str,
) -> Result<Option<(crate::files::Put, &'static str, i64, i64)>, String> {
    let bytes =
        unfurl::fetch_media_bytes(url, state.config.max_upload_bytes, state.config.local_test)
            .await?;
    let crushed = crate::media::lane::background(move || {
        crate::media::crush_with_sidecar(&bytes, None, &|_: u8| {})
    })
    .await
    .map_err(|e| format!("the crush died: {e}"))?
    .map_err(|e| format!("couldn't read that picture: {e}"))?;
    let format = match crushed.format {
        crate::record::documents::Format::Avif => "avif",
        crate::record::documents::Format::Apng => "apng",
        _ => return Err("not a picture".into()),
    };
    let (width, height) = (crushed.width.unwrap_or(0), crushed.height.unwrap_or(0));
    if width <= 2 && height <= 2 {
        return Ok(None);
    }
    let put = state.files.put_public(&crushed.body).await.map_err(|e| format!("{e:#}"))?;
    Ok(Some((put, format, i64::from(width), i64::from(height))))
}

/// An item's words as a reader's browser gets them: each web picture this node keeps, swapped
/// for its copy here; a tracking pixel, gone; and any other - not fetched yet, failed, or past
/// the first twenty - a link to where it lives, never a picture loaded from there.
fn served_words(body: &str, pictures: &HashMap<String, (String, String, String)>) -> String {
    static EMBED: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"!\[((?:[^\]\\]|\\.)*)\]\(([^()\s]+)\)").expect("a fixed pattern")
    });
    EMBED
        .replace_all(body, |c: &regex::Captures| {
            let (alt, target) = (&c[1], &c[2]);
            if !(target.starts_with("https://") || target.starts_with("http://")) {
                return c[0].to_string();
            }
            match pictures.get(target).map(|(s, k, f)| (s.as_str(), k, f.as_str())) {
                Some(("ready", key, format)) => {
                    let ext = if format == "apng" { "png" } else { "avif" };
                    format!("![{alt}]({PICTURE_PATH}{key}.{ext})")
                }
                Some(("dropped", ..)) => String::new(),
                _ => {
                    let words = if alt.trim().is_empty() {
                        url::Url::parse(target)
                            .ok()
                            .and_then(|u| u.host_str().map(str::to_string))
                            .unwrap_or_else(|| "↗".to_string())
                    } else {
                        alt.to_string()
                    };
                    format!("[{words}]({target})")
                }
            }
        })
        .into_owned()
}

/// `GET /api/rss/pictures/{key}.{ext}`: one feed picture this node keeps, for anyone signed in
/// here - they're the open web's pictures, and the session keeps the node from being anybody's
/// proxy.
pub async fn picture_get(
    _session: Session,
    State(state): State<AppState>,
    Path(file): Path<String>,
) -> Result<axum::response::Response, AppError> {
    let missing =
        || AppError::NotFound(crate::msg!("feedreader.no-picture", "that picture isn't here"));
    let key = file.split('.').next().unwrap_or_default();
    if !is_id(key) {
        return Err(missing());
    }
    let row: Option<(Vec<u8>, String)> = state
        .node_db
        .fetch_optional(
            "SELECT hash, format FROM rss_pictures WHERE key = ?1 AND status = 'ready'",
            (key,),
        )
        .await
        .map_err(AppError::Internal)?;
    let Some((hash, format)) = row else { return Err(missing()) };
    let hash = <[u8; 32]>::try_from(hash.as_slice()).map_err(|_| missing())?;
    let Some(bytes) = state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(hash))
        .await
        .map_err(AppError::Internal)?
    else {
        return Err(missing());
    };
    let kind = if format == "apng" { "image/apng" } else { "image/avif" };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, kind),
            (axum::http::header::CACHE_CONTROL, "private, max-age=31536000, immutable"),
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes,
    )
        .into_response())
}

// ---------------------------------------------------------------------------------------------
// The feed's logo: what its card wears where a post wears its author's face.

/// Look for a feed's logo, unless it was looked for this week: the feed's own logo, then its
/// icon, then its site's `favicon.ico`. Kept only when it is a picture this node will serve.
async fn logo(state: &AppState, id: &str, feed: &feed_rs::model::Feed, now: i64) -> Result<()> {
    let db = &state.node_db;
    let looked: Option<(i64,)> = db
        .fetch_optional("SELECT logo_ms FROM rss_feeds WHERE feed_id = ?1", (id,))
        .await
        .context("reading when a feed's logo was looked for")?;
    if looked.is_some_and(|(at,)| now - at < LOGO_EVERY_MS) {
        return Ok(());
    }
    let mut candidates: Vec<String> =
        [&feed.logo, &feed.icon].into_iter().flatten().map(|i| i.uri.clone()).collect();
    if let Ok(site) = url::Url::parse(&feed_site(feed)) {
        if let Ok(icon) = site.join("/favicon.ico") {
            candidates.push(icon.to_string());
        }
    }
    let mut found: Option<(Vec<u8>, &'static str)> = None;
    for at in candidates {
        let Ok(got) = unfurl::guarded_get(
            &at,
            HeaderMap::new(),
            LOGO_BYTES,
            FETCH_TIMEOUT,
            state.config.local_test,
        )
        .await
        else {
            continue;
        };
        if let Some(kind) = picture_type(&got.body) {
            found = Some((got.body, kind));
            break;
        }
    }
    let (bytes, kind) = match found {
        Some((bytes, kind)) => (Some(bytes), Some(kind)),
        None => (None, None),
    };
    db.execute(
        "UPDATE rss_feeds SET logo = ?2, logo_type = ?3, logo_ms = ?4 WHERE feed_id = ?1",
        (id, bytes, kind, now),
    )
    .await
    .context("keeping a feed's logo")?;
    Ok(())
}

/// The media type of a picture this node will serve as a logo, by its first bytes - never by
/// what its server said, and never an SVG, which is a document that can carry script.
fn picture_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else if bytes.starts_with(&[0, 0, 1, 0]) {
        Some("image/x-icon")
    } else {
        None
    }
}

// ---------------------------------------------------------------------------------------------
// Into the feed: the followers' journals.

/// Journal a feed's kept items into its followers' feeds - every follower here, or `reader`
/// alone (who has just followed it) - and take out what the feed no longer keeps. An item's row
/// is refreshed in place when the item changed.
async fn journal(state: &AppState, feed: &str, reader: Option<&str>) -> Result<()> {
    let db = &state.node_db;
    db.execute(
        "INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms,
             updated_ms, arrived_ms)
         SELECT f.root, ?3 || i.feed_id, i.item_id, i.title, 'rss', i.dated_ms, i.updated_ms, i.fetched_ms
         FROM rss_items i JOIN rss_follows f ON f.feed_id = i.feed_id
         WHERE i.feed_id = ?1 AND (?2 IS NULL OR f.root = ?2)
         ON CONFLICT (reader_root, author_root, doc_id) DO UPDATE SET
             title = excluded.title,
             published_ms = excluded.published_ms,
             updated_ms = excluded.updated_ms
         WHERE feed_journal.updated_ms <> excluded.updated_ms",
        (feed, reader, AUTHOR),
    )
    .await
    .context("journalling a feed's items")?;
    db.execute(
        "DELETE FROM feed_journal
         WHERE author_root = ?2 || ?1 AND group_id = x''
           AND doc_id NOT IN (SELECT item_id FROM rss_items WHERE feed_id = ?1)",
        (feed, AUTHOR),
    )
    .await
    .context("taking dropped items out of feeds")?;
    crate::search::journal_or_labels_moved();
    Ok(())
}

/// Take a feed's items out of one reader's feed: they let it go.
async fn unjournal(state: &AppState, reader: &str, feed: &str) -> Result<()> {
    state
        .node_db
        .execute(
            "DELETE FROM feed_journal WHERE reader_root = ?1 AND author_root = ?3 || ?2 AND group_id = x''",
            (reader, feed, AUTHOR),
        )
        .await
        .context("taking a feed out of a reader's feed")?;
    crate::search::journal_or_labels_moved();
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The persona's doors (js/apps/rss.js).

/// One followed feed, as the reader shows it.
#[derive(Serialize)]
struct FeedView {
    id: String,
    url: String,
    title: String,
    site: String,
    tags: Vec<String>,
    /// How far the persona has read: the date of the newest item they'd seen.
    seen_ms: i64,
    unread: i64,
    /// Its newest item's date: how far opening it reads it.
    newest_ms: i64,
    /// When this node last heard from the feed; 0 if it never has.
    fetched_ms: i64,
    /// What went wrong the last time it was asked, while it keeps going wrong.
    error: Option<String>,
    /// Every ask has failed for a month: asked weekly now.
    quiet: bool,
}

/// A feed's row, as [`view`] reads it: its name, its site, and how its asking is going.
type ViewRow = (String, String, i64, Option<String>, Option<i64>);

async fn view(state: &AppState, id: &str, sub: &Subscription, seen_ms: i64) -> Result<FeedView> {
    let db = &state.node_db;
    let row: Option<ViewRow> = db
        .fetch_optional(
            "SELECT title, site, fetched_ms, error, failing_since_ms FROM rss_feeds WHERE feed_id = ?1",
            (id,),
        )
        .await
        .context("reading a feed")?;
    let (title, site, fetched_ms, error, failing_since) = row.unwrap_or_default();
    let (unread, newest_ms): (i64, i64) = db
        .fetch_one(
            "SELECT COUNT(CASE WHEN dated_ms > ?2 THEN 1 END), COALESCE(MAX(dated_ms), 0)
             FROM rss_items WHERE feed_id = ?1",
            (id, seen_ms),
        )
        .await
        .context("counting unread items")?;
    Ok(FeedView {
        id: id.to_string(),
        url: sub.url.clone(),
        title: if title.is_empty() { sub.title.clone() } else { title },
        site,
        tags: sub.tags.clone(),
        seen_ms,
        unread,
        newest_ms,
        fetched_ms,
        error,
        quiet: failing_since.is_some_and(|since| now_ms() - since >= QUIET_AFTER_MS),
    })
}

async fn views(state: &AppState, data: &Store, root: &str) -> Result<serde_json::Value, AppError> {
    let subs = subscriptions(data).await?;
    note_follows(state, root, &subs).await.map_err(AppError::Internal)?;
    note_tags(state, data, root).await?;
    let (seen, _) = data.private_registers(SEEN).all().await?;
    let seen: HashMap<String, i64> =
        seen.into_iter().filter_map(|r| Some((r.key, r.value.trim().parse().ok()?))).collect();
    let mut feeds = Vec::with_capacity(subs.len());
    for (id, sub) in &subs {
        feeds.push(
            view(state, id, sub, seen.get(id).copied().unwrap_or(0))
                .await
                .map_err(AppError::Internal)?,
        );
    }
    feeds.sort_by_key(|f| f.title.to_lowercase());
    Ok(serde_json::json!({ "feeds": feeds, "max": MAX_FEEDS }))
}

/// `GET /api/identity/{root}/rss`: the feeds the persona follows, each with its unread count.
pub async fn feeds_get(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    Ok(Json(views(&state, &data, &root).await?))
}

#[derive(Deserialize)]
pub struct FollowRequest {
    pub url: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

fn refused(r: Refusal) -> AppError {
    match r {
        Refusal::BadTarget(m) => AppError::BadRequest(m),
        Refusal::RateLimited => AppError::TooManyRequests(crate::msg!(
            "feedreader.too-many-fetches",
            "this node has fetched a lot just now - try again in a minute"
        )),
    }
}

/// `POST /api/identity/{root}/rss`: follow a feed - its address, or a web page's that names its
/// feed. Asked at once (unless this node already has it), so a bad address is refused here, not
/// found out three hours later.
pub async fn feeds_post(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<FollowRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let subs = subscriptions(&data).await?;
    if subs.len() >= MAX_FEEDS {
        return Err(AppError::BadRequest(crate::msg!(
            "feedreader.too-many-feeds",
            "you follow {n} feeds already, which is as many as one persona can",
            n = MAX_FEEDS
        )));
    }
    let asker = format!("account:{}", session.account.id);
    let mut url = normalise(&req.url).map_err(AppError::BadRequest)?;
    let mut answer = None;
    // Twice at most: the address given, then the feed its page names.
    for _ in 0..2 {
        let id = feed_id(&url);
        let cached: Option<(i64,)> = state
            .node_db
            .fetch_optional(
                "SELECT fetched_ms FROM rss_feeds WHERE feed_id = ?1 AND fetched_ms > 0",
                (id.as_str(),),
            )
            .await
            .map_err(AppError::Internal)?;
        if cached.is_some() {
            break;
        }
        state.unfurl.spend(&asker, now_ms()).await.map_err(refused)?;
        match ask(&state, url.as_str(), None, None).await {
            Ok(Answer::Page(Some(feed))) => {
                url = normalise(feed.as_str()).map_err(AppError::BadRequest)?
            }
            Ok(Answer::Page(None)) => {
                return Err(AppError::BadRequest(crate::msg!(
                    "feedreader.no-feed-there",
                    "that page isn't a feed, and doesn't name one"
                )))
            }
            Ok(Answer::Busy(_)) => {
                return Err(AppError::BadRequest(crate::msg!(
                    "feedreader.feed-busy",
                    "that feed's server is busy - try again later"
                )))
            }
            Ok(found) => {
                answer = Some(found);
                break;
            }
            Err(e) => {
                return Err(AppError::BadRequest(crate::msg!(
                    "feedreader.could-not-fetch",
                    "couldn't fetch that feed: {reason}",
                    reason = e
                )))
            }
        }
    }
    let id = feed_id(&url);
    let now = now_ms();
    let db = &state.node_db;
    db.execute(
        "INSERT OR IGNORE INTO rss_follows (feed_id, root, since_ms) VALUES (?1, ?2, ?3)",
        (id.as_str(), root.as_str(), now),
    )
    .await
    .map_err(AppError::Internal)?;
    db.execute(
        "INSERT OR IGNORE INTO rss_feeds (feed_id, url) VALUES (?1, ?2)",
        (id.as_str(), url.as_str()),
    )
    .await
    .map_err(AppError::Internal)?;
    let mut title = String::new();
    if let Some(Answer::Feed { feed, url: at, etag, modified, hint_ms }) = answer {
        keep(&state, &id, &feed, &at, now).await.map_err(AppError::Internal)?;
        logo(&state, &id, &feed, now).await.map_err(AppError::Internal)?;
        title = feed_title(&feed, &at);
        db.execute(
            "UPDATE rss_feeds SET title = ?2, site = ?3, etag = ?4, modified = ?5, checked_ms = ?6,
             fetched_ms = ?6, due_ms = ?7, failures = 0, failing_since_ms = NULL, error = NULL
             WHERE feed_id = ?1",
            (
                id.as_str(),
                title.as_str(),
                feed_site(&feed),
                etag,
                modified,
                now,
                next_due(now, hint_ms),
            ),
        )
        .await
        .map_err(AppError::Internal)?;
    } else if let Some((t,)) = db
        .fetch_optional::<(String,)>(
            "SELECT title FROM rss_feeds WHERE feed_id = ?1",
            (id.as_str(),),
        )
        .await
        .map_err(AppError::Internal)?
    {
        title = t;
    }
    journal(&state, &id, Some(&root)).await.map_err(AppError::Internal)?;
    // Its pictures now, so the first look finds them: not on this request's time.
    let pictures = state.clone();
    tokio::spawn(async move {
        if let Err(e) = pictures_pass(&pictures).await {
            tracing::debug!(error = ?e, "feed pictures pass failed");
        }
    });
    let tags = tidy_tags(&req.tags);
    let tags = match subs.iter().find(|(had, _)| *had == id) {
        // Followed already: the tags given join the ones it wears.
        Some((_, had)) => tidy_tags(&[had.tags.clone(), tags].concat()),
        None => tags,
    };
    write_subscription(&data, &id, &Subscription { url: url.to_string(), title, tags }).await?;
    let mut all = views(&state, &data, &root).await?;
    all["followed"] = serde_json::Value::String(id);
    Ok(Json(all))
}

#[derive(Deserialize)]
pub struct RetagRequest {
    pub tags: Vec<String>,
}

async fn followed(data: &Store, id: &str) -> Result<Subscription, AppError> {
    subscriptions(data)
        .await?
        .into_iter()
        .find(|(had, _)| had == id)
        .map(|(_, sub)| sub)
        .ok_or_else(|| {
            AppError::NotFound(crate::msg!("feedreader.not-followed", "you don't follow that feed"))
        })
}

/// `PUT /api/identity/{root}/rss/{feed}`: a followed feed's tags, replaced.
pub async fn feed_put(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
    Json(req): Json<RetagRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let mut sub = followed(&data, &id).await?;
    sub.tags = tidy_tags(&req.tags);
    write_subscription(&data, &id, &sub).await?;
    Ok(Json(views(&state, &data, &root).await?))
}

/// `DELETE /api/identity/{root}/rss/{feed}`: stop following a feed. The next [`pass`] forgets
/// it here, if nobody else on the node follows it.
pub async fn feed_delete(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    followed(&data, &id).await?;
    data.private_registers(SUBSCRIPTIONS).set(&id, "").await?;
    Ok(Json(views(&state, &data, &root).await?))
}

/// `POST /api/identity/{root}/rss/{feed}/refresh`: ask a followed feed now, rather than when
/// it's due - unless it was asked within the minute.
pub async fn feed_refresh(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    followed(&data, &id).await?;
    let checked: Option<(i64,)> = state
        .node_db
        .fetch_optional("SELECT checked_ms FROM rss_feeds WHERE feed_id = ?1", (id.as_str(),))
        .await
        .map_err(AppError::Internal)?;
    if checked.is_some_and(|(at,)| now_ms() - at >= AGAIN_GAP_MS) {
        state
            .unfurl
            .spend(&format!("account:{}", session.account.id), now_ms())
            .await
            .map_err(refused)?;
        refresh(&state, &id).await.map_err(AppError::Internal)?;
    }
    Ok(Json(views(&state, &data, &root).await?))
}

/// `GET /api/identity/{root}/rss/{feed}/logo`: a followed feed's logo, as this node keeps it.
pub async fn logo_get(
    session: Session,
    State(state): State<AppState>,
    Path((root, id)): Path<(String, String)>,
) -> Result<axum::response::Response, AppError> {
    store::open(&state, &session.account.id, &root).await?;
    let row: Option<(Vec<u8>, String)> = state
        .node_db
        .fetch_optional(
            "SELECT f.logo, f.logo_type FROM rss_feeds f JOIN rss_follows w ON w.feed_id = f.feed_id
             WHERE f.feed_id = ?1 AND w.root = ?2 AND f.logo IS NOT NULL",
            (id.as_str(), root.as_str()),
        )
        .await
        .map_err(AppError::Internal)?;
    let Some((bytes, kind)) = row else {
        return Err(AppError::NotFound(crate::msg!(
            "feedreader.no-logo",
            "that feed has no logo here"
        )));
    };
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, kind),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400".to_string()),
            (axum::http::header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
        ],
        bytes,
    )
        .into_response())
}

/// `GET /api/identity/{root}/rss/{feed}/{item}/body`: an item's words, as Marquee - the card's
/// body door, where a post's is its author's.
pub async fn body_get(
    session: Session,
    State(state): State<AppState>,
    Path((root, feed, item)): Path<(String, String, String)>,
) -> Result<axum::response::Response, AppError> {
    store::open(&state, &session.account.id, &root).await?;
    let row: Option<(String, String)> = state
        .node_db
        .fetch_optional(
            "SELECT i.body, i.summary FROM rss_items i JOIN rss_follows f ON f.feed_id = i.feed_id
             WHERE f.root = ?1 AND i.feed_id = ?2 AND i.item_id = ?3",
            (root.as_str(), feed.as_str(), item.as_str()),
        )
        .await
        .map_err(AppError::Internal)?;
    let Some((body, summary)) = row else {
        return Err(AppError::NotFound(crate::msg!(
            "feedreader.no-item",
            "that item isn't in a feed you follow"
        )));
    };
    let words = if body.is_empty() { summary } else { body };
    let wanted = serde_json::to_string(&embedded_pictures(&words)).unwrap_or_default();
    let rows: Vec<(String, String, String, Option<String>)> = state
        .node_db
        .fetch_all(
            "SELECT source_url, status, key, format FROM rss_pictures
             WHERE source_url IN (SELECT value FROM json_each(?1))",
            (wanted,),
        )
        .await
        .map_err(AppError::Internal)?;
    let pictures = rows
        .into_iter()
        .map(|(url, status, key, format)| (url, (status, key, format.unwrap_or_default())))
        .collect();
    Ok((
        [(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        served_words(&words, &pictures),
    )
        .into_response())
}

/// The key of a persona's tags on one item, in the [`TAGS`] collection.
fn tags_key(feed: &str, item: &str) -> String {
    format!("{feed}{item}")
}

/// Bring this node's note of the persona's tags on items up to date with their registers: tags
/// put on another computer count here.
async fn note_tags(state: &AppState, data: &Store, root: &str) -> Result<(), AppError> {
    let (registers, _) = data.private_registers(TAGS).all().await?;
    let mut wanted: std::collections::BTreeSet<(String, String, String)> = Default::default();
    for r in registers {
        if r.key.len() != 64 || !is_id(&r.key[..32]) || !is_id(&r.key[32..]) {
            continue;
        }
        let tags: Vec<String> = serde_json::from_str(&r.value).unwrap_or_default();
        for tag in tags.into_iter().take(crate::annotations::MAX_TAGS_PER_LABELLER) {
            wanted.insert((r.key[..32].to_string(), r.key[32..].to_string(), tag));
        }
    }
    let db = &state.node_db;
    let noted: Vec<(String, String, String)> = db
        .fetch_all("SELECT feed_id, item_id, tag FROM rss_tags WHERE root = ?1", (root,))
        .await
        .map_err(AppError::Internal)?;
    // Unchanged, as it mostly is: the tag cloud's cache stays good.
    if noted.into_iter().collect::<std::collections::BTreeSet<_>>() == wanted {
        return Ok(());
    }
    db.execute("DELETE FROM rss_tags WHERE root = ?1", (root,))
        .await
        .map_err(AppError::Internal)?;
    for (feed, item, tag) in &wanted {
        db.execute(
            "INSERT OR IGNORE INTO rss_tags (root, feed_id, item_id, tag) VALUES (?1, ?2, ?3, ?4)",
            (root, feed.as_str(), item.as_str(), tag.as_str()),
        )
        .await
        .map_err(AppError::Internal)?;
    }
    crate::search::journal_or_labels_moved();
    Ok(())
}

/// `PUT /api/identity/{root}/rss/{feed}/{item}/tags/{tag}`: tag an item, privately - two tags at
/// most, as on somebody else's post.
pub async fn tag_put(
    session: Session,
    State(state): State<AppState>,
    Path((root, feed, item, tag)): Path<(String, String, String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    retag(&state, &session, &root, &feed, &item, &tag, true).await
}

/// `DELETE /api/identity/{root}/rss/{feed}/{item}/tags/{tag}`: take a tag of theirs off an item.
pub async fn tag_delete(
    session: Session,
    State(state): State<AppState>,
    Path((root, feed, item, tag)): Path<(String, String, String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    retag(&state, &session, &root, &feed, &item, &tag, false).await
}

async fn retag(
    state: &AppState,
    session: &Session,
    root: &str,
    feed: &str,
    item: &str,
    tag: &str,
    on: bool,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(state, &session.account.id, root).await?;
    let followed: Option<(i64,)> = state
        .node_db
        .fetch_optional(
            "SELECT 1 FROM rss_items i JOIN rss_follows f ON f.feed_id = i.feed_id
             WHERE f.root = ?1 AND i.feed_id = ?2 AND i.item_id = ?3",
            (root, feed, item),
        )
        .await
        .map_err(AppError::Internal)?;
    if followed.is_none() {
        return Err(AppError::NotFound(crate::msg!(
            "feedreader.no-item",
            "that item isn't in a feed you follow"
        )));
    }
    let tag = tag.trim().to_lowercase();
    if tag.is_empty() || tag.chars().count() > MAX_TAG_CHARS {
        return Err(AppError::BadRequest(crate::msg!(
            "feedreader.bad-tag",
            "a tag is one to {n} characters",
            n = MAX_TAG_CHARS
        )));
    }
    let key = tags_key(feed, item);
    let registers = data.private_registers(TAGS);
    let (all, _) = registers.all().await?;
    let mut tags: Vec<String> = all
        .into_iter()
        .find(|r| r.key == key)
        .and_then(|r| serde_json::from_str(&r.value).ok())
        .unwrap_or_default();
    if on {
        if !tags.contains(&tag) {
            if tags.len() >= crate::annotations::MAX_TAGS_PER_LABELLER {
                return Err(AppError::BadRequest(crate::msg!(
                    "feedreader.two-tags",
                    "two tags on an item at most - take one off first"
                )));
            }
            tags.push(tag);
        }
    } else {
        tags.retain(|t| *t != tag);
    }
    let value = if tags.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&tags).map_err(|e| AppError::Internal(e.into()))?
    };
    registers.set(&key, &value).await?;
    note_tags(state, &data, root).await?;
    Ok(Json(serde_json::json!({ "tags": tags })))
}

// ---------------------------------------------------------------------------------------------
// An item as a post: what the feed, the card and the filters ask of an author, answered for a
// feed.

/// The feed an author spells, when the author is a feed ([`AUTHOR`] and a feed id).
pub fn feed_of(author: &str) -> Option<&str> {
    author.strip_prefix(AUTHOR).filter(|id| is_id(id))
}

/// The page's feed items, `(feed id, item id)` by their `(author, doc)` pair - the ids checked, so
/// they are safe to write into SQL.
fn items_of(posts: &[(String, String)]) -> Vec<(&str, &str)> {
    posts
        .iter()
        .filter_map(|(author, doc)| Some((feed_of(author)?, doc.as_str())))
        .filter(|(_, doc)| is_id(doc))
        .collect()
}

fn quoted<'a>(ids: impl Iterator<Item = &'a str>) -> String {
    let set: std::collections::BTreeSet<&str> = ids.collect();
    set.into_iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",")
}

/// Feeds' bylines, by their author spelling: the feed's name, where a person's is theirs
/// (profiles.rs `bylines` asks here for every author that is a feed).
pub async fn bylines(
    node_db: &crate::db::Db,
    authors: &[String],
) -> Result<std::collections::BTreeMap<String, crate::profiles::Byline>> {
    let feeds: Vec<&str> = authors.iter().filter_map(|a| feed_of(a)).collect();
    if feeds.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, String)> = node_db
        .fetch_all(
            &format!(
                "SELECT feed_id, title FROM rss_feeds WHERE feed_id IN ({})",
                quoted(feeds.into_iter())
            ),
            (),
        )
        .await
        .context("reading feeds' names")?;
    Ok(rows
        .into_iter()
        .map(|(id, title)| {
            (
                format!("{AUTHOR}{id}"),
                crate::profiles::Byline { name: Some(title), ..Default::default() },
            )
        })
        .collect())
}

/// What a card shows of an item's feed, beside what a post's card shows.
#[derive(Serialize, Clone)]
pub struct FeedCard {
    /// The feed's id, and its address.
    pub id: String,
    pub url: String,
    /// The website it belongs to, and whether this node has its logo.
    pub site: String,
    pub logo: bool,
    /// The item's own address, on the website, and who the feed says wrote it.
    pub link: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub byline: String,
}

/// The feed cards of a page's items, by `(author, doc)`.
pub async fn cards(
    node_db: &crate::db::Db,
    posts: &[(String, String)],
) -> Result<HashMap<(String, String), FeedCard>> {
    let items = items_of(posts);
    if items.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, String, String, String, String, i64, String)> = node_db
        .fetch_all(
            &format!(
                "SELECT i.feed_id, i.item_id, i.link, i.author, f.url, f.logo IS NOT NULL, f.site
                 FROM rss_items i JOIN rss_feeds f ON f.feed_id = i.feed_id
                 WHERE i.feed_id IN ({}) AND i.item_id IN ({})",
                quoted(items.iter().map(|(f, _)| *f)),
                quoted(items.iter().map(|(_, i)| *i))
            ),
            (),
        )
        .await
        .context("reading feed items' cards")?;
    Ok(rows
        .into_iter()
        .map(|(feed, item, link, byline, url, logo, site)| {
            (
                (format!("{AUTHOR}{feed}"), item),
                FeedCard { id: feed, url, site, logo: logo != 0, link, byline },
            )
        })
        .collect())
}

/// The labels on a page's items, as `annotations::for_posts` gives a post's: each item's
/// automatic tags, said by its feed as a post's are by its author, then the viewer's own private
/// tags on it.
pub async fn labels(
    node_db: &crate::db::Db,
    viewer: Option<&str>,
    posts: &[(String, String)],
) -> Result<HashMap<(String, String), Vec<crate::annotations::KnownAnnotation>>> {
    let items = items_of(posts);
    if items.is_empty() {
        return Ok(Default::default());
    }
    let wanted: HashSet<(&str, &str)> = items.iter().copied().collect();
    let feeds = quoted(items.iter().map(|(f, _)| *f));
    let ids = quoted(items.iter().map(|(_, i)| *i));
    let automatic: Vec<(String, String, String)> = node_db
        .fetch_all(
            &format!(
                "SELECT feed_id, item_id, tags FROM rss_items
                 WHERE feed_id IN ({feeds}) AND item_id IN ({ids}) AND tags <> ''"
            ),
            (),
        )
        .await
        .context("reading items' automatic tags")?;
    let own: Vec<(String, String, String)> = match viewer {
        Some(viewer) => node_db
            .fetch_all(
                &format!(
                    "SELECT feed_id, item_id, tag FROM rss_tags
                     WHERE root = ?1 AND feed_id IN ({feeds}) AND item_id IN ({ids})"
                ),
                (viewer,),
            )
            .await
            .context("reading a reader's tags on items")?,
        None => Vec::new(),
    };
    Ok(gather(automatic, own, viewer, &wanted))
}

/// Every label on the feed items of one reader's journal published since `since_ms`: the tag
/// cloud's read (annotations.rs `for_journal_since` asks here for the window's feed items).
pub async fn labels_since(
    node_db: &crate::db::Db,
    reader: &str,
    since_ms: i64,
) -> Result<HashMap<(String, String), Vec<crate::annotations::KnownAnnotation>>> {
    let automatic: Vec<(String, String, String)> = node_db
        .fetch_all(
            "SELECT i.feed_id, i.item_id, i.tags FROM rss_items i
             JOIN rss_follows f ON f.feed_id = i.feed_id
             WHERE f.root = ?1 AND i.dated_ms >= ?2 AND i.tags <> ''",
            (reader, since_ms),
        )
        .await
        .context("reading a window's automatic tags")?;
    let own: Vec<(String, String, String)> = node_db
        .fetch_all(
            "SELECT t.feed_id, t.item_id, t.tag FROM rss_tags t
             JOIN rss_items i ON i.feed_id = t.feed_id AND i.item_id = t.item_id
             WHERE t.root = ?1 AND i.dated_ms >= ?2",
            (reader, since_ms),
        )
        .await
        .context("reading a window's own tags")?;
    let mut out = gather(automatic, own, Some(reader), &HashSet::new());
    out.retain(|_, labels| !labels.is_empty());
    Ok(out)
}

/// Automatic tags (space-separated, by item) and a viewer's own (one a row), as labels by
/// `(author, doc)`; only the `wanted` items, unless it is empty.
fn gather(
    automatic: Vec<(String, String, String)>,
    own: Vec<(String, String, String)>,
    viewer: Option<&str>,
    wanted: &HashSet<(&str, &str)>,
) -> HashMap<(String, String), Vec<crate::annotations::KnownAnnotation>> {
    let mut out: HashMap<(String, String), Vec<crate::annotations::KnownAnnotation>> =
        HashMap::new();
    let admit = |f: &str, i: &str| wanted.is_empty() || wanted.contains(&(f, i));
    for (feed, item, tags) in automatic {
        if !admit(&feed, &item) {
            continue;
        }
        let author = format!("{AUTHOR}{feed}");
        let list = out.entry((author.clone(), item)).or_default();
        for tag in tags.split_whitespace() {
            list.push(crate::annotations::KnownAnnotation {
                annotator: author.clone(),
                key: "tag".into(),
                value: tag.into(),
            });
        }
    }
    if let Some(viewer) = viewer {
        for (feed, item, tag) in own {
            if !admit(&feed, &item) {
                continue;
            }
            out.entry((format!("{AUTHOR}{feed}"), item)).or_default().push(
                crate::annotations::KnownAnnotation {
                    annotator: viewer.to_string(),
                    key: "tag".into(),
                    value: tag,
                },
            );
        }
    }
    out
}

/// The items of the feeds `reader` follows that carry this tag - automatic, or their own - as
/// `(author, doc)`: the feed's "only" pick reads these beside the posts the label's memo names.
pub async fn tagged(
    node_db: &crate::db::Db,
    reader: &str,
    tag: &str,
) -> Result<Vec<(String, String)>> {
    let mut rows: Vec<(String, String)> = node_db
        .fetch_all(
            "SELECT i.feed_id, i.item_id FROM rss_items i
             JOIN rss_follows f ON f.feed_id = i.feed_id
             WHERE f.root = ?1 AND (' ' || i.tags || ' ') LIKE ('% ' || ?2 || ' %')",
            (reader, tag),
        )
        .await
        .context("reading items with an automatic tag")?;
    let own: Vec<(String, String)> = node_db
        .fetch_all(
            "SELECT feed_id, item_id FROM rss_tags WHERE root = ?1 AND tag = ?2",
            (reader, tag),
        )
        .await
        .context("reading items with a tag of the reader's")?;
    rows.extend(own);
    Ok(rows.into_iter().map(|(feed, item)| (format!("{AUTHOR}{feed}"), item)).collect())
}

/// An item as copied into a reader's notes (routes.rs `docs_copy_handler`), or rebroadcast as a
/// post of theirs (`rss_rebroadcast_handler`).
pub struct CopySource {
    pub title: String,
    /// Its words as Marquee.
    pub words: String,
    /// Its own address, and its feed's address and name.
    pub link: String,
    pub feed_url: String,
    pub feed_name: String,
    /// The reader's own tags on it.
    pub tags: Vec<String>,
}

impl CopySource {
    /// Its words as a note of the reader's, with where they came from beneath them in a `:::meta`
    /// (Marquee SPEC, Document metadata; Curtis, 2026-10-30): a note has no fields to say it in,
    /// and a `:::meta` renders nothing but travels with the words - into exports, and back in. A
    /// rebroadcast takes the words alone: its post says its source as fields, which every card
    /// reads as its "via" line.
    pub fn note_body(&self) -> String {
        let attrs: marquee_parser::Attrs = [
            (SOURCE_NAME, &self.feed_name),
            (SOURCE_LINK, &self.link),
            (SOURCE_FEED, &self.feed_url),
        ]
        .into_iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| (k.to_string(), v.replace(['\n', '\r'], " ")))
        .collect();
        if attrs.is_empty() {
            return self.words.clone();
        }
        let meta = marquee_parser::serialize(&marquee_parser::Node::Directive {
            name: "meta".to_string(),
            attrs,
            children: Vec::new(),
        });
        format!("{}\n\n{}", self.words.trim_end(), meta.trim_end())
    }
}

/// A rebroadcast's "via" line, for a surface that shows only a post's words (rss.rs, reading.rs):
/// the cards read it from the same labels. Only what its author said, and only a web address.
pub fn via_html(labels: &[crate::annotations::KnownAnnotation], author: &str) -> Option<String> {
    let said = |key: &str| {
        labels
            .iter()
            .find(|a| a.annotator == author && a.key == key)
            .map(|a| a.value.trim())
            .filter(|v| !v.is_empty())
    };
    let web = |v: &str| url::Url::parse(v).ok().filter(|u| matches!(u.scheme(), "http" | "https"));
    let feed = said(SOURCE_FEED).and_then(web)?;
    let link = said(SOURCE_LINK).and_then(web).unwrap_or_else(|| feed.clone());
    let name = said(SOURCE_NAME)
        .map(str::to_string)
        .unwrap_or_else(|| feed.host_str().unwrap_or_default().to_string());
    Some(format!(
        "<p>Via <a href=\"{}\">{}</a></p>",
        marquee_html_renderer::escape_attr(link.as_str()),
        crate::reading::esc(&name)
    ))
}

/// The labels a rebroadcast item's post carries, said by its author as a post's own fields are
/// (routes.rs `draft_labels`): where it came from - the feed's address, its name, and the item's own
/// address - so every reader's card says "via" it (plans/RSS.md).
pub const SOURCE_FEED: &str = "source_feed";
pub const SOURCE_NAME: &str = "source_name";
pub const SOURCE_LINK: &str = "source_link";
/// The private collection of where a persona has rebroadcast each item: keyed as [`TAGS`] is, the
/// value a JSON list of "everyone" and group ids.
pub const REBROADCASTS: &str = "rss_rebroadcasts";

/// Note that the persona is rebroadcasting this item `to` everyone or a group; refused when it
/// already went there.
pub async fn note_rebroadcast(
    data: &Store,
    feed: &str,
    item: &str,
    to: &str,
) -> Result<(), AppError> {
    let key = tags_key(feed, item);
    let registers = data.private_registers(REBROADCASTS);
    let (all, _) = registers.all().await?;
    let mut places: Vec<String> = all
        .into_iter()
        .find(|r| r.key == key)
        .and_then(|r| serde_json::from_str(&r.value).ok())
        .unwrap_or_default();
    if places.iter().any(|p| p == to) {
        return Err(AppError::BadRequest(crate::msg!(
            "feedreader.rebroadcast-already",
            "you've rebroadcast this there already"
        )));
    }
    places.push(to.to_string());
    let value = serde_json::to_string(&places).map_err(|e| AppError::Internal(e.into()))?;
    registers.set(&key, &value).await?;
    Ok(())
}

/// An item of a feed `reader` follows, ready to copy into their notes; `None` when the author
/// is no feed, or the item isn't one of theirs to read.
pub async fn copy_source(
    node_db: &crate::db::Db,
    reader: &str,
    author: &str,
    item: &str,
) -> Result<Option<CopySource>> {
    let Some(feed) = feed_of(author) else { return Ok(None) };
    let row: Option<(String, String, String, String, String, String)> = node_db
        .fetch_optional(
            "SELECT i.title, i.body, i.summary, i.link, d.title, d.url FROM rss_items i
             JOIN rss_follows f ON f.feed_id = i.feed_id JOIN rss_feeds d ON d.feed_id = i.feed_id
             WHERE f.root = ?1 AND i.feed_id = ?2 AND i.item_id = ?3",
            (reader, feed, item),
        )
        .await
        .context("reading an item to copy")?;
    let Some((title, body, summary, link, feed_name, feed_url)) = row else { return Ok(None) };
    let tags: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT tag FROM rss_tags WHERE root = ?1 AND feed_id = ?2 AND item_id = ?3",
            (reader, feed, item),
        )
        .await
        .context("reading a reader's tags to copy")?;
    Ok(Some(CopySource {
        title,
        words: if body.is_empty() { summary } else { body },
        link,
        feed_url,
        feed_name,
        tags: tags.into_iter().map(|(t,)| t).collect(),
    }))
}

/// An item's words, as plain text, for a search to read (search.rs `bag_for`).
pub async fn words(node_db: &crate::db::Db, author: &str, item: &str) -> Result<Option<String>> {
    let Some(feed) = feed_of(author) else { return Ok(None) };
    let row: Option<(String, String)> = node_db
        .fetch_optional(
            "SELECT summary, body FROM rss_items WHERE feed_id = ?1 AND item_id = ?2",
            (feed, item),
        )
        .await
        .context("reading an item's words")?;
    Ok(row.map(|(summary, body)| if body.is_empty() { summary } else { body }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_normalise_and_ids_follow_them() {
        let a = normalise("  Example.COM/feed.xml#top ").unwrap();
        assert_eq!(a.as_str(), "https://example.com/feed.xml");
        let b = normalise("https://example.com/feed.xml").unwrap();
        assert_eq!(feed_id(&a), feed_id(&b));
        assert!(is_id(&feed_id(&a)));
        assert_ne!(
            feed_id(&a),
            feed_id(&normalise("https://example.com/feed.xml?token=1").unwrap())
        );
        assert!(normalise("ftp://example.com/feed").is_err());
        assert!(normalise("javascript:alert(1)").is_err());
        assert!(normalise(&format!("https://example.com/{}", "a".repeat(MAX_URL))).is_err());
    }

    #[test]
    fn tags_are_tidied() {
        let tags = tidy_tags(&["  News ".into(), "news".into(), "".into(), "x".repeat(40)]);
        assert_eq!(tags, vec!["news".to_string(), "x".repeat(MAX_TAG_CHARS)]);
        let many: Vec<String> = (0..40).map(|n| format!("t{n}")).collect();
        assert_eq!(tidy_tags(&many).len(), MAX_TAGS);
    }

    #[test]
    fn a_page_names_its_feed() {
        let page = url::Url::parse("https://example.com/blog/").unwrap();
        let html = r#"<html><head>
            <link rel="stylesheet" href="/style.css">
            <link rel="alternate" type="application/rss+xml" title="RSS" href="feed.xml">
            </head><body></body></html>"#;
        assert_eq!(alternate(html, &page).unwrap().as_str(), "https://example.com/blog/feed.xml");
        let none = r#"<link rel="alternate" hreflang="fr" href="/fr/">"#;
        assert!(alternate(none, &page).is_none());
        let sneaky =
            r#"<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">"#;
        assert!(alternate(sneaky, &page).is_none());
    }

    #[test]
    fn asking_again_waits_three_hours_or_what_the_feed_asks() {
        let now = 1_000_000_000_000;
        for _ in 0..50 {
            let due = next_due(now, 0) - now;
            assert!((REFRESH_MS * 7 / 8..=REFRESH_MS * 9 / 8).contains(&due));
            let due = next_due(now, 12 * 60 * 60 * 1000) - now;
            assert!(due >= 12 * 60 * 60 * 1000 * 7 / 8);
            let due = next_due(now, 30 * 24 * 60 * 60 * 1000) - now;
            assert!(due <= LONGEST_MS * 9 / 8, "a feed can't put itself off for more than a day");
        }
        assert_eq!(max_age_ms("public, max-age=600"), Some(600_000));
        assert_eq!(max_age_ms("no-store"), None);
    }

    #[test]
    fn failures_back_off_then_go_quiet() {
        let now = 1_000_000_000_000;
        assert_eq!(backoff_due(now, 1, now) - now, REFRESH_MS);
        assert_eq!(backoff_due(now, 2, now) - now, 2 * REFRESH_MS);
        assert_eq!(backoff_due(now, 3, now) - now, 4 * REFRESH_MS);
        assert_eq!(backoff_due(now, 9, now) - now, LONGEST_MS);
        assert_eq!(backoff_due(now, 9, now - QUIET_AFTER_MS) - now, QUIET_EVERY_MS);
    }

    const RSS: &str = r#"<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
  <title>The &amp; Gazette</title>
  <link>https://gazette.example/</link>
  <ttl>720</ttl>
  <item>
    <title>Horses &lt;3 hay</title>
    <link>https://gazette.example/2026/hay</link>
    <guid>hay-1</guid>
    <pubDate>Mon, 26 Oct 2026 12:00:00 GMT</pubDate>
    <description>A short &lt;b&gt;word&lt;/b&gt; on hay.</description>
    <content:encoded><![CDATA[<p>Hay is <em>good</em>.</p><script>alert(1)</script><p><a href="/more">more</a></p>]]></content:encoded>
  </item>
  <item>
    <title>Undated</title>
    <link>https://gazette.example/undated</link>
    <pubDate>Thu, 01 Jan 1970 00:00:00 GMT</pubDate>
  </item>
</channel>
</rss>"#;

    #[test]
    fn an_item_is_translated_never_kept_as_html() {
        let at = url::Url::parse("https://gazette.example/rss").unwrap();
        let feed = feed_rs::parser::Builder::new()
            .base_uri(Some(at.as_str()))
            .build()
            .parse(RSS.as_bytes())
            .unwrap();
        assert_eq!(feed_title(&feed, &at), "The & Gazette");
        assert_eq!(feed.ttl, Some(720));
        let now = 1_800_000_000_000;
        let hay = item(&feed.entries[0], &at, now);
        assert_eq!(hay.id, item_id("hay-1"));
        assert_eq!(hay.title, "Horses <3 hay");
        assert_eq!(hay.link, "https://gazette.example/2026/hay");
        assert_eq!(hay.summary, "A short word on hay.");
        assert!(hay.body.contains("Hay is *good*."), "{}", hay.body);
        assert!(
            hay.body.contains("https://gazette.example/more"),
            "relative links resolve: {}",
            hay.body
        );
        assert!(!hay.body.contains("script") && !hay.body.contains("alert"), "{}", hay.body);
        assert!(hay.dated_ms.is_some());
        let undated = item(&feed.entries[1], &at, now);
        assert_eq!(undated.dated_ms, None, "1970 is a mistake, not a date");
        assert_eq!(hay.tags, vec!["micro"], "a few words are a micro post");
    }

    #[test]
    fn an_item_wears_a_posts_automatic_tags() {
        let words = "word ".repeat(600);
        let podcast = format!(
            r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Pod</title>
            <item><title>Episode 1</title><guid>e1</guid><description>{words}</description>
              <enclosure url="https://pod.example/1.mp3" type="audio/mpeg" length="1"/></item>
            <item><title>Pictures</title><guid>p1</guid>
              <description>&lt;p&gt;look&lt;/p&gt;&lt;img src="/a.png"&gt;</description></item>
            <item><title>Nothing</title><guid>n1</guid></item>
            </channel></rss>"#
        );
        let at = url::Url::parse("https://pod.example/feed").unwrap();
        let feed = feed_rs::parser::parse(podcast.as_bytes()).unwrap();
        let tags: Vec<Vec<&str>> = feed.entries.iter().map(|e| item(e, &at, 0).tags).collect();
        assert_eq!(tags, vec![vec!["audio", "medium"], vec!["image", "micro"], vec![]]);
    }

    #[test]
    fn a_logo_is_a_picture_by_its_bytes() {
        assert_eq!(picture_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(picture_type(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(picture_type(b"RIFF0000WEBPVP8 "), Some("image/webp"));
        assert_eq!(picture_type(b"<svg onload=alert(1)>"), None, "never an svg");
        assert_eq!(picture_type(b"<html>"), None);
    }

    #[test]
    fn a_feed_is_an_author_no_root_can_be() {
        let id = feed_id(&normalise("example.com/feed").unwrap());
        assert_eq!(feed_of(&format!("{AUTHOR}{id}")), Some(id.as_str()));
        assert_eq!(feed_of(&id), None);
        assert_eq!(feed_of("rss:' OR 1=1 --"), None, "only an id reaches the SQL");
        let posts = vec![
            (format!("{AUTHOR}{id}"), "0".repeat(32)),
            (format!("{AUTHOR}{id}"), "nope".into()),
            ("a".repeat(64), "0".repeat(32)),
        ];
        assert_eq!(items_of(&posts), vec![(id.as_str(), "0".repeat(32).as_str())]);
    }

    /// Serious Eats' news sitemap, trimmed: an entry with its picture, one without a title (not
    /// news, so not an item), and an ampersand that stays one.
    #[test]
    fn a_news_sitemap_reads_as_a_feed() {
        let sitemap = r#"<?xml version="1.0" encoding="UTF-8" standalone="no"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
<url><loc>
https://www.seriouseats.com/porcupine-meatballs-recipe-12196859
</loc><lastmod>2026-10-27T21:30:00-04:00</lastmod>
<news:news><news:publication><news:language>en</news:language><news:name>seriouseats.com</news:name></news:publication>
<news:publication_date>2026-10-27T21:30:00-04:00</news:publication_date>
<news:title>Porcupine Meatballs &amp; Rice</news:title></news:news>
<image:image><image:loc>https://www.seriouseats.com/thmb/a.jpg</image:loc></image:image></url>
<url><loc>https://www.seriouseats.com/about</loc></url>
</urlset>"#;
        let at = url::Url::parse("https://feeds.feedburner.com/seriouseatsfeaturesvideos").unwrap();
        let atom = news_sitemap(sitemap.as_bytes(), &at).expect("a news sitemap");
        let feed = feed_rs::parser::parse(atom.as_bytes()).unwrap();
        assert_eq!(feed_title(&feed, &at), "seriouseats.com");
        assert_eq!(feed_site(&feed), "https://www.seriouseats.com/");
        assert_eq!(feed.entries.len(), 1, "the untitled page is not news");
        let hay = item(&feed.entries[0], &at, 1_793_200_000_000);
        assert_eq!(hay.title, "Porcupine Meatballs & Rice");
        assert_eq!(hay.link, "https://www.seriouseats.com/porcupine-meatballs-recipe-12196859");
        assert!(hay.body.contains("https://www.seriouseats.com/thmb/a.jpg"), "{}", hay.body);
        assert_eq!(hay.dated_ms, Some(1793151000000));

        // A plain sitemap, an RSS feed and a web page are none of them a news sitemap.
        let plain = r#"<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://example.com/</loc></url></urlset>"#;
        assert!(news_sitemap(plain.as_bytes(), &at).is_none());
        assert!(news_sitemap(b"<rss version=\"2.0\"><channel></channel></rss>", &at).is_none());
        assert!(news_sitemap(b"<html><body>hi</body></html>", &at).is_none());
    }

    /// Real writing nests shallowly and passes; nesting past [`DEEPEST`] doesn't, however it's
    /// spelled - including the two spellings a count of tags alone would miss.
    #[test]
    fn deep_html_is_caught_without_a_parser() {
        let deep =
            |open: &str, close: &str, n: usize| format!("{}x{}", open.repeat(n), close.repeat(n));
        let post =
            "<div><p>One <em>two</em><p>three<ul><li>a<li>b<ul><li>c</ul></ul><img src=x><br>\
                    <table><tr><td>1<td>2<tr><td>3</table></div>";
        assert!(!too_much(&post.repeat(1_000)), "siblings are not depth");
        assert!(!too_much(&"<p>unclosed ".repeat(5_000)));
        assert!(!too_much(&"<div><table><tr><td>a</td></tr></table></div>".repeat(2_000)));
        assert!(!too_much(&deep("<div>", "</div>", DEEPEST)));
        assert!(too_much(&deep("<div>", "</div>", DEEPEST + 1)));
        assert!(too_much(&deep("<UL><LI>", "</li></ul>", 600)));
        assert!(too_much(&deep("<blockquote class=\"q\">", "</blockquote>", 600)));
        assert!(too_much(&"<div/>".repeat(600)), "HTML ignores the slash");
        assert!(too_much(&"<div></span>".repeat(600)), "a stray closing tag closes nothing");
        // Closing tags the parser never sees as tags, or never lets reach their element.
        assert!(too_much(&"<div><!-- </div> -->".repeat(600)), "a comment holds no tags");
        assert!(
            too_much(&"<div><script></div></script>".repeat(600)),
            "a script's insides are text"
        );
        assert!(too_much(&"<div title='</div>'>".repeat(600)), "nor are an attribute's");
        assert!(
            too_much(&"<div><table></div>".repeat(300)),
            "a table is a scope a div's end can't reach into"
        );
        assert!(!too_much(&"<!-- <div> -->".repeat(600)));
        assert!(
            too_much(&format!("<svg><title>{}", "<g>".repeat(600))),
            "an SVG's title holds elements"
        );
        assert!(too_much(&"<div><noscript></div></noscript>".repeat(600)));
        assert!(!too_much(&"<script>if (a<b) { x = '<div>'; }</script>".repeat(600)));
        // A tag with too many attributes: html5ever checks each against all before it.
        let attributes: String =
            (0..MOST_ATTRIBUTES + 1).map(|i| format!(" a{i}=\"1 2 3\"")).collect();
        assert!(too_much(&format!("<div{attributes}>x</div>")));
        assert!(!too_much(
            r#"<img src="data:image/png;base64,iVBOR==" alt="a > b" title='c "d"'>"#
        ));
        assert!(too_much(&"x".repeat(PARSED_BYTES + 1)), "and past a size, unread");
    }

    /// The probe that found it (2026-10-28): 5 MiB of nested lists took html5ever two minutes. Now
    /// the item keeps its words, flattened, in well under a second - and so does its summary.
    #[test]
    fn a_deep_item_is_kept_as_its_words_in_no_time() {
        let n = 5 * 1024 * 1024 / 19;
        let html = format!("{}hay and oats{}", "<ul><li>".repeat(n), "</li></ul>".repeat(n));
        let rss = format!(
            "<rss version=\"2.0\"><channel><title>t</title><item><title>deep</title><guid>1</guid>\
             <description><![CDATA[{html}]]></description></item></channel></rss>"
        );
        let feed = feed_rs::parser::parse(rss.as_bytes()).unwrap();
        let at = url::Url::parse("https://evil.example/feed").unwrap();
        let started = std::time::Instant::now();
        let deep = item(&feed.entries[0], &at, 0);
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
        assert_eq!(deep.body.trim(), "hay and oats");
        assert_eq!(deep.summary, "hay and oats");

        // The worst for the scan itself: closing tags that each look all the way down.
        let lopsided = format!(
            "{}{}",
            "<div>".repeat(DEEPEST),
            "</x>".repeat((PARSED_BYTES - 5 * DEEPEST) / 4)
        );
        let started = std::time::Instant::now();
        assert!(!too_much(&lopsided));
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
    }

    /// A page too deep to read for its head names no feed, and costs nothing to find out.
    #[test]
    fn a_deep_page_names_no_feed() {
        let page = url::Url::parse("https://example.com/").unwrap();
        let deep = format!(
            "<html><head>{}<link rel=\"alternate\" type=\"application/rss+xml\" href=\"f.xml\">",
            "<div>".repeat(600)
        );
        assert!(alternate(&deep, &page).is_none());
        let fine = format!(
            "{}</head><body>{}",
            r#"<html><head><link rel="alternate" type="application/rss+xml" href="f.xml">"#,
            "<div>".repeat(100_000)
        );
        assert_eq!(
            alternate(&fine, &page).unwrap().as_str(),
            "https://example.com/f.xml",
            "only its head is read"
        );
    }

    /// A body's pictures as a reader gets them: a kept one from here, a pixel gone, any other a
    /// link - and an address that isn't the web's, a link, and code left alone.
    #[test]
    fn a_copy_says_its_source_in_a_meta_and_a_post_in_its_labels() {
        let src = CopySource {
            title: "a canter".into(),
            words: "the *second* post\n".into(),
            link: "https://example.com/canter?a=1&b=\"2\"".into(),
            feed_url: "https://example.com/rss.xml".into(),
            feed_name: "Ada \"the\" Gazette".into(),
            tags: Vec::new(),
        };
        let body = src.note_body();
        assert!(body.starts_with("the *second* post\n\n:::meta "), "{body}");
        let doc = marquee_parser::parse(&body).unwrap();
        let marquee_parser::Node::Document { children, .. } = &doc else { panic!() };
        let meta = children
            .iter()
            .find_map(|c| match c {
                marquee_parser::Node::Directive { name, attrs, .. } if name == "meta" => {
                    Some(attrs.clone())
                }
                _ => None,
            })
            .expect("a :::meta");
        assert_eq!(meta.get(SOURCE_NAME).map(String::as_str), Some("Ada \"the\" Gazette"));
        assert_eq!(meta.get(SOURCE_LINK).map(String::as_str), Some(src.link.as_str()));
        assert_eq!(meta.get(SOURCE_FEED).map(String::as_str), Some(src.feed_url.as_str()));
        let bare = CopySource {
            link: String::new(),
            feed_url: String::new(),
            feed_name: String::new(),
            ..src
        };
        assert_eq!(bare.note_body(), bare.words);

        let said = |who: &str, key: &str, value: &str| crate::annotations::KnownAnnotation {
            annotator: who.into(),
            key: key.into(),
            value: value.into(),
        };
        let labels = vec![
            said("someone", SOURCE_FEED, "https://elsewhere.example/rss"),
            said("me", SOURCE_FEED, "https://example.com/rss.xml"),
            said("me", SOURCE_NAME, "Ada <b>Gazette</b>"),
            said("me", SOURCE_LINK, "https://example.com/canter?a=1&b=2"),
        ];
        assert_eq!(
            via_html(&labels, "me").unwrap(),
            "<p>Via <a href=\"https://example.com/canter?a=1&amp;b=2\">Ada &lt;b&gt;Gazette&lt;/b&gt;</a></p>"
        );
        let hostile = vec![
            said("me", SOURCE_FEED, "https://example.com/rss.xml"),
            said("me", SOURCE_LINK, "javascript:alert(1)"),
        ];
        assert_eq!(
            via_html(&hostile, "me").unwrap(),
            "<p>Via <a href=\"https://example.com/rss.xml\">example.com</a></p>",
            "only a web address, and the feed's host when it names none"
        );
        assert!(via_html(&labels, "someone-else").is_none(), "only what its author said");
        assert!(via_html(&[said("me", SOURCE_FEED, "javascript:x")], "me").is_none());
    }

    #[test]
    fn a_readers_pictures_come_from_here_or_not_at_all() {
        let body = "Hay.\n\n![a bale](https://hay.example/bale.jpg)\n\n![](https://t.example/p.gif)\n\n\
                    ![](https://hay.example/later.png) and ![a \\] bracket](http://hay.example/b.jpg)\n\n\
                    [a link](https://hay.example/bale.jpg) ![ours](/api/rss/pictures/x.avif)";
        assert_eq!(
            embedded_pictures(body),
            [
                "https://hay.example/bale.jpg",
                "https://t.example/p.gif",
                "https://hay.example/later.png",
                "http://hay.example/b.jpg"
            ]
        );
        let key = picture_key("https://hay.example/bale.jpg");
        let row = |status: &str, key: &str, format: &str| {
            (status.to_string(), key.to_string(), format.to_string())
        };
        let pictures: HashMap<String, (String, String, String)> = [
            ("https://hay.example/bale.jpg", row("ready", &key, "avif")),
            ("https://t.example/p.gif", row("dropped", "", "")),
            ("http://hay.example/b.jpg", row("failed", "", "")),
        ]
        .into_iter()
        .map(|(url, r)| (url.to_string(), r))
        .collect();
        assert_eq!(
            served_words(body, &pictures),
            format!(
                "Hay.\n\n![a bale](/api/rss/pictures/{key}.avif)\n\n\n\n\
                 [hay.example](https://hay.example/later.png) and [a \\] bracket](http://hay.example/b.jpg)\n\n\
                 [a link](https://hay.example/bale.jpg) ![ours](/api/rss/pictures/x.avif)"
            )
        );
    }

    #[test]
    fn a_doctype_with_entities_is_not_expanded() {
        // The billion laughs: a parser that expands entities from a DTD balloons; ours never reads one.
        let bomb = r#"<?xml version="1.0"?>
<!DOCTYPE rss [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>
<rss version="2.0"><channel><title>&c;</title><item><title>x</title><guid>1</guid></item></channel></rss>"#;
        if let Ok(feed) = feed_rs::parser::parse(bomb.as_bytes()) {
            let title = feed.title.map(|t| t.content).unwrap_or_default();
            assert!(title.len() < 100, "an entity was expanded: {} bytes", title.len());
        }
    }
}
