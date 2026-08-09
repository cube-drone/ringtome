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

use super::{account_for_token, has_tag, Account, TAG_ADMIN, TAG_NODE_ADMIN};
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

        // Single-tenant desktop mode: the OS user is the only tenant, so login is a formality.
        // TODO(identity): synthesize/auto-provision the single local account and return its
        // session here, so desktop handlers need no login flow. Until accounts-per-mode wiring
        // exists, fall through to cookie auth even in single mode.
        if state.config.tenancy == Tenancy::Single {
            // intentional fall-through for now
        }

        let jar = CookieJar::from_request_parts(parts, &state)
            .await
            .map_err(|_| AppError::Unauthorized(crate::msg!("auth.extractor.no-cookies", "no cookies")))?;

        let token = jar
            .get(&session_cookie_name(state.config.port))
            .map(|c| c.value().to_string())
            .ok_or_else(|| AppError::Unauthorized(crate::msg!("auth.extractor.not-logged-in", "not logged in")))?;

        let account = account_for_token(&state.node_db, &token)
            .await?
            .ok_or_else(|| AppError::Unauthorized(crate::msg!("auth.extractor.session-invalid-or-expired", "session invalid or expired")))?;

        // The presence signal: an authenticated request is a human at the keyboard, and the
        // follow-refresh sweep spends its budget on present humans first.
        state.activity.stamp(&account.id.to_string());

        Ok(Session { account })
    }
}

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
