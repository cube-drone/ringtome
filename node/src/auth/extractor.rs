//! The `Session` extractor: a handler that takes a `Session` parameter only runs for an
//! authenticated caller; otherwise the request is rejected with 401.
//!
//! Two ways in. A browser: a valid session cookie. An outside program: an API key (keys.rs), sent as
//! `Authorization: Bearer rtk_...` - the account, but never its keys or its administering.
//!
//! The cookie, on every kind of node. The desktop app used to have a
//! second - its launch token was the session, and there was no login screen - and that is gone
//! (Curtis, 2026-09-28): a desktop node is a localhost multi-user server with the ordinary sign-in,
//! so its own window signs in like any browser. The launch token survives only as the window's
//! name for itself ([`window_offered`]): it says which account is signed in THERE, which is whose
//! alerts the operating system shows (attention.rs), and it proves nothing else.

use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum_extra::extract::CookieJar;

use super::{account_for_token_renewing, has_tag, secret_eq, Account, TAG_ADMIN, TAG_NODE_ADMIN};
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
    /// The API key that signed this request in, by id - None for a browser's session (keys.rs).
    pub key: Option<String>,
}

/// The API key a request carries, if it carries one: `Authorization: Bearer rtk_...`.
fn bearer_key(headers: &axum::http::HeaderMap) -> Option<String> {
    let value = headers.get(axum::http::header::AUTHORIZATION)?.to_str().ok()?;
    let key = value.strip_prefix("Bearer ")?.trim();
    key.starts_with(super::keys::KEY_PREFIX).then(|| key.to_string())
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

        // The desktop app's own window, if this request is from it: whoever proves to be signed in
        // below is who the window is signed in as; a window that proves nobody is signed out.
        let window = window_offered(&parts.headers, &state);

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

        // An outside program's key (keys.rs): the account it belongs to, or nobody - a key that
        // doesn't open never falls back to a cookie. No window, no presence: a script is not a
        // human at the keyboard.
        if let Some(key) = bearer_key(&parts.headers) {
            return match super::keys::account_for_key(&state.node_db, &key).await? {
                Some((account, key_id)) => Ok(Session { account, key: Some(key_id) }),
                None => Err(AppError::Unauthorized(crate::msg!(
                    "auth.extractor.key-not-valid",
                    "that API key isn't valid here"
                ))),
            };
        }

        let signed_in = async {
            let jar = CookieJar::from_request_parts(parts, &state).await.map_err(|_| {
                AppError::Unauthorized(crate::msg!("auth.extractor.no-cookies", "no cookies"))
            })?;
            let token = jar
                .get(&session_cookie_name(state.config.port))
                .map(|c| c.value().to_string())
                .ok_or_else(|| {
                    AppError::Unauthorized(crate::msg!(
                        "auth.extractor.not-logged-in",
                        "please sign in again"
                    ))
                })?;
            let (account, renewed) =
                account_for_token_renewing(&state.node_db, &token).await?.ok_or_else(|| {
                    AppError::Unauthorized(crate::msg!(
                        "auth.extractor.session-invalid-or-expired",
                        "please sign in again"
                    ))
                })?;
            // Renewed: the response carries the cookie again, with its Max-Age fresh (`renew_cookie`).
            if renewed {
                if let Some(slot) = parts.extensions.get::<RenewedSession>() {
                    *slot.0.lock().expect("renewal slot poisoned") = Some(token);
                }
            }
            Ok(account)
        }
        .await;
        if window {
            match &signed_in {
                Ok(account) => state.attention.set_window_account(Some(account.id.to_string())),
                Err(AppError::Unauthorized(_)) => state.attention.set_window_account(None),
                Err(_) => {}
            }
        }
        let account = signed_in?;

        // The presence signal: an authenticated request is a human at the keyboard, and the
        // follow-refresh sweep spends its budget on present humans first.
        state.activity.stamp(&account.id.to_string());

        Ok(Session { account, key: None })
    }
}

/// Room on a request for "this session just renewed" (2026-10-01, sliding sessions): an extractor
/// can't touch the response, so `renew_cookie` puts this on the request, the `Session` extractor
/// fills it when `account_for_token_renewing` pushed the expiry out, and `renew_cookie` sends the
/// cookie again on the way out.
#[derive(Clone, Default)]
pub struct RenewedSession(std::sync::Arc<std::sync::Mutex<Option<String>>>);

/// The middleware half of a session's renewal: re-send the session cookie, Max-Age and all, when
/// the request's session renewed - unless the response already says something about that cookie
/// (a logout clearing it), which stands.
pub async fn renew_cookie(
    State(state): State<AppState>,
    mut req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let slot = RenewedSession::default();
    req.extensions_mut().insert(slot.clone());
    let mut res = next.run(req).await;
    let Some(token) = slot.0.lock().expect("renewal slot poisoned").take() else {
        return res;
    };
    let name = session_cookie_name(state.config.port);
    let said = res
        .headers()
        .get_all(axum::http::header::SET_COOKIE)
        .iter()
        .any(|v| v.to_str().is_ok_and(|v| v.starts_with(&format!("{name}="))));
    if !said {
        if let Ok(value) = axum::http::HeaderValue::from_str(
            &super::routes::session_cookie(token, state.config.port).to_string(),
        ) {
            res.headers_mut().append(axum::http::header::SET_COOKIE, value);
        }
    }
    res
}

/// The header the desktop app's window names itself by, on every request it makes: the launch
/// token, which the shell hands its window alone and nothing else knows.
pub const WINDOW_HEADER: &str = "x-ringtome-window";

/// Is this request from the desktop app's own window? Only a request carrying this launch's
/// token says so - a browser on the same computer cannot, since the token is never written down.
/// It grants nothing: a request is who its cookie says, wherever it comes from.
pub fn window_offered(headers: &axum::http::HeaderMap, state: &AppState) -> bool {
    let Some(expected) = state.config.launch_token.as_deref() else { return false };
    headers
        .get(WINDOW_HEADER)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|given| secret_eq(given.trim(), expected))
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

/// The server is administered from a signed-in browser only: an API key never carries an account's
/// administering, whatever its tags (keys.rs).
fn refuse_key(session: &Session) -> Result<(), AppError> {
    if session.key.is_some() {
        return Err(AppError::Forbidden(crate::msg!(
            "auth.extractor.no-administering-by-key",
            "the server is administered from a signed-in browser, not with an API key"
        )));
    }
    Ok(())
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
        refuse_key(&session)?;
        let db = &state.node_db;
        if has_tag(db, &session.account.id, TAG_NODE_ADMIN).await? {
            Ok(NodeAdminSession { account: session.account })
        } else {
            Err(AppError::Forbidden(crate::msg!(
                "auth.extractor.nodeadmin-required",
                "node_admin required"
            )))
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
        refuse_key(&session)?;
        let db = &state.node_db;
        let id = &session.account.id;
        if has_tag(db, id, TAG_ADMIN).await? || has_tag(db, id, TAG_NODE_ADMIN).await? {
            Ok(AdminSession { account: session.account })
        } else {
            Err(AppError::Forbidden(crate::msg!("auth.extractor.admin-required", "admin required")))
        }
    }
}
