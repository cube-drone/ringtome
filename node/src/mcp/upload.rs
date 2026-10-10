//! Pictures in (plans/MCP.md, _Pictures_; ruling 11, 2026-10-10): `upload_link`, an address a file
//! can be sent to once (uploadlink.rs). MCP carries no file from a client to a server, and a model
//! rarely holds the bytes of a picture to type them out, so the tool hands back a place to send it
//! instead: an agent with a shell sends the file there, and one in a chat window gives the person
//! the address to open in a browser. The upload's own answer carries the embed to put in a note or
//! a post; `read_document` gives it too, once the picture is made.
//!
//! Gated as the app's upload is: File upload (UNLOCKS.md).

use axum::http::{header, request::Parts, Method};
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::CallToolResult;
use rmcp::{schemars, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

use super::{answer, finish, when, Answer, Tools};

#[derive(Deserialize, schemars::JsonSchema)]
pub struct UploadLinkArgs {
    /// Which persona the file is for: its name, its @slug or its root. Leave it out when the
    /// account has only one.
    persona: Option<String>,
    /// What to call the file - its title in the persona's files, and the words a screen reader
    /// says in its place. Defaults to "picture".
    title: Option<String>,
}

#[tool_router(router = upload_tools, vis = "pub(super)")]
impl Tools {
    #[tool(
        description = "Get an address to send ONE picture, video or sound to, for the persona's \
            files - MCP can't carry a file, so this is how one gets in. With a shell, send the file \
            as the request's body: `curl --data-binary @photo.jpg '<url>'`. Without one, give the \
            person the url to open in a browser, where they choose the file. The address works \
            once, for 30 minutes. The upload's answer (or read_document on `document` afterwards) \
            gives `embed`: markup that shows the picture in a note or a post - put it in \
            write_document's or publish's words. Any common format (JPEG, PNG, GIF, WebP, MP3...) \
            is made into the stored one. Needs the File upload unlock.",
        annotations(
            title = "Get an upload link",
            read_only_hint = false,
            destructive_hint = false,
            idempotent_hint = false
        )
    )]
    async fn upload_link(
        &self,
        Extension(parts): Extension<Parts>,
        Parameters(args): Parameters<UploadLinkArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        finish(self.upload_link_answer(&parts, args).await)
    }
}

impl Tools {
    async fn upload_link_answer(&self, parts: &Parts, args: UploadLinkArgs) -> Answer {
        let persona = self.persona(parts, args.persona.as_deref()).await?;
        self.require(parts, &persona.root, "file-upload").await?;
        let minted = self
            .call(
                parts,
                Method::POST,
                &format!("/api/identity/{}/upload-links", persona.root),
                Some(json!({ "title": args.title })),
            )
            .await?;
        let path = minted.get("path").and_then(Value::as_str).unwrap_or_default();
        let url = format!("{}{path}", self.base(parts));
        answer(json!({
            "url": url,
            "document": minted.get("doc_id"),
            "expires": when(minted.get("expires_ms").and_then(Value::as_i64)),
            "with_a_shell": format!("curl --data-binary @<file> '{url}'"),
            "without_one": "give the person the url: they open it in a browser and choose the file",
            "then": "the upload's answer has `embed` once the picture is made (or `status: pending` \
                while it's still being made - read_document on `document` gives `embed` then). Put \
                `embed` in a note's or a post's words to show it.",
        }))
    }

    /// The address this node is reached at, for a link the agent hands on: its public URL when it
    /// has one, else the address the agent itself connected to (nodeface.rs `public_base`).
    fn base(&self, parts: &Parts) -> String {
        if let Some(url) = self.public_url.as_deref().filter(|u| !u.is_empty()) {
            return url.trim_end_matches('/').to_string();
        }
        match parts.headers.get(header::HOST).and_then(|h| h.to_str().ok()) {
            Some(host) => format!("http://{host}"),
            None => String::new(),
        }
    }
}
