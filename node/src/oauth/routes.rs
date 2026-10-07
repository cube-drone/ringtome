//! The OAuth doors (oauth.rs): the two metadata documents, registration and the token door - which
//! programs call, so they answer in OAuth's own words and to any origin, never with a cookie - and
//! the consent page's two doors, which only a signed-in browser opens.

use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Form, Json, Router};
use serde::Deserialize;
use serde_json::json;
use tower_http::cors::CorsLayer;

use super::{Ask, Refusal};
use crate::auth::Session;
use crate::error::AppError;
use crate::AppState;

/// Every door here. The programs' doors answer any origin (a browser-based client registers and
/// trades its code from a page of its own) - safe because none of them reads a cookie. `route_layer`
/// rather than `layer`, so the CORS stays on these routes and off the fallback (mcp.rs, the same
/// lesson).
pub fn router() -> Router<AppState> {
    let programs = Router::new()
        .route("/.well-known/oauth-protected-resource", get(resource_metadata))
        .route("/.well-known/oauth-protected-resource/mcp", get(resource_metadata))
        .route("/.well-known/oauth-authorization-server", get(server_metadata))
        .route("/oauth/register", post(register_handler))
        .route("/oauth/token", post(token_handler))
        .route_layer(CorsLayer::permissive());
    programs
        // The consent page is the app's: it signs a visitor in first, as any page does.
        .route("/oauth/authorize", get(crate::ui::homepage))
        .route("/api/oauth/request", get(request_handler))
        .route("/api/oauth/consent", post(consent_handler))
}

/// The protected resource, `/mcp`, as this node's authorization server is asked about it.
pub fn resource_url(base: &str) -> String {
    format!("{base}{}", crate::mcp::PATH)
}

/// Where the 401 from `/mcp` points a client (RFC 9728 §5.1): the resource's metadata.
pub fn resource_metadata_url(base: &str) -> String {
    format!("{base}/.well-known/oauth-protected-resource{}", crate::mcp::PATH)
}

/// GET `/.well-known/oauth-protected-resource[/mcp]` (RFC 9728): `/mcp`, and who authorizes it.
async fn resource_metadata(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let base = crate::nodeface::public_base(&state, &headers);
    Json(json!({
        "resource": resource_url(&base),
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "resource_name": "Horse Drawing Tycoon 2",
    }))
    .into_response()
}

/// GET `/.well-known/oauth-authorization-server` (RFC 8414): the doors, and what they speak.
async fn server_metadata(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let base = crate::nodeface::public_base(&state, &headers);
    Json(json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/oauth/authorize"),
        "token_endpoint": format!("{base}/oauth/token"),
        "registration_endpoint": format!("{base}/oauth/register"),
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": ["none"],
        "client_id_metadata_document_supported": true,
        "authorization_response_iss_parameter_supported": true,
    }))
    .into_response()
}

/// An OAuth answer, never cached (RFC 6749 §5.1).
fn oauth(status: StatusCode, body: serde_json::Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn refused(status: StatusCode, refusal: Refusal) -> Response {
    oauth(status, json!({ "error": refusal.error, "error_description": refusal.description }))
}

/// POST `/oauth/register` (RFC 7591): a client registers itself. Public clients only - it is told
/// so (`token_endpoint_auth_method: none`), whatever it asked for.
async fn register_handler(
    State(state): State<AppState>,
    Json(req): Json<super::Registration>,
) -> Response {
    match super::register(&state.node_db, &req).await {
        Ok(client) => oauth(
            StatusCode::CREATED,
            json!({
                "client_id": client.id,
                "client_name": client.name,
                "redirect_uris": client.redirect_uris,
                "token_endpoint_auth_method": "none",
                "grant_types": ["authorization_code"],
                "response_types": ["code"],
                "client_id_issued_at": crate::clock::now_ms() / 1000,
            }),
        ),
        Err(refusal) => refused(StatusCode::BAD_REQUEST, refusal),
    }
}

#[derive(Deserialize)]
struct TokenRequest {
    grant_type: String,
    code: Option<String>,
    redirect_uri: Option<String>,
    client_id: Option<String>,
    code_verifier: Option<String>,
}

/// POST `/oauth/token` (RFC 6749 §4.1.3): a code and its verifier, traded for a new API key in the
/// consenting account's name - the client's name on it, so the settings page says who holds it.
async fn token_handler(State(state): State<AppState>, Form(req): Form<TokenRequest>) -> Response {
    if req.grant_type != "authorization_code" {
        return refused(
            StatusCode::BAD_REQUEST,
            Refusal::new("unsupported_grant_type", "only authorization_code"),
        );
    }
    let (Some(code), Some(redirect), Some(client), Some(verifier)) =
        (req.code, req.redirect_uri, req.client_id, req.code_verifier)
    else {
        return refused(
            StatusCode::BAD_REQUEST,
            Refusal::new("invalid_request", "code, redirect_uri, client_id and code_verifier"),
        );
    };
    let redeemed = match super::redeem(&state.node_db, &code, &client, &redirect, &verifier).await {
        Ok(redeemed) => redeemed,
        Err(refusal) => return refused(StatusCode::BAD_REQUEST, refusal),
    };
    let name = format!("{} (assistant)", redeemed.client_name);
    match crate::auth::keys::mint(&state.node_db, &redeemed.account, &name).await {
        Ok(minted) => {
            oauth(StatusCode::OK, json!({ "access_token": minted.key, "token_type": "Bearer" }))
        }
        Err(e) => refused(
            StatusCode::BAD_REQUEST,
            Refusal::new(
                "invalid_grant",
                e.user_message()
                    .map_or_else(|| "the key wasn't made".to_string(), |m| m.english.clone()),
            ),
        ),
    }
}

/// The refusal a person reads on the consent page.
fn for_a_person(refusal: Refusal) -> AppError {
    AppError::BadRequest(crate::msg!(
        "oauth.this-assistant-cant-connect",
        "this assistant can't connect: {why}",
        why = refusal.description
    ))
}

/// GET `/api/oauth/request` - the consent page asks what it is being asked: which client, sending
/// the person back where. Checked here before anyone is shown a button.
async fn request_handler(
    session: Session,
    State(state): State<AppState>,
    Query(ask): Query<Ask>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::auth::keys::by_browser(&session)?;
    let client = super::check(&state, &ask).await.map_err(for_a_person)?;
    let goes_to = url::Url::parse(&ask.redirect_uri)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| ask.redirect_uri.clone());
    Ok(Json(json!({
        "client": { "name": client.name, "id": client.id },
        "goes_to": goes_to,
        "account": session.account.username,
    })))
}

#[derive(Deserialize)]
struct Consent {
    #[serde(flatten)]
    ask: Ask,
    approve: bool,
}

/// POST `/api/oauth/consent` - the person's answer, from a signed-in browser and never a key (keys
/// are made from a browser: auth/keys.rs). Yes mints a code; either answer is a redirect back to the
/// client, which the page follows.
async fn consent_handler(
    session: Session,
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(consent): Json<Consent>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::auth::keys::by_browser(&session)?;
    let ask = consent.ask;
    let client = super::check(&state, &ask).await.map_err(for_a_person)?;
    let mut back = url::Url::parse(&ask.redirect_uri).map_err(|_| {
        for_a_person(Refusal::new("invalid_request", "the redirect URI isn't a URL"))
    })?;
    // The code is minted before the query is touched: its editor holds the URL, and must not be
    // held across an await.
    let code = match consent.approve {
        true => Some(
            super::issue(&state.node_db, &client, &ask, &session.account.id.to_string())
                .await
                .map_err(AppError::Internal)?,
        ),
        false => None,
    };
    {
        let mut query = back.query_pairs_mut();
        match &code {
            Some(code) => query.append_pair("code", code),
            None => query.append_pair("error", "access_denied"),
        };
        if let Some(st) = &ask.state {
            query.append_pair("state", st);
        }
        // RFC 9207: the issuer, so a client talking to several can't be sent another's code.
        query.append_pair("iss", &crate::nodeface::public_base(&state, &headers));
    }
    Ok(Json(json!({ "redirect": back.to_string() })))
}
