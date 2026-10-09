//! The `/id/<root>` surface (PROJECT_PLAN, Addressing: "The prefix gets its name") - one URL,
//! two audiences, and the split that keeps both simple: **a session gets the SPA, anonymity
//! gets a server-rendered face.** The browser app stays session-only (its whole substrate -
//! mirror, stream, lens - assumes one); the anonymous face is deliberately tiny, static HTML
//! with hardened headers, because the stranger-facing surface should have as little machinery
//! behind it as possible.
//!
//! The anonymous rungs shipped here (Moderation, The Web Gateway):
//!   - **shelf**: a root this node hosts -> its public profile (name, bio - the public lane).
//!   - **tombstone, warmly**: a root not carried -> an honest dead end with directions.
//!   - **checksum refusal**: worded address whose words lie -> refused loudly, with the true
//!     words in hand ("did you mean").
//!
//! The **signpost** rung waits on serving records carrying public web URLs; the fetch-and-serve
//! behavior for members waits on the resolution ladder. Both are NEXT_STEPS' next bricks, not
//! forgotten scope.

use axum::extract::RawQuery;
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::imaol;
use crate::speakable::{self, Parsed};
use crate::AppState;

/// Escape untrusted text into HTML body/attribute position. The profile is user-authored;
/// the face renders nothing unescaped.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The anonymous face's response envelope: plain HTML under the hardened serving headers
/// (the gateway posture, applied from the first byte this surface ever serves - validated
/// type, nosniff, a CSP that permits our own inline style and nothing else).
fn face(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
            ),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
        .into_response()
}

/// The shared page skeleton: system fonts, one card, no scripts, no fetches.
fn page(title: &str, card: String) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #f6f2ea; color: #2d2a26;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; }}
  .card {{ max-width: 34rem; margin: 2rem; padding: 2rem 2.2rem; background: #fffdf8;
          border: 1px solid #e0d8c8; border-radius: 14px; }}
  .chip {{ display: inline-block; width: 0.9em; height: 0.9em; border-radius: 50%;
          margin-right: 0.45rem; vertical-align: baseline; }}
  .avatar {{ width: 4.5rem; height: 4.5rem; border-radius: 12px; object-fit: cover;
            display: block; margin-bottom: 0.8rem; border: 1px solid #e0d8c8;
            overflow: hidden; }}
  .avatar svg {{ width: 100%; height: 100%; display: block; }}
  h1 {{ font-size: 1.35rem; margin: 0 0 0.2rem; }}
  .words {{ color: #8a7f6e; font-size: 0.9rem; margin: 0 0 1rem; }}
  .bio {{ white-space: pre-wrap; }}
  .addr {{ font-family: ui-monospace, monospace; font-size: 0.78rem; word-break: break-all;
          background: #f2ecdf; border-radius: 8px; padding: 0.6rem 0.8rem; }}
  .foot {{ color: #8a7f6e; font-size: 0.8rem; margin-top: 1.4rem; }}
  a {{ color: #2a7f78; }}
</style>
</head>
<body><div class="card">{card}</div></body>
</html>
"#,
        title = esc(title),
    )
}

/// Is this root hosted by any account on this node? (The shelf, v1: hosting is the only
/// demand edge that exists - member follows join it when follows do.) The identities table
/// belongs to identity.rs; this is its question, asked through its door.
pub(crate) async fn hosted_here(state: &AppState, root_hex: &str) -> Result<bool, AppError> {
    crate::identity::is_hosted(&state.node_db, root_hex).await
}

/// The public profile straight off the identity's own db - the public lane, no account in
/// the question. Absent fields render as absent; a profile-less persona is still a page.
pub(crate) async fn public_profile(
    state: &AppState,
    root_hex: &str,
) -> Result<Vec<imaol::ProfileField>, AppError> {
    let Some(db) = state.user_dbs.get(root_hex).await.map_err(AppError::Internal)? else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.nothing-of-theirs-is-held",
            "nothing of theirs is held here"
        )));
    };
    imaol::get_profile(&db).await
}

pub(crate) fn profile_value<'a>(fields: &'a [imaol::ProfileField], name: &str) -> Option<&'a str> {
    fields.iter().find(|f| f.field == name).map(|f| f.value.as_str())
}

/// The person's colourway, named in their page's head (Curtis, 2026-10-02: the light default
/// flashed before the app put a colourway on). index.html's first script wears it before anything
/// draws, as the app's `usePageColorway` will once their profile arrives; nothing when they chose
/// none. Which names are colourways is the page's business - it ignores one it does not know.
fn colorway_meta(fields: &[imaol::ProfileField]) -> String {
    profile_value(fields, "colorway")
        .filter(|c| !c.trim().is_empty())
        .map(|c| format!("\n<meta name=\"page-colorway\" content=\"{}\">", esc(c)))
        .unwrap_or_default()
}

/// GET `/id/{seg}/{*rest}` - any deeper path under a persona. Its own handler because axum
/// extracts path params POSITIONALLY: a two-parameter route destructured as one `Path<String>`
/// is a 500, not a fallback (found 2026-08-03 by the first deep /id link the app ever
/// followed - the widget gallery). The deeper path is the SPA's business: routes under a
/// persona (their pages, the gallery) resolve in the client, so this hands back the same
/// answer the bare address does.
pub async fn idface_deep(
    session: Option<Session>,
    state: State<AppState>,
    Path((seg, rest)): Path<(String, String)>,
) -> Result<Response, AppError> {
    // A post's address wears the POST's head (slice 4 of the `/ringtome/` links, 2026-09-28) - what
    // an unfurler outside Ringtome shows for a pasted link - and so does a published note's; any
    // other deeper path, or a post this node cannot vouch for, wears the person's.
    if let Some(Parsed::Ok(root)) = speakable::parse(&seg) {
        if let Some(doc) = post_named(&state, &root, &rest).await {
            if let Some(page) = post_page(&state, root, doc).await? {
                return Ok(page);
            }
        }
    }
    idface(session, state, Path(seg)).await
}

/// The public post a deeper path names: `post/<doc>`, a book's `post/<book>/page/<doc>` (the page's
/// own post), or `doc/<note>` once the note is published (its author's `published_from` label).
async fn post_named(state: &AppState, root: &[u8; 32], rest: &str) -> Option<[u8; 16]> {
    let parts: Vec<&str> = rest.trim_matches('/').split('/').collect();
    let hex_id = match parts.as_slice() {
        ["post", doc] | ["post", _, "page", doc] => doc.to_string(),
        ["doc", note] => crate::annotations::published_from(
            &state.node_db,
            &hex::encode(root),
            &note.to_ascii_lowercase(),
        )
        .await
        .ok()
        .flatten()?,
        _ => return None,
    };
    hex::decode(hex_id).ok().and_then(|b| <[u8; 16]>::try_from(b).ok())
}

/// How much of a post's words its head quotes.
const HEAD_EXCERPT_CHARS: usize = 200;

/// A post's page: the app, under the POST's head - its title, what it says (the author's own
/// description, else the start of its words), its picture (else the author's), `og:type` article,
/// and its own short-form address. Only for a persona this node hosts, whose shelf is its to vouch
/// for; `None` - the person's head instead - for anyone else, for a post that is not on the public
/// shelf, and for a SEALED post, whose title and words are for trusted readers and never for an
/// unfurler.
async fn post_page(
    state: &AppState,
    root: [u8; 32],
    doc_id: [u8; 16],
) -> Result<Option<Response>, AppError> {
    let root_hex = hex::encode(root);
    if !hosted_here(state, &root_hex).await? {
        return Ok(None);
    }
    let Some(db) = state.user_dbs.get(&root_hex).await.map_err(AppError::Internal)? else {
        return Ok(None);
    };
    let Some(post) = crate::record::documents::public_doc(&db, &doc_id).await? else {
        return Ok(None);
    };
    if post.trusted_only {
        return Ok(None);
    }
    let doc_hex = hex::encode(doc_id);
    let speak = speakable::speakable(&root);
    let short = speak.rsplit('-').next().unwrap_or(&speak).to_string();
    let words_of_name = speak.rsplit_once('-').map(|x| x.0).unwrap_or("").to_string();
    let fields = public_profile(state, &root_hex).await.unwrap_or_default();
    let author = profile_value(&fields, "name").unwrap_or(&words_of_name).to_string();
    let said = post_words(state, &db, &root_hex, &post, &author).await?;
    let first_picture = said.picture;
    let excerpt = said.described.unwrap_or_else(|| clip(&said.words, HEAD_EXCERPT_CHARS));
    let title = said.title;

    let base = state.config.public_url.clone().unwrap_or_default();
    let url = format!("{base}/ringtome/user/{short}/post/{doc_hex}");
    let mut head = format!(
        "<title>{} - {}</title>\n<meta property=\"og:title\" content=\"{}\">\n<meta property=\"og:type\" content=\"article\">\n<meta property=\"og:url\" content=\"{}\">\n<meta property=\"og:site_name\" content=\"{}\">",
        esc(&title),
        esc(&author),
        esc(&title),
        esc(&url),
        esc(&author),
    );
    if !excerpt.is_empty() {
        head.push_str(&format!(
            "\n<meta property=\"og:description\" content=\"{}\">\n<meta name=\"description\" content=\"{}\">",
            esc(&excerpt),
            esc(&excerpt)
        ));
    }
    let picture = match first_picture {
        Some(path) => Some(format!("{base}{path}")),
        None => profile_value(&fields, "avatar")
            .map(|avatar| format!("{base}/id/{short}/docs/{avatar}/thumb")),
    };
    if let Some(picture) = picture {
        head.push_str(&format!("\n<meta property=\"og:image\" content=\"{}\">", esc(&picture)));
    }
    head.push_str(&colorway_meta(&fields));
    Ok(Some(
        (
            StatusCode::OK,
            [(header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
            axum::response::Html(crate::ui::app_page(state, &head)),
        )
            .into_response(),
    ))
}

/// What a public post says, for the surfaces that describe it from outside - its page's head, its
/// author's RSS (rss.rs).
pub(crate) struct PostWords {
    /// Its title, else its first nine words, else its author's name.
    pub title: String,
    /// The author's own description label, when they wrote one.
    pub described: Option<String>,
    /// Its words, plain, on one line - empty for anything but a note.
    pub words: String,
    /// The first picture its words embed, as a path (Curtis, 2026-09-28: a text post has no
    /// thumbnail of its own - only a picture does).
    pub picture: Option<String>,
}

pub(crate) async fn post_words(
    state: &AppState,
    db: &crate::db::Db,
    root_hex: &str,
    post: &crate::record::documents::PublicDoc,
    author: &str,
) -> Result<PostWords, AppError> {
    let doc_hex = hex::encode(post.doc_id);
    let labels =
        crate::annotations::for_posts(state, &[(root_hex.to_string(), doc_hex.clone())], None)
            .await
            .unwrap_or_default();
    let described = labels.get(&(root_hex.to_string(), doc_hex)).and_then(|ls| {
        ls.iter()
            .find(|a| a.annotator == root_hex && a.key == "description")
            .map(|a| a.value.clone())
    });
    let marquee = crate::record::documents::Format::from_wire(post.format)
        == crate::record::documents::Format::Marquee;
    let text = match crate::record::documents::public_head(db, &post.doc_id).await? {
        Some(head) => {
            match state.files.get_public(iroh_blobs::Hash::from_bytes(head.file_hash)).await {
                Ok(Some(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
                _ => String::new(),
            }
        }
        None => String::new(),
    };
    let picture = if marquee { first_picture_thumb(&text) } else { None };
    let words = if marquee {
        crate::record::bake::plain_words(&text, &|_| String::new()).unwrap_or(text)
    } else {
        String::new()
    };
    let words = words.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = if post.title.trim().is_empty() {
        let first: String = words.split(' ').take(9).collect::<Vec<_>>().join(" ");
        if first.is_empty() {
            author.to_string()
        } else {
            first
        }
    } else {
        post.title.clone()
    };
    Ok(PostWords { title, described, words, picture })
}

/// The thumbnail of the first public picture a post's words embed, as a path - whosever it is.
fn first_picture_thumb(words: &str) -> Option<String> {
    let doc = marquee_parser::parse(words).ok()?;
    let mut found: Option<String> = None;
    crate::record::bake::each_embed(&doc, &mut |target| {
        if found.is_some() {
            return;
        }
        if let Some((author, twin)) = crate::record::bake::twin_address(target) {
            let speak = speakable::speakable(&author);
            let short = speak.rsplit('-').next().unwrap_or(&speak).to_string();
            found = Some(format!("/ringtome/user/{short}/doc/{}/thumb", hex::encode(twin)));
        }
    });
    found
}

/// At most `max` characters of `s`, cut at a word and marked when cut.
pub(crate) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    let at = cut.rfind(' ').unwrap_or(cut.len());
    format!("{}…", cut[..at].trim_end())
}

/// GET `/id/{seg}` and `/id/{seg}/{*rest}` - the address before `/ringtome/` (PROJECT_PLAN's
/// "`/ringtome/` replaces `/home`, `/in` and `/id`", 2026-09-28): sent on to its `/ringtome/` form,
/// the query (the `?via=` hints) kept. Only the PAGES move; a picture's bytes stay at
/// `/id/{seg}/docs/…`, which signed documents name and can never stop naming. Temporary rather than
/// permanent while the grammar is young, so a browser never caches a redirect we later regret.
pub async fn legacy_id(
    Path(seg): Path<String>,
    RawQuery(query): RawQuery,
) -> axum::response::Redirect {
    axum::response::Redirect::temporary(&ringtome_from_legacy(&seg, None, query.as_deref()))
}

pub async fn legacy_id_deep(
    Path((seg, rest)): Path<(String, String)>,
    RawQuery(query): RawQuery,
) -> axum::response::Redirect {
    axum::response::Redirect::temporary(&ringtome_from_legacy(&seg, Some(&rest), query.as_deref()))
}

/// `/id/<seg>[/<rest>][?<query>]` as `/ringtome/user/<seg>[/<rest>][?<query>]`, a book's page
/// (`post/<book>/<page>`, the page's own post id) spelled as the new grammar spells it
/// (`post/<book>/page/<page>`).
fn ringtome_from_legacy(seg: &str, rest: Option<&str>, query: Option<&str>) -> String {
    let mut path = format!("/ringtome/user/{seg}");
    if let Some(rest) = rest.map(|r| r.trim_matches('/')).filter(|r| !r.is_empty()) {
        let parts: Vec<&str> = rest.split('/').collect();
        match parts.as_slice() {
            ["post", doc, page]
                if page.len() == 32 && page.chars().all(|c| c.is_ascii_hexdigit()) =>
            {
                path.push_str(&format!("/post/{doc}/page/{page}"));
            }
            _ => {
                path.push('/');
                path.push_str(rest);
            }
        }
    }
    if let Some(q) = query.filter(|q| !q.is_empty()) {
        path.push('?');
        path.push_str(q);
    }
    path
}

/// GET `/ringtome/user/{seg}` (and, before 2026-09-28, `/id/{seg}`): the one URL, both audiences.
pub async fn idface(
    _session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
) -> Result<Response, AppError> {
    let Some(parsed) = speakable::parse(&seg) else {
        return Ok(face(
            StatusCode::NOT_FOUND,
            page(
                "not a ringtome address",
                "<h1>that's not an address</h1>\
                 <p>The path after <code>/id/</code> should be a persona's address - two words \
                 and a key, like <code>sway-broke-AwTy…</code></p>"
                    .into(),
            ),
        ));
    };

    let root = match parsed {
        Parsed::Ok(root) => root,
        Parsed::Mismatch { root, expected } => {
            // Refused loudly, with the truth in hand - lenient acceptance would train
            // everyone to ignore the words, which deletes the feature.
            let key = seg.rsplit('-').next().unwrap_or("");
            let _ = root; // the claimed root is never rendered as if it were good
            return Ok(face(
                StatusCode::BAD_REQUEST,
                page(
                    "this address arrived mangled",
                    format!(
                        "<h1>this address arrived mangled</h1>\
                         <p>The words on this address don't match its key, so something got \
                         mixed up in transit.</p>\
                         <p>Did you mean <a href=\"/ringtome/user/{expected}-{key}\"><code>{expected}-{key_short}…</code></a>?</p>",
                        expected = esc(&expected),
                        key = esc(key),
                        key_short = esc(&key.chars().take(8).collect::<String>()),
                    ),
                ),
            ));
        }
    };
    persona_page(&state, root).await
}

/// The persona's page: the app with a meta head (PROJECT_PLAN's The node's public face, ruling 8). The server's part
/// is the head - the title and the OpenGraph meta a crawler or a link unfurler reads, the
/// URL carrying the via hints that say where this persona can be reached - and the app takes
/// the body, signed in or not. A hosted persona is 200; anything else is the same page under
/// a 404, since nothing about it is served here and the app says so. Served at `/id/<addr>`
/// and, for a hosted persona with a slug, at `/@<slug>` (ruling 6). The raw card page
/// retired here on 2026-09-15.
pub(crate) async fn persona_page(state: &AppState, root: [u8; 32]) -> Result<Response, AppError> {
    let root_hex = hex::encode(root);
    let speak = speakable::speakable(&root);
    let words = speak.rsplit_once('-').map(|x| x.0).unwrap_or("").to_string();
    let hosted = hosted_here(state, &root_hex).await?;
    let fields = if hosted {
        public_profile(state, &root_hex).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let name = profile_value(&fields, "name").unwrap_or(&words).to_string();
    let bio = profile_value(&fields, "bio").unwrap_or("").to_string();
    let mut via = Vec::new();
    if hosted {
        if let Ok(Some(own_leaf)) = crate::identity::leaf_hex_of(&state.node_db, &root_hex).await {
            via.push(own_leaf);
        }
        for leaf in crate::net::sync::liveliest_leaves(&state.node_db, &root_hex, 16)
            .await
            .unwrap_or_default()
        {
            if via.len() >= 10 {
                break;
            }
            if !via.contains(&leaf) {
                via.push(leaf);
            }
        }
        if via.is_empty() {
            via.push(state.endpoint.id().to_string());
        }
        for peer in crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 16)
            .await
            .unwrap_or_default()
        {
            if via.len() >= 10 {
                break;
            }
            if !via.contains(&peer) {
                via.push(peer);
            }
        }
    }
    let via: Vec<String> =
        via.iter().map(|k| speakable::node_key_b58(k).unwrap_or_else(|| k.clone())).collect();
    let base = state.config.public_url.clone().unwrap_or_default();
    // The address in its `/ringtome/` form, the root in its short spelling (2026-09-28).
    let short = speak.rsplit('-').next().unwrap_or(&speak);
    let url = if via.is_empty() {
        format!("{base}/ringtome/user/{short}")
    } else {
        format!("{base}/ringtome/user/{short}?via={}", via.join(","))
    };
    let mut head = format!(
        "<title>{}</title>\n<meta property=\"og:title\" content=\"{}\">\n<meta property=\"og:type\" content=\"profile\">\n<meta property=\"og:url\" content=\"{}\">",
        esc(&name),
        esc(&name),
        esc(&url)
    );
    if !bio.is_empty() {
        head.push_str(&format!("\n<meta property=\"og:description\" content=\"{}\">\n<meta name=\"description\" content=\"{}\">", esc(&bio), esc(&bio)));
    }
    // Their RSS (rss.rs, 2026-09-30), for a reader that looks for it on the page.
    if hosted {
        head.push_str(&format!(
            "\n<link rel=\"alternate\" type=\"application/rss+xml\" title=\"{}\" href=\"{base}/ringtome/user/{short}/rss.xml\">",
            esc(&name)
        ));
    }
    if let Some(doc) = profile_value(&fields, "avatar") {
        head.push_str(&format!(
            "\n<meta property=\"og:image\" content=\"{}/id/{}/docs/{}/thumb\">",
            esc(&base),
            esc(&speak),
            esc(doc)
        ));
    }
    head.push_str(&colorway_meta(&fields));
    let status = if hosted { StatusCode::OK } else { StatusCode::NOT_FOUND };
    Ok((
        status,
        [(header::X_CONTENT_TYPE_OPTIONS, "nosniff")],
        axum::response::Html(crate::ui::app_page(state, &head)),
    )
        .into_response())
}

/// How long a fetched foreign profile is served without even trying to revalidate.
///
/// This was ten minutes, back when a visit's fetch sat in the request path and a long window
/// was the only thing keeping a dead peer from making a slow page. It is thirty seconds now,
/// because the fetch no longer blocks anything: a visit serves what we hold and revalidates
/// BEHIND the response. What remains is an anti-hammer floor - a reload loop must not become a
/// dial loop - and the exchange it guards is cheap in the common case (an up-to-date frontier
/// swap transfers nothing; only a persona that actually moved costs more than a kilobyte).
const FOREIGN_REVALIDATE_MS: i64 = 30 * 1000;

/// A test node's runtime override of [`FOREIGN_REVALIDATE_MS`] (`/test/foreign-revalidate`); 0
/// means none. Per test, never boot-wide: the claim that watches a visit revalidate behind its
/// answer slept the real thirty seconds, the slowest wait in the suite (2026-10-02).
pub static FOREIGN_REVALIDATE_OVERRIDE: std::sync::atomic::AtomicI64 =
    std::sync::atomic::AtomicI64::new(0);

fn foreign_revalidate_ms() -> i64 {
    match FOREIGN_REVALIDATE_OVERRIDE.load(std::sync::atomic::Ordering::Relaxed) {
        ms if ms > 0 => ms,
        _ => FOREIGN_REVALIDATE_MS,
    }
}

/// Record a successful foreign fetch - ON DISK (amended 2026-08-02 from an in-memory map):
/// once an identity's own nodes go permanently dark, it survives exactly in the nodes that
/// fetched it and their memory of having done so; a fleet of friendly nodes rebooting must
/// not orphan chains they still hold. Durable KNOWLEDGE, still member-scoped SERVING - this
/// table never touches the identities table (the anonymous shelf) or identity_peers (the
/// background sync worklist): a fetch is remembered, never promoted to fronting.
/// A via hint interpreted as an identity leaf: if a fresh serving record exists under this
/// key AND names the root we are fetching, the record's endpoint is the dial target -
/// authenticated by the leaf's own signature, with the root binding checked so a leaf via
/// for the WRONG identity can't redirect a fetch. Anything else returns the key unchanged,
/// to be dialed as the endpoint id it presumably is.
pub(crate) async fn leaf_via_to_endpoint(
    state: &AppState,
    root_hex: &str,
    key_hex: &str,
) -> String {
    let Some(leaf) = crate::pubkey::decode(key_hex) else {
        return key_hex.to_string();
    };
    match state.directory.resolve_serving(&leaf).await {
        Ok(Some(signed)) if hex::encode(signed.record().root) == root_hex => {
            match iroh::PublicKey::from_bytes(&signed.record().endpoint_id) {
                Ok(ep) => ep.to_string(),
                Err(_) => key_hex.to_string(),
            }
        }
        _ => key_hex.to_string(),
    }
}

async fn record_foreign_fetch(state: &AppState, root_hex: &str, via: &str) -> Result<(), AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO foreign_fetches (root_pubkey, fetched_at_ms, last_via, looked_ms)
             VALUES (?1, ?2, ?3, ?2)
             ON CONFLICT(root_pubkey) DO UPDATE SET fetched_at_ms = ?2, last_via = ?3, looked_ms = ?2",
            (root_hex, crate::clock::now_ms(), via),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

/// Drop a root's fetch memory - called when this node starts HOSTING it (identity.rs, the
/// transition that makes the record wrong rather than merely old) and by the eviction
/// sweep's owner-forgets walk (eviction.rs, 2026-08-25 - an evicted mirror must not leave
/// a registry row claiming a persona whose database is gone).
pub async fn forget_foreign_fetch(node_db: &crate::db::Db, root_hex: &str) -> Result<(), AppError> {
    node_db
        .execute("DELETE FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

/// The fetch memory for a root: (fetched_at_ms, the endpoint key that last answered).
/// Every foreign root this node has fetched and still carries. The other half of "personas we
/// hold" - deliberately NOT in the identities table (that is what keeps the anonymous face
/// tombstoning them), so the frontier sweep has to ask both.
pub async fn fetched_roots(node_db: &crate::db::Db) -> anyhow::Result<Vec<String>> {
    use anyhow::Context;
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT root_pubkey FROM foreign_fetches", ())
        .await
        .context("listing fetched identities")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Has this node ever fetched-and-carried this foreign root? The sync responder's question
/// when a push arrives for a persona we don't host: a carried persona's updates are welcome.
pub async fn has_fetched(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<bool> {
    use anyhow::Context;
    let row: Option<(i64,)> = node_db
        .fetch_optional("SELECT 1 FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await
        .context("checking the fetch registry")?;
    Ok(row.is_some())
}

/// The endpoint that last answered a fetch of this persona, if any - the recovery sweep's
/// best first guess for who holds its bodies (net::bodies).
pub async fn fetched_via(
    node_db: &crate::db::Db,
    root_hex: &str,
) -> anyhow::Result<Option<String>> {
    let row: Option<(Option<String>,)> = node_db
        .fetch_optional("SELECT last_via FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await?;
    Ok(row.and_then(|(via,)| via))
}

/// Every endpoint that answered a fetch here since `since_ms` - one of the census's sources of
/// "nodes this one has talked to lately" (census.rs, 2026-09-29). Freshest first.
pub(crate) async fn recent_answerers(state: &AppState, since_ms: i64) -> Vec<String> {
    let rows: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT last_via FROM foreign_fetches WHERE last_via IS NOT NULL AND fetched_at_ms >= ?1
             GROUP BY last_via ORDER BY MAX(fetched_at_ms) DESC",
            (since_ms,),
        )
        .await
        .unwrap_or_default();
    rows.into_iter().map(|(e,)| e).collect()
}

pub(crate) async fn foreign_fetch_row(
    state: &AppState,
    root_hex: &str,
) -> Result<Option<(i64, Option<String>)>, AppError> {
    state
        .node_db
        .fetch_optional(
            "SELECT fetched_at_ms, last_via FROM foreign_fetches WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .map_err(AppError::Internal)
}

/// Per-candidate ceiling on the whole dial-and-sync; the ladder tries at most three, so a
/// page's worst case stays bounded even when every hinted node is dark.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(serde::Deserialize)]
pub struct IdQuery {
    /// Comma-separated node endpoint keys - the address's own `?via=` hints, passed through
    /// by the lens page. Hints are keys, never addresses; anything unparseable is skipped.
    pub via: Option<String>,
    /// The VIEWING persona's root, hex - the reader the sealed-post rule is asked for: a
    /// trusted-only post the viewer cannot open is not listed at all, as the feed does.
    #[serde(rename = "as")]
    pub as_root: Option<String>,
}

/// Fetch a foreign identity's PUBLIC chains at request time: dial the candidate node keys IN
/// PARALLEL and take the first success - with the `?via=` list widened to ten keys
/// (2026-08-02, keeping fast-moving identities alive), a sequential ladder's worst case
/// would be ten timeouts end to end, and a page can't wait for that. Each task runs the
/// ordinary sync exchange (an unproven requester with empty frontiers receives exactly the
/// public lane - the same from-empty path adoption exercises), the gate validates everything
/// against `root`, and concurrent winners are safe (single-writer chains, duplicate-skip
/// ingest; the also-rans are DETACHED to finish, never aborted - see below). Candidates
/// arrive base58 or hex, and each may be
/// either kind of key (2026-08-07, "hints become leaves"): an identity LEAF - resolved
/// through its signed serving record, which must name OUR target root or the hint is
/// discarded - or a bare endpoint id, the original transport-layer form. Leaves are tried as
/// leaves first; a key that resolves no serving record falls back to being dialed as an
/// endpoint. The resolve-a-bare-root announce backstop remains NEXT_STEPS.
pub(crate) async fn fetch_foreign(state: &AppState, root_hex: &str, via: &[String]) -> bool {
    fetch_foreign_passes(state, root_hex, via, crate::net::sync::CONTINUATIONS_PER_WAKE).await
}

/// `fetch_foreign` with the continuation count named: each winning candidate chains up to
/// `max_passes` budgeted exchanges while the peer still holds more (PROJECT_PLAN's Peeks, ruling 2). One
/// pass is the test beat's "pull-once", which is how the cut itself is observed.
/// Held at PEEK depth (PROJECT_PLAN's Peeks, ruling 1): not this node's own, and nobody's dial here names
/// them - follow, rebroadcast interest, or trust alike (the eviction sweep's "nobody wants"
/// question; a rebroadcast-only follow is a relationship whose shares chain must arrive
/// whole, which the first full rig run proved by refusing every share in the tree). Depth
/// is a fact about OUR relationships, so this is the one question every door asks.
pub(crate) async fn peek_held(state: &AppState, root_hex: &str) -> bool {
    if crate::identity::is_agented(&state.node_db, root_hex).await.unwrap_or(false) {
        return false;
    }
    // A speculative mirror (Discovery slice 1) is held on a reader's trust rollup, not on a
    // dial - quiet by design, and at whatever depth its own pass chose. Not a peek.
    if crate::speculative::fetched_at(&state.node_db, root_hex).await.ok().flatten().is_some() {
        return false;
    }
    crate::net::subscriptions::dialed_by(&state.node_db, root_hex)
        .await
        .map(|d| d.is_empty())
        .unwrap_or(false)
}

/// Promotion (PROJECT_PLAN's Peeks, ruling 7): a dial just landed on a persona held as a peek, so fetch
/// them whole NOW, through the ladder the peek already knows - the demand signal is the
/// dial, and "follow, then open their page" must find the mirror, not the next beat.
pub(crate) async fn promote_peek(state: &AppState, root_hex: &str) -> bool {
    let via = stored_tree_leaves(state, root_hex).await;
    fetch_foreign_at(state, root_hex, &via, crate::net::sync::CONTINUATIONS_PER_WAKE, Some(false))
        .await
}

/// How many posts a peek carries (PROJECT_PLAN's Peeks, ruling 4), and how long the page waits for them.
const PEEK_POSTS: u64 = 20;
const PEEK_SHELF_WAIT: std::time::Duration = std::time::Duration::from_secs(6);
/// How often a look is written down - a reload loop is one look.
const PEEK_LOOK_THROTTLE_MS: i64 = 60 * 1000;

/// A member looked at this peek (PROJECT_PLAN's Peeks, ruling 6): the expiry and the node-wide budget's
/// least-recently-looked order read the stamp. Throttled in memory so a page's dozen reads
/// are one write.
pub(crate) async fn touch_look(state: &AppState, root_hex: &str) {
    let now = crate::clock::now_ms();
    if state
        .sweep_marks
        .last("peek-look", root_hex)
        .is_some_and(|t| now - t < PEEK_LOOK_THROTTLE_MS)
    {
        return;
    }
    state.sweep_marks.record("peek-look", root_hex, now);
    if let Err(e) = state
        .node_db
        .execute(
            "UPDATE foreign_fetches SET looked_ms = ?2 WHERE root_pubkey = ?1",
            (root_hex, now),
        )
        .await
    {
        tracing::debug!(root = %root_hex, error = ?e, "could not stamp a look");
    }
}

/// The peek registry, for the eviction sweep: every fetched root with its last look and
/// its measured footprint (PROJECT_PLAN's Peeks, ruling 6). Owner's read - `foreign_fetches` is this
/// module's table.
pub(crate) async fn peek_registry(
    node_db: &crate::db::Db,
) -> anyhow::Result<Vec<(String, i64, i64)>> {
    node_db
        .fetch_all("SELECT root_pubkey, looked_ms, bytes FROM foreign_fetches", ())
        .await
        .map_err(|e| anyhow::anyhow!("reading the peek registry: {e}"))
}

/// Whether somebody here looked at this persona within the expiry - the keeper a peek
/// holds its mirror by (PROJECT_PLAN's Peeks, ruling 6): a look is the rest clock a peek is judged on.
pub(crate) async fn looked_within(
    node_db: &crate::db::Db,
    root_hex: &str,
    now: i64,
    expiry_ms: i64,
) -> bool {
    let row: Option<(i64,)> = node_db
        .fetch_optional("SELECT looked_ms FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await
        .ok()
        .flatten();
    row.is_some_and(|(looked,)| now - looked < expiry_ms)
}

/// The author's pinned posts as this node holds them (PROJECT_PLAN's Peeks, ruling 12): the pins off the
/// author's own annotations chain (mirror or peek alike carry it), each resolved to the
/// post - the mirror's shelf, or for a peek whatever the ledger fetched. A pin whose post
/// is not here yet is simply not in the strip until it lands.
///
/// Also the pins about somebody else's post (Curtis, 2026-09-29: "Pin books, chats, or
/// rebroadcasts"): a post this persona passes along, placed on their page while the share
/// stands - a withdrawn share takes its pin with it. The strip's order is `Pinned::order`.
struct Pinned {
    order: Vec<crate::record::imaol::Pin>,
    posts: Vec<crate::record::documents::PublicDoc>,
    shares: Vec<crate::record::imaol::RebroadcastRow>,
}

async fn pinned_here(state: &AppState, root_hex: &str, peek: bool) -> Pinned {
    let Ok(Some(db)) = state.user_dbs.get(root_hex).await else {
        return Pinned { order: Vec::new(), posts: Vec::new(), shares: Vec::new() };
    };
    let order = crate::record::imaol::pins(&db).await.unwrap_or_default();
    let ids: Vec<[u8; 16]> =
        order.iter().filter(|p| p.author == root_hex).map(|p| p.doc_id).collect();
    let shares: Vec<crate::record::imaol::RebroadcastRow> =
        if order.iter().any(|p| p.author != root_hex) {
            crate::record::imaol::rebroadcasts(&db)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|s| {
                    !s.is_retracted()
                        && order.iter().any(|p| p.author == s.author_root && p.doc_id == s.doc_id)
                })
                .collect()
        } else {
            Vec::new()
        };
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let doc = if peek {
            crate::fragments::public_doc_of(&state.node_db, root_hex, &hex::encode(id))
                .await
                .ok()
                .flatten()
                .map(|(p, _)| p)
        } else {
            match crate::record::documents::public_doc(&db, &id).await.ok().flatten() {
                Some(p) => Some(p),
                None => {
                    // Beneath the follow ceiling's floor (PROJECT_PLAN's Peeks, ruling 13): acquired by id
                    // over the fragment road, never by deepening the chain.
                    if let Some(author) = crate::pubkey::decode(root_hex) {
                        crate::fragments::fetch_post(state, root_hex, &author, &id).await;
                    }
                    crate::fragments::public_doc_of(&state.node_db, root_hex, &hex::encode(id))
                        .await
                        .ok()
                        .flatten()
                        .map(|(p, _)| p)
                }
            }
        };
        if let Some(p) = doc {
            out.push(p);
        }
    }
    Pinned { order, posts: out, shares }
}

/// One share on a persona's shelf, as a card: the ORIGINAL author's post, worn with this persona
/// as its via. Title and format off whatever header this node holds (`fragments::card_header`).
async fn share_json(
    state: &AppState,
    s: &crate::record::imaol::RebroadcastRow,
    via: &str,
) -> serde_json::Value {
    let header = crate::fragments::card_header(state, &s.author_root, &s.doc_id).await;
    serde_json::json!({
        "kind": "share",
        "author": s.author_root,
        "doc_id": hex::encode(s.doc_id),
        "title": header.as_ref().map(|h| h.title.clone()),
        "format": header
            .as_ref()
            .map(|h| crate::record::documents::Format::from_wire(h.format).as_str()),
        "published_ms": s.received_at_ms,
        "shared_ms": s.received_at_ms,
        "via": via,
    })
}

/// The peek's footprint, measured now and written to the registry (PROJECT_PLAN's Peeks, ruling 6).
pub(crate) async fn peek_bytes(state: &AppState, root_hex: &str) -> u64 {
    let bytes = crate::fragments::bytes_of_author(state, root_hex).await.unwrap_or(0);
    let _ = state
        .node_db
        .execute(
            "UPDATE foreign_fetches SET bytes = ?2 WHERE root_pubkey = ?1",
            (root_hex, bytes as i64),
        )
        .await;
    bytes
}

/// Whether this peek may still fetch (PROJECT_PLAN's Peeks, ruling 6): under its byte ceiling. Every
/// road that fetches for a peek - the shelf, the on-demand reads, the reply door - asks
/// this first; over the ceiling, the peek keeps what it has and the page says so.
pub(crate) async fn peek_room(state: &AppState, root_hex: &str) -> bool {
    peek_bytes(state, root_hex).await < state.config.peek_max_bytes
}

/// The peek's shelf (PROJECT_PLAN's Peeks, ruling 4): ask the node that just answered for the persona
/// which posts are newest (and pinned), then fetch each as a fragment - its own signed
/// header, verified here, its labels riding along - and want its body. Bounded by the
/// page's patience: what lands in time renders now, the rest lands behind the page
/// (ruling 9, render at first entry). Returns how many posts the ledger holds afterwards.
async fn peek_shelf(state: &AppState, root_hex: &str, endpoint_id: &str) -> usize {
    let Some(author) = crate::pubkey::decode(root_hex) else {
        return 0;
    };
    let shelf = tokio::time::timeout(
        PEEK_SHELF_WAIT,
        crate::net::fragment::fetch_shelf_from(state, endpoint_id, &author, PEEK_POSTS),
    )
    .await;
    let (posts, pinned) = match shelf {
        Ok(Ok(lists)) => lists,
        Ok(Err(e)) => {
            tracing::debug!(root = %root_hex, via = %endpoint_id, "peek: shelf refused: {e:#}");
            return 0;
        }
        Err(_) => {
            tracing::debug!(root = %root_hex, via = %endpoint_id, "peek: shelf did not answer in time");
            return 0;
        }
    };
    let mut wanted: Vec<[u8; 16]> = Vec::new();
    // The face first: the profile names its avatar by document id, and a peek that shows
    // the name without the face is half a look.
    if let Ok(fields) = public_profile(state, root_hex).await {
        // ...and the banner beside it (2026-09-28): the top of their page.
        for field in ["avatar", "banner"] {
            if let Some(doc) = profile_value(&fields, field)
                .and_then(|h| hex::decode(h).ok())
                .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
            {
                wanted.push(doc);
            }
        }
    }
    for id in pinned.into_iter().chain(posts) {
        if !wanted.contains(&id) {
            wanted.push(id);
        }
    }
    wanted.truncate((PEEK_POSTS * 2 + 1) as usize);
    if !peek_room(state, root_hex).await {
        tracing::info!(root = %root_hex, "peek: at its ceiling - nothing more fetched");
        return crate::fragments::shelf_of(&state.node_db, root_hex, PEEK_POSTS as i64)
            .await
            .map(|s| s.len())
            .unwrap_or(0);
    }
    let started = std::time::Instant::now();
    let mut tasks = tokio::task::JoinSet::new();
    for (index, doc_id) in wanted.into_iter().enumerate() {
        let doc_hex = hex::encode(doc_id);
        if let Ok(Some(_)) = crate::fragments::held(&state.node_db, root_hex, &doc_hex).await {
            continue;
        }
        let task_state = state.clone();
        let task_root = root_hex.to_string();
        let task_via = endpoint_id.to_string();
        tasks.spawn(async move {
            let fetched =
                crate::net::fragment::fetch_from(&task_state, &task_via, &author, &doc_id).await;
            if let Ok(crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by)) =
                fetched
            {
                if crate::fragments::remember(
                    &task_state.node_db,
                    &task_root,
                    &task_root,
                    &verified,
                    &entry,
                    &auth_path,
                )
                .await
                .is_ok()
                {
                    if let Some(ep) = served_by {
                        let _ =
                            crate::fragments::note_deliverer(&task_state.node_db, &task_root, &ep)
                                .await;
                    }
                    // The words, the thumbnail and the preview alike: a face is its thumbnail.
                    let mut hashes = vec![verified.header.file_hash];
                    hashes.extend(verified.header.thumb_hash);
                    hashes.extend(verified.header.preview_hash);
                    return Some((index, hashes));
                }
            }
            None
        });
    }
    // Wait the page's patience, then let the rest finish detached (never aborted: a late
    // fragment is a warmer shelf, and an abort mid-dial is the zombie the ladder learned
    // to avoid).
    let mut landed: Vec<(usize, Vec<[u8; 32]>)> = Vec::new();
    let deadline = tokio::time::sleep(PEEK_SHELF_WAIT);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            joined = tasks.join_next() => match joined {
                None => break,
                Some(Ok(Some(hit))) => landed.push(hit),
                Some(_) => {}
            },
            _ = &mut deadline => {
                tasks.detach_all();
                break;
            }
        }
    }
    landed.sort_by_key(|(i, _)| *i);
    // The bytes cross with the look, not behind it (the face test's "no second trip") -
    // one document at a time, in shelf order, each wanted and fetched only while the peek
    // has room (ruling 6) and the page has patience. Past either, nothing more is even
    // wanted: what the ceiling refuses, the sweep must not fetch later.
    if let Ok(addr) = crate::net::sync::dial_addr(state, endpoint_id).await {
        for (_, hashes) in landed {
            if started.elapsed() > PEEK_SHELF_WAIT * 2 || !peek_room(state, root_hex).await {
                break;
            }
            for h in &hashes {
                let _ = crate::net::bodies::want(&state.node_db, root_hex, h).await;
            }
            crate::net::bodies::fetch_wanted(state, root_hex, addr.clone()).await;
        }
    }
    peek_bytes(state, root_hex).await;
    crate::fragments::shelf_of(&state.node_db, root_hex, PEEK_POSTS as i64)
        .await
        .map(|s| s.len())
        .unwrap_or(0)
}

pub(crate) async fn fetch_foreign_passes(
    state: &AppState,
    root_hex: &str,
    via: &[String],
    max_passes: usize,
) -> bool {
    fetch_foreign_at(state, root_hex, via, max_passes, None).await
}

/// How far one scrollback backfill reaches beneath the floor (PROJECT_PLAN's Peeks, slice 5).
const BACKFILL_ENTRIES: u64 = 200;

/// Scrollback's backfill (PROJECT_PLAN's Peeks, ruling 8): the pager ran out of what a follow holds and
/// the posts chain has a floor above zero - ask the author's nodes for the entries beneath
/// it, one bounded exchange, and let the caller read again.
pub(crate) async fn backfill(state: &AppState, root_hex: &str) -> bool {
    let via = stored_tree_leaves(state, root_hex).await;
    fetch_foreign_with(
        state,
        root_hex,
        &via,
        1,
        Some(false),
        crate::net::sync::Ask {
            ceiling: state.config.follow_posts_ceiling,
            below: BACKFILL_ENTRIES,
        },
    )
    .await
}

/// The posts chain's floor as this node holds it - zero when whole or absent.
pub(crate) async fn posts_floor(state: &AppState, root_hex: &str) -> u64 {
    crate::net::frontier::memo_chains(&state.node_db, root_hex)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, svc, _, _, _, _)| *svc == ringtome_proto::registry::service::POSTS)
        .map(|(_, _, _, floor, _, _)| floor)
        .max()
        .unwrap_or(0)
}

/// `fetch_foreign_passes` with the depth named: `Some(true)` peeks, `Some(false)` pulls
/// whole, `None` asks the relationships (`peek_held`).
async fn fetch_foreign_at(
    state: &AppState,
    root_hex: &str,
    via: &[String],
    max_passes: usize,
    depth: Option<bool>,
) -> bool {
    let ask = crate::net::sync::Ask { ceiling: state.config.follow_posts_ceiling, below: 0 };
    fetch_foreign_with(state, root_hex, via, max_passes, depth, ask).await
}

async fn fetch_foreign_with(
    state: &AppState,
    root_hex: &str,
    via: &[String],
    max_passes: usize,
    depth: Option<bool>,
    ask: crate::net::sync::Ask,
) -> bool {
    // Depth (PROJECT_PLAN's Peeks, ruling 1): nobody here follows them, so this is a PEEK - the scoped
    // exchange for identity, profile and annotations, then the shelf as fragments. A
    // followed persona takes the ordinary full pull.
    let peek = match depth {
        Some(p) => p,
        None => peek_held(state, root_hex).await,
    };
    let scope: &'static [u32] = if peek { crate::net::sync::PEEK_SCOPE } else { &[] };
    // Whether anything of theirs is here before the dials go out. An exchange that delivers
    // NOTHING to a node that holds NOTHING is not a fetch (2026-09-24): a housemate's serve
    // gate answers strangers with the polite empty exchange, and counting that as a win
    // recorded a fetch of a persona this node still knew nothing about, and answered a page
    // for it. A revalidation that finds nothing new is still a success: we held them.
    let held_before = state.user_dbs.db_mtime_ms(root_hex).is_some();

    // Round one: the persona's own machinery. The zeroth hint is the root itself: a founding
    // node signs with the root AS its leaf, so its serving record lives under the root key -
    // which makes a bare root resolve with no hint at all, for every persona whose founding
    // node still publishes. (The announce rendezvous, when built, covers the personas whose
    // founder is gone.)
    let own: Vec<String> =
        std::iter::once(root_hex.to_string()).chain(via.iter().take(10).cloned()).collect();
    let mut won = race(state, root_hex, scope, ask, max_passes, held_before, own).await;

    // Round two, only when round one reached nobody: the household (the cohort rung, decided
    // 2026-08-15; moved here 2026-09-24 so that EVERY foreign fetch has it - the first look
    // at a persona and a follow's promotion used to walk only the hints, and a phone opening
    // a sleeping author's page for the first time got "none of the address's computers
    // answered" while its own desktop held that author whole). A FALLBACK and never a
    // racer: when the persona's own node answers it must be the one that answers, because
    // what a fetch records (`last_via`) is where the doors ask next - replies, the peek's
    // shelf, the bodies behind a ceiling - and a housemate that won the race by a
    // millisecond has none of that authority. The cohort's rows exist because a ceremony
    // bound those machines to one of our personas, and the sync door there answers for
    // anyone their users follow or have fetched.
    if won.is_none() {
        let household: Vec<String> =
            crate::net::sync::cohort_endpoints(state).await.unwrap_or_default();
        if !household.is_empty() {
            won = race(state, root_hex, scope, ask, max_passes, held_before, household).await;
        }
    }

    let Some((key_hex, received)) = won else {
        return false;
    };
    tracing::info!(root = %root_hex, via = %key_hex, received, peek,
        "fetched foreign identity on member request");
    if let Err(e) = record_foreign_fetch(state, root_hex, &key_hex).await {
        tracing::warn!(root = %root_hex, "could not record foreign fetch: {e:#}");
    }
    if peek {
        state.peeked.mark(root_hex);
        // The shelf lands BEHIND the answer (ruling 9, render at first entry - Curtis,
        // 2026-09-05: "my first look at the page is completely blank"): the page gets
        // the persona the moment their chains are here and says the posts are still
        // arriving; the in-flight set is what it reads, and it polls until clear.
        let shelf_state = state.clone();
        let shelf_root = root_hex.to_string();
        let shelf_via = key_hex.clone();
        if state.refreshing.lock().unwrap().insert(root_hex.to_string()) {
            tokio::spawn(async move {
                let held = peek_shelf(&shelf_state, &shelf_root, &shelf_via).await;
                shelf_state.refreshing.lock().unwrap().remove(&shelf_root);
                tracing::info!(root = %shelf_root, via = %shelf_via, held, "peek: shelf fetched as fragments");
            });
        }
    } else {
        // A peek becoming whole: whatever the history dig concluded about the peek's
        // shelf was about a different shelf (fanout::fill_pass).
        if state.peeked.is_behind(root_hex) {
            if let Err(e) = crate::fanout::restart_history_dig(&state.node_db, root_hex).await {
                tracing::warn!(root = %root_hex, "could not restart the history dig: {e:#}");
            }
        }
        state.peeked.clear(root_hex);
    }
    true
}

/// One round of the ladder: dial every candidate IN PARALLEL and take the first that answers
/// with something - with the `?via=` list widened to ten keys (2026-08-02, keeping
/// fast-moving identities alive), a sequential ladder's worst case would be ten timeouts end
/// to end, and a page can't wait for that. Each task runs the ordinary sync exchange (an
/// unproven requester with empty frontiers receives exactly the public lane - the same
/// from-empty path adoption exercises), the gate validates everything against `root`, and
/// concurrent winners are safe (single-writer chains, duplicate-skip ingest; the also-rans
/// are DETACHED to finish, never aborted - see below). Candidates arrive base58 or hex, and
/// each may be either kind of key (2026-08-07, "hints become leaves"): an identity LEAF -
/// resolved through its signed serving record, which must name OUR target root or the hint
/// is discarded - or a bare endpoint id, the original transport-layer form. Leaves are tried
/// as leaves first; a key that resolves no serving record falls back to being dialed as an
/// endpoint. The resolve-a-bare-root announce backstop remains NEXT_STEPS.
///
/// Returns the winning key and how much it delivered, or `None` when nobody answered with
/// anything this node could use.
async fn race(
    state: &AppState,
    root_hex: &str,
    scope: &'static [u32],
    ask: crate::net::sync::Ask,
    max_passes: usize,
    held_before: bool,
    candidates: Vec<String>,
) -> Option<(String, u64)> {
    // Detach, never cancel (2026-08-24, closing REFACTOR's visit-ladder entry): the old
    // shape aborted the also-rans on first success (JoinSet::abort_all) and cancelled each
    // exchange at its 8s deadline (timeout around the future), and every one of those
    // aborts could mint zombie QUIC state against the very node the winner just used. The
    // sharedby CI artifact caught the cluster the REFACTOR entry predicted: three share
    // pointers took 128 seconds - the QUIC idle reaper's clearing time - to cross to a
    // node whose wake pass was dialing their host every 4 seconds, every dial wedged
    // behind a poisoned connection. Now each exchange runs on its own task; deadlines and
    // winners bound the WAIT and detach the work (the `speculative::acquire_one` idiom),
    // and a late also-ran just leaves a warmer mirror (duplicate-skip ingest).
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Option<(String, u64)>>(16);
    for candidate in candidates {
        let candidate = &candidate;
        // A hint in neither spelling costs a shrug, never the ladder.
        let Some(key_hex) = speakable::node_key_from_via(candidate) else {
            continue;
        };
        let task_state = state.clone();
        let task_root = root_hex.to_string();
        let tx = tx.clone();
        tokio::spawn(async move {
            let key_hex = leaf_via_to_endpoint(&task_state, &task_root, &key_hex).await;
            let Ok(addr) = crate::net::sync::dial_addr(&task_state, &key_hex).await else {
                let _ = tx.send(None).await;
                return;
            };
            let exchange_state = task_state.clone();
            let exchange_root = task_root.clone();
            let mut pull = tokio::spawn(async move {
                let mut passes = 0;
                loop {
                    let stats = crate::net::sync::sync_with_peer_asking(
                        &exchange_state,
                        &exchange_root,
                        addr.clone(),
                        scope,
                        &[],
                        ask,
                    )
                    .await?;
                    passes += 1;
                    if !stats.behind || passes >= max_passes.max(1) {
                        break Ok::<_, anyhow::Error>(stats);
                    }
                }
            });
            let outcome = match tokio::time::timeout(FETCH_TIMEOUT, &mut pull).await {
                Ok(Ok(Ok(stats))) => Some((key_hex, stats.received)),
                Ok(Ok(Err(e))) => {
                    tracing::debug!(root = %task_root, via = %key_hex, "foreign fetch failed: {e:#}");
                    None
                }
                Ok(Err(join_error)) => {
                    tracing::debug!(root = %task_root, via = %key_hex, "foreign fetch died: {join_error}");
                    None
                }
                Err(_) => {
                    tracing::debug!(root = %task_root, via = %key_hex,
                        "foreign fetch still in flight at the deadline - detached, moving on");
                    None
                }
            };
            let _ = tx.send(outcome).await;
        });
    }
    drop(tx); // the channel closes when the last candidate reports (or none were spawnable)
    while let Some(outcome) = rx.recv().await {
        if let Some((key_hex, received)) = outcome {
            if received == 0 && !held_before {
                tracing::debug!(root = %root_hex, via = %key_hex, "answered, but had nothing of them: not a fetch");
                continue;
            }
            return Some((key_hex, received));
        }
    }
    None
}

/// Start a background revalidation of a foreign persona, unless one is already running for it.
///
/// Returns whether a refresh is now in flight - true if this call started one OR found one
/// already going, because either way the answer being served may be superseded shortly, and
/// that is what the caller is asking.
///
/// The in-flight set is what keeps a reload loop from becoming a dial loop: ten page loads in a
/// second dial the stranger's node once. It is released in every exit path (the guard is
/// dropped by the task's own end, success or failure), because a root that leaked into the set
/// would never be refreshed again for the life of the process.
fn spawn_revalidate(state: &AppState, root_hex: String, via: Vec<String>) -> bool {
    {
        let mut running = state.refreshing.lock().unwrap();
        if !running.insert(root_hex.clone()) {
            return true; // already being fetched; the caller's answer is superseded either way
        }
    }
    let task_state = state.clone();
    tokio::spawn(async move {
        // Widen the hints with the tree we already hold (2026-08-07): a revalidation only
        // runs for a persona we've fetched before, so its identity chain is here - and its
        // Active leaves are exactly the members the mesh now uses to find its own siblings.
        // This is what un-pins a mirror from the one node that answered its first fetch:
        // last_via dead, every explicit hint rotten, and the refresh still finds any device
        // whose serving record is alive.
        let mut via = via;
        for leaf in stored_tree_leaves(&task_state, &root_hex).await {
            if !via.contains(&leaf) {
                via.push(leaf);
            }
        }
        // The cohort - our own personas' sibling nodes, which hold the followed world we
        // slept through (FRONTIER GOSSIP's fetch half, the AM-node scenario, 2026-08-15) -
        // is the last rung of EVERY foreign fetch now, added inside `fetch_foreign_with`.
        let ok = fetch_foreign(&task_state, &root_hex, &via).await;
        if !ok {
            tracing::debug!(root = %root_hex, "background revalidation reached nobody");
        }
        task_state.refreshing.lock().unwrap().remove(&root_hex);
    });
    true
}

/// Stamp a mirrored persona as fresh without a fetch - called by the sync responder when a
/// push DELIVERS for a followed persona, so the follow-refresh sweep stays quiet exactly
/// while the push machinery is doing its job. Update-only: a persona with no fetch record
/// yet keeps "never fetched", which correctly reads as stale.
pub async fn touch_foreign_fetch(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<()> {
    node_db
        .execute(
            "UPDATE foreign_fetches SET fetched_at_ms = ?2 WHERE root_pubkey = ?1",
            (root_hex, crate::clock::now_ms()),
        )
        .await?;
    Ok(())
}

/// One followed persona, as the refresh sweep weighs it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RefreshCandidate {
    foreign: String,
    /// Any follower's account touched the node within the activity window.
    active: bool,
    /// The highest eagerness any follower set.
    eagerness: i64,
    /// COALESCE(fetched_at_ms, 0) - never-fetched sorts stalest.
    fetched_at: i64,
}

/// Priority for a wake-up's limited sync budget: personas followed by HUMANS PRESENT AT THE
/// NODE first (a computer waking with a hundred users must serve the ones actually here),
/// then by the interest dial (already a cadence dial by design), stalest first within a tie.
fn order_refresh(mut candidates: Vec<RefreshCandidate>) -> Vec<String> {
    candidates.sort_by(|a, b| {
        b.active
            .cmp(&a.active)
            .then(b.eagerness.cmp(&a.eagerness))
            .then(a.fetched_at.cmp(&b.fetched_at))
    });
    candidates.into_iter().map(|c| c.foreign).collect()
}

/// How long a follower's account counts as "active on the node" after its last request.
const ACTIVITY_WINDOW_MS: i64 = 30 * 60 * 1000;
/// A mirror this stale gets a wake-up sync. LOCAL_TEST may shorten it.
const FOLLOW_REFRESH_STALE_MS: i64 = 30 * 60 * 1000;
/// Refreshes started per pass - the stampede cap. A laptop waking with hundreds of stale
/// follows catches up over a few beats, priority-ordered, instead of dialing them all at once.
const FOLLOW_REFRESH_CAP: usize = 8;
/// How long an ATTEMPTED mirror rests before the sweep tries it again, success or failure.
/// Without this, a partition starves the tail: failures don't advance any ordering key, so
/// the same top-of-list mirrors would be re-dialed every beat forever while everything
/// behind them is never attempted. The cooldown rotates the cap through the whole list and
/// rate-limits partition-time dialing; partition-heal latency is bounded by one cooldown.
const FOLLOW_ATTEMPT_COOLDOWN_MS: i64 = 5 * 60 * 1000;

/// In-memory attempt stamps for the rotation above. Boot-reset by design: the first pass
/// after boot may retry everything once, which is exactly what a booting node wants.
static FOLLOW_ATTEMPTS: std::sync::Mutex<Option<std::collections::HashMap<String, i64>>> =
    std::sync::Mutex::new(None);

/// Follower-side anti-entropy (2026-08-07): the wake pass. For each followed persona whose
/// mirror has gone stale, re-fetch through the ordinary ladder (zeroth root rung, stored-tree
/// leaves, last_via) - which does BOTH halves of the reunion in one exchange: pulls whatever
/// we missed while closed, and re-records this node as an asker on whoever answers ("asking
/// is telling"), re-arming their push list until we go quiet again. Steady state is near
/// silent: delivered pushes touch the freshness stamp, so an online node's sweep finds
/// nothing stale. This is what makes a follow bind to the PERSON: their founder can die and
/// their fleet can migrate, and the next wake finds whoever currently answers for the tree.
pub async fn refresh_followed_pass(state: crate::AppState) -> anyhow::Result<()> {
    let stale_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_FOLLOW_STALE_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(FOLLOW_REFRESH_STALE_MS)
    } else {
        FOLLOW_REFRESH_STALE_MS
    };
    let cooldown_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_FOLLOW_COOLDOWN_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(FOLLOW_ATTEMPT_COOLDOWN_MS)
    } else {
        FOLLOW_ATTEMPT_COOLDOWN_MS
    };
    let now = crate::clock::now_ms();

    let follows = crate::net::subscriptions::followed_foreign(&state.node_db).await?;
    if follows.is_empty() {
        return Ok(());
    }
    // Local personas are the eager loop's job, whoever follows them; and the follower ->
    // account join is how presence reaches priority.
    let hosted: std::collections::HashMap<String, String> =
        crate::identity::hosted_roots_with_accounts(&state.node_db)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?
            .into_iter()
            .map(|(root, account)| (root, account.to_string()))
            .collect();
    let active_accounts = state.activity.active_within(ACTIVITY_WINDOW_MS);
    let fetched: std::collections::HashMap<String, i64> = state
        .node_db
        .fetch_all("SELECT root_pubkey, fetched_at_ms FROM foreign_fetches", ())
        .await?
        .into_iter()
        .map(|(r, at): (String, i64)| (r, at))
        .collect();

    let mut by_foreign: std::collections::HashMap<String, RefreshCandidate> =
        std::collections::HashMap::new();
    for (foreign, local, eagerness) in follows {
        if hosted.contains_key(&foreign) {
            continue;
        }
        let fetched_at = fetched.get(&foreign).copied().unwrap_or(0);
        // A persona the last exchange left behind is stale whatever its stamp says
        // (PROJECT_PLAN's Peeks, ruling 2): the wake pass is how a budgeted history keeps arriving. So is
        // one held at PEEK depth that somebody here now dials (ruling 7): the dial is the
        // demand, and the whole mirror is owed on the next beat.
        if now - fetched_at < stale_ms
            && !state.behind.is_behind(&foreign)
            && !state.peeked.is_behind(&foreign)
        {
            continue;
        }
        {
            let marks = FOLLOW_ATTEMPTS.lock().expect("attempt marks poisoned");
            if let Some(at) = marks.as_ref().and_then(|m| m.get(&foreign)) {
                if now - at < cooldown_ms {
                    continue; // recently attempted - let the rest of the list have the cap
                }
            }
        }
        let active = hosted.get(&local).is_some_and(|account| active_accounts.contains(account));
        let entry = by_foreign.entry(foreign.clone()).or_insert(RefreshCandidate {
            foreign,
            active: false,
            eagerness: 0,
            fetched_at,
        });
        entry.active |= active;
        entry.eagerness = entry.eagerness.max(eagerness);
    }
    if by_foreign.is_empty() {
        return Ok(());
    }

    let started: Vec<String> = order_refresh(by_foreign.into_values().collect())
        .into_iter()
        .take(FOLLOW_REFRESH_CAP)
        .collect();
    let n = started.len();
    {
        let mut marks = FOLLOW_ATTEMPTS.lock().expect("attempt marks poisoned");
        let map = marks.get_or_insert_with(Default::default);
        for foreign in &started {
            map.insert(foreign.clone(), now);
        }
    }
    for foreign in started {
        // The revalidate machinery is the whole ladder: dedup against in-flight fetches,
        // stored-tree leaves, the zeroth root rung, last_via.
        spawn_revalidate(&state, foreign, Vec::new());
    }
    tracing::info!(refreshed = n, "follow-refresh pass reached for stale mirrors");
    Ok(())
}

/// The Active leaves of a persona's stored identity chain, hex - candidates for re-fetching
/// it. Empty on any failure: a mirror we can't read just falls back to the explicit hints.
///
/// A mirror we hold NOTHING of has no stored leaves, and says so by existing-check rather
/// than by trusting its callers to have checked: `user_dbs.get` creates on open, so the
/// version that asked the question directly minted an empty database (and WAL, and journal)
/// for every persona it was asked about cold. The doc used to say "callers must hold a
/// reason to believe the mirror exists" - and the wake pass, whose whole job is chasing
/// followed personas we may never have synced, is a caller that structurally cannot. Found
/// 2026-08-08 in the node log: `generated new database encryption key` for a stranger root,
/// thirteen milliseconds before `background revalidation reached nobody`. A precondition a
/// caller cannot satisfy belongs in the callee (STYLE: structural, not disciplinary).
pub(crate) async fn stored_tree_leaves(state: &AppState, root_hex: &str) -> Vec<String> {
    let result: anyhow::Result<Vec<String>> = async {
        let Some(db) = state.user_dbs.get(root_hex).await? else {
            return Ok(Vec::new()); // hold nothing of them, so we know none of their leaves
        };
        let tree = crate::record::imaol::load_key_tree(&db, root_hex).await?;
        Ok(tree
            .members()
            .filter(|(_, status)| *status == ringtome_proto::crown::KeyStatus::Active)
            .map(|(leaf, _)| hex::encode(leaf))
            .collect())
    }
    .await;
    result.unwrap_or_default()
}

#[derive(serde::Serialize)]
pub struct DirectoryRow {
    pub root: String,
    pub speakable: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Hosted here (a neighbor), or merely known here (someone a member once reached).
    pub hosted: bool,
}

/// GET `/api/directory` - the personas this node KNOWS, for its members: a proto-discovery
/// surface, and the first place anywhere that ENUMERATES identities, which is why its rules
/// are consent lines rather than reach:
///
///   - Hosted personas appear only once SERVED. `served_at_ms` is the publication act
///     ("identities are born dark"), and it gates local listing for the same reason it gates
///     the DHT record - a housemate's dark pseudonym must not be volunteered to housemates.
///   - Fetched personas appear because acquaintance is the surface's whole value - but the
///     trail is node-level and anonymous WITHIN the node by construction: `foreign_fetches`
///     has no account column, so a row says "someone here has met them", never who.
///   - Members only. The anonymous face keeps tombstoning everything it already tombstones;
///     a stranger enumerating who this node knows would be reading its members' interests.
///   - Follows are never consulted. A quiet follow is quiet (Edge-Endpoint Visibility), and
///     this list must not be a way to notice one.
///
/// Bylines come from the cache - one query, no database per face (the conventions test pins
/// this surface to zero `user_dbs.get` calls simply by counting).
/// Directory rows served per request - see the cap comment in `directory` for the reasoning.
const DIRECTORY_CAP: usize = 200;

pub async fn directory(
    _session: Session,
    State(state): State<AppState>,
) -> Result<axum::Json<Vec<DirectoryRow>>, AppError> {
    let served: std::collections::BTreeSet<String> =
        crate::identity::served_roots(&state.node_db).await?.into_iter().collect();
    let fetched = fetched_roots(&state.node_db).await.map_err(AppError::Internal)?;
    let mut roots: Vec<String> = served.iter().cloned().collect();
    roots.extend(fetched.into_iter().filter(|r| !served.contains(r)));
    // The directory is a shelf to scan, never an export: capped, hosted-first, BEFORE the
    // byline join so a node fronting tens of thousands of mirrors neither builds a
    // roots-long IN clause nor ships them all. Which fetched personas make the cut is
    // arbitrary past "hosted first", and that is fine for a discovery surface - finding a
    // KNOWN persona is the lookup box's job (and a search endpoint's, the day it exists:
    // NEXT_STEPS, "Search my people / all visible people").
    roots.truncate(DIRECTORY_CAP);

    let bylines =
        crate::profiles::bylines(&state.node_db, &roots).await.map_err(AppError::Internal)?;
    let mut rows: Vec<DirectoryRow> = roots
        .into_iter()
        .filter_map(|root| {
            let raw = crate::pubkey::decode(&root)?;
            let byline = bylines.get(&root).cloned().unwrap_or_default();
            Some(DirectoryRow {
                speakable: speakable::speakable(&raw),
                hosted: served.contains(&root),
                name: byline.name,
                avatar: byline.avatar,
                root,
            })
        })
        .collect();
    // The named before the nameless, each alphabetically - a directory people can scan.
    rows.sort_by(|a, b| match (&a.name, &b.name) {
        (Some(x), Some(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.speakable.cmp(&b.speakable),
    });
    Ok(axum::Json(rows))
}

/// GET `/id/{seg}/docs/{doc}/body` and `/thumb` - a public document's bytes, anonymously.
/// The lane check is the whole gate: `public_head` answers only for POSTS-lane documents, so
/// a private doc_id asked through this door is a 404, never a leak. Bytes are served with
/// the stored format's own Content-Type, nosniff, and ETag revalidation (the blob hash:
/// a different avatar is a different document).
/// `?via=<root>` on the body doors (2026-09-08): where to ask for a post this node does
/// not hold - the sharer whose shelf listed it, as a share card knows. Without a hint the
/// author's own nodes are asked.
#[derive(serde::Deserialize, Default)]
pub struct ViaQuery {
    pub via: Option<String>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn public_doc_bytes(
    state: &AppState,
    session: &Option<Session>,
    seg: &str,
    doc_hex: &str,
    thumb: bool,
    if_none_match: Option<&str>,
    via: Option<&str>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    let doc_id: [u8; 16] =
        hex::decode(doc_hex).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| {
            AppError::NotFound(crate::msg!("idface.no-such-document", "no such document"))
        })?;
    // Two shelves, the author's chain first. Held chain: authoritative, retraction-filtered
    // at `public_head`. No chain: the FRAGMENT ledger (2026-08-14) - a reader whose node
    // learned of this document through a share holds the author's own signed entry and (once
    // healed) its bytes, and this route was the missing door between that store and the
    // reader's own browser. Every reader past the chain rendered "these words haven't reached
    // this computer" forever, under months of green cascade tests that stopped at the
    // database. An anonymous probe for a document held NEITHER way finds nothing rather than
    // minting a place to look: absence is the answer here, and `get` is the verb that can say
    // it.
    //
    // One carve-out to "the chain first" (2026-08-21, found by cascade.cjs the day the
    // speculative pass landed): a chain held ONLY SPECULATIVELY (speculative.rs - no hosting,
    // no member fetch, no follow) has no freshness contract - it is allowed to be hours
    // stale by design - so its silence is ignorance, not retraction, and it must not shadow
    // a fragment a chosen share delivered five seconds ago. For a hunch-held persona the
    // FRAGMENT shelf answers first (explicit beats implicit: the share was asked for), and
    // the mirror serves only what no fragment can. Relationship-held chains keep the
    // authoritative rule unchanged, silence included.
    struct ServeFacts {
        file_hash: [u8; 32],
        thumb_hash: Option<[u8; 32]>,
        format: Option<u64>,
        trusted_only: bool,
        /// Whose seal these bytes wear, as the header says (PROJECT_PLAN's Replies under
        /// the author's seal): absent means this document's own author.
        seal_of: Option<([u8; 32], [u8; 16])>,
        /// The title, sealed under the post key (ruling 5) - handed back beside the words,
        /// to whoever gets the words.
        sealed_title: Option<Vec<u8>>,
    }
    let from_fragments = || async {
        Result::<Option<ServeFacts>, AppError>::Ok(
            crate::fragments::serving_header(&state.node_db, &root_hex, &doc_id)
                .await
                .map_err(AppError::Internal)?
                .map(|h| ServeFacts {
                    file_hash: h.file_hash,
                    thumb_hash: h.thumb_hash,
                    format: h.format,
                    trusted_only: h.trusted_only,
                    seal_of: h.seal_of,
                    sealed_title: h.sealed_title,
                }),
        )
    };
    let facts: Option<ServeFacts> = match state
        .user_dbs
        .get(&root_hex)
        .await
        .map_err(AppError::Internal)?
    {
        Some(db) => {
            let speculative_only = crate::speculative::speculative_only(state, &root_hex)
                .await
                .map_err(AppError::Internal)?;
            // A peek's mirror (PROJECT_PLAN's Peeks, ruling 4) has no posts lane either: its words
            // live on the fragment ledger, so it reads fragment-first like a hunch does.
            // And a peek FOLLOWS THE EYE (ruling 5): a document it never fetched - a
            // page of a shared book, a post past the newest twenty - is asked for by id
            // over the fragment road from the author's own nodes, right now, so the
            // reader who clicked it gets it rather than a shrug.
            let peek = peek_held(state, &root_hex).await;
            let mut fragment_first =
                if speculative_only || peek { from_fragments().await? } else { None };
            if peek {
                touch_look(state, &root_hex).await;
            }
            if peek && fragment_first.is_none() {
                if !peek_room(state, &root_hex).await {
                    return Err(AppError::NotFound(crate::msg!(
                        "idface.this-look-is-full",
                        "this look is full - follow them to keep everything"
                    )));
                }
                crate::fragments::fetch_post(state, &root_hex, &root, &doc_id).await;
                fragment_first = from_fragments().await?;
            }
            // A FOLLOW held from a floor (PROJECT_PLAN's Peeks, ruling 8) may lack an old document
            // too - a pin beneath the floor, a link into deep history: the ledger, then
            // by id over the fragment road. Only while the posts chain HAS a floor: a
            // whole mirror lacking a document lacks it for a reason (retracted,
            // disproven), and must not fetch it back. Never for a persona hosted here.
            // A document the held chain lacks may sit on the shelf: beneath a follow
            // ceiling's floor, or brought by a share or a room (CHAT.md, ruling 11 - a
            // persona held at room depth has no posts chain here at all, and its media
            // twins arrive as fragments under the room's door). The shelf is one read,
            // always taken; the dial for what the shelf lacks stays gated by the floor,
            // so a typo against a followed persona costs no connection.
            if !peek
                && !speculative_only
                && fragment_first.is_none()
                && !hosted_here(state, &root_hex).await.unwrap_or(false)
                && crate::record::documents::public_head(&db, &doc_id).await?.is_none()
            {
                fragment_first = from_fragments().await?;
                if fragment_first.is_none() && posts_floor(state, &root_hex).await > 0 {
                    crate::fragments::fetch_post(state, &root_hex, &root, &doc_id).await;
                    fragment_first = from_fragments().await?;
                }
            }
            match fragment_first {
                Some(facts) => Some(facts),
                None => {
                    // Off the HEADER, not the text-only shelf view: a media twin is
                    // filtered out of `public_doc` by format, which left sealed
                    // pictures serving their ciphertext ungated (caught by the twins
                    // acceptance - 200 of sealed bytes for the untrusted).
                    let (gated, seal_of, sealed_title) =
                        match crate::record::documents::public_header_entry(&db, &doc_id).await? {
                            Some(entry) => match &entry.entry().payload {
                                ringtome_proto::Payload::Inline(payload) => {
                                    ringtome_proto::registry::DocHeaderPlain::decode(payload)
                                        .map(|h| (h.trusted_only, h.seal_of, h.sealed_title))
                                        .unwrap_or((false, None, None))
                                }
                                _ => (false, None, None),
                            },
                            None => (false, None, None),
                        };
                    crate::record::documents::public_head(&db, &doc_id).await?.map(|h| ServeFacts {
                        file_hash: h.file_hash,
                        thumb_hash: h.thumb_hash,
                        format: h.format,
                        trusted_only: gated,
                        seal_of,
                        sealed_title,
                    })
                }
            }
        }
        None => from_fragments().await?,
    };
    // Nothing here has the words and a member is asking: one fetch - from the sharer
    // whose shelf listed it (`?via=`), else the author's own nodes - whichever way the
    // author is held: not at all, as a hunch, as a peek short of this post. A share on a
    // person's page used to read "these words haven't reached this computer" forever
    // (Curtis, 2026-09-08): nothing ever asked for them.
    // "Missing" means "not here yet" only when this node holds the author as a hunch, a
    // peek, or not at all. A whole held mirror without the post means the post is GONE
    // from it - retracted, or disproven by a repudiation - and re-fetching it from the
    // network would resurrect what the chain took back (the repudiation suite caught the
    // first draft doing exactly that).
    let not_here_yet = match state.user_dbs.get(&root_hex).await.map_err(AppError::Internal)? {
        None => true,
        Some(_) => {
            crate::speculative::speculative_only(state, &root_hex).await.unwrap_or(false)
                || peek_held(state, &root_hex).await
        }
    };
    let facts = match facts {
        Some(f) => Some(f),
        // ...or a stranger, for someone a public post here links to (publinks.rs).
        None if (session.is_some() || crate::publinks::linked_publicly_here(state, &root_hex))
            && not_here_yet
            && !hosted_here(state, &root_hex).await.unwrap_or(false) =>
        {
            let origin = via
                .filter(|v| v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()))
                .map(str::to_lowercase)
                .unwrap_or_else(|| root_hex.clone());
            crate::fragments::fetch_post(state, &origin, &root, &doc_id).await;
            from_fragments().await?
        }
        None => None,
    };
    let Some(ServeFacts { file_hash, thumb_hash, format, trusted_only, seal_of, sealed_title }) =
        facts
    else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-public-document-here",
            "no such public document here"
        )));
    };
    // The trusted-readers gate (PROJECT_PLAN's Post visibility slice 2). The BODY is the gated thing; the
    // thumbnail is the post's public face by ruling, with the title and the date. A reader
    // qualifies when any persona on their session is the author, or holds any published
    // trust band on the author's own chain - checked at serve time, so trust published
    // later opens older posts.
    // The thumb exemption died with the twins slice (PROJECT_PLAN's Post visibility): a sealed document's
    // thumbnail is a small copy of the sealed content. A text post's public face - title,
    // date - never had a thumb to lose, and untrusted feeds hide the card anyway.
    // The seal's holder (PROJECT_PLAN's Replies under the author's seal): a reply to a sealed
    // parent wears the parent's seal, so the parent's author's trust is the gate and the
    // parent's key is the key.
    let (holder, key_doc) = seal_holder(&root, &doc_id, seal_of);
    let holder_hex = hex::encode(holder);
    let mut viewer_hex: Option<String> = None;
    if trusted_only {
        viewer_hex =
            trusted_viewer(state, session, &holder_hex, &hex::encode(key_doc), false, via).await?;
        if viewer_hex.is_none() {
            return Err(AppError::Forbidden(crate::msg!(
                "idface.for-trusted-readers-only",
                "the author shares these words only with people they trust"
            )));
        }
    }
    let mut title_header: Option<String> = None;
    let (hash, mime) = if thumb {
        let Some(t) = thumb_hash else {
            return Err(AppError::NotFound(crate::msg!(
                "idface.this-document-has-no-thumbnail",
                "this document has no thumbnail"
            )));
        };
        (t, "image/avif")
    } else {
        (file_hash, crate::record::documents::Format::from_wire(format).mime())
    };
    // The URL names the DOCUMENT (mutable - editing re-publishes new words under the same
    // doc_id); only the blob underneath is content-addressed. This once said `immutable,
    // max-age=1y`, which promised browsers a year of staleness on every edited post - the
    // "my edit isn't visible until refresh" bug (2026-08-06). The honest shape: the blob
    // hash IS content-addressed, so it makes a perfect ETag - an unchanged body costs a
    // 304 and no bytes, an edited one arrives the moment the card asks.
    let etag = format!("\"{}\"", hex::encode(hash));
    let cache = cache_policy(format, trusted_only);
    if if_none_match.is_some_and(|inm| etag_matches(inm, &etag)) {
        return Ok((
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, etag.as_str()), (header::CACHE_CONTROL, cache)],
        )
            .into_response());
    }
    let Some(bytes) = state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(hash))
        .await
        .map_err(AppError::Internal)?
    else {
        // A peek at its ceiling never wanted these bytes (PROJECT_PLAN's Peeks, ruling 6): say so, rather
        // than promising bodies that are not on their way.
        if peek_held(state, &root_hex).await && !peek_room(state, &root_hex).await {
            return Err(AppError::NotFound(crate::msg!(
                "idface.this-look-is-full",
                "this look is full - follow them to keep everything"
            )));
        }
        return Err(AppError::NotFound(crate::msg!(
            "idface.the-bytes-havent-arrived-here",
            "still on its way"
        )));
    };
    // A sealed body opens at the door (PROJECT_PLAN's Post visibility slice 2b): what the store holds and
    // the network spreads is ciphertext; the trusted reader above has earned the words,
    // and the key comes from the memo - or, first time, from whoever serves the author,
    // over the key lane with its own trust check at the far end.
    let bytes = if trusted_only {
        let doc_bytes: [u8; 16] =
            hex::decode(doc_hex).ok().and_then(|b| b.try_into().ok()).expect("checked above");
        // The key for THIS persona (2026-09-14): a grant, or the lane asked for them.
        let key = match viewer_hex.as_deref() {
            Some(v) => key_for(state, &holder_hex, &key_doc, v, via).await,
            None => None,
        };
        let _ = doc_bytes;
        let Some(key) = key else {
            return Err(AppError::NotFound(crate::msg!(
                "idface.the-key-hasnt-arrived",
                "not shared with you"
            )));
        };
        let Some(plain) = crate::record::private::open_post_body(&bytes, &key) else {
            return Err(AppError::Internal(anyhow::anyhow!(
                "a sealed body would not open with its own key"
            )));
        };
        // The title travels with the words (PROJECT_PLAN's Replies under the author's seal,
        // ruling 5): whoever may read the body may read the title, and they are asking for
        // the body right now - so no surface needs a key of its own. Hex, because a header
        // is ASCII and a title is not.
        if let Some(sealed) = &sealed_title {
            if let Some(t) = crate::record::private::open_post_body(sealed, &key) {
                title_header = Some(hex::encode(t));
            }
        }
        // And the labels (ruling 7): a reader proven entitled to the words is entitled to
        // what is said about them - open the raw sealed statements this node holds, once.
        match crate::annotations::open_sealed(
            &state.node_db,
            &hex::encode(root),
            &hex::encode(doc_id),
            &holder_hex,
            &hex::encode(key_doc),
            &key,
        )
        .await
        {
            Ok(opened) if !opened.is_empty() => {
                let touched: Vec<(String, String, String)> = opened
                    .into_iter()
                    .map(|x| (hex::encode(root), hex::encode(doc_id), x))
                    .collect();
                crate::score::labels_moved(state, &touched).await;
            }
            Ok(_) => {}
            Err(e) => tracing::debug!(error = ?e, "opening sealed labels failed"),
        }
        plain
    } else {
        bytes
    };
    let mut response = (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            // Words: no-cache, "keep a copy, ask before using it" - every use revalidates against
            // the ETag, so an edit's staleness is one conditional request. Media: kept (below).
            (header::CACHE_CONTROL, cache),
            (header::ETAG, etag.as_str()),
        ],
        bytes,
    )
        .into_response();
    if let Some(t) = title_header {
        if let Ok(v) = axum::http::HeaderValue::from_str(&t) {
            response.headers_mut().insert(SEALED_TITLE_HEADER, v);
        }
    }
    Ok(response)
}

/// Where a sealed post's title rides back to a reader who may have it: hex-encoded UTF-8,
/// beside the words it belongs to.
pub const SEALED_TITLE_HEADER: axum::http::HeaderName =
    axum::http::HeaderName::from_static("x-post-title-hex");

pub async fn public_body_route(
    State(state): State<AppState>,
    session: Option<Session>,
    headers: axum::http::HeaderMap,
    Path((seg, doc_hex)): Path<(String, String)>,
    axum::extract::Query(q): axum::extract::Query<ViaQuery>,
) -> Result<Response, AppError> {
    let inm = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    public_doc_bytes(&state, &session, &seg, &doc_hex, false, inm, q.via.as_deref()).await
}

/// The decorative-filename twin of the body route: baked embeds mint as
/// `/id/<root>/docs/<doc>/body/media.<ext>` so the renderer's media-kind sniff has an
/// extension to read; the name itself is ignored, exactly like the private twin.
pub async fn public_body_named_route(
    State(state): State<AppState>,
    session: Option<Session>,
    headers: axum::http::HeaderMap,
    Path((seg, doc_hex, _filename)): Path<(String, String, String)>,
    axum::extract::Query(q): axum::extract::Query<ViaQuery>,
) -> Result<Response, AppError> {
    let inm = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    public_doc_bytes(&state, &session, &seg, &doc_hex, false, inm, q.via.as_deref()).await
}

pub async fn public_thumb_route(
    State(state): State<AppState>,
    session: Option<Session>,
    headers: axum::http::HeaderMap,
    Path((seg, doc_hex)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let inm = headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok());
    public_doc_bytes(&state, &session, &seg, &doc_hex, true, inm, None).await
}

/// GET `/api/id/{root}/profile` - the JSON face. Anonymous callers get the shelf rule (hosted
/// -> the public profile; not carried -> 404: only what the HTML face already shows the whole
/// web). A MEMBER asking about an off-shelf root triggers fetch-and-serve: a demand edge in
/// miniature - funnel 2 with a named human - synced at request time, cached with a TTL,
/// ephemeral by design (the anonymous shelf grows only through durable demand; a fetch here
/// never touches the identities table, so the HTML face still tombstones this root).
/// How many posts a page of the public shelf carries. The profile's first page and the
/// "further back" pages are the same size, so the reader's scroll is even.
pub const POSTS_PAGE: i64 = 20;

#[derive(serde::Deserialize)]
pub struct PostsQuery {
    /// The cursor: the `published_ms` and `doc_id` of the last post already shown.
    pub after_ms: Option<i64>,
    pub after_doc: Option<String>,
    /// The viewing persona's root, hex (see `IdQuery::as_root`).
    #[serde(rename = "as")]
    pub as_root: Option<String>,
    /// A search (search.rs, 2026-09-07): the whole held shelf narrowed to the posts whose
    /// words say this, newest first, one deep page and no cursor; shares stand aside.
    pub q: Option<String>,
}

/// Is a post sealed, as this node holds its header - the chain first, the fragment ledger
/// second? `None` when the header is not here at all.
pub(crate) async fn sealed_here(
    state: &AppState,
    author_hex: &str,
    doc_id: &[u8; 16],
) -> Option<bool> {
    held_flags(state, author_hex, doc_id).await.map(|(sealed, _)| sealed)
}

/// Is a post "people I trust, and onward" (Contact tags, ruling 7), as this node holds its
/// header? `None` when the header is not here at all.
pub(crate) async fn onward_here(
    state: &AppState,
    author_hex: &str,
    doc_id: &[u8; 16],
) -> Option<bool> {
    held_flags(state, author_hex, doc_id).await.map(|(_, onward)| onward)
}

/// `(trusted_only, onward)` off the held header - the chain first, the fragment ledger second.
async fn held_flags(state: &AppState, author_hex: &str, doc_id: &[u8; 16]) -> Option<(bool, bool)> {
    if let Ok(Some(db)) = state.user_dbs.get(author_hex).await {
        if let Ok(Some(entry)) = crate::record::documents::public_header_entry(&db, doc_id).await {
            if let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload {
                if let Ok(h) = ringtome_proto::registry::DocHeaderPlain::decode(payload) {
                    return Some((h.trusted_only, h.onward));
                }
            }
        }
    }
    crate::fragments::held_header(&state.node_db, author_hex, &hex::encode(doc_id))
        .await
        .ok()
        .flatten()
        .map(|h| (h.trusted_only, h.onward))
}

/// The onward hop (Contact tags, ruling 7): `sharer` passed `(holder, key_doc)` along, and
/// their own published trust admits `subject`. Judged from the sharer's chains as this node
/// mirrors them - the share on their shares chain, the trust on their identity chain - so
/// a `?via=` hint nobody's record backs admits nobody. Only for a post whose header says
/// onward; a plain sealed post has no hop, and neither the holder nor the subject is a hop.
pub(crate) async fn onward_sharer_admits(
    state: &AppState,
    holder_hex: &str,
    key_doc_hex: &str,
    sharer_hex: &str,
    subject_hex: &str,
) -> bool {
    if sharer_hex == holder_hex || sharer_hex == subject_hex {
        return false;
    }
    let Ok(key_doc) = hex::decode(key_doc_hex).map(|b| <[u8; 16]>::try_from(b.as_slice())) else {
        return false;
    };
    let Ok(key_doc) = key_doc else { return false };
    if onward_here(state, holder_hex, &key_doc).await != Some(true) {
        return false;
    }
    // user-db open 18 of 18 (tests/conventions.rs): the sharer's mirrored chains.
    let Ok(Some(db)) = state.user_dbs.get(sharer_hex).await else { return false };
    let shared = crate::record::imaol::rebroadcasts(&db)
        .await
        .map(|rows| {
            rows.iter().any(|s| {
                s.version_seen.is_some() && s.author_root == holder_hex && s.doc_id == key_doc
            })
        })
        .unwrap_or(false);
    if !shared {
        return false;
    }
    crate::record::imaol::published_edges(&db)
        .await
        .map(|edges| edges.get(subject_hex).is_some_and(|e| e.edge.trust.is_some()))
        .unwrap_or(false)
}

/// The key a statement about `(author, doc)` must be sealed under, when the subject is
/// sealed (ruling 7): `Some((holder, key))` for a sealed post whose key this node holds or
/// can fetch, `None` when the subject is open (label it plainly) - and an error when it is
/// sealed and the key is not to be had: you cannot label words you cannot read. Reads the
/// held header for the seal's holder, the user db first, the fragment store second.
pub(crate) async fn seal_key_for(
    state: &AppState,
    author_hex: &str,
    doc_id: &[u8; 16],
    labeller_hex: &str,
) -> Result<Option<(String, [u8; 32])>, AppError> {
    if sealed_here(state, author_hex, doc_id).await != Some(true) {
        return Ok(None);
    }
    let doc_hex = hex::encode(doc_id);
    let Some(author) = hex::decode(author_hex).ok().and_then(|b| <[u8; 32]>::try_from(b).ok())
    else {
        return Ok(None);
    };
    // user-db open 18 of 18 (tests/conventions.rs): the subject's own header, for whose
    // seal it wears.
    let seal_of = match state.user_dbs.get(author_hex).await {
        Ok(Some(db)) => match crate::record::documents::public_header_entry(&db, doc_id).await? {
            Some(entry) => match &entry.entry().payload {
                ringtome_proto::Payload::Inline(payload) => {
                    ringtome_proto::registry::DocHeaderPlain::decode(payload)
                        .ok()
                        .and_then(|h| h.seal_of)
                }
                _ => None,
            },
            None => None,
        },
        _ => crate::fragments::held_header(&state.node_db, author_hex, &doc_hex)
            .await
            .ok()
            .flatten()
            .and_then(|h| h.seal_of),
    };
    let (holder, key_doc) = seal_holder(&author, doc_id, seal_of);
    let holder_hex = hex::encode(holder);
    let key = key_for(state, &holder_hex, &key_doc, labeller_hex, None).await;
    match key {
        Some(k) => Ok(Some((holder_hex, k))),
        None => Err(AppError::Forbidden(crate::msg!(
            "idface.cant-label-words-you-cant-read",
            "you can't label words you can't read"
        ))),
    }
}

/// Whether an `If-None-Match` names this ETag (RFC 9110 13.1.2, the weak comparison a GET uses): any
/// in a comma-separated list, weak (`W/`) or strong, or `*`. A CDN that compresses a response may
/// hand the browser a weakened ETag, which it then sends back weak - an exact string compare would
/// miss it every time and send the bytes anyway.
pub(crate) fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    let bare = |t: &str| t.trim().trim_start_matches("W/").to_string();
    let ours = bare(etag);
    if_none_match.split(',').any(|t| t.trim() == "*" || bare(t) == ours)
}

/// How long a public document's bytes may be kept (Curtis, 2026-10-02: back from a post, "all of the
/// images slowly reload" - and the node sits behind a CDN). A post's WORDS live at a mutable address:
/// editing re-publishes new words under the same doc, so they revalidate every use (`no-cache` and
/// the content-hash ETag). Its MEDIA never does: every twin, drawing, avatar and banner is minted as
/// a fresh document of one version (`documents::save_public_media`) - a changed picture is a new
/// address, never new bytes at the old one - so media is kept, browsers for a year. A CDN keeps an
/// open one thirty days, not a year, because a takedown cannot reach into a CDN: what it holds it
/// serves until it expires, and thirty days is the bound on that. A SEALED one is `private` - opened
/// for one admitted reader, it is theirs to keep and never a shared cache's.
fn cache_policy(format: Option<u64>, sealed: bool) -> &'static str {
    use crate::record::documents::Format;
    let media = matches!(
        Format::from_wire(format),
        Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus
    );
    match (media, sealed) {
        (true, false) => "public, max-age=31536000, s-maxage=2592000, immutable",
        (true, true) => "private, max-age=31536000, immutable",
        (false, _) => "no-cache",
    }
}

/// Whose seal a sealed document wears (PROJECT_PLAN's Replies under the author's seal): the
/// header SAYS it - `seal_of` names the post whose key seals these bytes and whose author's
/// trust opens them - and absent means this document's own author and id. Stated rather
/// than inferred since 2026-09-09, because a media twin cannot name the post that embeds
/// it: without the statement a picture inside a sealed reply would be gated by the
/// commenter's trust rather than the author's. `(holder author, key document)`.
pub(crate) fn seal_holder(
    author: &[u8; 32],
    doc_id: &[u8; 16],
    seal_of: Option<([u8; 32], [u8; 16])>,
) -> ([u8; 32], [u8; 16]) {
    seal_of.unwrap_or((*author, *doc_id))
}

/// Does the session hold a persona the seal's holder trusts - or the holder themselves?
/// THE seal's question (PROJECT_PLAN's Replies under the author's seal; Contact tags, ruling
/// 4): does the holder of `(holder, key_doc)` admit `subject` to the words? The holder
/// themself, always. A post sealed to an audience - a contact tag the author put on people,
/// known only on the author's own node - admits whoever wears the tag; any other sealed
/// post admits whoever the holder publishes trust for. Every sealed door asks this and
/// nothing else, so an audience is one narrower answer, not a new mechanism. `via` is the
/// sharer a share card named: on a post sealed "people I trust, and onward" (ruling 7)
/// the sharer's own trust admits the subject too - one hop, judged from the sharer's
/// mirrored record.
pub(crate) async fn seal_admits(
    state: &AppState,
    holder_hex: &str,
    key_doc_hex: &str,
    subject_hex: &str,
    via: Option<&str>,
) -> bool {
    if subject_hex == holder_hex {
        return true;
    }
    if let Some(sharer) = via {
        if onward_sharer_admits(state, holder_hex, key_doc_hex, sharer, subject_hex).await {
            return true;
        }
    }
    // Away from the holder's node (2026-09-14) the audience is unknown, and the word is
    // the holder's own: a grant the lane gave this persona says yes; nothing yet falls back
    // to published trust, and the door's fetch for the persona settles it either way.
    if !hosted_here(state, holder_hex).await.unwrap_or(false) {
        if crate::postkeys::granted(&state.node_db, holder_hex, key_doc_hex, subject_hex)
            .await
            .unwrap_or(false)
        {
            return true;
        }
        // A chat for two (CHAT.md, ruling 12) is sealed to one person, whom only the author's
        // node can name - and trust is no stand-in for them (Curtis's first live demo,
        // 2026-10-01: a third person he trusted, on their own node, saw his chat with someone
        // else listed and could open it). Away from the author's node, only the grant the lane
        // gives the one it names admits anybody; the signed header says what kind of room it is.
        if let Some(doc) =
            hex::decode(key_doc_hex).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
        {
            if crate::chat::is_im(state, holder_hex, &doc).await {
                return false;
            }
        }
        return match state.user_dbs.get(holder_hex).await {
            Ok(Some(db)) => crate::record::imaol::published_edges(&db)
                .await
                .map(|edges| edges.get(subject_hex).is_some_and(|e| e.edge.trust.is_some()))
                .unwrap_or(false),
            _ => false,
        };
    }
    match crate::postkeys::audience(&state.node_db, holder_hex, key_doc_hex).await.ok().flatten() {
        Some(tag) => {
            audience_members(state, holder_hex, key_doc_hex, &tag).await.contains(subject_hex)
        }
        None => match state.user_dbs.get(holder_hex).await {
            Ok(Some(db)) => crate::record::imaol::published_edges(&db)
                .await
                .map(|edges| edges.get(subject_hex).is_some_and(|e| e.edge.trust.is_some()))
                .unwrap_or(false),
            _ => false,
        },
    }
}

/// The LISTING's question: `seal_admits`, minus what the holder's node has refused. Away
/// from the holder's node the audience is unknown, and published trust would say yes to a
/// reader the author tagged out; the holder's refusal of the key, remembered for a while,
/// is the word for the shelf, the feed, the thread and the labels (Contact tags, ruling 4).
/// Never for the body door: the door is what asks for the key, and a refusal must not stop
/// it asking again once trust or the audience has changed - a key's arrival clears it.
pub(crate) async fn seal_lists(
    state: &AppState,
    holder_hex: &str,
    key_doc_hex: &str,
    subject_hex: &str,
    via: Option<&str>,
) -> bool {
    if subject_hex != holder_hex
        && crate::postkeys::refused(&state.node_db, holder_hex, key_doc_hex, subject_hex)
            .await
            .unwrap_or(false)
    {
        return false;
    }
    seal_admits(state, holder_hex, key_doc_hex, subject_hex, via).await
}

/// The key for `viewer` to open `(holder, key_doc)`, or None: the holder's own, always; on the
/// holder's own node the memo, for whoever the seal admits; elsewhere the memo only on a grant
/// to this persona, else the lane is asked FOR this persona and grants or refuses (2026-09-14: a
/// node hosts many personas, and a key one fetched is not the others' to use).
///
/// The holder's node used to hand the memo to ANY viewer, on the word that "the gate already
/// judged the viewer" - but callers ask this AS the gate: a room's door falls back to it when the
/// seal says no, and the chats list lists whatever it opens. So at Curtis's first live demo
/// (2026-10-01) a private chat between him and one person, on a node hosting a third he also
/// trusted, was listed for the third, opened, read and spoken in. The seal's own question is
/// asked here now, so no caller can skip it.
pub(crate) async fn key_for(
    state: &AppState,
    holder_hex: &str,
    key_doc: &[u8; 16],
    viewer_hex: &str,
    via: Option<&str>,
) -> Option<[u8; 32]> {
    let key_doc_hex = hex::encode(key_doc);
    let held =
        crate::postkeys::lookup(&state.node_db, holder_hex, &key_doc_hex).await.ok().flatten();
    if viewer_hex == holder_hex {
        return held;
    }
    if hosted_here(state, holder_hex).await.unwrap_or(false) {
        return match seal_admits(state, holder_hex, &key_doc_hex, viewer_hex, via).await {
            true => held,
            false => None,
        };
    }
    if held.is_some()
        && crate::postkeys::granted(&state.node_db, holder_hex, &key_doc_hex, viewer_hex)
            .await
            .unwrap_or(false)
    {
        return held;
    }
    let holder = hex::decode(holder_hex).ok().and_then(|b| <[u8; 32]>::try_from(b).ok())?;
    let viewer = hex::decode(viewer_hex).ok().and_then(|b| <[u8; 32]>::try_from(b).ok())?;
    crate::net::fragment::fetch_key(state, &holder, key_doc, &viewer, via).await
}

/// Everyone the holder has put `tag` on, from the holder's private contact bag - readable
/// only where the holder is hosted, which is the only place an audience is ever judged.
/// The post's own audience (`@mentioned`, Contact tags ruling 5) is the member list noted
/// for that key document instead.
pub(crate) async fn audience_members(
    state: &AppState,
    holder_hex: &str,
    key_doc_hex: &str,
    tag: &str,
) -> std::collections::HashSet<String> {
    let mut out = std::collections::HashSet::new();
    if tag == crate::postkeys::MENTIONED_AUDIENCE {
        out.extend(
            crate::postkeys::members(&state.node_db, holder_hex, key_doc_hex)
                .await
                .unwrap_or_default(),
        );
        return out;
    }
    let Ok(data) = crate::record::store::open_agented(state, holder_hex).await else { return out };
    let Ok(contacts) = data.contacts().await else { return out };
    let want = tag.trim().to_lowercase();
    for (root, facts) in contacts {
        let Some(raw) = facts.get("tags") else { continue };
        let Ok(serde_json::Value::Array(list)) = serde_json::from_str::<serde_json::Value>(raw)
        else {
            continue;
        };
        if list.iter().any(|v| v.as_str().is_some_and(|t| t.trim().to_lowercase() == want)) {
            out.insert(root);
        }
    }
    out
}

/// The viewer's standing with a seal: the first of the session's personas the holder
/// admits, by root - `for_listing` honours a remembered refusal (`seal_lists`), the body
/// door does not.
pub(crate) async fn trusted_viewer(
    state: &AppState,
    session: &Option<Session>,
    holder_hex: &str,
    key_doc_hex: &str,
    for_listing: bool,
    via: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(sess) = session else { return Ok(None) };
    let mine: Vec<String> = crate::identity::list_for_account(&state.node_db, &sess.account.id)
        .await?
        .into_iter()
        .map(|i| i.root_pubkey)
        .collect();
    for r in mine {
        let ok = if for_listing {
            seal_lists(state, holder_hex, key_doc_hex, &r, via).await
        } else {
            seal_admits(state, holder_hex, key_doc_hex, &r, via).await
        };
        if ok {
            return Ok(Some(r));
        }
    }
    Ok(None)
}

/// The feed's sealed-post rule, on the shelf (Curtis, 2026-09-05: a trusted-only post from
/// someone who does not trust you "I shouldn't see ... we just hide that"): drop every
/// trusted-only post unless the viewer is the author or the author publishes trust for
/// them. Checked against the author's own published edges as this node holds them; fails
/// closed when it holds none.
async fn hide_sealed(
    state: &AppState,
    session: &Option<Session>,
    author_hex: &str,
    viewer: Option<&str>,
    posts: &mut Vec<crate::record::documents::PublicDoc>,
) {
    if !posts.iter().any(|p| p.trusted_only) || viewer == Some(author_hex) {
        return;
    }
    if viewer.is_none()
        && session.is_some()
        && hosted_here(state, author_hex).await.unwrap_or(false)
    {
        return;
    }
    let Ok(author) = hex_fixed_root(author_hex) else {
        posts.retain(|p| !p.trusted_only);
        return;
    };
    // Each sealed post through the one gate (`seal_admits`), judged once per (holder,
    // key document): a plain sealed post is its own; a reply under its parent's seal is
    // the parent's. A key this node was refused hides the post too (Contact tags, ruling
    // 4): the author trusts the viewer but sealed the post to an audience they are not in.
    let mut verdicts: std::collections::HashMap<(String, String), bool> = Default::default();
    let mut kept = Vec::with_capacity(posts.len());
    for p in posts.drain(..) {
        if !p.trusted_only {
            kept.push(p);
            continue;
        }
        let reply_to = p.reply_to.as_ref().and_then(|(a, d)| {
            let a = hex::decode(a).ok().and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())?;
            let d = hex::decode(d).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())?;
            Some((a, d))
        });
        let (mut holder, mut key_doc) = (author, p.doc_id);
        if let Some((pa, pd)) = reply_to {
            if sealed_here(state, &hex::encode(pa), &pd).await == Some(true) {
                holder = pa;
                key_doc = pd;
            }
        }
        let at = (hex::encode(holder), hex::encode(key_doc));
        let ok = match (viewer, verdicts.get(&at)) {
            (_, Some(v)) => *v,
            (None, None) => false,
            (Some(v), None) => {
                let admitted = seal_lists(state, &at.0, &at.1, v, None).await;
                verdicts.insert(at.clone(), admitted);
                admitted
            }
        };
        if ok {
            kept.push(p);
        }
    }
    *posts = kept;
}

fn hex_fixed_root(hex_str: &str) -> Result<[u8; 32], ()> {
    hex::decode(hex_str).ok().and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok()).ok_or(())
}

/// GET `/api/id/{root}/posts` - further back down someone's public shelf.
///
/// The shelf rule, same as the profile's: anonymous callers get personas this node HOSTS, and
/// nothing else. A member may page a foreign persona too, but only one this node has already
/// reached - paging is a continuation of a visit, so it reads what an earlier fetch brought
/// home rather than reaching across the network again per page turn.
/// The shelf rule, shared by the paged and single-post reads: anonymous callers get personas
/// this node HOSTS, and nothing else. A member may also read a foreign persona this node has
/// already reached - a visit's continuation, never a fresh reach - and a SPECULATIVELY held
/// one (speculative.rs): the quiet mirror serves nobody over the network, but its own node's
/// members reading it was never serving - that is the whole reason it was pulled.
async fn shelf_readable(
    state: &AppState,
    session: &Option<Session>,
    root_hex: &str,
) -> Result<bool, AppError> {
    if hosted_here(state, root_hex).await? {
        return Ok(true);
    }
    // A stranger reads what a member would, for someone a public post here links to (publinks.rs).
    if session.is_none() && !crate::publinks::linked_publicly_here(state, root_hex) {
        return Ok(false);
    }
    Ok(foreign_fetch_row(state, root_hex).await?.is_some()
        || crate::speculative::fetched_at(&state.node_db, root_hex)
            .await
            .map_err(AppError::Internal)?
            .is_some())
}

/// GET `/api/id/{seg}/labels?as=` - the facets (2026-09-07): every bucket and every tag
/// across the WHOLE shelf this node holds for the persona, with how often each appears,
/// buckets first, over exactly the posts the viewer may see.
pub async fn id_labels(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<PostsQuery>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Result<axum::Json<serde_json::Value>, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-4",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-5",
            "no such persona here"
        )));
    }
    let mut posts = whole_shelf(&state, &root_hex).await;
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut posts).await;
    // The kind row: the posts by their shape, plus every share the persona passed along.
    let shares = match state.user_dbs.get(&root_hex).await.ok().flatten() {
        Some(db) => crate::record::imaol::rebroadcasts(&db)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|s| s.version_seen.is_some())
            .count(),
        None => 0,
    };
    // As the shelf narrows its posts (id_posts), so the facets count them (Curtis, 2026-09-27).
    let candidates: Vec<crate::search::Candidate> = posts
        .iter()
        .map(|p| crate::search::Candidate {
            author_root: root_hex.clone(),
            doc_hex: hex::encode(p.doc_id),
            title: p.title.clone(),
            updated_ms: p.head_ms,
            kind: post_kind(p),
        })
        .collect();
    let narrow = crate::search::Narrow::parse(raw.as_deref(), query.q.as_deref());
    let facets =
        crate::search::facets_json(&state, &candidates, &narrow, query.as_root.as_deref(), shares)
            .await
            .map_err(AppError::Internal)?;
    Ok(axum::Json(facets))
}

/// A shelf post's kind (search.rs KINDS): a book by its format, a reply by its link, a
/// post otherwise; shares are not posts and are counted beside them.
fn post_kind(p: &crate::record::documents::PublicDoc) -> &'static str {
    match crate::record::documents::Format::from_wire(p.format) {
        crate::record::documents::Format::Book => return "book",
        crate::record::documents::Format::Room => return "room",
        _ => {}
    }
    if p.reply_to.is_some() {
        "reply"
    } else {
        "post"
    }
}

/// The whole shelf this node holds for a persona - a peek's fragments or the chain - for
/// the search and the facets; no backfill, no cursor: what is here.
async fn whole_shelf(state: &AppState, root_hex: &str) -> Vec<crate::record::documents::PublicDoc> {
    let hosted_here = crate::identity::is_agented(&state.node_db, root_hex).await.unwrap_or(false);
    let all: Vec<crate::record::documents::PublicDoc> =
        if !hosted_here && peek_held(state, root_hex).await {
            touch_look(state, root_hex).await;
            crate::fragments::shelf_of(&state.node_db, root_hex, 5000).await.unwrap_or_default()
        } else {
            match state.user_dbs.get(root_hex).await.ok().flatten() {
                Some(db) => {
                    crate::record::documents::public_docs(&db, None, 5000).await.unwrap_or_default()
                }
                None => Vec::new(),
            }
        };
    all.into_iter().filter(|p| p.part_of.is_none()).collect()
}

pub async fn id_posts(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<PostsQuery>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-2",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    let missing =
        || AppError::NotFound(crate::msg!("idface.no-such-persona-here-3", "no such persona here"));
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(missing());
    }
    // A cursor that doesn't parse is a bad REQUEST, and says so: answering "no such persona"
    // to a malformed doc_id sends the reader looking for the wrong problem entirely (it did:
    // this was written against a 32-byte id, and document ids are 16).
    let after = match (query.after_ms, query.after_doc.as_deref()) {
        (Some(ms), Some(doc)) => {
            let bad = || {
                AppError::BadRequest(crate::msg!(
                    "idface.that-cursor-isnt-a-document",
                    "that cursor isn't a document id"
                ))
            };
            let raw = hex::decode(doc).map_err(|_| bad())?;
            let id: [u8; 16] = raw.try_into().map_err(|_| bad())?;
            Some((ms, id))
        }
        _ => None,
    };
    // One more than the page, to learn whether there IS a further page without counting the
    // whole shelf - the extra row is the answer and never reaches the reader.
    let dbh = state.user_dbs.get(&root_hex).await.ok().flatten();
    let hosted_here = crate::identity::is_agented(&state.node_db, &root_hex).await.unwrap_or(false);
    let narrow = crate::search::Narrow::parse(raw.as_deref(), query.q.as_deref());
    let searching = !narrow.is_empty();
    let page = if searching { crate::search::RESULTS_CAP as i64 } else { POSTS_PAGE };
    let posts = if searching {
        // The whole shelf, judged by the labels and the index (search.rs).
        let all = whole_shelf(&state, &root_hex).await;
        let candidates: Vec<crate::search::Candidate> = all
            .iter()
            .map(|p| crate::search::Candidate {
                author_root: root_hex.clone(),
                doc_hex: hex::encode(p.doc_id),
                title: p.title.clone(),
                updated_ms: p.head_ms,
                kind: post_kind(p),
            })
            .collect();
        let keep = crate::search::matching(&state, &candidates, &narrow, query.as_root.as_deref())
            .await
            .map_err(AppError::Internal)?;
        all.into_iter().enumerate().filter(|(i, _)| keep.contains(i)).map(|(_, p)| p).collect()
    } else if !hosted_here && peek_held(&state, &root_hex).await {
        touch_look(&state, &root_hex).await;
        // A peek's shelf is the fragment ledger's (PROJECT_PLAN's Peeks, ruling 4): one page, no further.
        if after.is_some() {
            Vec::new()
        } else {
            crate::fragments::shelf_of(&state.node_db, &root_hex, POSTS_PAGE)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|p| p.part_of.is_none())
                .collect()
        }
    } else {
        match &dbh {
            Some(db) => crate::record::documents::public_docs(db, after, POSTS_PAGE + 1)
                .await
                .unwrap_or_default()
                .into_iter()
                // Pages stay off the shelf too (PROJECT_PLAN's Books, ruling 4): the book lists them.
                .filter(|p| p.part_of.is_none())
                .collect(),
            None => Vec::new(), // nothing held, or unreadable: an empty shelf either way
        }
    };
    let mut posts = posts;
    // Scrollback backfills on demand (PROJECT_PLAN's Peeks, ruling 8): a page that came up short on a
    // follow held from a floor asks the author's nodes for what lies beneath, then reads
    // again - the reader paging back is the demand.
    if !searching
        && !hosted_here
        && session.is_some()
        && posts.len() as i64 <= POSTS_PAGE
        && posts_floor(&state, &root_hex).await > 0
        && crate::net::waited(
            "older posts (backfill)",
            &root_hex,
            tokio::time::timeout(std::time::Duration::from_secs(8), backfill(&state, &root_hex)),
            |r| match r {
                Ok(true) => "got some",
                Ok(false) => "nothing more",
                Err(_) => "timed out",
            },
        )
        .await
        .unwrap_or(false)
    {
        if let Some(db) = &dbh {
            posts = crate::record::documents::public_docs(db, after, POSTS_PAGE + 1)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|p| p.part_of.is_none())
                .collect();
        }
    }
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut posts).await;
    // The persona's SHARES join the shelf (Curtis, 2026-09-02: the page defaults to
    // everything - posts, rebroadcasts, replies - and the client's toggles subtract).
    // Same stamp-keyset cursor as the posts, stamped by when they passed it along; a
    // withdrawn pointer is a tombstone and stays off. Titles resolve from the fragment
    // shelf this node's own share machinery keeps - node.db only, no per-author opens.
    let mut shares = match &dbh {
        Some(db) => crate::record::imaol::rebroadcasts(db).await.unwrap_or_default(),
        None => Vec::new(),
    };
    shares.retain(|s| s.version_seen.is_some());
    // Narrowing: words and labels judge posts only, so a share stands aside unless the
    // kind row alone asks for shares (and it is the kind row that can drop them).
    if searching && !(narrow.only_kinds() && narrow.kinds_admit("rebroadcast")) {
        shares.clear();
    }
    if let Some((ms, doc)) = &after {
        let doc_hex = hex::encode(doc);
        shares.retain(|s| {
            s.received_at_ms < *ms || (s.received_at_ms == *ms && hex::encode(s.doc_id) > doc_hex)
        });
    }
    shares.truncate((page + 1) as usize); // the view is already newest-first
    enum Shelf {
        Post(usize),
        Share(usize),
    }
    let mut merged: Vec<(i64, String, Shelf)> = Vec::with_capacity(posts.len() + shares.len());
    for (i, p) in posts.iter().enumerate() {
        // The DISPLAY stamp (PUBLISH.md): a dated post files under its claimed day here as
        // everywhere - the query already ordered by it; the merge must not undo that.
        merged.push((p.display_ms(), hex::encode(p.doc_id), Shelf::Post(i)));
    }
    for (i, s) in shares.iter().enumerate() {
        merged.push((s.received_at_ms, hex::encode(s.doc_id), Shelf::Share(i)));
    }
    merged.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    let more = merged.len() as i64 > page;
    merged.truncate(page as usize);
    // The reply counts, one page-scoped memo read for the whole shelf page.
    let pairs: Vec<(String, String)> =
        posts.iter().map(|p| (root_hex.clone(), hex::encode(p.doc_id))).collect();
    let counts = crate::replies::known_counts(&state.node_db, &pairs).await.unwrap_or_default();
    let mut items: Vec<serde_json::Value> = Vec::with_capacity(merged.len());
    for (_, _, which) in &merged {
        items.push(match which {
            Shelf::Post(i) => {
                let p = &posts[*i];
                let n =
                    counts.get(&(root_hex.clone(), hex::encode(p.doc_id))).copied().unwrap_or(0);
                post_json(p, n)
            }
            Shelf::Share(i) => share_json(&state, &shares[*i], &root_hex).await,
        });
    }
    attach_annotations(&state, &root_hex, &mut items, query.as_root.as_deref()).await;
    // Replies say what they answer (Curtis, 2026-09-02: the list "doesn't make it obvious
    // what the replies are replies to"): dress each reply's parent link with a title and a
    // byline - the author's own shelf for same-shelf parents, the fragment shelf for
    // foreign ones, never a fresh per-author open.
    {
        let mut parents: Vec<(String, String)> = Vec::new();
        for v in items.iter() {
            if let (Some(pa), Some(pd)) =
                (v["reply_to"]["author"].as_str(), v["reply_to"]["doc_id"].as_str())
            {
                parents.push((pa.to_string(), pd.to_string()));
            }
        }
        if !parents.is_empty() {
            let bylines = crate::profiles::bylines(
                &state.node_db,
                &parents.iter().map(|(a, _)| a.clone()).collect::<Vec<_>>(),
            )
            .await
            .unwrap_or_default();
            let mut cards: std::collections::HashMap<
                (String, String),
                (Option<String>, Option<i64>),
            > = Default::default();
            for (pa, pd) in &parents {
                let Some(id) =
                    hex::decode(pd).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
                else {
                    continue;
                };
                // The parent's card: this author's own shelf, any OTHER author's shelf this
                // node holds (the reader's own post, a friend's - Curtis, 2026-09-05: "we
                // know about that post, because it's ours"), then the fragment ledger.
                let resolved: Option<(Option<String>, Option<i64>)> = if *pa == root_hex {
                    match &dbh {
                        Some(db) => crate::record::documents::public_doc(db, &id)
                            .await
                            .ok()
                            .flatten()
                            .map(|d| (Some(d.title), Some(d.genesis_ms))),
                        None => None,
                    }
                } else {
                    let held = match state.user_dbs.get(pa).await {
                        Ok(Some(db)) => crate::record::documents::public_doc(&db, &id)
                            .await
                            .ok()
                            .flatten()
                            .map(|d| (Some(d.title), Some(d.genesis_ms))),
                        _ => None,
                    };
                    match held {
                        Some(card) => Some(card),
                        None => crate::fragments::serving_header(&state.node_db, pa, &id)
                            .await
                            .ok()
                            .flatten()
                            .map(|h| (Some(h.title), None)),
                    }
                };
                if let Some((title, ms)) = resolved {
                    cards.insert((pa.clone(), pd.clone()), (title, ms));
                }
            }
            for v in items.iter_mut() {
                let (Some(pa), Some(pd)) = (
                    v["reply_to"]["author"].as_str().map(String::from),
                    v["reply_to"]["doc_id"].as_str().map(String::from),
                ) else {
                    continue;
                };
                let (title, ms) =
                    cards.get(&(pa.clone(), pd.clone())).cloned().unwrap_or((None, None));
                v["reply_to"] = serde_json::json!({
                    "author": pa,
                    "doc_id": pd,
                    "name": bylines.get(&pa).and_then(|b| b.name.clone()),
                    "title": title,
                    "published_ms": ms,
                });
            }
        }
    }
    Ok(axum::Json(serde_json::json!({
        "posts": items,
        "more": more,
    }))
    .into_response())
}

/// Attach every known label to a page of post JSON (PROJECT_PLAN's Public annotations, slice 2's read, on the
/// two surfaces that missed it): one page-scoped memo read, bylines for the annotators,
/// the author's own labels first. The reader's display register filters at the client.
async fn attach_annotations(
    state: &AppState,
    root_hex: &str,
    posts: &mut [serde_json::Value],
    viewer: Option<&str>,
) {
    // The author's own shelf names the list a sealed post is for (Contact tags, ruling 4).
    if viewer == Some(root_hex) {
        for v in posts.iter_mut() {
            if v["trusted_only"].as_bool() != Some(true) {
                continue;
            }
            let Some(doc) = v["doc_id"].as_str().map(str::to_string) else { continue };
            if let Ok(Some(tag)) = crate::postkeys::audience(&state.node_db, root_hex, &doc).await {
                v["audience"] = serde_json::Value::String(tag);
            }
        }
    }
    let pairs: Vec<(String, String)> = posts
        .iter()
        .filter_map(|v| v["doc_id"].as_str().map(|d| (root_hex.to_string(), d.to_string())))
        .collect();
    let Ok(known) = crate::annotations::for_posts(state, &pairs, viewer).await else {
        return;
    };
    if known.is_empty() {
        return;
    }
    let annotators: Vec<String> = known.values().flatten().map(|a| a.annotator.clone()).collect();
    let bylines = crate::profiles::bylines(&state.node_db, &annotators).await.unwrap_or_default();
    for v in posts.iter_mut() {
        let Some(doc) = v["doc_id"].as_str().map(String::from) else {
            continue;
        };
        let Some(list) = known.get(&(root_hex.to_string(), doc)) else {
            continue;
        };
        v["annotations"] = serde_json::json!(list
            .iter()
            .map(|a| serde_json::json!({
                "annotator_name": bylines.get(&a.annotator).and_then(|b| b.name.clone()),
                "annotator": a.annotator,
                "key": a.key,
                "value": a.value,
            }))
            .collect::<Vec<_>>());
    }
}

/// One post, as every surface reports it. `replies` is the honest-partial count from
/// this node's memo (`replies::known_counts`) - absent when zero, so a surface that knows
/// nothing renders exactly as before.
fn post_json(p: &crate::record::documents::PublicDoc, replies: i64) -> serde_json::Value {
    let link = |l: &Option<(String, String)>| {
        l.as_ref().map(|(author, doc)| serde_json::json!({ "author": author, "doc_id": doc }))
    };
    serde_json::json!({
        "settled": if p.settled { Some(true) } else { None },
        "trusted_only": if p.trusted_only { Some(true) } else { None },
        "onward": if p.onward { Some(true) } else { None },
        "replies": if replies > 0 { Some(replies) } else { None },
        "reply_to": link(&p.reply_to),
        "thread_root": link(&p.thread_root),
        "doc_id": hex::encode(p.doc_id),
        "title": p.title,
        "format": crate::record::documents::Format::from_wire(p.format).as_str(),
        // When it was first said - what it is dated by and sorted by. A re-publication
        // improves a post; it does not make a new one, and does not move it.
        "published_ms": p.display_ms(),
        // The preferred date when one was claimed, and the mint moment beside it - the dossier's
        // honest "when it was actually said", and what `updated_ms` is compared with to say
        // "edited" (2026-10-02).
        "dated_ms": p.dated_ms,
        "minted_ms": p.genesis_ms,
        // The book this is a page of (PROJECT_PLAN's Books), when it is one.
        "part_of": p.part_of.map(hex::encode),
        "updated_ms": p.head_ms,
        "thumb": p.thumb_hash.map(hex::encode),
    })
}

/// GET `/api/id/{root}/from/{doc}` - which public post a document of theirs became (2026-09-28,
/// PROJECT_PLAN's "`/ringtome/` replaces `/home`, `/in` and `/id`", slice 3): `{ "post": <hex> }`
/// from the author's own `published_from` label, or the same 404 for a document that is still
/// private and one that never was - which of those is exactly what a stranger must not learn.
pub async fn id_from(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
) -> Result<axum::Json<serde_json::Value>, AppError> {
    let private = || {
        AppError::NotFound(crate::msg!(
            "idface.that-document-is-private",
            "that document is private"
        ))
    };
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(private());
    };
    let root_hex = hex::encode(root);
    if doc.len() != 32
        || !doc.chars().all(|c| c.is_ascii_hexdigit())
        || !shelf_readable(&state, &session, &root_hex).await?
    {
        return Err(private());
    }
    match crate::annotations::published_from(&state.node_db, &root_hex, &doc.to_ascii_lowercase())
        .await
        .map_err(AppError::Internal)?
    {
        Some(post) => Ok(axum::Json(serde_json::json!({ "post": post }))),
        None => Err(private()),
    }
}

/// GET `/api/id/{root}/posts/{doc}` - one post, by id: the permalink's read (2026-08-25).
/// The same shelf rule as the page, and the same honest 404 for never-was, private, and
/// taken-down alike - a post that is not on the public shelf is not a post here.
/// GET `/api/id/{seg}/posts/{doc}/versions` - a post's history (Curtis, 2026-10-02: posts edit
/// forever, and an edited one says so - "edited {date}" - and opens to every version it has been).
/// Newest first: each version's moment, title and words, or `held: false` where this node no longer
/// has the words. A sealed post answers its reader as the body door does - every version wears the
/// post's one key - and nobody else. Answered where the author's chain is held; a node holding only
/// a copy has one version, and says not found rather than a history of one.
pub async fn id_post_versions(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<IdQuery>,
) -> Result<axum::Json<serde_json::Value>, AppError> {
    let missing =
        || AppError::NotFound(crate::msg!("idface.no-such-post-here-3", "no such post here"));
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else { return Err(missing()) };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(missing());
    }
    let doc_id: [u8; 16] =
        hex::decode(&doc).ok().and_then(|b| b.try_into().ok()).ok_or_else(missing)?;
    let Ok(Some(db)) = state.user_dbs.get(&root_hex).await else { return Err(missing()) };
    let Some(versions) = crate::record::documents::public_versions(&db, &doc_id).await? else {
        return Err(missing());
    };
    let Some(head) = versions.first() else { return Err(missing()) };
    // The seal: one key for every version, judged on the newest header as the body door judges it.
    let key = if head.header.trusted_only {
        let (holder, key_doc) = seal_holder(&root, &doc_id, head.header.seal_of);
        let holder_hex = hex::encode(holder);
        let viewer = trusted_viewer(
            &state,
            &session,
            &holder_hex,
            &hex::encode(key_doc),
            false,
            query.via.as_deref(),
        )
        .await?;
        let key = match viewer.as_deref() {
            Some(v) => key_for(&state, &holder_hex, &key_doc, v, query.via.as_deref()).await,
            None => None,
        };
        let Some(key) = key else {
            return Err(AppError::Forbidden(crate::msg!(
                "idface.for-trusted-readers-only-2",
                "the author shares these words only with people they trust"
            )));
        };
        Some(key)
    } else {
        None
    };
    let mut out = Vec::with_capacity(versions.len());
    for v in versions.iter().take(200) {
        let words =
            if crate::record::documents::Format::from_wire(v.header.format).is_mergeable_text() {
                let bytes = state
                    .files
                    .get_public(iroh_blobs::Hash::from_bytes(v.header.file_hash))
                    .await
                    .ok()
                    .flatten();
                let plain = match (bytes, key) {
                    (Some(b), Some(k)) => crate::record::private::open_post_body(&b, &k),
                    (Some(b), None) => Some(b),
                    (None, _) => None,
                };
                plain.map(|b| String::from_utf8_lossy(&b).into_owned())
            } else {
                None
            };
        let title = match (&v.header.sealed_title, key) {
            (Some(sealed), Some(k)) => crate::record::private::open_post_body(sealed, &k)
                .map(|t| String::from_utf8_lossy(&t).into_owned())
                .unwrap_or_default(),
            _ => v.header.title.clone(),
        };
        out.push(serde_json::json!({
            "version": hex::encode(v.hash),
            "at_ms": v.timestamp_ms,
            "title": title,
            "format": crate::record::documents::Format::from_wire(v.header.format).as_str(),
            "held": words.is_some(),
            "words": words,
        }));
    }
    Ok(axum::Json(serde_json::json!({ "versions": out })))
}

pub async fn id_post(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<IdQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-8",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-9",
            "no such persona here"
        )));
    }
    let doc_id: [u8; 16] =
        hex::decode(&doc).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "idface.that-isnt-a-document-id",
                "that isn't a document id"
            ))
        })?;
    // A post this node holds a COPY of, opened (2026-10-02): past its fresh day nothing keeps the
    // copy current, so the visit asks the author - in the background, whichever road answers this
    // read below; the feed's cards read the copy, and the next look at them sees what is current.
    if crate::fragments::held(&state.node_db, &root_hex, &doc).await.ok().flatten().is_some() {
        crate::fragments::refresh_on_visit(&state, &root_hex, &doc);
    }
    let db_for_labels = match state.user_dbs.get(&root_hex).await {
        Ok(Some(db)) => db,
        _ => {
            return Err(AppError::NotFound(crate::msg!(
                "idface.no-such-post-here-2",
                "no such post here"
            )));
        }
    };
    let mut post = crate::record::documents::public_doc(&db_for_labels, &doc_id).await?;
    // A peek's permalink (PROJECT_PLAN's Peeks, ruling 4 and 5): the mirror has no posts lane, so the
    // fragment ledger answers - fetched by id right now if the peek never held it.
    let mut fragment_refs: Option<Vec<[u8; 16]>> = None;
    let peek_here = peek_held(&state, &root_hex).await;
    // A peek's permalink, or a follow's beneath its floor - never a whole mirror's missing
    // document, which is missing for a reason (retracted, disproven).
    let beneath_floor = !peek_here
        && !hosted_here(&state, &root_hex).await.unwrap_or(false)
        && posts_floor(&state, &root_hex).await > 0;
    if post.is_none() && (peek_here || beneath_floor) {
        if peek_here {
            touch_look(&state, &root_hex).await;
        }
        // A peek's permalink, or a follow's beneath its floor (PROJECT_PLAN's Peeks, ruling 4, 8, 13):
        // the ledger answers, fetched by id right now if it never held the document.
        if crate::fragments::held(&state.node_db, &root_hex, &doc).await.ok().flatten().is_none()
            && (!peek_here || peek_room(&state, &root_hex).await)
        {
            crate::fragments::fetch_post(&state, &root_hex, &root, &doc_id).await;
        }
        if let Some((p, refs)) = crate::fragments::public_doc_of(&state.node_db, &root_hex, &doc)
            .await
            .map_err(AppError::Internal)?
        {
            fragment_refs = Some(refs);
            post = Some(p);
        }
    }
    match post {
        Some(p) => {
            let n = crate::replies::known_counts(
                &state.node_db,
                &[(root_hex.clone(), hex::encode(p.doc_id))],
            )
            .await
            .unwrap_or_default()
            .values()
            .copied()
            .next()
            .unwrap_or(0);
            // The author's own public annotations ride the permalink read (PROJECT_PLAN's Public annotations
            // slice 1) - from the author's shelf, so a mirror-holding node answers too.
            let mut v = post_json(&p, n);
            // The refs are public facts (they ride the signed header and every fragment);
            // naming them here lets a reader's renderer - and the twins acceptance - ask
            // for exactly the documents the post embeds.
            if let Some(refs) = &fragment_refs {
                v["refs"] = serde_json::json!(refs.iter().map(hex::encode).collect::<Vec<_>>());
            } else if let Ok(Some(entry)) =
                crate::record::documents::public_header_entry(&db_for_labels, &doc_id).await
            {
                if let ringtome_proto::Payload::Inline(payload) = &entry.entry().payload {
                    if let Ok(h) = ringtome_proto::registry::DocHeaderPlain::decode(payload) {
                        v["refs"] =
                            serde_json::json!(h.refs.iter().map(hex::encode).collect::<Vec<_>>());
                    }
                }
            }
            // The author's own statements straight off their shelf (read-your-writes for a
            // fresh publish), merged with everything the memo knows - others' labels with
            // their annotator (PROJECT_PLAN's Public annotations, slice 2). Names ride from the byline cache.
            let doc_hex = hex::encode(p.doc_id);
            let mut labels: Vec<(String, String, String)> = Vec::new();
            if let Ok(rows) =
                crate::record::imaol::annotations_of(&db_for_labels, &root_hex, &p.doc_id).await
            {
                // A sealed statement is ciphertext on the chain (ruling 7): never a chip -
                // the memo below carries it opened, for whoever may see it.
                labels.extend(
                    rows.into_iter()
                        .filter(|r| r.key != crate::annotations::SEALED_KEY)
                        .map(|r| (root_hex.clone(), r.key, r.value)),
                );
            }
            if let Ok(known) = crate::annotations::for_posts(
                &state,
                &[(root_hex.clone(), doc_hex.clone())],
                query.as_root.as_deref(),
            )
            .await
            {
                for a in known.into_values().flatten() {
                    let row = (a.annotator, a.key, a.value);
                    if !labels.contains(&row) {
                        labels.push(row);
                    }
                }
            }
            let annotators: Vec<String> = labels.iter().map(|(a, _, _)| a.clone()).collect();
            let bylines =
                crate::profiles::bylines(&state.node_db, &annotators).await.unwrap_or_default();
            v["annotations"] = serde_json::json!(labels
                .into_iter()
                .map(|(annotator, key, value)| serde_json::json!({
                    "annotator_name": bylines.get(&annotator).and_then(|b| b.name.clone()),
                    "annotator": annotator,
                    "key": key,
                    "value": value,
                }))
                .collect::<Vec<_>>());
            Ok(axum::Json(v).into_response())
        }
        None => {
            Err(AppError::NotFound(crate::msg!("idface.no-such-post-here", "no such post here")))
        }
    }
}

/// GET `/api/id/{root}/posts/{doc}/replies` - one page of the post's DIRECT replies as
/// this node knows them (PROJECT_PLAN's Replies slice 2: assembly is honest-partial, and the copy
/// says "replies known here"). Same shelf rule as the post itself; keyset by
/// (claimed_ms, reply_doc), oldest first.
pub async fn id_post_replies(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
    axum::extract::Query(query): axum::extract::Query<RepliesQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-10",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-11",
            "no such persona here"
        )));
    }
    if hex::decode(&doc).map(|b| b.len()) != Ok(16) {
        return Err(AppError::BadRequest(crate::msg!(
            "idface.that-isnt-a-document-id-2",
            "that isn't a document id"
        )));
    }
    let after = match (query.after_ms, query.after_doc) {
        (Some(ms), Some(d)) => Some((ms, d)),
        _ => None,
    };
    // A settled parent's thread door is shut (PROJECT_PLAN's Post visibility): a node that can see the
    // header serves no replies and does not go asking for more.
    if let Ok(Some(db)) = state.user_dbs.get(&root_hex).await {
        if let Ok(doc_bytes) = hex::decode(&doc) {
            if let Ok(doc_id) = <[u8; 16]>::try_from(doc_bytes.as_slice()) {
                if let Ok(Some(p)) = crate::record::documents::public_doc(&db, &doc_id).await {
                    if p.settled {
                        return Ok(axum::Json(serde_json::json!({
                            "replies": [], "more": false, "seeking": false, "settled": true,
                        }))
                        .into_response());
                    }
                }
            }
        }
    }
    // A sealed post's conversation is under the same seal (PROJECT_PLAN's Replies under the
    // author's seal): a reader the author does not trust sees no replies at all, rather
    // than a thread of hollow cards.
    if let Ok(Ok(doc_id)) = hex::decode(&doc).map(|b| <[u8; 16]>::try_from(b.as_slice())) {
        if sealed_here(&state, &root_hex, &doc_id).await == Some(true)
            && trusted_viewer(&state, &session, &root_hex, &doc, true, None).await?.is_none()
        {
            return Ok(axum::Json(serde_json::json!({
                "replies": [], "more": false, "seeking": false, "sealed": true,
            }))
            .into_response());
        }
    }
    // A level whole (2026-09-28), unless a caller pages it by cursor as the API always allowed.
    let (mut replies, more) = match after {
        None => crate::replies::replies_level(&state.node_db, &root_hex, &doc).await,
        Some(after) => {
            crate::replies::replies_of(&state.node_db, &root_hex, &doc, Some(after)).await
        }
    }
    .map_err(AppError::Internal)?;

    // Curation is the same bit as display (PROJECT_PLAN's Replies slice 6): when the post's author
    // lives HERE, this public read speaks with the author's own voice, so it holds back
    // exactly what the door would - a stranger's reply waits for the nod, a suppressed one
    // stays quiet. The author's own view (session-owned, routes.rs) sees everything,
    // pending marked; other nodes' memos only ever learned what some door already served.
    let hosted = hosted_here(&state, &root_hex).await?;
    if hosted {
        let mut served = Vec::with_capacity(replies.len());
        for r in replies {
            if crate::replies::servable(&state, &root_hex, &r.author, &r.doc_id).await {
                served.push(r);
            }
        }
        replies = served;
    }

    // The reading side (slice 6): visiting the permalink IS the demand. For a foreign
    // author, ask their door behind this render - budget-capped by the cursor table's
    // cooldown, `refresh=1` the human's deliberate re-ask - and say so, so the UI can show
    // its quiet "looking for more of the conversation" and look again.
    let mut seeking = false;
    if !hosted && session.is_some() {
        let force = query.refresh.unwrap_or(0) != 0;
        if let Some(since) =
            crate::replies::should_ask(&state.node_db, &root_hex, &doc, force).await
        {
            seeking = true;
            let state = state.clone();
            let (author_hex, doc_hex) = (root_hex.clone(), doc.clone());
            tokio::spawn(async move {
                let Ok(doc_bytes) = hex::decode(&doc_hex) else { return };
                let Ok(doc_id) = <[u8; 16]>::try_from(doc_bytes.as_slice()) else { return };
                if let Some((verified, cursor)) =
                    crate::net::fragment::fetch_replies(&state, &root, &doc_id, since).await
                {
                    crate::replies::learn(&state, &author_hex, &doc_hex, verified).await;
                    let _ =
                        crate::replies::record_ask(&state.node_db, &author_hex, &doc_hex, cursor)
                            .await;
                }
            });
        }
    }
    // Hot or best (slice 3): the siblings ordered by the viewer's own scores - only for a signed-in
    // viewer asking as a persona of theirs, since the scores are that persona's dials read aloud.
    if let (Some(order @ ("hot" | "best")), Some(sess), Some(viewer)) =
        (query.sort.as_deref(), &session, query.as_root.as_deref())
    {
        if let Ok(data) = crate::record::store::open(&state, &sess.account.id, viewer).await {
            let facts: crate::selectivity::Facts = data.contacts().await?.into_iter().collect();
            crate::score::refresh_dials(&state, viewer, &facts)
                .await
                .map_err(AppError::Internal)?;
            let pairs: Vec<(String, String)> =
                replies.iter().map(|r| (r.author.clone(), r.doc_id.clone())).collect();
            let scores = crate::score::stored_for(&state.node_db, viewer, &pairs)
                .await
                .map_err(AppError::Internal)?;
            let milli = |r: &crate::replies::KnownReply| {
                scores.get(&(r.author.clone(), r.doc_id.clone())).copied().unwrap_or(0)
            };
            if order == "hot" {
                // Each at its time plus an hour a like, the hottest first.
                replies.sort_by_key(|r| {
                    std::cmp::Reverse((
                        crate::score::hot_of(r.claimed_ms, milli(r)),
                        r.doc_id.clone(),
                    ))
                });
            } else {
                // The best first; among equals, the conversation's own order.
                replies
                    .sort_by_key(|r| (std::cmp::Reverse(milli(r)), r.claimed_ms, r.doc_id.clone()));
            }
        }
    }
    // The repliers' bylines ride the answer (Curtis, 2026-09-05: a trusted-but-unread
    // replier rendered as their speakable words): the page's own mirror knows only the
    // people the reader follows, and this node knows everyone it holds.
    let authors: Vec<String> = replies
        .iter()
        .map(|r| r.author.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let bylines: serde_json::Map<String, serde_json::Value> =
        crate::profiles::bylines_healed(&state, &authors)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(root, b)| (root, serde_json::json!({ "name": b.name, "avatar": b.avatar })))
            .collect();
    Ok(axum::Json(serde_json::json!({ "replies": replies, "more": more, "seeking": seeking, "bylines": bylines }))
        .into_response())
}

/// GET `/api/id/{root}/posts/{doc}/dossier` - the post's forensic ledger (Curtis,
/// 2026-08-31): everything THIS node knows about the post, its replies and its labels, and
/// crucially, which ROAD taught the node each fact. Every statement in the network is
/// signed, but carriage was anonymous; a reader who feels harassed reads this to
/// reverse-engineer the peer that has been rubber-stamping the traffic in. Deliberately
/// dense and unpolished: it is a log, not a page.
pub async fn id_post_dossier(
    session: Option<Session>,
    State(state): State<AppState>,
    Path((seg, doc)): Path<(String, String)>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-12",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    if !shelf_readable(&state, &session, &root_hex).await? {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-13",
            "no such persona here"
        )));
    }
    if hex::decode(&doc).map(|b| b.len()) != Ok(16) {
        return Err(AppError::BadRequest(crate::msg!(
            "idface.that-isnt-a-document-id-3",
            "that isn't a document id"
        )));
    }
    let hosted = hosted_here(&state, &root_hex).await?;

    // The post's own shelf facts, when a shelf here holds it.
    let mut post_v = serde_json::Value::Null;
    let doc_id: [u8; 16] =
        hex::decode(&doc).ok().and_then(|b| b.try_into().ok()).expect("length-checked above");
    if let Ok(Some(db)) = state.user_dbs.get(&root_hex).await {
        if let Ok(Some(p)) = crate::record::documents::public_doc(&db, &doc_id).await {
            post_v = post_json(&p, 0);
        }
    }

    // Every reply row the memo holds for this post - the owning module's ledger read - and
    // (when the author lives here) the door's verdict per row.
    let rows = crate::replies::ledger_for(&state.node_db, &root_hex, &doc)
        .await
        .map_err(AppError::Internal)?;
    let mut replies = Vec::with_capacity(rows.len());
    for (author, rdoc, direct, claimed_ms, noted_ms, learned_via) in rows {
        let served = if hosted {
            Some(crate::replies::servable(&state, &root_hex, &author, &rdoc).await)
        } else {
            None
        };
        replies.push(serde_json::json!({
            "author": author,
            "doc_id": rdoc,
            "direct": direct,
            "claimed_ms": claimed_ms,
            "noted_ms": noted_ms,
            "learned_via": learned_via,
            "served": served,
        }));
    }

    // Every label the memo holds, its road, and whether the proof is kept servable onward
    // (a kept proof means this node RELAYS it - carriage, named).
    let (labels, kept) = crate::annotations::ledger_for(&state.node_db, &root_hex, &doc)
        .await
        .map_err(AppError::Internal)?;

    let mut names: Vec<String> = labels.iter().map(|(a, ..)| a.clone()).collect();
    names.extend(replies.iter().filter_map(|r| r["author"].as_str().map(String::from)));
    let bylines = crate::profiles::bylines_healed(&state, &names).await.unwrap_or_default();

    let annotations: Vec<serde_json::Value> = labels
        .into_iter()
        .map(|(annotator, key, value, noted_ms, learned_via)| {
            serde_json::json!({
                "annotator_name": bylines.get(&annotator).and_then(|b| b.name.clone()),
                "proof_kept": kept.contains(&(annotator.clone(), key.clone(), value.clone())),
                "annotator": annotator,
                "key": key,
                "value": value,
                "noted_ms": noted_ms,
                "learned_via": learned_via,
            })
        })
        .collect();
    let reply_names: serde_json::Value = serde_json::json!(replies
        .iter()
        .filter_map(|r| r["author"].as_str())
        .filter_map(|a| bylines.get(a).and_then(|b| b.name.clone()).map(|n| (a.to_string(), n)))
        .collect::<std::collections::BTreeMap<String, String>>());

    Ok(axum::Json(serde_json::json!({
        "hosted": hosted,
        "post": post_v,
        "replies": replies,
        "reply_names": reply_names,
        "annotations": annotations,
    }))
    .into_response())
}

#[derive(serde::Deserialize)]
pub struct RepliesQuery {
    pub after_ms: Option<i64>,
    pub after_doc: Option<String>,
    /// The refresh affordance: a human asking the author's door again on purpose.
    pub refresh: Option<u8>,
    /// The level's order (PROJECT_PLAN's Scores and sort orders, slice 3): `hot` or `best` for a
    /// signed-in viewer asking `as` a persona of theirs - the scores are that persona's; oldest
    /// first otherwise, and by default.
    pub sort: Option<String>,
    #[serde(rename = "as")]
    pub as_root: Option<String>,
}

pub async fn id_profile(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<IdQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound(crate::msg!(
            "idface.no-such-persona-here-4",
            "no such persona here"
        )));
    };
    let root_hex = hex::encode(root);
    let hosted = hosted_here(&state, &root_hex).await?;

    // Whether a refresh is running behind this response, so the caller knows to look again, and
    // when this node last successfully reached them. Both are honest only for a FOREIGN
    // persona: one we host has no "last synced" - its words are written here.
    let mut refreshing = false;
    let mut synced_ms: Option<i64> = None;
    if !hosted {
        // A member, or a stranger following a link a public post here makes (publinks.rs - the
        // public post vouches: "if something is on our node it's because someone we trust put
        // it there"). Either is fetched for, and served stale while revalidating.
        if session.is_none() && !crate::publinks::linked_publicly_here(&state, &root_hex) {
            return Err(AppError::NotFound(crate::msg!(
                "idface.no-such-persona-here-5",
                "no such persona here"
            )));
        }
        let now = crate::clock::now_ms();
        let row = foreign_fetch_row(&state, &root_hex).await?;
        // Candidates: the address's own hints first, then the endpoint that answered last time
        // (the durable half of the ladder - it works even when the URL was typed bare, and it
        // is what keeps a quiet identity reachable after every friendly node has rebooted).
        let mut via: Vec<String> = query
            .via
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        if let Some((_, Some(last))) = &row {
            if !via.contains(last) {
                via.push(last.clone());
            }
        }
        // A speculative mirror (speculative.rs) may hold them even when no member ever asked.
        let speculative_at = crate::speculative::fetched_at(&state.node_db, &root_hex)
            .await
            .map_err(AppError::Internal)?;
        match &row {
            // Held by the quiet pull: serve what it brought home, exactly like a member
            // fetch. No revalidation spawns here - freshness for speculative content is the
            // acquisition pass's own slow beat, at lower priority than real follows
            // (PROJECT_PLAN's Discovery), and a page view must not promote a hunch into a dial loop.
            None if speculative_at.is_some() => {
                synced_ms = speculative_at;
            }
            // Nothing held: there is nothing to serve stale, so this one waits. A first visit
            // to a stranger is the only case that pays the network's latency.
            None => {
                synced_ms = Some(now); // this request IS the sync; saying so beats saying nothing
                if !fetch_foreign(&state, &root_hex, &via).await {
                    return Err(AppError::NotFound(crate::msg!(
                        "idface.not-carried-here-and-none",
                        "not carried here, and none of the address's computers answered"
                    )));
                }
                // A peek's shelf is still landing behind this answer: say so, and the page
                // keeps asking until it has arrived.
                refreshing = state.refreshing.lock().unwrap().contains(&root_hex);
            }
            // Something held: answer NOW and revalidate behind it. A visit is the demand
            // signal the pull model is built on, so it always means "go and look" - but the
            // reader should not wait on a stranger's node to find that out.
            Some((at, _)) => {
                synced_ms = Some(*at);
                if now - at >= foreign_revalidate_ms() {
                    refreshing = spawn_revalidate(&state, root_hex.clone(), via);
                }
                refreshing = refreshing || state.refreshing.lock().unwrap().contains(&root_hex);
            }
        }
    }

    let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
    // What they have PUBLISHED - the public lane's documents, newest first. Keyless and
    // lane-checked like everything on this surface; a private note cannot appear here
    // because the query cannot name one.
    // A PEEK (PROJECT_PLAN's Peeks, ruling 4) holds no posts chain: its shelf is the fragment ledger's -
    // the newest posts the peek fetched, each the author's own signed header.
    let peek = !hosted && peek_held(&state, &root_hex).await;
    let mut peek_full = false;
    if peek {
        touch_look(&state, &root_hex).await;
        peek_full = !peek_room(&state, &root_hex).await;
    }
    let mut posts: Vec<crate::record::documents::PublicDoc> = if peek {
        crate::fragments::shelf_of(&state.node_db, &root_hex, POSTS_PAGE)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.part_of.is_none())
            .collect()
    } else {
        match state.user_dbs.get(&root_hex).await {
            Ok(Some(db)) => crate::record::documents::public_docs(&db, None, POSTS_PAGE + 1)
                .await
                .unwrap_or_default()
                .into_iter()
                // Pages stay off this shelf as off the other (PROJECT_PLAN's Books, ruling 4).
                .filter(|p| p.part_of.is_none())
                .collect(),
            _ => Vec::new(), // nothing held, or unreadable: an empty shelf either way
        }
    };
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut posts).await;
    let posts_more = posts.len() as i64 > POSTS_PAGE;
    posts.truncate(POSTS_PAGE as usize);
    // The pinned strip (PROJECT_PLAN's Peeks, ruling 12): the author's own pins, most recently pinned
    // first, each the post as this node holds it - the mirror's, or for a peek the ledger's.
    let Pinned { order: pin_order, posts: mut pinned, shares: pinned_shares } =
        pinned_here(&state, &root_hex, peek).await;
    hide_sealed(&state, &session, &root_hex, query.as_root.as_deref(), &mut pinned).await;
    // How to REACH this persona, as this node honestly knows it - the `?via=` hints any
    // address minted here should carry (Addressing: hints are keys, never addresses).
    //
    // Hosted: this node serves them to anyone, so it hints ITSELF first, then their
    // liveliest known peers. NOT hosted: this node serves them to nobody (fetch-and-serve
    // is member-scoped and the anonymous face still tombstones them), so hinting itself
    // would hand strangers a dead end - the honest hints are the ones that reached them,
    // whatever the caller's URL carried plus the endpoint that last answered for them.
    let mut via: Vec<String> = Vec::new();
    if hosted {
        via.push(state.endpoint.id().to_string());
        via.extend(
            crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 16)
                .await
                .unwrap_or_default(),
        );
    } else {
        via.extend(
            query
                .via
                .as_deref()
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter_map(speakable::node_key_from_via),
        );
        if let Some((_, Some(last))) = foreign_fetch_row(&state, &root_hex).await? {
            via.push(last);
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let via: Vec<String> = via
        .into_iter()
        .filter(|k| seen.insert(k.clone()))
        .take(10)
        .filter_map(|k| speakable::node_key_b58(&k))
        .collect();

    // The profile's first shelf page carries reply counts like every other post surface.
    let count_pairs: Vec<(String, String)> =
        posts.iter().map(|p| (root_hex.clone(), hex::encode(p.doc_id))).collect();
    let reply_counts =
        crate::replies::known_counts(&state.node_db, &count_pairs).await.unwrap_or_default();
    let mut profile_posts: Vec<serde_json::Value> = posts
        .iter()
        .map(|p| {
            let n =
                reply_counts.get(&(root_hex.clone(), hex::encode(p.doc_id))).copied().unwrap_or(0);
            post_json(p, n)
        })
        .collect();
    attach_annotations(&state, &root_hex, &mut profile_posts, query.as_root.as_deref()).await;
    let mut pinned_posts: Vec<serde_json::Value> = pinned.iter().map(|p| post_json(p, 0)).collect();
    attach_annotations(&state, &root_hex, &mut pinned_posts, query.as_root.as_deref()).await;
    // The strip in pin order, the persona's own posts and the posts they pass along together
    // (Curtis, 2026-09-29). A pinned share wears `pinned`: its card carries no annotations of
    // its own to say so.
    let pinned_posts: Vec<serde_json::Value> = {
        let mut strip = Vec::with_capacity(pin_order.len());
        for pin in &pin_order {
            let doc_hex = hex::encode(pin.doc_id);
            if pin.author == root_hex {
                if let Some(v) = pinned_posts.iter().find(|v| v["doc_id"] == doc_hex.as_str()) {
                    strip.push(v.clone());
                }
            } else if let Some(s) =
                pinned_shares.iter().find(|s| s.author_root == pin.author && s.doc_id == pin.doc_id)
            {
                let mut v = share_json(&state, s, &root_hex).await;
                v["pinned"] = serde_json::Value::Bool(true);
                strip.push(v);
            }
        }
        strip
    };

    Ok(axum::Json(serde_json::json!({
        "root": root_hex,
        "speakable": speakable::speakable(&root),
        "foreign": !hosted,
        // A look, not a mirror (PROJECT_PLAN's Peeks, ruling 9): nobody here follows them, so this node
        // holds their identity, profile, labels and newest posts, and no history.
        "peek": peek,
        // The look is at its ceiling (PROJECT_PLAN's Peeks, ruling 6): what is here stays, nothing more
        // is fetched, and following them is the way to the rest.
        "peek_full": peek_full,
        // Whether an address minted here may wear this node's ORIGIN: only for personas it
        // actually serves. A foreign persona's address mints origin-free, which re-homes at
        // whatever node the reader has.
        "hosted": hosted,
        // The short name this node gave them (PROJECT_PLAN's The node's public face, ruling 6), for a persona it hosts.
        "slug": if hosted { crate::slugs::of_root(&state.node_db, &root_hex).await.ok().and_then(|(c, _)| c) } else { None },
        "via": via,
        // A refresh is running behind this answer: what you are reading may be a moment old,
        // and asking again shortly will say so honestly either way.
        "refreshing": refreshing,
        // When this node last reached them, for a persona it does not host. Absent for one it
        // does: a persona we host has no "last synced" - its words are written here.
        "synced_ms": synced_ms,
        "posts": profile_posts,
        // The pinned strip (PROJECT_PLAN's Peeks, ruling 12): above the shelf, in place in it still.
        "pinned": pinned_posts,
        // Whether the shelf goes further back than this first page.
        "posts_more": posts_more,
        "fields": fields.iter().map(|f| serde_json::json!({
            "field": f.field, "value": f.value,
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}

#[cfg(test)]
mod refresh_order_tests {
    use super::*;

    fn cand(foreign: &str, active: bool, eagerness: i64, fetched_at: i64) -> RefreshCandidate {
        RefreshCandidate { foreign: foreign.into(), active, eagerness, fetched_at }
    }

    #[test]
    fn present_humans_outrank_every_dial_setting() {
        // A node waking with a hundred users serves the ones actually here first: an active
        // follower's mild interest beats an absent follower's obsession.
        let order = order_refresh(vec![
            cand("absent-obsessed", false, 100, 0),
            cand("present-mild", true, 10, 0),
        ]);
        assert_eq!(order, vec!["present-mild".to_string(), "absent-obsessed".to_string()]);
    }

    #[test]
    fn within_presence_the_dial_ranks_and_staleness_breaks_ties() {
        let order = order_refresh(vec![
            cand("low-dial", true, 20, 0),
            cand("high-dial", true, 90, 0),
            cand("high-dial-fresher", true, 90, 500),
        ]);
        assert_eq!(
            order,
            vec![
                "high-dial".to_string(), // same dial, stalest first
                "high-dial-fresher".to_string(),
                "low-dial".to_string(),
            ]
        );
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_etag_matches_weak_strong_listed_or_star() {
        let ours = "\"abc\"";
        assert!(super::etag_matches("\"abc\"", ours));
        assert!(super::etag_matches("W/\"abc\"", ours), "a CDN-weakened tag still matches");
        assert!(super::etag_matches("\"x\", W/\"abc\"", ours), "anywhere in a list");
        assert!(super::etag_matches("*", ours));
        assert!(!super::etag_matches("\"abd\"", ours));
        assert!(!super::etag_matches("", ours));
    }

    use super::*;

    /// The address before `/ringtome/` goes to its new spelling, the hints kept, and a book's
    /// page (`post/<doc>/<n>`) spelled as the grammar spells it (2026-09-28).
    #[test]
    fn an_old_address_finds_its_new_one() {
        assert_eq!(ringtome_from_legacy("k", None, None), "/ringtome/user/k");
        assert_eq!(ringtome_from_legacy("k", None, Some("via=a,b")), "/ringtome/user/k?via=a,b");
        assert_eq!(ringtome_from_legacy("k", Some("post/d"), None), "/ringtome/user/k/post/d");
        let page = "fedcba9876543210fedcba9876543210";
        assert_eq!(
            ringtome_from_legacy("k", Some(&format!("post/d/{page}")), Some("via=a")),
            format!("/ringtome/user/k/post/d/page/{page}?via=a")
        );
        assert_eq!(ringtome_from_legacy("k", Some("gallery"), None), "/ringtome/user/k/gallery");
        assert_eq!(ringtome_from_legacy("k", Some("/"), None), "/ringtome/user/k");
    }

    /// The visit registry answers the DOOR's question (has this node fetched-and-carried
    /// them), agelessly; retention is the eviction grace's business, not this table's
    /// (2026-08-25 - the aged-visit detour and its revert are in HISTORY).
    #[tokio::test]
    async fn the_visit_registry_is_ageless_and_the_doors() {
        let db = crate::db::test_node_db().await;
        let now = crate::clock::now_ms();
        for (root, at) in [("aa11", now - 10_000), ("bb22", now - 100)] {
            db.execute(
                "INSERT INTO foreign_fetches (root_pubkey, fetched_at_ms) VALUES (?1, ?2)",
                (root, at),
            )
            .await
            .unwrap();
        }
        let all = fetched_roots(&db).await.unwrap();
        assert_eq!(all.len(), 2, "the ageless list still serves the door's question");
    }
}
