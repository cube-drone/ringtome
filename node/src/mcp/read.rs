//! The reading tools (plans/MCP.md, _Looking around_): the feed, a post and its replies, a
//! person's page, the notifications, and the persona's own documents. All but one only look - the
//! exception, `mark_notifications_seen`, is the bell's own one write, kept a tool of its own so
//! that reading never uses up the person's notifications.
//!
//! Every answer is shaped for a model rather than passed through: a post becomes a card with its
//! author named once, its tags split into the author's own and other people's labels, its moments
//! as dates, and its words fenced as `{"author", "text"}` (mcp.rs, _Other people's words_). A post
//! is addressed as `author/doc` - the two ids every door takes - and the same string is what every
//! card hands back, so an agent can pass what it read straight to the next tool.
//!
//! The gates (mcp.rs, ruling 1) follow the app's (UNLOCKS.md, _What each unlock gates_): the feed
//! is hrseFeed's, so Social; its tag filter is Reactions, tags & filters, its search never gated;
//! notes are Private notes' and files File upload's, drawings anyone's. Reading what's addressed to
//! you - a post by its link, a person's page, the bell - is never gated (UNLOCKS.md, _Never
//! gated_).

use axum::http::{request::Parts, Method};
use base64::Engine;
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{answer, escape, finish, stop, when, Answer, Persona, Tools};
use crate::notifications;

/// The most a feed or a person's page shows of each post's words: enough to know what it says.
/// `read_post` has the whole of it.
const EXCERPT_CHARS: usize = 1_200;
/// The most of one document's words a tool hands back, a novel being ~10MB (identity/routes.rs's
/// body limits) and a model's context far less.
const WORDS_MAX_CHARS: usize = 60_000;
/// The longest side of a file's picture as `read_document` hands it back - enough to see what it
/// is, small enough not to swallow a context.
const PICTURE_BOUND: u32 = 1024;
/// How many posts a feed or a person's page answers with, by default and at most.
const POSTS_DEFAULT: usize = 20;
const POSTS_MAX: usize = 50;
/// How many replies `read_post` fetches the words of; the rest are listed by address.
const REPLIES_WITH_WORDS: usize = 20;

#[derive(Deserialize, schemars::JsonSchema)]
pub struct FeedArgs {
    /// Which persona's feed: its name, its @slug or its root. Leave it out when the account has
    /// only one.
    persona: Option<String>,
    /// Words to search the whole feed for. Without it, the newest posts first.
    search: Option<String>,
    /// Only posts with this tag (needs the "Reactions, tags & filters" unlock).
    tag: Option<String>,
    /// Only one kind: "post", "reply", "rebroadcast" (a share), "book" or "room" (a chat).
    kind: Option<String>,
    /// Leave out the persona's own posts.
    hide_mine: Option<bool>,
    /// Leave out posts made with an AI agent or an API key - they carry the tag "ai-agent" or
    /// "api-key".
    hide_agents: Option<bool>,
    /// How many posts, newest first: 20 if left out, at most 50.
    limit: Option<usize>,
    /// To read further back: the `next` the previous page answered.
    next: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct NotificationsArgs {
    /// Which persona's notifications: its name, its @slug or its root. Leave it out when the
    /// account has only one.
    persona: Option<String>,
    /// How many, newest first: 20 if left out, at most 100.
    limit: Option<usize>,
    /// To read further back: the `next` the previous page answered.
    next: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct MarkSeenArgs {
    /// Which persona's notifications: its name, its @slug or its root. Leave it out when the
    /// account has only one.
    persona: Option<String>,
    /// Mark seen only up to here: a notification's `mark`, as read_notifications gives it -
    /// that one and everything older. Leave it out to mark them all.
    through: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct PeopleArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// For list_contacts only: "following" for the people it follows, "trusted" for the people it
    /// trusts. Leave it out for everyone it has a dial on.
    only: Option<String>,
    /// How many: 50 if left out, at most 200.
    limit: Option<usize>,
    /// To read further: the `next` the previous page answered.
    next: Option<String>,
}

/// How many people a page of contacts or followers answers with, by default and at most.
const PEOPLE_DEFAULT: usize = 50;
const PEOPLE_MAX: usize = 200;

/// How many notifications a page answers with, by default and at most.
const NOTIFICATIONS_DEFAULT: usize = 20;
const NOTIFICATIONS_MAX: usize = 100;

#[derive(Deserialize, schemars::JsonSchema)]
pub struct PostArgs {
    /// The post: `author/doc` as a feed card gives it, or a link to it.
    post: String,
    /// Which persona is reading - it decides what a post sealed for trusted people shows. Leave it
    /// out when the account has only one.
    persona: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct ProfileArgs {
    /// Whose page: their root (as a card's `author.root` gives it), their speakable address, or
    /// their @slug on this node.
    who: String,
    /// How many of their posts, newest first: 20 if left out, at most 50.
    limit: Option<usize>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct DocumentsArgs {
    /// Which persona's documents: its name, its @slug or its root. Leave it out when the account
    /// has only one.
    persona: Option<String>,
    /// Only one kind: "note" (Writer), "drawing" or "file" (an uploaded picture, film or sound).
    kind: Option<String>,
    /// Only documents with this tag (needs the "Reactions, tags & filters" unlock).
    tag: Option<String>,
    /// Only documents whose title has these words in it, in any case.
    search: Option<String>,
    /// Only published documents (true), or only unpublished ones (false).
    published: Option<bool>,
    /// Just how many documents match - no list.
    count_only: Option<bool>,
    /// How many, newest change first: 50 if left out, at most 200.
    limit: Option<usize>,
    /// To read further: the `next` the previous page answered.
    next: Option<String>,
}

/// How many documents a page of `list_documents` answers with, by default and at most.
const DOCUMENTS_DEFAULT: usize = 50;
const DOCUMENTS_MAX: usize = 200;

#[derive(Deserialize, schemars::JsonSchema)]
pub struct DocumentArgs {
    /// The document's id, as `list_documents` gives it.
    document: String,
    /// Which persona's document: its name, its @slug or its root. Leave it out when the account
    /// has only one.
    persona: Option<String>,
}

/// What kind of thing a document is, by its format (record/documents.rs `Format::parse`), and the
/// unlock that opens its app (UNLOCKS.md, _Apps_) - None for one anyone may read.
pub(super) fn kind_of(format: &str) -> (&'static str, Option<&'static str>) {
    match format {
        "plaintext" | "marquee" => ("note", Some("private-notes")),
        "drawing" => ("drawing", None),
        "avif" | "apng" | "webm" | "opus" => ("file", Some("file-upload")),
        "book" => ("book", Some("private-notes")),
        "room" => ("room", Some("chat")),
        _ => ("other", None),
    }
}

/// Is this format words a model can read?
fn is_text(format: &str) -> bool {
    matches!(format, "plaintext" | "marquee")
}

/// At most `max` characters of `text`, cut at a character, with a mark when anything was cut.
fn clip(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// A post's address from what an agent was handed: `author/doc`, or any link holding a 64-hex
/// root and, after it, a 32-hex document id - which every post link this node makes does.
pub(super) fn post_address(given: &str) -> Option<(String, String)> {
    let hex_run = |len: usize, from: usize| {
        let bytes = given.as_bytes();
        let mut start = from;
        while start + len <= bytes.len() {
            let run = bytes[start..].iter().take_while(|b| b.is_ascii_hexdigit()).count();
            let bounded = start == 0 || !bytes[start - 1].is_ascii_hexdigit();
            if bounded && run == len {
                return Some((start, given[start..start + len].to_ascii_lowercase()));
            }
            start += run.max(1);
        }
        None
    };
    let (at, author) = hex_run(64, 0)?;
    let (_, doc) = hex_run(32, at + 64)?;
    Some((author, doc))
}

/// A post as a card (the feed's rows, a person's page, a post): who wrote it, what it's called,
/// when, its kind, and its tags split into the author's own and the labels other people put on it.
/// `words` is its text when the caller fetched it, fenced as theirs.
fn card(post: &Value, author: &str, author_name: Option<&str>, words: Option<String>) -> Value {
    let doc = post.get("doc_id").and_then(Value::as_str).unwrap_or_default();
    let mut tags = Vec::new();
    let mut labels = Vec::new();
    for note in post.get("annotations").and_then(Value::as_array).into_iter().flatten() {
        if note.get("key").and_then(Value::as_str) != Some("tag") {
            continue;
        }
        let Some(tag) = note.get("value").and_then(Value::as_str) else { continue };
        if note.get("annotator").and_then(Value::as_str) == Some(author) {
            tags.push(tag);
        } else {
            labels.push(json!({ "tag": tag, "by": note.get("annotator_name") }));
        }
    }
    let reply_to = post.get("reply_to").and_then(|to| {
        Some(format!("{}/{}", to.get("author")?.as_str()?, to.get("doc_id")?.as_str()?))
    });
    let published =
        post.get("published_ms").or_else(|| post.get("minted_ms")).and_then(Value::as_i64);
    let mut card = json!({
        "post": format!("{author}/{doc}"),
        "author": { "root": author, "name": author_name },
        "title": post.get("title"),
        "kind": kind_of(post.get("format").and_then(Value::as_str).unwrap_or_default()).0,
        "published": when(published),
        "tags": tags,
    });
    if !labels.is_empty() {
        card["labels"] = json!(labels);
    }
    if let Some(reply_to) = reply_to {
        card["reply_to"] = json!(reply_to);
    }
    if post.get("mine").and_then(Value::as_bool) == Some(true) {
        card["mine"] = json!(true);
    }
    // The author's no-shares-no-replies wish (PROJECT_PLAN's Post visibility): said on the card,
    // so an agent asked to reply learns it before the door refuses.
    if post.get("settled").and_then(Value::as_bool) == Some(true) {
        card["closed"] = json!("the author asked for no replies and no shares");
    }
    if let Some(text) = words {
        card["words"] = json!({ "author": author_name, "text": text });
    }
    card
}

impl Tools {
    /// A post's words, from the door the app reads them through (postentry.js): the public body,
    /// with the sharer's hint when the post came by a share. None for what isn't text, or for
    /// words this node can't fetch - the card still says what the post is.
    async fn post_words(
        &self,
        parts: &Parts,
        post: &Value,
        author: &str,
        max: usize,
    ) -> Option<String> {
        let format = post.get("format").and_then(Value::as_str).unwrap_or_default();
        if !is_text(format) || post.get("private_doc").is_some_and(|p| !p.is_null()) {
            return None;
        }
        let doc = post.get("doc_id")?.as_str()?;
        let via = post
            .get("via")
            .and_then(Value::as_str)
            .map(|via| format!("?via={}", escape(via)))
            .unwrap_or_default();
        let text = self.text(parts, &format!("/id/{author}/docs/{doc}/body{via}")).await.ok()?;
        Some(clip(&text, max))
    }

    async fn feed(&self, parts: &Parts, args: FeedArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let owned = self.unlocks(parts, &persona.root).await?;
        owned.require("social")?;
        let mut query = Vec::new();
        if let Some(search) = args.search.as_deref().filter(|s| !s.trim().is_empty()) {
            query.push(format!("q={}", escape(search)));
        }
        if let Some(tag) = args.tag.as_deref() {
            owned.require("tags")?;
            query.push(format!("tag={}", escape(tag)));
        }
        if let Some(kind) = args.kind.as_deref() {
            if !crate::search::KINDS.contains(&kind) {
                return Err(stop(format!(
                    "\"{kind}\" isn't a kind of post: post, reply, rebroadcast, book or room"
                )));
            }
            query.push(format!("kind={kind}"));
        }
        if args.hide_mine == Some(true) {
            query.push("me=0".into());
        }
        // The feed's own exclusion over the author's tags (search.rs `Narrow`): never gated,
        // like the protection from other people it is (UNLOCKS.md, _Never gated_).
        if args.hide_agents == Some(true) {
            for tag in [crate::made_with::AI_AGENT, crate::made_with::API_KEY] {
                query.push(format!("not_tag={tag}"));
            }
        }
        if let Some((ms, doc)) = args.next.as_deref().and_then(|next| next.split_once(':')) {
            query.push(format!("before_ms={}&before_doc={}", escape(ms), escape(doc)));
        }
        let path = format!("/api/identity/{}/feed?{}", persona.root, query.join("&"));
        let page = self.call(parts, Method::GET, &path, None).await?;
        let items = page.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let limit = args.limit.unwrap_or(POSTS_DEFAULT).clamp(1, POSTS_MAX);
        let mut posts = Vec::new();
        for item in items.iter().take(limit) {
            let author = item.get("author").and_then(Value::as_str).unwrap_or_default();
            let words = self.post_words(parts, item, author, EXCERPT_CHARS).await;
            posts.push(card(item, author, item.get("author_name").and_then(Value::as_str), words));
        }
        // The feed's cursor is its journal's page order (fanout.rs `page_sql`): when the post was
        // published, then its id - not when it arrived, which pages from the wrong place.
        let further =
            items.len() > limit || page.get("more").and_then(Value::as_bool) == Some(true);
        let next = items
            .get(limit.min(items.len()).saturating_sub(1))
            .filter(|_| further)
            .and_then(|last| {
                Some(format!(
                    "{}:{}",
                    last.get("published_ms")?.as_i64()?,
                    last.get("doc_id")?.as_str()?
                ))
            });
        answer(json!({ "persona": persona_line(&persona), "posts": posts, "next": next }))
    }

    async fn post(&self, parts: &Parts, args: PostArgs) -> Answer {
        let Some((author, doc)) = post_address(&args.post) else {
            return Err(stop(
                "that isn't a post address: give `author/doc` as a feed card does, or a link",
            ));
        };
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let post = self
            .call(
                parts,
                Method::GET,
                &format!("/api/id/{author}/posts/{doc}?as={}", persona.root),
                None,
            )
            .await?;
        let replies = self
            .call(parts, Method::GET, &format!("/api/id/{author}/posts/{doc}/replies"), None)
            .await?;
        let bylines = replies.get("bylines").cloned().unwrap_or(Value::Null);
        let name_of = |root: &str| -> Option<String> {
            bylines.get(root)?.get("name")?.as_str().map(str::to_string)
        };
        let author_name = name_of(&author).or(self.name_of(parts, &author).await);
        let words = self.post_words(parts, &post, &author, WORDS_MAX_CHARS).await;
        let mut answer_card = card(&post, &author, author_name.as_deref(), words);
        if !is_text(post.get("format").and_then(Value::as_str).unwrap_or_default()) {
            answer_card["note"] = json!("its body isn't words, so only what it is shows here");
        }
        let mut listed = Vec::new();
        for (i, reply) in
            replies.get("replies").and_then(Value::as_array).into_iter().flatten().enumerate()
        {
            let (Some(by), Some(reply_doc)) = (
                reply.get("author").and_then(Value::as_str),
                reply.get("doc_id").and_then(Value::as_str),
            ) else {
                continue;
            };
            let name = name_of(by);
            let mut line = json!({
                "post": format!("{by}/{reply_doc}"),
                "author": { "root": by, "name": name },
                "written": when(reply.get("claimed_ms").and_then(Value::as_i64)),
            });
            if i < REPLIES_WITH_WORDS {
                if let Ok(text) = self.text(parts, &format!("/id/{by}/docs/{reply_doc}/body")).await
                {
                    line["words"] = json!({ "author": name, "text": clip(&text, EXCERPT_CHARS) });
                }
            }
            listed.push(line);
        }
        answer(json!({
            "post": answer_card,
            "replies": listed,
            "more_replies": replies.get("more"),
        }))
    }

    /// Someone's name as their profile gives it, for a post whose replies didn't carry it.
    async fn name_of(&self, parts: &Parts, root: &str) -> Option<String> {
        let profile =
            self.call(parts, Method::GET, &format!("/api/id/{root}/profile"), None).await.ok()?;
        profile_fields(&profile).get("name").and_then(Value::as_str).map(str::to_string)
    }

    /// Someone's root from what an agent was given: a root, a speakable address, or an @slug on
    /// this node. The `/api/id` doors read the first two alike (idface.rs `id_profile`); the
    /// cards and the dials need the root itself, from the same parser.
    pub(super) async fn root_of(&self, parts: &Parts, who: &str) -> Result<String, CallToolResult> {
        let who = who.trim();
        let seg = match who.strip_prefix('@') {
            Some(slug) => {
                let found = self
                    .call(parts, Method::GET, &format!("/api/node/slugs/{}", escape(slug)), None)
                    .await?;
                found.get("root").and_then(Value::as_str).unwrap_or_default().to_string()
            }
            None => who.to_string(),
        };
        match crate::speakable::parse(&seg) {
            Some(crate::speakable::Parsed::Ok(root)) => Ok(hex::encode(root)),
            _ => Err(stop(format!(
                "\"{who}\" isn't someone this node can find: give their root, their speakable \
                 address, or an @slug"
            ))),
        }
    }

    async fn profile(&self, parts: &Parts, args: ProfileArgs) -> Answer {
        let root = self.root_of(parts, &args.who).await?;
        let profile =
            self.call(parts, Method::GET, &format!("/api/id/{root}/profile"), None).await?;
        let fields = profile_fields(&profile);
        let name = fields.get("name").and_then(Value::as_str).map(str::to_string);
        let limit = args.limit.unwrap_or(POSTS_DEFAULT).clamp(1, POSTS_MAX);
        let mut posts = Vec::new();
        for post in profile.get("posts").and_then(Value::as_array).into_iter().flatten().take(limit)
        {
            let words = self.post_words(parts, post, &root, EXCERPT_CHARS).await;
            posts.push(card(post, &root, name.as_deref(), words));
        }
        answer(json!({
            "who": { "root": root, "name": name },
            // Everything on their profile is theirs to say: fenced like their posts.
            "profile": { "author": name, "fields": fields },
            "posts": posts,
        }))
    }

    async fn notifications(&self, parts: &Parts, args: NotificationsArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let page = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{}/notifications", persona.root),
                None,
            )
            .await?;
        let all: Vec<Value> = page
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| {
                let mut line = notification(item, &persona.root);
                // What mark_notifications_seen's `through` takes to stop here: the bell's
                // watermark is a moment, and this is this notification's.
                if let Some(at) = item.get("updated_ms").and_then(Value::as_i64) {
                    line["mark"] = json!(at.to_string());
                }
                line
            })
            .collect();
        let from: usize = match args.next.as_deref() {
            Some(next) => next
                .trim()
                .parse()
                .map_err(|_| stop("that `next` isn't one read_notifications gave"))?,
            None => 0,
        };
        let limit = args.limit.unwrap_or(NOTIFICATIONS_DEFAULT).clamp(1, NOTIFICATIONS_MAX);
        let unseen = all.iter().filter(|n| n.get("seen") == Some(&json!(false))).count();
        let more = from + limit < all.len();
        let items: Vec<Value> = all.into_iter().skip(from).take(limit).collect();
        let mut answered = json!({
            "persona": persona_line(&persona),
            "unseen": unseen,
            "notifications": items,
        });
        if more {
            answered["next"] = json!((from + limit).to_string());
        }
        answer(answered)
    }

    /// The bell's "mark all read" (apps/notifications.js): the watermark moves to the newest
    /// notification there is, one write that every computer the persona is on reads.
    async fn mark_seen(&self, parts: &Parts, args: MarkSeenArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let through: Option<i64> = match args.through.as_deref() {
            Some(t) => Some(
                t.trim()
                    .parse()
                    .map_err(|_| stop("that `through` isn't a notification's `mark`"))?,
            ),
            None => None,
        };
        let page = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{}/notifications", persona.root),
                None,
            )
            .await?;
        let mut items = page.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        // "Up to here": that notification and everything older. The watermark is one moment, so
        // marking through a notification marks every one from that moment back, never a newer one.
        if let Some(through) = through {
            items.retain(|i| {
                i.get("updated_ms").and_then(Value::as_i64).is_some_and(|at| at <= through)
            });
        }
        let unseen =
            items.iter().filter(|i| i.get("seen").and_then(Value::as_bool) == Some(false)).count();
        let newest = items.iter().filter_map(|i| i.get("updated_ms").and_then(Value::as_i64)).max();
        if let Some(newest) = newest.filter(|_| unseen > 0) {
            self.call(
                parts,
                Method::PUT,
                &format!("/api/identity/{}/private/kv/notifications_seen/watermark", persona.root),
                Some(json!({ "value": newest.to_string() })),
            )
            .await?;
        }
        answer(json!({ "persona": persona_line(&persona), "marked_seen": unseen }))
    }

    async fn documents(&self, parts: &Parts, args: DocumentsArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let owned = self.unlocks(parts, &persona.root).await?;
        if let Some(kind) = args.kind.as_deref() {
            match kind {
                "note" => owned.require("private-notes")?,
                "file" => owned.require("file-upload")?,
                "drawing" => {}
                _ => return Err(stop(format!("\"{kind}\" isn't a kind: note, drawing or file"))),
            }
        }
        let path = match args.tag.as_deref() {
            Some(tag) => {
                owned.require("tags")?;
                format!("/api/identity/{}/docs/tagged/{}", persona.root, escape(tag))
            }
            None => format!("/api/identity/{}/docs", persona.root),
        };
        let listing = self.call(parts, Method::GET, &path, None).await?;
        let mut docs = listing.get("docs").and_then(Value::as_array).cloned().unwrap_or_default();
        // Newest change first, the order a page continues in; ties by id, so a page boundary
        // never lands between two documents that changed in the same millisecond.
        docs.sort_by(|a, b| {
            let at = |d: &Value| d.get("updated_ms").and_then(Value::as_i64).unwrap_or(0);
            let id = |d: &Value| d.get("doc_id").and_then(Value::as_str).unwrap_or("").to_string();
            at(b).cmp(&at(a)).then_with(|| id(a).cmp(&id(b)))
        });
        let search =
            args.search.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(|q| {
                q.to_lowercase().split_whitespace().map(str::to_string).collect::<Vec<_>>()
            });
        let mut shown = Vec::new();
        let mut locked_kinds = std::collections::BTreeSet::new();
        for doc in &docs {
            let (kind, unlock) =
                kind_of(doc.get("format").and_then(Value::as_str).unwrap_or_default());
            // Chat rooms and books are their own apps' to show, not a document list's.
            if matches!(kind, "room" | "book" | "other")
                || args.kind.as_deref().is_some_and(|k| k != kind)
            {
                continue;
            }
            if unlock.is_some_and(|u| owned.require(u).is_err()) {
                locked_kinds.insert(kind);
                continue;
            }
            let published = doc.get("fields").and_then(|f| f.get("published_as")).is_some();
            if args.published.is_some_and(|want| want != published) {
                continue;
            }
            if let Some(words) = &search {
                let title =
                    doc.get("title").and_then(Value::as_str).unwrap_or_default().to_lowercase();
                if !words.iter().all(|w| title.contains(w.as_str())) {
                    continue;
                }
            }
            shown.push(json!({
                "document": doc.get("doc_id"),
                "title": doc.get("title"),
                "kind": kind,
                "format": doc.get("format"),
                "updated": when(doc.get("updated_ms").and_then(Value::as_i64)),
                "created": when(doc.get("created_ms").and_then(Value::as_i64)),
                "tags": doc.get("tags"),
                "published": published,
                "pinned": doc.get("pinned"),
            }));
        }
        let matched = shown.len();
        let mut answered = if args.count_only == Some(true) {
            json!({ "persona": persona_line(&persona), "count": matched })
        } else {
            // A page of what matched: `next` is where the following page starts, while any is left.
            let from: usize = match args.next.as_deref() {
                Some(next) => next
                    .trim()
                    .parse()
                    .map_err(|_| stop("that `next` isn't one list_documents gave"))?,
                None => 0,
            };
            let limit = args.limit.unwrap_or(DOCUMENTS_DEFAULT).clamp(1, DOCUMENTS_MAX);
            let page: Vec<Value> = shown.into_iter().skip(from).take(limit).collect();
            let mut answered = json!({
                "persona": persona_line(&persona),
                "count": matched,
                "documents": page,
            });
            if from + limit < matched {
                answered["next"] = json!((from + limit).to_string());
            }
            answered
        };
        if !locked_kinds.is_empty() {
            answered["not_shown"] = json!(format!(
                "{} - their apps aren't unlocked yet",
                locked_kinds.into_iter().map(|k| format!("{k}s")).collect::<Vec<_>>().join(" and ")
            ));
        }
        answer(answered)
    }

    async fn document(&self, parts: &Parts, args: DocumentArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let doc = self
            .call(
                parts,
                Method::GET,
                &format!("/api/identity/{}/docs/{}", persona.root, escape(args.document.trim())),
                None,
            )
            .await?;
        let format = doc.get("format").and_then(Value::as_str).unwrap_or_default();
        let (kind, unlock) = kind_of(format);
        if let Some(unlock) = unlock {
            self.require(parts, &persona.root, unlock).await?;
        }
        let mut answered = json!({
            "document": doc.get("doc_id"),
            "title": doc.get("title"),
            "kind": kind,
            "format": format,
        });
        if doc.get("diverged").and_then(Value::as_bool) == Some(true) {
            answered["diverged"] = json!(
                "edited on two computers at once and not yet merged: these are the newest words"
            );
        }
        if is_text(format) {
            let body = doc.get("body").and_then(Value::as_str).unwrap_or_default();
            // Their own document, but words can arrive in it from anywhere (a copied post): fenced.
            answered["words"] =
                json!({ "author": persona.name, "text": clip(body, WORDS_MAX_CHARS) });
        } else if kind == "file" && matches!(format, "avif" | "apng") {
            // A picture, to look at (ruling 9): the stored AVIF as a PNG, which every client
            // reads, bounded so one photo doesn't fill a context. A drawing never comes here
            // (ruling 7) - its picture is the browser's to compose.
            let path = format!(
                "/api/identity/{}/docs/{}/body",
                persona.root,
                escape(args.document.trim())
            );
            let (status, bytes) = self.send(parts, Method::GET, &path, None).await?;
            if !status.is_success() {
                return Err(stop("its picture hasn't reached this computer yet"));
            }
            let png = if format == "apng" {
                Ok(bytes.to_vec())
            } else {
                let avif = bytes.to_vec();
                tokio::task::spawn_blocking(move || {
                    crate::media::image::avif_to_png(&avif, PICTURE_BOUND)
                })
                .await
                .map_err(|_| stop("its picture couldn't be read"))?
                .map_err(|_| ())
            };
            let Ok(png) = png else { return Err(stop("its picture couldn't be read")) };
            answered["picture"] =
                json!(format!("below, as a PNG at most {PICTURE_BOUND} pixels on a side"));
            let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
            return Ok(CallToolResult::success(vec![
                ContentBlock::text(answered.to_string()),
                ContentBlock::image(encoded, "image/png"),
            ]));
        } else if kind == "file" {
            answered["note"] = json!("a film or a sound: only pictures can be looked at here");
        } else {
            answered["note"] = json!(format!("a {kind}: its body isn't words"));
        }
        answer(answered)
    }
}

impl Tools {
    /// A page of people off one of the persona's people doors, gated like Neighbors (Friends).
    async fn people(&self, parts: &Parts, args: PeopleArgs, door: &str, mine: bool) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "friends").await?;
        let listing = self
            .call(parts, Method::GET, &format!("/api/identity/{}/{door}", persona.root), None)
            .await?;
        let mut people: Vec<Value> =
            listing.get("people").and_then(Value::as_array).cloned().unwrap_or_default();
        if let Some(only) = args.only.as_deref() {
            if !mine {
                return Err(stop(
                    "`only` is list_contacts': these are everyone who follows or trusts",
                ));
            }
            let band = match only.trim() {
                "following" => "interest",
                "trusted" => "trust",
                other => return Err(stop(format!("\"{other}\" isn't one: following or trusted"))),
            };
            people.retain(|p| p.get(band).and_then(Value::as_str).is_some());
        }
        // Names first, alphabetically, then the nameless by root: a stable order to page in.
        people.sort_by_key(|p| {
            (
                p.get("name").and_then(Value::as_str).map(str::to_lowercase).is_none(),
                p.get("name").and_then(Value::as_str).map(str::to_lowercase).unwrap_or_default(),
                p.get("root").and_then(Value::as_str).unwrap_or_default().to_string(),
            )
        });
        let from: usize = match args.next.as_deref() {
            Some(next) => {
                next.trim().parse().map_err(|_| stop("that `next` isn't one this list gave"))?
            }
            None => 0,
        };
        let limit = args.limit.unwrap_or(PEOPLE_DEFAULT).clamp(1, PEOPLE_MAX);
        let count = people.len();
        // A name is their own word about themselves: fenced like everything they write.
        let page: Vec<Value> = people
            .into_iter()
            .skip(from)
            .take(limit)
            .map(|mut p| {
                if let Some(name) = p.get("name").cloned().filter(|n| !n.is_null()) {
                    p["name"] = json!({ "author": name.clone(), "text": name });
                }
                p
            })
            .collect();
        let mut answered =
            json!({ "persona": persona_line(&persona), "count": count, "people": page });
        if from + limit < count {
            answered["next"] = json!((from + limit).to_string());
        }
        answer(answered)
    }
}

/// One notification, in words an agent can act on. Each kind's `doc_id` names something
/// different (notifications.rs, the `KIND_` docs): for a reply, a label or a share it is the
/// READER's own post; for a mention, the author's post; for a room mention, the room, whose author
/// rides in `detail`; for a contract, the contract's id, its name and reward in `detail`. So the
/// post address is built per kind, and a kind this doesn't know keeps only who and when.
fn notification(item: &Value, reader: &str) -> Value {
    let kind = item.get("kind").and_then(Value::as_str).unwrap_or_default();
    let from = item.get("author").and_then(Value::as_str).unwrap_or_default();
    let doc = item.get("doc_id").and_then(Value::as_str);
    let detail = item.get("detail").and_then(Value::as_str);
    let mut line = json!({
        "kind": kind,
        "when": when(item.get("updated_ms").and_then(Value::as_i64)),
        "seen": item.get("seen"),
    });
    if kind != notifications::KIND_CONTRACT {
        let name = item.get("author_name").or_else(|| item.get("claimed_name"));
        line["from"] = json!({ "root": from, "name": name });
    }
    if item.get("stranger").and_then(Value::as_bool) == Some(true) {
        line["stranger"] = json!(true);
    }
    match (kind, doc) {
        (
            notifications::KIND_COMMENT
            | notifications::KIND_TAGGED
            | notifications::KIND_REBROADCAST,
            Some(doc),
        ) => {
            line["post"] = json!(format!("{reader}/{doc}"));
            line["title"] = item.get("doc_title").cloned().unwrap_or(Value::Null);
        }
        (notifications::KIND_MENTIONED, Some(doc)) => {
            line["post"] = json!(format!("{from}/{doc}"));
        }
        (notifications::KIND_ROOM_MENTION, Some(doc)) => {
            if let Some(room_author) = detail {
                line["room"] = json!(format!("{room_author}/{doc}"));
            }
        }
        (notifications::KIND_CONTRACT, Some(_)) => {
            let contract: Value =
                detail.and_then(|d| serde_json::from_str(d).ok()).unwrap_or_default();
            line["contract"] = contract.get("name").cloned().unwrap_or(Value::Null);
            line["reward"] = contract
                .get("pennies")
                .and_then(Value::as_str)
                .map_or(Value::Null, |p| json!(format!("H$ {}", super::horsebucks(p))));
        }
        (notifications::KIND_PUBLIC_EDGE, _) => {
            for dial in ["trust", "interest"] {
                if let Some(value) = item.get(dial).filter(|v| !v.is_null()) {
                    line[dial] = value.clone();
                }
            }
        }
        _ => {}
    }
    line
}

/// A profile's fields as one object, the form a model reads best.
fn profile_fields(profile: &Value) -> serde_json::Map<String, Value> {
    let fields = profile.get("fields").or(Some(profile)).and_then(Value::as_array);
    fields
        .into_iter()
        .flatten()
        .filter_map(|f| Some((f.get("field")?.as_str()?.to_string(), f.get("value")?.clone())))
        .collect()
}

/// Which persona an answer is about, in a line.
fn persona_line(persona: &Persona) -> Value {
    json!({ "name": persona.name, "root": persona.root })
}

#[tool_router(router = read_tools, vis = "pub(super)")]
impl Tools {
    #[tool(
        description = "The persona's feed: posts from the people they follow, and their own, \
            newest first - or a search of all of it. Each post comes as a card: `post` (its \
            address, for read_post), author, title, kind, when it was published, the author's \
            tags, other people's labels, and the start of its words. Needs the Social unlock.",
        annotations(title = "Read the feed", read_only_hint = true)
    )]
    async fn read_feed(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<FeedArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.feed(&parts, args).await)
    }

    #[tool(
        description = "One post, all its words, and its replies (the first twenty with their \
            words). Give its address as a feed card's `post` does (`author/doc`), or a link.",
        annotations(title = "Read a post", read_only_hint = true)
    )]
    async fn read_post(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PostArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.post(&parts, args).await)
    }

    #[tool(
        description = "Someone's page: their profile (name, bio and the rest) and their posts, \
            newest first. `who` is their root (a card's `author.root`), their speakable address, \
            or an @slug on this node.",
        annotations(title = "Read someone's page", read_only_hint = true)
    )]
    async fn read_profile(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<ProfileArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.profile(&parts, args).await)
    }

    #[tool(
        description = "The persona's notifications, newest first, a page at a time: follows and \
            trust, mentions, replies, and the rest - each with who it's from, what post it's \
            about, whether it's been seen, and a `mark` that mark_notifications_seen can stop at. \
            Reading them doesn't mark them seen.",
        annotations(title = "Read notifications", read_only_hint = true)
    )]
    async fn read_notifications(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<NotificationsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.notifications(&parts, args).await)
    }

    #[tool(
        description = "Mark notifications seen, on every computer the persona is on: all of them, \
            as the bell's \"mark all read\" does, or only up to one (`through`, its `mark`) and \
            everything older. Only when the person asks.",
        annotations(
            title = "Mark notifications seen",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn mark_notifications_seen(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<MarkSeenArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.mark_seen(&parts, args).await)
    }

    #[tool(
        description = "The persona's own documents: notes (Writer), drawings, and files - each \
            with its id, title, kind, dates, tags, and whether it's been published. Kinds whose \
            app the persona hasn't unlocked aren't listed.",
        annotations(title = "List documents", read_only_hint = true)
    )]
    async fn list_documents(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<DocumentsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.documents(&parts, args).await)
    }

    #[tool(
        description = "One of the persona's own documents: its title and kind; for a note, its \
            words; for a picture file, the picture itself. A drawing, a film or a sound says what \
            it is.",
        annotations(title = "Read a document", read_only_hint = true)
    )]
    async fn read_document(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<DocumentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.document(&parts, args).await)
    }

    #[tool(
        description = "The people the persona has a dial on - who it follows and how much \
            (`interest`), who it trusts and how much (`trust`), and any nickname it gave them - \
            a page at a time. Needs the Friends unlock.",
        annotations(title = "List who the persona follows and trusts", read_only_hint = true)
    )]
    async fn list_contacts(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PeopleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.people(&parts, args, "contacts", true).await)
    }

    #[tool(
        description = "Who publicly follows or trusts the persona, with how much - as far as \
            this computer knows, which is the people whose posts it holds - a page at a time. \
            Needs the Friends unlock.",
        annotations(title = "List the persona's followers", read_only_hint = true)
    )]
    async fn list_followers(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PeopleArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.people(&parts, args, "followers/list", false).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTHOR: &str = "971a1d92fa5c2606f905c931c69f9daa7d7f8bb80a6fde9ad9e805879182be3d";
    const DOC: &str = "c5f099c7290098a1861a5cdd1ef8450e";

    #[test]
    fn a_post_address_is_found_in_what_a_card_or_a_link_gives() {
        let want = Some((AUTHOR.to_string(), DOC.to_string()));
        assert_eq!(post_address(&format!("{AUTHOR}/{DOC}")), want);
        assert_eq!(
            post_address(&format!("https://horses.example/id/{AUTHOR}/docs/{DOC}/body")),
            want
        );
        assert_eq!(post_address(&format!("{}/{DOC}", AUTHOR.to_uppercase())), want, "any case");
        assert_eq!(post_address(DOC), None, "a doc alone is no address");
        assert_eq!(post_address(&format!("{AUTHOR}ab/{DOC}")), None, "66 hex is not a root");
    }

    #[test]
    fn a_card_keeps_the_authors_tags_apart_from_other_peoples_labels() {
        let post = json!({
            "doc_id": DOC, "format": "marquee", "title": "hay", "published_ms": 0,
            "annotations": [
                { "annotator": AUTHOR, "key": "tag", "value": "horses" },
                { "annotator": AUTHOR, "key": "bucket", "value": "feed" },
                { "annotator": "someone", "annotator_name": "Pal", "key": "tag", "value": "❤" },
            ],
        });
        let card = card(&post, AUTHOR, Some("Aloha"), Some("neigh".into()));
        assert_eq!(card["post"], format!("{AUTHOR}/{DOC}"));
        assert_eq!(card["tags"], json!(["horses"]), "a bucket is not a tag");
        assert_eq!(card["labels"], json!([{ "tag": "❤", "by": "Pal" }]));
        assert_eq!(card["kind"], "note");
        assert_eq!(card["published"], "1970-01-01T00:00:00Z");
        assert_eq!(card["words"], json!({ "author": "Aloha", "text": "neigh" }), "fenced");
    }

    #[test]
    fn a_notification_points_at_the_post_its_kind_means() {
        const ME: &str = "35320ad6838e667c23d22cc712492555b1487d4b02b0c8f827b69dc53ad95551";
        let reply =
            json!({ "kind": "comment", "author": AUTHOR, "author_name": "Pal", "doc_id": DOC });
        assert_eq!(notification(&reply, ME)["post"], format!("{ME}/{DOC}"), "a reply: my post");
        let mention = json!({ "kind": "mentioned", "author": AUTHOR, "doc_id": DOC });
        assert_eq!(notification(&mention, ME)["post"], format!("{AUTHOR}/{DOC}"), "theirs");
        let room = json!({ "kind": "room-mention", "author": AUTHOR, "doc_id": DOC, "detail": ME });
        assert_eq!(notification(&room, ME)["room"], format!("{ME}/{DOC}"), "the room's author");
        let contract = json!({
            "kind": "contract", "author": ME, "doc_id": "organize-a-note",
            "detail": "{\"name\":\"Organize a note\",\"pennies\":\"250000\"}",
        });
        let line = notification(&contract, ME);
        assert_eq!(line["contract"], "Organize a note");
        assert_eq!(line["reward"], "H$ 2,500.00");
        assert!(line.get("post").is_none() && line.get("from").is_none(), "no post, no sender");
        let edge = json!({ "kind": "public-edge", "author": AUTHOR, "trust": "max" });
        assert_eq!(notification(&edge, ME)["trust"], "max");
    }

    #[test]
    fn clip_cuts_at_a_character_and_says_so() {
        assert_eq!(clip("horse", 10), "horse");
        assert_eq!(clip("horse", 3), "hor…");
        assert_eq!(clip("🐴🐴🐴", 2), "🐴🐴…");
    }
}
