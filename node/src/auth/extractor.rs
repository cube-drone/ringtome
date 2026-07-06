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

use super::{account_for_token, Account};
use crate::config::Tenancy;
use crate::error::AppError;
use crate::AppState;

/// Name of the cookie carrying the opaque session token.
pub const SESSION_COOKIE: &str = "ringtome_session";

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
            .map_err(|_| AppError::Unauthorized("no cookies".into()))?;

        let token = jar
            .get(SESSION_COOKIE)
            .map(|c| c.value().to_string())
            .ok_or_else(|| AppError::Unauthorized("not logged in".into()))?;

        let account = account_for_token(&state.node_db, &token)
            .await?
            .ok_or_else(|| AppError::Unauthorized("session invalid or expired".into()))?;

        Ok(Session { account })
    }
}
