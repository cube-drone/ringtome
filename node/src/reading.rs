//! Reading copies (plans/CRAWLING.md, slice 2): a public page's content as plain HTML in its body,
//! for a search engine that doesn't run the app and a reader without JavaScript. The app replaces it
//! on mounting, and a browser that runs scripts never shows it (ruling 1, the template's `html.js`).
//!
//! Nothing here says anything the page doesn't already show a stranger: a post's words as its
//! public body holds them, a person's open posts as their shelf lists them - read from the same
//! public lane and memos the anonymous doors read. Every link is a page's canonical address
//! (webpath.rs), so a crawler following them lands where the head says the page lives.

use marquee_html_renderer::{EmojiResolution, Output, Profile};

use crate::record::documents::{Format, PublicDoc};
use crate::AppState;

/// How many posts a person's reading copy lists before "older posts".
pub const PERSON_PAGE: i64 = 30;

/// The web's own profile, with emoji as themselves; links, media and the rest the bare web's.
struct ReadingProfile;

impl Profile for ReadingProfile {
    fn emoji(&self, slug: &str) -> Option<EmojiResolution> {
        marquee_markup::standard_emoji(slug).map(|e| EmojiResolution::Text(e.to_string()))
    }
}

/// Text for HTML.
pub fn esc(s: &str) -> String {
    marquee_html_renderer::escape_text(s)
}

fn attr(s: &str) -> String {
    marquee_html_renderer::escape_attr(s)
}

/// A post's words as HTML: Marquee rendered, plain text kept as paragraphs.
pub fn words_html(source: &str, format: Format) -> String {
    // Kept by what was rendered (plans/CACHE.md, Stage 7): a post page renders its words for every
    // reader without the app and every crawler, and the same words render the same way.
    type Kept = std::collections::HashMap<([u8; 32], bool), std::sync::Arc<str>>;
    static KEPT: std::sync::LazyLock<std::sync::Mutex<Kept>> =
        std::sync::LazyLock::new(Default::default);
    let key = (*blake3::hash(source.as_bytes()).as_bytes(), format == Format::Marquee);
    if let Some(html) = KEPT.lock().expect("rendered words poisoned").get(&key) {
        return html.to_string();
    }
    let html = render_words(source, format);
    let mut kept = KEPT.lock().expect("rendered words poisoned");
    if kept.len() >= 20_000 {
        kept.clear();
    }
    kept.insert(key, std::sync::Arc::from(html.as_str()));
    html
}

fn render_words(source: &str, format: Format) -> String {
    if format == Format::Marquee {
        if let Ok(html) =
            marquee_html_renderer::render_marquee_with(source, &ReadingProfile, Output::Html)
        {
            return html;
        }
    }
    source
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| format!("<p>{}</p>", esc(p).replace('\n', "<br>")))
        .collect()
}

/// A post's public words, as its public body holds them ("" for none).
pub async fn public_text(state: &AppState, db: &crate::db::Db, doc_id: &[u8; 16]) -> String {
    let Ok(Some(head)) = crate::record::documents::public_head(db, doc_id).await else {
        return String::new();
    };
    match crate::idface::public_blob(state, head.file_hash).await {
        Ok(Some(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    }
}

/// A day, as a reading copy shows it: `11 October 2026`.
fn day(ms: i64) -> String {
    match time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000) {
        Ok(t) => format!("{} {} {}", t.day(), t.month(), t.year()),
        Err(_) => String::new(),
    }
}

/// `<time>`, machine-readable and readable.
fn when(ms: i64) -> String {
    format!("<time datetime=\"{}\">{}</time>", crate::crawl::iso(ms), esc(&day(ms)))
}

/// A post's reading copy: its title, its author and date, its words, its tags, and - for a book -
/// its contents, or for a book's page, the book it's in.
pub async fn post_copy(
    state: &AppState,
    db: &crate::db::Db,
    root: &[u8; 32],
    post: &PublicDoc,
    title: &str,
    author: &str,
) -> String {
    let root_hex = hex::encode(root);
    let person = crate::webpath::person_url(state, root, "").await;
    let source = public_text(state, db, &post.doc_id).await;
    let format = Format::from_wire(post.format);
    let mut out = String::from("<article>");
    out.push_str(&format!("<h1>{}</h1>", esc(title)));
    out.push_str(&format!(
        "<p><a href=\"{}\" rel=\"author\">{}</a> · {}</p>",
        attr(&person),
        esc(author),
        when(post.display_ms())
    ));
    if let Some(book) = post.part_of {
        let book_hex = hex::encode(book);
        let book_title = crate::record::documents::public_doc(db, &book)
            .await
            .ok()
            .flatten()
            .map(|b| b.title)
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "a book".to_string());
        out.push_str(&format!(
            "<p>From <a href=\"{}\">{}</a></p>",
            attr(&crate::webpath::post_url(state, root, &book_hex, "").await),
            esc(&book_title)
        ));
    }
    if format == Format::Book {
        out.push_str(&book_contents(state, root, &post.doc_id, &source).await);
    } else if format.is_mergeable_text() {
        out.push_str(&words_html(&source, format));
    }
    let doc_hex = hex::encode(post.doc_id);
    let labels = crate::annotations::for_posts(state, &[(root_hex.clone(), doc_hex.clone())], None)
        .await
        .unwrap_or_default();
    let tags: Vec<String> = labels
        .get(&(root_hex.clone(), doc_hex))
        .into_iter()
        .flatten()
        // The author's own words for it - not its size or medium, which the node says for it.
        .filter(|a| {
            a.annotator == root_hex && a.key == "tag" && crate::search::tag_family(&a.value) == 0
        })
        .map(|a| a.value.clone())
        .collect();
    if !tags.is_empty() {
        out.push_str(&format!(
            "<p>Tagged {}</p>",
            tags.iter().map(|t| esc(t)).collect::<Vec<_>>().join(", ")
        ));
    }
    out.push_str("</article>");
    out.push_str(&format!(
        "<footer><a href=\"{}\">More from {}</a></footer>",
        attr(&person),
        esc(author)
    ));
    out
}

/// A book's table of contents, every page a link, from the book's own payload.
async fn book_contents(
    state: &AppState,
    root: &[u8; 32],
    book: &[u8; 16],
    payload: &str,
) -> String {
    let Ok(book_json) = serde_json::from_str::<serde_json::Value>(payload) else {
        return String::new();
    };
    let person = crate::webpath::person_url(state, root, "").await;
    let book_hex = hex::encode(book);
    // A page with no path is the book's page by id, under the person's address too (2026-10-18).
    fn list(node: &serde_json::Value, person: &str, book_hex: &str, out: &mut String) {
        let pages = node.get("pages").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let sections = node.get("sections").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        if pages.is_empty() && sections.is_empty() {
            return;
        }
        out.push_str("<ul>");
        for page in pages {
            let Some(post) = page.get("post").and_then(|v| v.as_str()) else { continue };
            let title = page.get("title").and_then(|v| v.as_str()).filter(|t| !t.trim().is_empty());
            let href = match page
                .get("path")
                .and_then(|v| v.as_str())
                .filter(|p| crate::webpath::well_formed(p))
            {
                Some(path) => format!("{person}/{path}"),
                None => format!("{person}/post/{book_hex}/page/{post}"),
            };
            out.push_str(&format!(
                "<li><a href=\"{}\">{}</a></li>",
                attr(&href),
                esc(title.unwrap_or("untitled page"))
            ));
        }
        for section in sections {
            let title = section.get("title").and_then(|v| v.as_str()).unwrap_or("");
            out.push_str(&format!("<li>{}", esc(title)));
            list(&section, person, book_hex, out);
            out.push_str("</li>");
        }
        out.push_str("</ul>");
    }
    let mut out = String::from("<nav><h2>Contents</h2>");
    list(&book_json, &person, &book_hex, &mut out);
    out.push_str("</nav>");
    out
}

/// Which of a person's posts a reading copy lists: the ones with a page of their own that a
/// stranger may read - not a reply, a room, a sealed post or a book's page (its book lists it).
fn listed(post: &PublicDoc) -> bool {
    !post.trusted_only
        && post.reply_to.is_none()
        && post.part_of.is_none()
        && post.format != Some(ringtome_proto::registry::doc_format::ROOM)
}

/// A cursor for "older posts": `<ms>.<doc hex>`.
pub fn cursor_of(post: &PublicDoc) -> String {
    format!("{}.{}", post.display_ms(), hex::encode(post.doc_id))
}

/// A cursor read back, or None.
pub fn parse_cursor(raw: &str) -> Option<(i64, [u8; 16])> {
    let (ms, doc) = raw.split_once('.')?;
    let ms = ms.parse().ok()?;
    let doc = <[u8; 16]>::try_from(hex::decode(doc).ok()?.as_slice()).ok()?;
    Some((ms, doc))
}

/// A person's reading copy: their name and bio, then their posts newest first, a page at a time
/// from `before`, each a link with its title and date - and a link to the page after. `folder`
/// narrows it to one notebook's folder (ruling 7 of plans/WEB_ADDRESSES.md).
pub async fn person_copy(
    state: &AppState,
    db: &crate::db::Db,
    root: &[u8; 32],
    name: &str,
    bio: &str,
    before: Option<(i64, [u8; 16])>,
    folder: Option<(&str, &str)>,
) -> String {
    let root_hex = hex::encode(root);
    let person = crate::webpath::person_url(state, root, "").await;
    let mut out = format!("<h1>{}</h1>", esc(name));
    if let Some((_, notebook)) = folder {
        out.push_str(&format!("<p>{}</p>", esc(notebook)));
    } else if !bio.is_empty() {
        out.push_str(&format!("<p>{}</p>", esc(bio)));
    }
    let under = folder.map(|(f, _)| format!("{f}/"));
    let mut shown: Vec<PublicDoc> = Vec::new();
    let mut after = before;
    let mut more = false;
    'pages: loop {
        let page = crate::record::documents::public_docs(db, after, 200).await.unwrap_or_default();
        let full = page.len() == 200;
        after = page.last().map(|p| (p.display_ms(), p.doc_id));
        for post in page {
            if !listed(&post) {
                continue;
            }
            if let Some(under) = &under {
                let path = crate::annotations::path_of(
                    &state.node_db,
                    &root_hex,
                    &hex::encode(post.doc_id),
                )
                .await
                .ok()
                .flatten()
                .unwrap_or_default();
                if !path.starts_with(under.as_str()) {
                    continue;
                }
            }
            if shown.len() as i64 == PERSON_PAGE {
                more = true;
                break 'pages;
            }
            shown.push(post);
        }
        if !full {
            break;
        }
    }
    if shown.is_empty() {
        out.push_str("<p>Nothing posted here yet.</p>");
        return out;
    }
    out.push_str("<ul>");
    for post in &shown {
        let doc_hex = hex::encode(post.doc_id);
        let href = crate::webpath::post_url(state, root, &doc_hex, "").await;
        let said = crate::idface::post_words(state, db, &root_hex, post, name).await.ok();
        let title = said.map(|s| s.title).unwrap_or_else(|| post.title.clone());
        out.push_str(&format!(
            "<li><a href=\"{}\">{}</a> · {}</li>",
            attr(&href),
            esc(&title),
            when(post.display_ms())
        ));
    }
    out.push_str("</ul>");
    if more {
        let here = match folder {
            Some((f, _)) => format!("{person}/{f}"),
            None => person.clone(),
        };
        let last = shown.last().map(cursor_of).unwrap_or_default();
        out.push_str(&format!(
            "<nav><a rel=\"next\" href=\"{}?before={}\">Older posts</a></nav>",
            attr(&here),
            attr(&last)
        ));
    }
    out
}

/// The node's front page as a reading copy: its newest open posts, every listed person's, a page at
/// a time from `before` (`<ms>.<doc hex>`, the shelf's own order), each a link with its author.
pub async fn front_copy(state: &AppState, before: Option<(i64, String)>) -> String {
    let rows =
        crate::nodeshelf::page(&state.node_db, before, PERSON_PAGE * 2).await.unwrap_or_default();
    let mut out = String::from("<h1>Lately on this node</h1><ul>");
    let mut shown = 0;
    let mut last = None;
    let mut more = false;
    for row in rows {
        if row.via_root.is_some() || row.reply_to.is_some() || row.format.as_deref() == Some("room")
        {
            continue;
        }
        if shown == PERSON_PAGE {
            more = true;
            break;
        }
        let Some(root) = crate::pubkey::decode(&row.author_root) else { continue };
        let fields =
            crate::idface::public_profile(state, &row.author_root).await.unwrap_or_default();
        let speak = crate::speakable::speakable(&root);
        let name = crate::idface::profile_value(&fields, "name").unwrap_or(&speak).to_string();
        let title = if row.title.trim().is_empty() {
            format!("A post by {name}")
        } else {
            row.title.clone()
        };
        let href = crate::webpath::post_url(state, &root, &row.doc_id, "").await;
        let person = crate::webpath::person_url(state, &root, "").await;
        out.push_str(&format!(
            "<li><a href=\"{}\">{}</a> · <a href=\"{}\">{}</a> · {}</li>",
            attr(&href),
            esc(&title),
            attr(&person),
            esc(&name),
            when(row.dated_ms.unwrap_or(row.published_ms))
        ));
        last = Some(format!("{}.{}", row.published_ms, row.doc_id));
        shown += 1;
    }
    out.push_str("</ul>");
    if shown == 0 {
        return "<h1>Lately on this node</h1><p>Nothing posted here yet.</p>".to_string();
    }
    out.push_str("<nav>");
    if let (true, Some(last)) = (more, last) {
        out.push_str(&format!(
            "<a rel=\"next\" href=\"/feed?before={}\">Older posts</a> · ",
            attr(&last)
        ));
    }
    out.push_str("<a href=\"/people\">People here</a></nav>");
    out
}

/// The node's people page as a reading copy: every listed person, a link to their page.
pub async fn people_copy(state: &AppState) -> String {
    let mut out = String::from("<h1>People on this node</h1><ul>");
    for root_hex in crate::nodeshelf::listed_roots(&state.node_db).await.unwrap_or_default() {
        let Some(root) = crate::pubkey::decode(&root_hex) else { continue };
        let fields = crate::idface::public_profile(state, &root_hex).await.unwrap_or_default();
        let speak = crate::speakable::speakable(&root);
        let name = crate::idface::profile_value(&fields, "name").unwrap_or(&speak).to_string();
        let bio = crate::idface::profile_value(&fields, "bio").unwrap_or("");
        let href = crate::webpath::person_url(state, &root, "").await;
        out.push_str(&format!("<li><a href=\"{}\">{}</a>", attr(&href), esc(&name)));
        if !bio.is_empty() {
            out.push_str(&format!(" - {}", esc(bio)));
        }
        out.push_str("</li>");
    }
    out.push_str("</ul><nav><a href=\"/feed\">Lately on this node</a></nav>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_render_as_the_web_reads_them() {
        let html =
            words_html("A **horse** :smile:\n\n[a link](https://example.com)", Format::Marquee);
        assert!(html.contains("<strong>horse</strong>"), "{html}");
        assert!(html.contains("😄"), "an emoji as itself: {html}");
        assert!(html.contains("href=\"https://example.com\""), "{html}");
        let plain = words_html("one <b>\nline\n\ntwo", Format::Plaintext);
        assert_eq!(plain, "<p>one &lt;b&gt;<br>line</p><p>two</p>");
    }

    #[test]
    fn a_cursor_reads_back() {
        let doc = [7u8; 16];
        let raw = format!("1791676800000.{}", hex::encode(doc));
        assert_eq!(parse_cursor(&raw), Some((1_791_676_800_000, doc)));
        assert_eq!(parse_cursor("nope"), None);
    }
}
