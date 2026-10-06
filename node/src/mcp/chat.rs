//! The chat tools (plans/MCP.md, _Chat_): the persona's rooms, a room's lines, and saying one.
//!
//! The gates follow the app's (UNLOCKS.md, _Chat_): the list of rooms is hrseChat's, so Chat's;
//! a room reached by its address opens without it, and so does saying something there - "a chat
//! for two someone started with you is a room, and reading what's addressed to you is never for
//! sale". Starting a room is the app's.
//!
//! A line is somebody's words, so it comes back fenced as theirs (mcp.rs, _Other people's words_),
//! and saying one is marked destructive: it speaks in the room, in the persona's name.

use axum::http::{request::Parts, Method};
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

use super::read::post_address;
use super::{answer, finish, stop, when, Answer, Tools};

/// How many lines a room answers with, by default and at most.
const LINES_DEFAULT: i64 = 30;
const LINES_MAX: i64 = 100;

#[derive(Deserialize, schemars::JsonSchema)]
pub struct RoomsArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct RoomArgs {
    /// Which persona: its name, its @slug or its root. Leave it out when the account has only one.
    persona: Option<String>,
    /// The room: `author/doc` as list_rooms or a feed card gives it, or a link.
    room: String,
    /// How many lines, newest first: 30 if left out, at most 100.
    limit: Option<i64>,
    /// To read further back: the `next` the previous answer gave.
    next: Option<String>,
}

#[derive(Deserialize, schemars::JsonSchema)]
pub struct SayArgs {
    /// Which persona speaks: its name, its @slug or its root. Leave it out when the account has
    /// only one.
    persona: Option<String>,
    /// The room: `author/doc` as list_rooms or a feed card gives it, or a link.
    room: String,
    /// What to say.
    words: String,
}

impl Tools {
    async fn rooms(&self, parts: &Parts, args: RoomsArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "chat").await?;
        let listing = self
            .call(parts, Method::GET, &format!("/api/identity/{}/rooms", persona.root), None)
            .await?;
        let rooms: Vec<Value> = listing
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|room| {
                let author = room.get("author")?.as_str()?;
                let doc = room.get("doc_id")?.as_str()?;
                Some(json!({
                    "room": format!("{author}/{doc}"),
                    // Its name is its maker's words: fenced.
                    "title": { "author": room.get("author_name"), "text": room.get("title") },
                    "started_by": { "root": author, "name": room.get("author_name") },
                    "last_said": when(room.get("latest_ms").and_then(Value::as_i64)),
                    "unread": room.get("unread"),
                    "mine": room.get("mine"),
                }))
            })
            .collect();
        answer(json!({ "rooms": rooms }))
    }

    async fn room(&self, parts: &Parts, args: RoomArgs) -> Answer {
        let Some((author, doc)) = post_address(&args.room) else {
            return Err(stop("that isn't a room's address: give `author/doc` as list_rooms does"));
        };
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let base = format!("/api/identity/{}/rooms/{author}/{doc}", persona.root);
        // The room's door: who may be in it is who may open its post (CHAT.md, ruling 2). Entering
        // notes the room as joined, as opening it in the app does.
        let door = self.call(parts, Method::GET, &base, None).await?;
        let limit = args.limit.unwrap_or(LINES_DEFAULT).clamp(1, LINES_MAX);
        let mut path = format!("{base}/messages?limit={limit}");
        if let Some(before) = args.next.as_deref().and_then(|n| n.trim().parse::<i64>().ok()) {
            path.push_str(&format!("&before_ms={before}"));
        }
        let page = self.call(parts, Method::GET, &path, None).await?;
        let items = page.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let lines: Vec<Value> = items
            .iter()
            .map(|line| {
                let name = line.get("speaker_name");
                let mut said = json!({
                    "line": line.get("hash"),
                    "speaker": { "root": line.get("speaker"), "name": name },
                    "said": when(line.get("said_ms").and_then(Value::as_i64)),
                    "words": { "author": name, "text": line.get("words") },
                });
                // What it was made with (made_with.rs): the line's own signed claim.
                if let Some(made_with) = line.get("made_with").filter(|v| !v.is_null()) {
                    said["made_with"] = made_with.clone();
                }
                said
            })
            .collect();
        let next = (page.get("more").and_then(Value::as_bool) == Some(true))
            .then(|| items.last().and_then(|l| l.get("said_ms")).and_then(Value::as_i64))
            .flatten()
            .map(|ms| ms.to_string());
        answer(json!({
            "room": format!("{author}/{doc}"),
            // Its name is its maker's words: fenced, by their root (the door names no one).
            "title": { "author": door.get("author"), "text": door.get("title") },
            "closed": door.get("closed"),
            "lines": lines,
            "next": next,
        }))
    }

    async fn say(&self, parts: &Parts, args: SayArgs) -> Answer {
        let Some((author, doc)) = post_address(&args.room) else {
            return Err(stop("that isn't a room's address: give `author/doc` as list_rooms does"));
        };
        let words = args.words.trim();
        if words.is_empty() {
            return Err(stop("there's nothing to say"));
        }
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        let said = self
            .call(
                parts,
                Method::POST,
                &format!("/api/identity/{}/rooms/{author}/{doc}/messages", persona.root),
                Some(json!({ "words": words })),
            )
            .await?;
        answer(json!({
            "room": format!("{author}/{doc}"),
            "said": words,
            "when": when(said.get("said_ms").and_then(Value::as_i64)),
        }))
    }
}

#[tool_router(router = chat_tools, vis = "pub(super)")]
impl Tools {
    #[tool(
        description = "The chat rooms the persona can see - its own, the ones from people it \
            follows, and ones it has been in - newest talk first, with whether there's anything \
            unread. Needs the Chat unlock.",
        annotations(title = "List chat rooms", read_only_hint = true)
    )]
    async fn list_rooms(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<RoomsArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.rooms(&parts, args).await)
    }

    #[tool(
        description = "A chat room's lines, newest first: who said what, and when. Give the room \
            as list_rooms gives it (`author/doc`).",
        annotations(title = "Read a chat room", read_only_hint = true)
    )]
    async fn read_room(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<RoomArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.room(&parts, args).await)
    }

    #[tool(
        description = "Say something in a chat room, in the persona's name - everyone in the \
            room reads it. Ask the person first.",
        annotations(title = "Say in a chat room", read_only_hint = false, destructive_hint = true)
    )]
    async fn send_message(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<SayArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.say(&parts, args).await)
    }
}
