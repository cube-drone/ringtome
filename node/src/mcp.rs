//! The Model Context Protocol at `/mcp` (plans/MCP.md): Horse Drawing Tycoon 2 for AI agents.
//!
//! An AI client (Claude Code, Cursor, claude.ai...) connects here with an API key and gets a small
//! set of tools shaped around what a person does - read the feed, post, draw - rather than the
//! hundred-odd doors the app's pages use. Three decisions shape the module:
//!
//! - **A key, and never a cookie.** [`by_key`] strips the `Cookie` header before anything reads
//!   the request, so a browser that happens to be signed in can't be made into an MCP client by a
//!   page that posts here; the only way in is `Authorization: Bearer rtk_...` (auth/keys.rs). That
//!   is also why the SDK's DNS-rebinding guard (a `Host` allowlist, loopback by default) is off: it
//!   protects servers that trust whoever can reach them, and this one trusts only a secret no
//!   browser carries on its own. A public node answers at its own hostname, which a loopback list
//!   would refuse.
//! - **Every tool is a request to the node's own router** ([`Tools::call`]), in-process, carrying
//!   the caller's key. Calling the handlers' insides would be a second door that has to repeat
//!   every rule the first one checks - who may write to a persona, what a key may not do, the body
//!   caps - and the two would drift. Through the router, a rule added to a door covers the agent
//!   the day it lands. The router `/mcp` dispatches to is the one built WITHOUT `/mcp` ([`mount`]),
//!   so a tool can't call the protocol back into itself.
//! - **Stateless.** No sessions are kept (`NeverSessionManager`) and answers are plain JSON, not
//!   event streams: every request carries its key and stands alone, which is what the protocol's
//!   2026-07-28 revision made the only way, and what lets any of a persona's nodes answer.
//!
//! The SDK is `rmcp` (the official Rust SDK) rather than a hand-written JSON-RPC loop because
//! the protocol is still moving: 2026-07-28 replaced the `initialize` handshake with per-request
//! metadata and added required headers, and the SDK answers both lifecycles.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::{header, request::Parts, Method, StatusCode};
use axum::middleware::Next;
use axum::response::Response;
use axum::Router;
use rmcp::handler::server::tool::Extension;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::transport::streamable_http_server::session::never::NeverSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{tool, tool_handler, tool_router, ErrorData, ServerHandler};
use serde_json::Value;
use tower::ServiceExt;

use crate::auth::Session;
use crate::error::AppError;
use crate::AppState;

/// Where the protocol is served.
pub const PATH: &str = "/mcp";

/// The most of a door's answer a tool reads. The doors a tool calls answer in JSON well under
/// this; a document body, the largest, is capped at ~10MB (identity/routes.rs's body limits).
const ANSWER_MAX: usize = 16 * 1024 * 1024;

/// What a client puts in front of the model on connecting.
const INSTRUCTIONS: &str = "This server is a person's own account in Horse Drawing Tycoon 2, \
a social network for drawing horses (and anything else) with a pretend economy of HorseBucks. \
You act as them, with their API key. Start with `whoami` to see their personas: most tools \
act as one of them.";

/// Mount `/mcp` beside the node's routes. `api` is the finished router - layers and state
/// applied - and is what every tool's request goes to; `/mcp` is added to a copy, so it never
/// dispatches to itself.
pub fn mount(api: Router, state: AppState) -> Router {
    let dispatch = api.clone();
    let service = StreamableHttpService::new(
        move || Ok(Tools::new(dispatch.clone())),
        Arc::new(NeverSessionManager::default()),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            // Off on purpose: see the module doc ("A key, and never a cookie").
            .disable_allowed_hosts(),
    );
    // `route_layer`, not `layer`: a router's `layer` also wraps its fallback, and once merged
    // every unknown path would ask for a key instead of answering 404 (field-found 2026-10-06 by
    // config.cjs's "unknown routes" claim).
    let mcp = Router::new()
        .route_service(PATH, service)
        .route_layer(axum::middleware::from_fn_with_state(state, by_key));
    api.merge(mcp)
}

/// The door: a request without an API key never reaches the protocol. The cookie is removed
/// first, so neither this check nor any tool's request can fall back to a browser's session.
async fn by_key(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, AppError> {
    let (mut parts, body) = request.into_parts();
    parts.headers.remove(header::COOKIE);
    if !parts.headers.contains_key(header::AUTHORIZATION) {
        return Err(AppError::Unauthorized(crate::msg!(
            "mcp.needs-an-api-key",
            "connect with an API key: Authorization: Bearer rtk_..."
        )));
    }
    // A key that doesn't open is refused here, in the node's own words (auth/extractor.rs).
    Session::from_request_parts(&mut parts, &state).await?;
    Ok(next.run(Request::from_parts(parts, body)).await)
}

/// The tools, one per thing a person asks an agent to do (plans/MCP.md, _The tools_).
#[derive(Clone)]
pub struct Tools {
    /// The node's router, without `/mcp` (module doc).
    api: Router,
}

/// A door answered with an error: its status, and the message it gave (error.rs's `ErrorBody`).
struct Refused {
    status: StatusCode,
    message: String,
}

impl Tools {
    fn new(api: Router) -> Self {
        Self { api }
    }

    /// One request to the node's own router, as the MCP request's caller: the same key, and the
    /// same connection's address (request_context.rs reads it for every request it tags). Nothing
    /// else crosses - not the cookie, which [`by_key`] already took, nor any browser header.
    async fn call(
        &self,
        parts: &Parts,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, Refused> {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(key) = parts.headers.get(header::AUTHORIZATION) {
            request = request.header(header::AUTHORIZATION, key);
        }
        let body = match body {
            Some(json) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(json.to_string())
            }
            None => Body::empty(),
        };
        let mut request = request.body(body).map_err(|e| Refused::internal(e.to_string()))?;
        if let Some(address) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
            request.extensions_mut().insert(*address);
        }

        let response = self
            .api
            .clone()
            .oneshot(request)
            .await
            .map_err(|e| Refused::internal(e.to_string()))?;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), ANSWER_MAX)
            .await
            .map_err(|e| Refused::internal(e.to_string()))?;
        let json: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(json);
        }
        let message = json
            .get("message")
            .and_then(Value::as_str)
            .map_or_else(|| status.to_string(), str::to_string);
        Err(Refused { status, message })
    }
}

impl Refused {
    fn internal(detail: String) -> Self {
        tracing::error!(%detail, "an MCP tool's request to the node failed");
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: "something went wrong".into() }
    }

    /// The refusal as the agent sees it: a tool result marked as an error, in the door's own
    /// words, so the model can tell the person what happened. A protocol error would reach the
    /// client as an opaque "internal error" instead (rmcp's `CallToolResult::error`).
    fn into_result(self) -> CallToolResult {
        CallToolResult::error(vec![ContentBlock::text(format!(
            "{} ({})",
            self.message, self.status
        ))])
    }
}

/// A tool's answer as JSON text, the form every client reads.
fn answer(json: Value) -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::json(json)?]))
}

#[tool_router]
impl Tools {
    #[tool(
        description = "Who you're acting as: the account's username, and each of its personas - \
            a persona is one public identity, with its own posts, drawings, followers and \
            HorseBucks. Most tools act as one persona, named by its `root`.",
        annotations(title = "Who am I?", read_only_hint = true)
    )]
    async fn whoami(
        &self,
        Extension(parts): Extension<Parts>,
    ) -> Result<CallToolResult, ErrorData> {
        let account = match self.call(&parts, Method::GET, "/api/auth/whoami", None).await {
            Ok(account) => account,
            Err(refused) => return Ok(refused.into_result()),
        };
        let identities = match self.call(&parts, Method::GET, "/api/identity", None).await {
            Ok(Value::Array(identities)) => identities,
            Ok(_) => Vec::new(),
            Err(refused) => return Ok(refused.into_result()),
        };
        let mut personas = Vec::with_capacity(identities.len());
        for identity in identities {
            let Some(root) = identity.get("root_pubkey").and_then(Value::as_str) else { continue };
            // The profile is a list of fields; an agent reads it better as one object.
            let profile = match self
                .call(&parts, Method::GET, &format!("/api/identity/{root}/profile"), None)
                .await
            {
                Ok(Value::Array(fields)) => fields
                    .iter()
                    .filter_map(|f| {
                        Some((f.get("field")?.as_str()?.to_string(), f.get("value")?.clone()))
                    })
                    .collect::<serde_json::Map<_, _>>(),
                Ok(_) => serde_json::Map::new(),
                Err(refused) => return Ok(refused.into_result()),
            };
            personas.push(serde_json::json!({
                "root": root,
                "profile": profile,
                "standing": identity.get("standing"),
            }));
        }
        answer(serde_json::json!({
            "username": account.get("username"),
            "personas": personas,
        }))
    }
}

#[tool_handler]
impl ServerHandler for Tools {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(
                // The protocol's name for itself; the title is what a person sees (README's two
                // names).
                Implementation::new("ringtome", env!("CARGO_PKG_VERSION"))
                    .with_title("Horse Drawing Tycoon 2"),
            )
            .with_instructions(INSTRUCTIONS)
    }
}
