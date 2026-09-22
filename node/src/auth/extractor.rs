//! The `Session` extractor: a handler that takes a `Session` parameter only runs for an
//! authenticated caller; otherwise the request is rejected with 401.
//!
//! Mode-aware by design (see the Tenancy seam): in multi-tenant node mode a session requires a
//! valid cookie; in single-tenant desktop mode there is one implicit account and login is a
//! formality, so that path will synthesize a session. Handlers just ask for `Session` and do not
//! care which mode produced it.

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;

use super::{account_for_token, has_tag, local_account, secret_eq, Account, TAG_ADMIN, TAG_NODE_ADMIN};
use crate::config::Tenancy;
use crate::error::AppError;
use crate::AppState;

/// Name of the cookie carrying the opaque session token - suffixed with the node's PORT,
/// because browsers scope cookies by host alone, never by port: two nodes on one host (the
/// localhost:5281/5282 dev pair, or any self-hosted stack) otherwise fight over a single
/// cookie, and each login logs the other node out (field-found 2026-08-01). Distinct names
/// let the jars coexist; a node only ever reads its own.
pub fn session_cookie_name(port: u16) -> String {
    format!("ringtome_session_{port}")
}

/// An authenticated session. Currently just wraps the account; identity scoping attaches later.
#[derive(Debug, Clone)]
pub struct Session {
    pub account: Account,
}

impl FromRequestParts<AppState> for Session {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let State(state) = State::<AppState>::from_request_parts(parts, state)
            .await
            .map_err(|_| AppError::Internal(anyhow::anyhow!("missing app state")))?;

        // Single-tenant desktop mode: the OS user is the only tenant, and the shell's launch
        // token is how they prove it (DESKTOP.md, Stage 3). Possession IS the session, so
        // there is no login screen - and the reason a token rather than an auto-minted cookie
        // is that a cookie is carried by any caller who reaches loopback, while a header is
        // carried only by something that can set one.
        if state.config.tenancy == Tenancy::Single {
            if let Some(expected) = state.config.launch_token.as_deref() {
                if let Some(given) = launch_token_offered(parts) {
                    if secret_eq(&given, expected) {
                        let account = local_account(&state.node_db, state.config.local_test).await?;
                        state.activity.stamp(&account.id.to_string());
                        return Ok(Session { account });
                    }
                    return Err(AppError::Unauthorized(crate::msg!(
                        "auth.extractor.that-is-not-this-computers-key",
                        "that isn't this computer's key"
                    )));
                }
            }
        }

        // A cross-site caller is nobody here, whatever cookie the browser attached.
        //
        // `SameSite=Lax` keeps the session off a cross-site `fetch`, but it deliberately DOES
        // send it on a cross-site top-level GET navigation - and a page on the open web can
        // perform one on itself, at a door of its choosing, and bounce straight back. That is
        // enough to make this node act: two GET doors have side effects (a profile fetch dials
        // the endpoints named in its query, and entering a room joins it). The browser labels
        // the request honestly, so the door reads the label. Unauthorized rather than Forbidden
        // on purpose: the public `/id/` surfaces then see an ANONYMOUS caller, which is what a
        // stranger arriving from another site actually is, rather than an error.
        if parts
            .headers
            .get("sec-fetch-site")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|site| site == "cross-site")
        {
            return Err(AppError::Unauthorized(crate::msg!(
                "auth.extractor.that-came-from-another-site",
                "that request came from another site"
            )));
        }

        let jar = CookieJar::from_request_parts(parts, &state)
            .await
            .map_err(|_| AppError::Unauthorized(crate::msg!("auth.extractor.no-cookies", "no cookies")))?;

        let token = jar
            .get(&session_cookie_name(state.config.port))
            .map(|c| c.value().to_string())
            .ok_or_else(|| AppError::Unauthorized(crate::msg!("auth.extractor.not-logged-in", "please sign in again")))?;

        let account = account_for_token(&state.node_db, &token)
            .await?
            .ok_or_else(|| AppError::Unauthorized(crate::msg!("auth.extractor.session-invalid-or-expired", "please sign in again")))?;

        // The presence signal: an authenticated request is a human at the keyboard, and the
        // follow-refresh sweep spends its budget on present humans first.
        state.activity.stamp(&account.id.to_string());

        Ok(Session { account })
    }
}

/// The launch token as this request carries it, if it does.
///
/// Two spellings, because a browser cannot set a header on every kind of request it makes:
/// ordinary calls carry `Authorization: Bearer <token>`, and the live-cache WebSocket - whose
/// constructor has no header argument at all - carries it as a subprotocol, which is the one
/// string the `WebSocket` constructor does let a page choose. Both are set by code running in
/// the shell's own window; neither can be attached by a navigation, which is the whole point.
fn launch_token_offered(parts: &Parts) -> Option<String> {
    if let Some(bearer) = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    {
        return Some(bearer.trim().to_string());
    }
    parts
        .headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|offered| {
            offered
                .split(',')
                .map(str::trim)
                .find_map(|p| p.strip_prefix(WS_TOKEN_PROTOCOL_PREFIX))
                .map(str::to_string)
        })
}

/// The subprotocol a token rides on, when the request is a WebSocket handshake. The server
/// must echo the protocol it accepts or the browser fails the connection, so the stream door
/// spells this prefix too.
pub const WS_TOKEN_PROTOCOL_PREFIX: &str = "ringtome.token.";

/// `Option<Session>` for the surfaces with two audiences (the `/id/` face): an anonymous
/// caller is a real caller there, not a rejection. Missing or invalid credentials become
/// `None`; anything else (state trouble, db errors) still fails the request - "not logged
/// in" and "the node is broken" must never look alike.
impl axum::extract::OptionalFromRequestParts<AppState> for Session {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Option<Self>, Self::Rejection> {
        match <Session as FromRequestParts<AppState>>::from_request_parts(parts, state).await {
            Ok(session) => Ok(Some(session)),
            Err(AppError::Unauthorized(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

/// A session belonging to a `node_admin`. Handlers taking this only run for the node's full
/// administrator(s); everyone else gets 403.
#[derive(Debug, Clone)]
pub struct NodeAdminSession {
    /// Unread so far - the only node-admin handler is a ping - but every future admin action
    /// will want to know who acted.
    #[allow(dead_code)]
    pub account: Account,
}

impl FromRequestParts<AppState> for NodeAdminSession {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let session = Session::from_request_parts(parts, state).await?;
        let db = &state.node_db;
        if has_tag(db, &session.account.id, TAG_NODE_ADMIN).await? {
            Ok(NodeAdminSession {
                account: session.account,
            })
        } else {
            Err(AppError::Forbidden(crate::msg!("auth.extractor.nodeadmin-required", "node_admin required")))
        }
    }
}

/// A session belonging to an admin. Satisfied by either the `admin` tag or `node_admin` (a
/// node_admin is a superset of an admin). Handlers taking this run for either; everyone else 403.
#[derive(Debug, Clone)]
pub struct AdminSession {
    pub account: Account,
}

impl FromRequestParts<AppState> for AdminSession {
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let session = Session::from_request_parts(parts, state).await?;
        let db = &state.node_db;
        let id = &session.account.id;
        if has_tag(db, id, TAG_ADMIN).await? || has_tag(db, id, TAG_NODE_ADMIN).await? {
            Ok(AdminSession {
                account: session.account,
            })
        } else {
            Err(AppError::Forbidden(crate::msg!("auth.extractor.admin-required", "admin required")))
        }
    }
}
