use axum::{
    extract::{FromRequestParts, State},
    http::request::Parts,
};
use axum_extra::extract::CookieJar;
use anyhow::{Result, anyhow};

use crate::modules::session::Session;
use crate::AppState;
use crate::app_error::AppError;

// this is a helper function that will take a cookie jar, a slug, and the app state
//  and return a session if it exists
pub async fn expand_session(jar: CookieJar, slug: &str, state: &AppState, test_verified: bool) -> Result<Session, AppError> {
    // dump all cookies:
    let mut counter = 0;
    for _cookie in jar.iter() {
        //tracing::info!("cookie: {:?}", cookie);
        counter += 1;
    }
    //tracing::info!("cookie count: {:?}", counter);
    if counter == 0 {
        return Err(AppError(anyhow!("400 No cookies found at all.")));
    }

    // so, session_<slug> is the cookie for this community,
    //  _but_ we also allow users from the "admin" community to log in to ANY community
    // (it's a special super-community)
    let possible_cookies = vec![
        format!("session_{}", slug),
        "session_admin".to_string(),
    ];

    let cookie = possible_cookies.iter().find_map(|name| jar.get(name)).ok_or(AppError(anyhow!("400 No session cookie found.")))?;
    let session_key = cookie.value();

    match state.session_service.get_session(&session_key).await? {
        Some(session) => {
            // TODO: there are some things we validate here maybe:
            // - throw out sessions that have expired or died somehow

            // IF the user isn't in the email verification flow, throw out the session if has_email but not email_verified
            if test_verified &&
                session.user_tags.contains(&"has_email".to_string()) &&
                !session.user_tags.contains(&"email_verified".to_string()) {

                return Err(AppError(anyhow!("400 Email not verified.")));
            }
            // IF the user isn't in the phone verification flow, throw out the session if has_phone but not phone_verified
            if test_verified &&
                session.user_tags.contains(&"has_phone".to_string()) &&
                !session.user_tags.contains(&"phone_verified".to_string()) {

                return Err(AppError(anyhow!("400 Phone not verified.")));
            }
            if test_verified &&
                !session.community_tags.contains(&"verified".to_string()) {

                return Err(AppError(anyhow!("400 Community not verified.")));
            }

            Ok(session)
        },
        None => Err(AppError(anyhow!("400 Session not valid.")))
    }
}

fn extract_slug(parts: &mut Parts) -> Result<String, AppError> {
    // Extract slug from URI path without using Path extractor
    // Example path: /api/community/the-disk-pestobread-guild/user/a37b1...
    let path_segments: Vec<&str> = parts
        .uri
        .path()
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();

    // Expected layout: ["api", "community", "<slug>", "user", "<user_id>", ...]
    let slug = path_segments
        .get(2) // index 2 should be the slug
        .ok_or_else(|| AppError(anyhow!("400 Missing slug in path.")))?;

    Ok(slug.to_string())
}

pub struct SessionExtractor {
    pub session: Session,
}

// This tells Axum how to build SessionExtractor from the request.
impl FromRequestParts<AppState> for SessionExtractor
where
    AppState: Clone + Send + Sync, // your AppState type
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {

        // Get shared state (cloned from Router's `with_state`).
        let State(app_state) = State::<AppState>::from_request_parts(parts, state).await?;

        // Get cookie jar
        let jar = CookieJar::from_request_parts(parts, state).await?;

        let slug = extract_slug(parts)?;

        // Call your existing helper
        let session = expand_session(jar, &slug, &app_state, true).await?;

        Ok(Self { session })
    }
}

pub struct UnverifiedSessionExtractor {
    pub session: Session,
}

// This tells Axum how to build UnverifiedSessionExtractor from the request.
impl FromRequestParts<AppState> for UnverifiedSessionExtractor
where
    AppState: Clone + Send + Sync, // your AppState type
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {

        // Get shared state (cloned from Router's `with_state`).
        let State(app_state) = State::<AppState>::from_request_parts(parts, state).await?;

        // Get cookie jar
        let jar = CookieJar::from_request_parts(parts, state).await?;

        // Get slug from path
        let slug = extract_slug(parts)?;

        // Call your existing helper
        let session = expand_session(jar, &slug, &app_state, false).await?;

        Ok(Self { session })
    }
}

pub struct AdminSessionExtractor {
    pub session: Session,
}

// This tells Axum how to build AdminSessionExtractor from the request.
impl FromRequestParts<AppState> for AdminSessionExtractor
where
    AppState: Clone + Send + Sync, // your AppState type
{
    type Rejection = AppError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {

        // Get shared state (cloned from Router's `with_state`).
        let State(app_state) = State::<AppState>::from_request_parts(parts, state).await?;

        // Get cookie jar
        let jar = CookieJar::from_request_parts(parts, state).await?;

        // Get slug from path
        let slug = extract_slug(parts)?;

        // Call your existing helper
        let session = expand_session(jar, &slug, &app_state, true).await?;

        if !session.is_admin {
            return Err(AppError(anyhow!("400 Not an admin user.")));
        }

        Ok(Self { session })
    }
}