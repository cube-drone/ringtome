//! The writing tools (plans/MCP.md, _Writing_): notes, posts, replies, labels, and the dials on
//! a person - and taking a post or a note back down.
//!
//! Everything said in public is marked destructive (`destructiveHint`), so a client that honours
//! the hint asks the person before it happens: a post, a reply and a label speak in their name to
//! everyone, and unpublishing and deleting take things away. A note and the dials stay private,
//! or quiet, and are not.
//!
//! Every write goes through the node's own doors as the rest of the tools do (mcp.rs), carrying
//! the agent's mark, so a post made here says "ai-agent" without this file doing anything about
//! it (made_with.rs): the doors mark the draft, and publishing restates the mark.
//!
//! The gates follow the app's (UNLOCKS.md, _What each unlock gates_): a note is Private notes';
//! a post and a reply Social's, a post for trusted people only also Sealed posts & audiences',
//! publishing a note again Public post editing's; a label Reactions, tags & filters'; a dial on a
//! person Friends'. Taking things down is never gated (UNLOCKS.md, _Never gated_).

use std::time::Duration;

use axum::http::{request::Parts, Method};
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

use super::read::{kind_of, post_address};
use super::{answer, escape, finish, stop, Answer, Persona, Tools};

/// The bucket the feed's composer files its drafts in (js/pure/feed.js `FEED_STYLE`), so a post
/// an agent writes lives where one the person wrote would.
const FEED_BUCKET: &str = "feed";
/// How long a publish with pictures to mint is asked after (publishing.rs: the door answers 202
/// while it works), and how often.
const PUBLISH_POLLS: usize = 60;
const PUBLISH_POLL_EVERY: Duration = Duration::from_secs(2);
/// A dial's stops (js/person.js `interestStops`, `trustStops`), lowest first.
const DIAL_STOPS: [&str; 5] = ["none", "low", "medium", "high", "max"];

#[derive(Deserialize, schemars::JsonSchema)]
pub struct WriteArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The note to change, by its id from list_documents. Leave it out to write a new one.
    document: Option<String>,
    /// The note's title. For a note being changed, leave it out to keep the title it has.
    title: Option<String>,
    /// The note's whole words - Marquee, which reads like Markdown. Replaces what was there.
    words: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct PublishArgs {
    /// Which persona posts: its name, its @slug or its root. Leave it out when the account has
    /// only one.
    persona: Option<String>,
    /// A note to post, by its id from list_documents - or posted again, if it was before, which
    /// updates the post. Give this or `words`, not both.
    document: Option<String>,
    /// Words to post as they are (Marquee, which reads like Markdown). Give this or `document`.
    words: Option<String>,
    /// A title for the post made from `words`.
    title: Option<String>,
    /// Only people the persona trusts can read it (needs the "Trusted only posts & post
    /// audiences" unlock).
    trusted_only: Option<bool>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct ReplyArgs {
    /// Which persona replies: its name, its @slug or its root. Leave it out when the account has
    /// only one.
    persona: Option<String>,
    /// The post replied to: `author/doc` as a card gives it, or a link.
    post: String,
    /// The reply's words (Marquee, which reads like Markdown).
    words: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct PostArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The post: `author/doc` as a card gives it, or a link.
    post: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct DocumentArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The document's id, as list_documents gives it.
    document: String,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct LabelArgs {
    /// Which persona says it: its name, its @slug or its root. Leave it out when the account has
    /// only one.
    persona: Option<String>,
    /// Somebody else's post: `author/doc` as a card gives it, or a link.
    post: String,
    /// The label: a word, or one emoji for a reaction.
    tag: String,
    /// Take the label back instead of putting it on.
    remove: Option<bool>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct DialArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The person: their root (a card's `author.root`), their speakable address, or an @slug.
    who: String,
    /// How much: "none", "low", "medium", "high" or "max". For follow, "none" stops following.
    level: String,
}

impl Tools {
    /// A new draft holding `words`, filed where the feed's composer files its own.
    async fn draft(
        &self,
        parts: &Parts,
        persona: &Persona,
        title: &str,
        words: &str,
    ) -> Result<String, CallToolResult> {
        let made = self
            .call(
                parts,
                Method::POST,
                &format!("/api/identity/{}/docs", persona.root),
                Some(json!({ "title": title, "body": words, "format": "marquee" })),
            )
            .await?;
        let Some(doc) = made.get("doc_id").and_then(Value::as_str).map(str::to_string) else {
            return Err(stop("the draft wasn't made"));
        };
        self.call(
            parts,
            Method::PUT,
            &format!("/api/identity/{}/docs/{doc}/buckets/{FEED_BUCKET}", persona.root),
            None,
        )
        .await?;
        Ok(doc)
    }

    /// Publish a draft through the publish door, asking again while it mints pictures (a 202 -
    /// publishing.rs), and answer the post's address.
    async fn publish_draft(
        &self,
        parts: &Parts,
        persona: &Persona,
        doc: &str,
        body: Value,
    ) -> Answer {
        let path = format!("/api/identity/{}/docs/{}/publish", persona.root, escape(doc));
        let mut published = self.call(parts, Method::POST, &path, Some(body.clone())).await?;
        for _ in 0..PUBLISH_POLLS {
            if published.get("post_id").is_some() || published.get("baking").is_none() {
                break;
            }
            tokio::time::sleep(PUBLISH_POLL_EVERY).await;
            published = self.call(parts, Method::POST, &path, Some(body.clone())).await?;
        }
        let Some(post) = published.get("post_id").and_then(Value::as_str) else {
            return Err(stop("the post is still being made; ask again in a little while"));
        };
        answer(json!({
            "post": format!("{}/{post}", persona.root),
            "document": doc,
            // What the post says it was made with (made_with.rs), so the agent can tell the person.
            "labelled": crate::made_with::AI_AGENT,
        }))
    }

    async fn write(&self, parts: &Parts, args: WriteArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "private-notes").await?;
        let Some(document) = args.document.as_deref().map(str::trim) else {
            let made = self
                .call(
                    parts,
                    Method::POST,
                    &format!("/api/identity/{}/docs", persona.root),
                    Some(json!({
                        "title": args.title.unwrap_or_default(),
                        "body": args.words,
                        "format": "marquee",
                    })),
                )
                .await?;
            return answer(json!({ "document": made.get("doc_id"), "written": "a new note" }));
        };
        let path = format!("/api/identity/{}/docs/{}", persona.root, escape(document));
        let doc = self.call(parts, Method::GET, &path, None).await?;
        let format = doc.get("format").and_then(Value::as_str).unwrap_or_default();
        if kind_of(format).0 != "note" {
            return Err(stop(format!(
                "that's a {}, not a note: only a note's words are written here",
                kind_of(format).0
            )));
        }
        // Edited from every head there is, so a note two computers had split is joined again by
        // these words rather than left in two.
        let parents: Vec<Value> = doc
            .get("heads")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|h| h.get("version").cloned())
            .collect();
        let title =
            args.title.or_else(|| doc.get("title").and_then(Value::as_str).map(str::to_string));
        self.call(
            parts,
            Method::PUT,
            &path,
            Some(json!({
                "title": title.unwrap_or_default(),
                "body": args.words,
                "parents": parents,
                "format": format,
            })),
        )
        .await?;
        answer(json!({ "document": document, "written": "a new version; the old ones are kept" }))
    }

    async fn publish_answer(&self, parts: &Parts, args: PublishArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let owned = self.unlocks(parts, &persona.root).await?;
        owned.require("social")?;
        let trusted_only = args.trusted_only == Some(true);
        if trusted_only {
            owned.require("sealing")?;
        }
        let doc = match (args.document.as_deref().map(str::trim), args.words.as_deref()) {
            (Some(document), None) => {
                let doc = self
                    .call(
                        parts,
                        Method::GET,
                        &format!("/api/identity/{}/docs/{}", persona.root, escape(document)),
                        None,
                    )
                    .await?;
                let kind = kind_of(doc.get("format").and_then(Value::as_str).unwrap_or_default()).0;
                if kind != "note" {
                    return Err(stop(format!(
                        "a {kind} is posted from the app: only notes and words are posted here"
                    )));
                }
                // Posted before? Then this is an edit of a public post (UNLOCKS.md, _Public post
                // editing_).
                let facts = self
                    .call(
                        parts,
                        Method::GET,
                        &format!(
                            "/api/identity/{}/docs/{}/annotations",
                            persona.root,
                            escape(document)
                        ),
                        None,
                    )
                    .await?;
                if facts.get("fields").and_then(|f| f.get("published_as")).is_some() {
                    owned.require("post-editing")?;
                }
                document.to_string()
            }
            (None, Some(words)) => {
                let draft = self
                    .draft(parts, &persona, args.title.as_deref().unwrap_or_default(), words)
                    .await?;
                let mut body = json!({ "tz_offset_min": 0 });
                if trusted_only {
                    body["trusted_only"] = json!(true);
                }
                return self.publish_fresh(parts, &persona, &draft, body).await;
            }
            _ => return Err(stop("give either `document` or `words`")),
        };
        let mut body = json!({ "tz_offset_min": 0 });
        if trusted_only {
            body["trusted_only"] = json!(true);
        }
        self.publish_draft(parts, &persona, &doc, body).await
    }

    /// Publish a draft this tool just made for the purpose, and take it away again if the
    /// publish is refused: words an agent tried to post must not linger as a note nobody wrote.
    async fn publish_fresh(
        &self,
        parts: &Parts,
        persona: &Persona,
        draft: &str,
        body: Value,
    ) -> Answer {
        let published = self.publish_draft(parts, persona, draft, body).await;
        if published.is_err() {
            let path = format!("/api/identity/{}/docs/{draft}", persona.root);
            if let Err(refused) = self.call(parts, Method::DELETE, &path, None).await {
                tracing::warn!(status = %refused.status, "a refused post's draft was not taken away");
            }
        }
        published
    }

    async fn reply_answer(&self, parts: &Parts, args: ReplyArgs) -> Answer {
        let Some((author, doc)) = post_address(&args.post) else {
            return Err(stop(
                "that isn't a post address: give `author/doc` as a card does, or a link",
            ));
        };
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "social").await?;
        // Ask about the post before writing anything: a room is answered in the room, and a post
        // this node can't find has no thread to join.
        let post = self
            .call(
                parts,
                Method::GET,
                &format!("/api/id/{author}/posts/{doc}?as={}", persona.root),
                None,
            )
            .await?;
        if post.get("format").and_then(Value::as_str) == Some("room") {
            return Err(stop(
                "that's a chat room, not a post: it's answered in the room, not with a reply",
            ));
        }
        let draft = self.draft(parts, &persona, "", &args.words).await?;
        let body = json!({ "reply_to": { "author": author, "doc_id": doc }, "tz_offset_min": 0 });
        self.publish_fresh(parts, &persona, &draft, body).await
    }

    async fn unpublish_answer(&self, parts: &Parts, args: PostArgs) -> Answer {
        let Some((author, doc)) = post_address(&args.post) else {
            return Err(stop(
                "that isn't a post address: give `author/doc` as a card does, or a link",
            ));
        };
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        if author != persona.root {
            return Err(stop("that post isn't this persona's: only their own posts come down"));
        }
        self.call(parts, Method::DELETE, &format!("/api/identity/{author}/posts/{doc}"), None)
            .await?;
        answer(
            json!({ "unpublished": format!("{author}/{doc}"), "note": "the note it was posted from is kept" }),
        )
    }

    async fn delete(&self, parts: &Parts, args: DocumentArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let document = args.document.trim();
        self.call(
            parts,
            Method::DELETE,
            &format!("/api/identity/{}/docs/{}", persona.root, escape(document)),
            None,
        )
        .await?;
        answer(
            json!({ "deleted": document, "note": "anything posted from it stays up until unpublished" }),
        )
    }

    async fn label_answer(&self, parts: &Parts, args: LabelArgs) -> Answer {
        let Some((author, doc)) = post_address(&args.post) else {
            return Err(stop(
                "that isn't a post address: give `author/doc` as a card does, or a link",
            ));
        };
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        // A persona's own post wears its draft's tags: publishing restates them, and would retract
        // one said here instead (identity/routes.rs `replicate_annotations`).
        if author == persona.root {
            return Err(stop(
                "that's this persona's own post: its tags are its note's, set in the app and \
                 posted again",
            ));
        }
        self.require(parts, &persona.root, "tags").await?;
        let tag = args.tag.trim();
        let base = format!("/api/identity/{}/public-annotations/{author}/{doc}", persona.root);
        if args.remove == Some(true) {
            self.call(parts, Method::DELETE, &format!("{base}/tag/{}", escape(tag)), None).await?;
            return answer(json!({ "post": format!("{author}/{doc}"), "removed": tag }));
        }
        self.call(parts, Method::PUT, &base, Some(json!({ "key": "tag", "value": tag }))).await?;
        answer(json!({ "post": format!("{author}/{doc}"), "labelled": tag }))
    }

    /// Set one of the persona's dials on a person - `interest` (following) or `trust` - a register
    /// on its private chain, as the person card does (js/person.js `put`).
    async fn dial(&self, parts: &Parts, args: DialArgs, register: &str) -> Answer {
        let level = args.level.trim().to_ascii_lowercase();
        if !DIAL_STOPS.contains(&level.as_str()) {
            return Err(stop(format!("\"{level}\" isn't a level: none, low, medium, high or max")));
        }
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "friends").await?;
        let who = self.root_of(parts, &args.who).await?;
        if who == persona.root {
            return Err(stop("that's this persona itself"));
        }
        let contact = escape(&format!("contact:{who}"));
        self.call(
            parts,
            Method::PUT,
            &format!("/api/identity/{}/private/kv/{contact}/{register}", persona.root),
            Some(json!({ "value": level })),
        )
        .await?;
        answer(json!({ "who": who, register: level }))
    }
}

#[tool_router(router = write_tools, vis = "pub(super)")]
impl Tools {
    #[tool(
        description = "Write a note (in Writer): a new one, or new words for one the persona has \
            - the whole text, replacing what was there; the old version is kept. Notes are \
            private until posted. Needs the Private notes unlock.",
        annotations(title = "Write a note", read_only_hint = false, destructive_hint = false)
    )]
    async fn write_document(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<WriteArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.write(&parts, args).await)
    }

    #[tool(
        description = "Post to the persona's feed, for everyone who follows them: a note by its \
            id (posted again, it updates the post), or words given here. Public, and in their \
            name - ask the person first. The post carries the tag \"ai-agent\", so readers know \
            an agent made it. Needs the Social unlock.",
        annotations(title = "Post", read_only_hint = false, destructive_hint = true)
    )]
    async fn publish(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PublishArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.publish_answer(&parts, args).await)
    }

    #[tool(
        description = "Reply to a post. Public, and in the persona's name - ask the person \
            first. The reply carries the tag \"ai-agent\". Needs the Social unlock.",
        annotations(title = "Reply", read_only_hint = false, destructive_hint = true)
    )]
    async fn reply(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<ReplyArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.reply_answer(&parts, args).await)
    }

    #[tool(
        description = "Take one of the persona's own posts down. The note it came from is kept.",
        annotations(title = "Unpublish a post", read_only_hint = false, destructive_hint = true)
    )]
    async fn unpublish(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<PostArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.unpublish_answer(&parts, args).await)
    }

    #[tool(
        description = "Delete one of the persona's documents. Anything posted from it stays up \
            until it's unpublished.",
        annotations(title = "Delete a document", read_only_hint = false, destructive_hint = true)
    )]
    async fn delete_document(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<DocumentArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.delete(&parts, args).await)
    }

    #[tool(
        description = "Put a label on somebody else's post, or take one back: a word, or an \
            emoji as a reaction. Public, in the persona's name. Needs the Reactions, tags & \
            filters unlock.",
        annotations(title = "Label a post", read_only_hint = false, destructive_hint = true)
    )]
    async fn label(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<LabelArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.label_answer(&parts, args).await)
    }

    #[tool(
        description = "Follow a person, or stop: how much of their posting the persona wants to \
            see, from \"none\" (not following) to \"max\". Needs the Friends unlock.",
        annotations(
            title = "Follow",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn follow(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<DialArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.dial(&parts, args, "interest").await)
    }

    #[tool(
        description = "How much the persona trusts a person - \"I know this person for real\" - \
            from \"none\" to \"max\". Trust decides who reads posts for trusted people only. \
            Needs the Friends unlock.",
        annotations(
            title = "Trust",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = true
        )
    )]
    async fn trust(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<DialArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.dial(&parts, args, "trust").await)
    }
}
