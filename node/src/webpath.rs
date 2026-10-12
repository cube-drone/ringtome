//! Web addresses (plans/WEB_ADDRESSES.md): a post's readable path, `recipes/sourdough-loaf`, said
//! in public as a label on the post (`path = ...`, ruling 4) so it travels with the persona: any
//! node holding them answers `/ringtome/user/<them>/recipes/sourdough-loaf`, a peek included,
//! since a peek holds the whole annotations chain.
//!
//! The path is made once, at first publish, and only a person changes it after (ruling 2): from
//! the title, else the date and the first few words, else the date and the start of the post's
//! id (ruling 3, amended); under the notebook it was published from (ruling 1), and for a book's
//! page, under the book's sections too (ruling 6). Everything in it comes from the post itself,
//! never a counter, so two computers publishing at once arrive at the same path - and a clash
//! takes the id's start rather than `-2`, so two posts can't both hold one.
//!
//! Sealed posts, replies and rooms get none: a sealed post's title is for trusted readers, and a
//! path made from it would say it in public.

use anyhow::Result;

use crate::record::store;

/// The label a post's path is said under.
pub const PATH_KEY: &str = "path";

/// Words a path's first segment can't be: the routes already under a persona's address
/// (`post/<id>`, `doc/<id>`, `room/<id>`...) and the doors beside them. A title that slugs to one
/// takes the id suffix; a notebook named one makes no folder.
pub const RESERVED: &[&str] = &[
    "post", "doc", "docs", "room", "book", "page", "line", "history", "diff", "ui-demo", "from",
    "at", "profile", "posts", "labels", "thumb", "body",
];

/// Notebooks that make no folder: the apps' own, where a post written there simply lives at the
/// top (the feed's, Writer's and the sketchbook's homes, and the files' and chat's).
const NO_FOLDER: &[&str] = &["feed", "default", "drawing", "files", "chat"];

/// A title's slug, at most (cut at a hyphen).
const SLUG_MAX: usize = 80;
/// An untitled post's words: at most this many, and about this many characters.
const WORDS_MAX: usize = 5;
const WORDS_CHARS: usize = 40;
/// How much of the post's id a suffix takes.
const SUFFIX_HEX: usize = 6;

/// Words as a path segment: lowercase, letters and digits of any script kept, apostrophes
/// dropped (`don't` is `dont`), and a run of anything else one hyphen - or two, `--`, when the
/// run held a separator between phrases (a colon, a semicolon, a bar, a slash, a dash, or a
/// hyphen with space around it). "CyberGamer Canada: Ad ViewMagic" is
/// `cybergamer-canada--ad-viewmagic`.
pub fn slug(text: &str) -> String {
    let mut out = String::new();
    // The run since the last letter or digit: whether it held anything, and whether a separator.
    let mut gap = false;
    let mut strong = false;
    let mut spaced = false;
    let mut dashed = false;
    for c in text.chars() {
        if c.is_alphanumeric() {
            if gap && !out.is_empty() {
                out.push_str(if strong || (dashed && spaced) { "--" } else { "-" });
            }
            gap = false;
            strong = false;
            spaced = false;
            dashed = false;
            out.extend(c.to_lowercase());
        } else if c == '\'' || c == '\u{2019}' {
            // An apostrophe joins the word it's inside.
        } else {
            gap = true;
            strong |= matches!(c, ':' | ';' | '|' | '/' | '\u{2014}' | '\u{2013}' | '\u{00b7}');
            spaced |= c.is_whitespace();
            dashed |= c == '-';
        }
    }
    cut(&out, SLUG_MAX)
}

/// At most `max` characters of a slug, cut back to the last hyphen when it's cut at all.
fn cut(slug: &str, max: usize) -> String {
    if slug.chars().count() <= max {
        return slug.to_string();
    }
    let head: String = slug.chars().take(max).collect();
    match head.rfind('-') {
        Some(at) if at > 0 => head[..at].trim_end_matches('-').to_string(),
        _ => head,
    }
}

/// The post's own part of its path: its title's slug; untitled, the date and its first few words;
/// with no words either, the date and the start of its id. A reserved word takes the id suffix.
pub fn leaf(title: &str, words: &str, date_ms: i64, doc_id: &[u8; 16]) -> String {
    let titled = slug(title);
    let leaf = if !titled.is_empty() {
        titled
    } else {
        let date = date_of(date_ms);
        let said: Vec<&str> = words
            .split_whitespace()
            .filter(|w| !w.contains("://") && !w.starts_with("www.") && !w.starts_with('('))
            .take(WORDS_MAX)
            .collect();
        let said = cut(&slug(&said.join(" ")), WORDS_CHARS);
        if said.is_empty() {
            format!("{date}-{}", suffix(doc_id))
        } else {
            format!("{date}-{said}")
        }
    };
    if RESERVED.contains(&leaf.as_str()) {
        with_suffix(&leaf, doc_id)
    } else {
        leaf
    }
}

/// The start of a post's id, as a path's tiebreak.
fn suffix(doc_id: &[u8; 16]) -> String {
    hex::encode(doc_id)[..SUFFIX_HEX].to_string()
}

/// `path` made unique by the post's own id.
pub fn with_suffix(path: &str, doc_id: &[u8; 16]) -> String {
    format!("{path}-{}", suffix(doc_id))
}

/// `YYYY-MM-DD`, UTC.
fn date_of(ms: i64) -> String {
    let at = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
    format!("{:04}-{:02}-{:02}", at.year(), u8::from(at.month()), at.day())
}

/// A notebook's folder, if it makes one: its name's slug, unless it's an app's own notebook, or
/// slugs to nothing or to a reserved word.
pub fn folder(notebook: &str) -> Option<String> {
    if NO_FOLDER.contains(&notebook) {
        return None;
    }
    let folder = slug(notebook);
    (!folder.is_empty() && !RESERVED.contains(&folder.as_str())).then_some(folder)
}

/// Which of a draft's notebooks gives its folder: the first, by name, that makes one.
pub fn folder_of(notebooks: &[String]) -> Option<String> {
    let mut names: Vec<&String> = notebooks.iter().collect();
    names.sort();
    names.into_iter().find_map(|n| folder(n))
}

/// The titles of the sections a page sits in, top first, in its notebook's tree (the book's own
/// shape, ruling 6) - empty for a page at the top, or a notebook with no tree.
pub async fn sections_of(
    data: &store::Store,
    notebook: &str,
    doc_id: &[u8; 16],
) -> Result<Vec<String>> {
    let title = format!("wiki:{notebook}");
    let roster = data.taxonomies().all().await?;
    let Some(root) = roster.iter().filter(|t| t.title == title).map(|t| t.taxonomy_id).min() else {
        return Ok(Vec::new());
    };
    let tree = data.taxonomies().tree(&root).await?;
    fn find(node: &store::TaxonomyNode, doc: &[u8; 16], trail: &mut Vec<String>) -> bool {
        for m in node.members.as_deref().unwrap_or(&[]) {
            match &m.taxonomy {
                Some(sub) => {
                    trail.push(sub.title.clone());
                    if find(sub, doc, trail) {
                        return true;
                    }
                    trail.pop();
                }
                None if m.doc_id == *doc => return true,
                None => {}
            }
        }
        false
    }
    let mut trail = Vec::new();
    Ok(if find(&tree, doc_id, &mut trail) { trail } else { Vec::new() })
}

/// The path to give a post, from its parts: `folders` joined, then the leaf - made unique against
/// the author's other posts by `taken` (whether another post already holds a path).
pub async fn unique<F, Fut>(
    folders: &[String],
    leaf: &str,
    doc_id: &[u8; 16],
    taken: F,
) -> Result<String>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<bool>>,
{
    let mut parts: Vec<String> =
        folders.iter().map(|f| slug(f)).filter(|f| !f.is_empty()).collect();
    parts.push(leaf.to_string());
    let path = parts.join("/");
    if taken(path.clone()).await? {
        Ok(with_suffix(&path, doc_id))
    } else {
        Ok(path)
    }
}

/// Is `path` well-formed as a reader asked for it: lowercase segments of letters, digits and
/// hyphens, none empty, and the first not a reserved word?
pub fn well_formed(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').collect();
    !path.is_empty()
        && path.len() <= 512
        && !RESERVED.contains(&segments[0])
        && segments.iter().all(|s| {
            !s.is_empty()
                && s.chars().all(|c| (c.is_alphanumeric() && !c.is_uppercase()) || c == '-')
        })
}

/// How long another node's answer about one of its addresses is kept.
const WEB_ADDRESS_TTL: std::time::Duration = std::time::Duration::from_secs(60 * 60);
/// The most of another node's answer read.
const WEB_ADDRESS_MAX_BYTES: usize = 16 * 1024;

/// What an address under a node's short name names (plans/WEB_ADDRESSES.md, slice 3, "the way
/// back"): `https://horsedrawingtycoon.com/@cube-drone/recipes/leek-soup` as the persona, the post
/// (or the notebook folder), and the key of the node that answered, for reaching them - so a link
/// copied off one node's website opens in a reader's own app, where they can comment. This node's
/// own addresses are answered here; another node's are asked of its `/api/node/at/...`, through
/// the unfurler's guarded fetch (public addresses only, pinned, no redirects inward), and kept an
/// hour. None for anything that isn't such an address, or that names nothing.
pub async fn web_address(state: &crate::AppState, raw: &str) -> Option<serde_json::Value> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let rest = url.path().strip_prefix("/@")?;
    let (slug, after) = rest.split_once('/').unwrap_or((rest, ""));
    let slug = crate::slugs::normalise(slug)?;
    let after = percent_decoded(after.trim_matches('/'))?;
    if !after.is_empty() && !well_formed(&after) {
        return None;
    }
    let own = state
        .config
        .public_url
        .as_deref()
        .and_then(|u| url::Url::parse(u).ok())
        .is_some_and(|mine| mine.origin() == url.origin());
    if own {
        return crate::nodeface::at_name_answer(state, &slug, &after).await.ok();
    }
    static ASKED: std::sync::OnceLock<moka::future::Cache<String, serde_json::Value>> =
        std::sync::OnceLock::new();
    let asked = ASKED.get_or_init(|| {
        moka::future::Cache::builder().max_capacity(4096).time_to_live(WEB_ADDRESS_TTL).build()
    });
    let origin = url.origin().ascii_serialization();
    let lookup = if after.is_empty() {
        format!("{origin}/api/node/at/{slug}")
    } else {
        format!(
            "{origin}/api/node/at/{slug}/{}",
            url.path().trim_start_matches('/').split_once('/').map(|x| x.1).unwrap_or("")
        )
    };
    if let Some(hit) = asked.get(&lookup).await {
        return Some(hit);
    }
    let bytes = crate::net::unfurl::fetch_media_bytes(
        &lookup,
        WEB_ADDRESS_MAX_BYTES,
        state.config.local_test,
    )
    .await
    .ok()?;
    let said: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    // Only what an answer may say, each checked for shape: it's another node's word.
    let hex_of = |key: &str, len: usize| {
        said.get(key)
            .and_then(|v| v.as_str())
            .filter(|v| v.len() == len && v.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|v| v.to_ascii_lowercase())
    };
    let root = hex_of("root", 64)?;
    let endpoint = said.get("endpoint").and_then(|v| v.as_str()).filter(|e| e.len() <= 128)?;
    let mut answer = serde_json::json!({ "root": root, "endpoint": endpoint });
    if let Some(post) = hex_of("post", 32) {
        answer["post"] = serde_json::json!(post);
        if let Some(path) = said.get("path").and_then(|v| v.as_str()).filter(|p| well_formed(p)) {
            answer["path"] = serde_json::json!(path);
        }
    } else if let (Some(folder), Some(bucket)) = (
        said.get("folder").and_then(|v| v.as_str()).filter(|f| well_formed(f)),
        said.get("bucket").and_then(|v| v.as_str()).filter(|b| b.len() <= 256),
    ) {
        answer["folder"] = serde_json::json!(folder);
        answer["bucket"] = serde_json::json!(bucket);
    } else if !after.is_empty() {
        return None; // a path that names nothing there
    }
    asked.insert(lookup, answer.clone()).await;
    Some(answer)
}

/// `%XX` escapes undone, as UTF-8 - or None for an escape that isn't one.
fn percent_decoded(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_reads_as_its_path() {
        assert_eq!(slug("CyberGamer Canada: Ad ViewMagic"), "cybergamer-canada--ad-viewmagic");
        assert_eq!(slug("Sourdough Loaf"), "sourdough-loaf");
        assert_eq!(slug("  Don't Panic!  "), "dont-panic");
        assert_eq!(slug("well-known horses"), "well-known-horses", "a hyphen inside a word is one");
        assert_eq!(slug("Horses - a history"), "horses--a-history", "a spaced dash is a separator");
        assert_eq!(slug("Ünïcode Straße 東京"), "ünïcode-straße-東京", "any script's letters");
        assert_eq!(slug("!!!"), "");
        let long = "word ".repeat(40);
        let cut = slug(&long);
        assert!(cut.chars().count() <= SLUG_MAX && !cut.ends_with('-'), "{cut}");
    }

    #[test]
    fn an_untitled_post_is_its_date_and_first_words_or_its_id() {
        let id = [0xa0, 0x4a, 0xa2, 0x29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let day = 1_791_676_800_000 + 3_600_000; // 2026-10-11, 1am UTC
        assert_eq!(
            leaf("", "today I drew a horse, and then another", day, &id),
            "2026-10-11-today-i-drew-a-horse"
        );
        assert_eq!(
            leaf("", "https://example.com look (picture) here", day, &id),
            "2026-10-11-look-here",
            "a link and an embed's word aren't words"
        );
        assert_eq!(leaf("", "", day, &id), "2026-10-11-a04aa2", "no words: the id");
        assert_eq!(leaf("Post", "", day, &id), "post-a04aa2", "a reserved word takes the id");
        assert_eq!(leaf("A Title", "words", day, &id), "a-title", "a title wins");
    }

    #[test]
    fn a_notebook_is_a_folder_unless_an_app_owns_it() {
        assert_eq!(folder("Recipes").as_deref(), Some("recipes"));
        assert_eq!(folder("feed"), None);
        assert_eq!(folder("default"), None);
        assert_eq!(folder("post"), None, "a reserved word makes no folder");
        assert_eq!(
            folder_of(&["feed".into(), "Recipes".into()]).as_deref(),
            Some("recipes"),
            "the first that makes one"
        );
    }

    #[tokio::test]
    async fn a_clash_takes_the_post_s_own_id() {
        let id = [0xa0, 0x4a, 0xa2, 0x29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let free = unique(&["Recipes".into(), "Soups & Stews".into()], "leek", &id, |_| async {
            Ok(false)
        })
        .await
        .unwrap();
        assert_eq!(free, "recipes/soups-stews/leek");
        let taken = unique(&[], "leek", &id, |p| async move { Ok(p == "leek") }).await.unwrap();
        assert_eq!(taken, "leek-a04aa2");
    }

    #[test]
    fn an_escaped_path_reads_as_its_letters() {
        assert_eq!(percent_decoded("r%C3%A9sum%C3%A9").as_deref(), Some("résumé"));
        assert_eq!(percent_decoded("plain/path").as_deref(), Some("plain/path"));
        assert_eq!(percent_decoded("bad%zz"), None);
        assert_eq!(percent_decoded("cut%4"), None);
    }

    #[test]
    fn a_path_asked_for_is_lowercase_segments_and_never_a_route() {
        assert!(well_formed("recipes/sourdough-loaf"));
        assert!(well_formed("2026-10-11-a04aa2"));
        assert!(!well_formed("post/a04aa2"), "a route's word");
        assert!(!well_formed("Recipes/x"), "uppercase");
        assert!(!well_formed("recipes//x"));
        assert!(!well_formed(""));
    }
}
