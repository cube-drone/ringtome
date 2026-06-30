use serde::{Serialize, Deserialize};
use axum::Json;
use axum::extract::{Path, State, Query};
use axum_extra::extract::cookie::{CookieJar, Cookie};
use time::Duration;
use anyhow::anyhow;
use uuid::Uuid;
use std::collections::HashMap;

use crate::{AppState, AppError, AppOk, AppJson};
use crate::modules::session::Session;
use crate::modules::user::{InviteCode, InviteCodeUseType};
use crate::request_context::RequestContext;
use crate::modules::session::extractors::{SessionExtractor, UnverifiedSessionExtractor, AdminSessionExtractor};

use super::VerificationCodeType;
use super::view::ApiUser;

#[derive(Debug, Clone, Deserialize)]
pub struct NewUser {
    pub name: String,
    pub email: Option<String>,
    pub phone_number: Option<String>,
    pub password: Option<String>,
    pub tos: bool,
}


#[derive(Debug, Deserialize)]
pub struct BasicAuthParams{
    pub touch: Option<bool>,
}

// GET /community/:slug/auth
//  can pass ?touch=true to do this without updating the last_login time or creating a superadmin user
//  (this defaults to false, meaning that last_login will be updated and superadmin user created if needed)
#[axum::debug_handler]
pub async fn get_session(
    // auth works with an unverified session: we need it on the UI side to find out if the user NEEDS to be verified
    UnverifiedSessionExtractor{session}: UnverifiedSessionExtractor,
    Query(query): Query<BasicAuthParams>,
    Path(slug): Path<String>,
    State(state): State<AppState>
    ) -> Result<Json<Session>, AppError> {

    let user_id = session.user_id.clone();

    tracing::info!("get_session: user_id: {:?}, community_slug: {:?}", user_id, session.community_slug);

    if session.community_slug != slug && session.community_slug != "admin" {
        return Err(AppError(anyhow!("400 Session does not match community.")));
    }

    // when the user hits this endpoint in particular, we should refresh the session
    let community = state.community_service.get_slug(&session.community_slug).await?.ok_or(anyhow!("404 community not found"))?;
    let community_db = state.community_service.get_database(&session.community_slug).await?;
    let user = community_db.user_service.get_user(&user_id).await?.ok_or(anyhow!("404 user not found"))?;

    let mut session = session;
    // there are a bunch of updates we might want to do to the session here,
    //  but only if "touch" is false ("touch" is just a quick check-in that doesn't update anything)
    if !query.touch.unwrap_or(false) {
        session = state.session_service.update_session(&session, &community, &user).await?;

        if session.community_slug == "admin" {
            // this user is from the special mega-community "admin"
            // which means they don't actually exist in the local community database
            // but we can MAKE them exist in the local community database if they don't already
            let other_community_db = state.community_service.get_database(&slug).await?;
            let other_user = other_community_db.user_service.get_user(&user_id).await?;
            if other_user.is_none() {
                tracing::warn!("Creating superadmin user in community {} for user_id {}", slug, user_id);
                other_community_db.user_service.create_superadmin_user(&user).await?;
            }
        }

        // while we're here, we can also update the last login time
        community_db.user_service.update_last_login(&session.user_id).await?;
    }

    Ok(Json(session))
}

// POST /community/:slug/auth/verify/email
#[axum::debug_handler]
pub async fn send_email_verification(
    // of course sending an email verification works with an unverified session: otherwise how would we verify a user?
    UnverifiedSessionExtractor{session}: UnverifiedSessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<AppOk>, AppError> {

    if !session.user_tags.contains(&"has_email".to_string()){
        return Err(AppError(anyhow!("400 No email to verify.")));
    }
    if session.user_tags.contains(&"email_verified".to_string()) {
        return Err(AppError(anyhow!("400 Email already verified.")));
    }
    // the user in the session? go fetch their user object
    let target_user_id = session.user_id;

    let user_view = state.community_service.get_database(&slug).await?.user_view;

    // create a new validation code, and send it to their email
    user_view.create_and_send_verification_code(&target_user_id, VerificationCodeType::Email, Some(&ctx)).await?;

    // their email will also contain a link to a verification station

    let app_ok = AppOk{
        message: "Email verification sent.".to_string()
    };

    Ok(Json(app_ok))
}


#[derive(Debug, Clone, Deserialize)]
pub struct VerificationCode {
    user_id: Uuid,
    code: String,
}

// POST /api/community/{:slug}/auth/verify/email/complete
#[axum::debug_handler]
pub async fn complete_email_verification(
    // note that there's NO session extractor here: this endpoint can be hit from an arbitrary email and does not require a session
    jar: CookieJar,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    Json(code_query): Json<VerificationCode>,
    )
    -> Result<(CookieJar, Json<AppOk>), AppError> {

    //tracing::info!("code: {:?}", code_query.code);

    let community_db = state.community_service.get_database(&slug).await?;
    let user_view = community_db.user_view;

    user_view.complete_verification(&code_query.user_id, &code_query.code, VerificationCodeType::Email, &ctx).await?;

    let session = user_view.create_session(&code_query.user_id).await?;

    // then give the session token to the requestor, in a cookie
    let cookie: Cookie = session.into();
    let jar = jar.add(cookie);

    let app_ok = AppOk{
        message: "Email verified.".to_string()
    };
    Ok((jar, Json(app_ok)))
}


// POST /community/:slug/auth/verify/sms
#[axum::debug_handler]
pub async fn send_sms_verification(
    UnverifiedSessionExtractor{session}: UnverifiedSessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<AppOk>, AppError> {

    if !session.user_tags.contains(&"has_phone".to_string()){
        return Err(AppError(anyhow!("400 No phone to verify.")));
    }
    if session.user_tags.contains(&"phone_verified".to_string()) {
        return Err(AppError(anyhow!("400 Phone already verified.")));
    }
    // the user in the session? go fetch their user object
    let target_user_id = session.user_id;

    let user_view = state.community_service.get_database(&slug).await?.user_view;

    // create a new validation code, and send it to their phone
    user_view.create_and_send_verification_code(&target_user_id, VerificationCodeType::Phone, Some(&ctx)).await?;

    let app_ok = AppOk{
        message: "SMS verification sent.".to_string()
    };

    Ok(Json(app_ok))
}


// POST /api/community/{:slug}/auth/verify/sms/complete
#[axum::debug_handler]
pub async fn complete_sms_verification(
    jar: CookieJar,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    Json(code_query): Json<VerificationCode>) -> Result<(CookieJar, Json<AppOk>), AppError> {
    //tracing::info!("code: {:?}", code_query.code);

    let community_db = state.community_service.get_database(&slug).await?;
    let user_view = community_db.user_view;

    user_view.complete_verification(&code_query.user_id, &code_query.code, VerificationCodeType::Phone, &ctx).await?;

    let session = user_view.create_session(&code_query.user_id).await?;

    // then give the session token to the requestor, in a cookie
    let cookie: Cookie = session.into();
    let jar = jar.add(cookie);

    let app_ok = AppOk{
        message: "Phone verified.".to_string()
    };
    Ok((jar, Json(app_ok)))
}

#[derive(Debug, Clone, Deserialize)]
pub struct InviteOptions {
    pub use_type: String,
}

#[derive(Debug, Serialize)]
pub struct InviteCodeResponse {
    pub invite_code: String,
}

// POST /api/community/{:slug}/invite
//   create an invite code for the community
#[axum::debug_handler]
pub async fn create_invite_code(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(options): AppJson<InviteOptions>) -> Result<Json<InviteCodeResponse>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let use_type_string: &str = &options.use_type;
    let use_type: InviteCodeUseType = use_type_string.into();

    if !session.is_admin {
        let community_config = community_db.community_settings_service.get_config().await?;
        if community_config.lock_community {
            return Err(AppError(anyhow!("403 Community is locked, only admins can create invite codes.")));
        }
        if !community_config.viral_growth_enabled {
            return Err(AppError(anyhow!("403 Viral growth is disabled, only admins can create invite codes.")));
        }
        if use_type == InviteCodeUseType::Unlimited {
            return Err(AppError(anyhow!("403 Only admins can create unlimited invite codes.")));
        }
    }

    let invite_code = community_db.user_view.create_invite_code(&session.user_id, use_type, &ctx).await?;

    Ok(Json(InviteCodeResponse{
        invite_code: invite_code.to_string()
    }))
}

// GET /api/community/{:slug}/invite
//   get all invite codes for a community
#[axum::debug_handler]
pub async fn get_invite_codes(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>) -> Result<Json<Vec<InviteCode>>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let community_config = community_db.community_settings_service.get_config().await?;

    // admins can see all invite codes, but non-admins can only see their own invite codes
    let invite_codes: Vec<InviteCode> = match session.is_admin{
        // user is not an admin:
        false => {
            if community_config.lock_community {
                return Err(AppError(anyhow!("403 Community is locked, only admins can view invite codes.")));
            }
            if !community_config.viral_growth_enabled {
                return Err(AppError(anyhow!("403 Viral growth is disabled, only admins can view invite codes.")));
            }

            community_db.user_service.get_invite_codes_for_user(&session.user_id).await?
        },
        // user is an admin:
        true => {
            community_db.user_service.get_invite_codes().await?
        }
    };

    Ok(Json(invite_codes))
}

// DELETE /api/community/{:slug}/invite/{:invite_code}
//    delete an invite code by its UUID
#[axum::debug_handler]
pub async fn delete_invite_code(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, invite_code)): Path<(String, String)>,
    State(state): State<AppState>,
    ctx: RequestContext
) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    let invite_uuid = invite_code.parse::<Uuid>()?;

    if session.is_admin == false {
        // check if the invite code exists and belongs to this user
        let invite_code = community_db.user_service.get_invite_code(&invite_uuid).await?;
        match invite_code {
            Some(invite_code) => {
                if invite_code.created_by != session.user_id {
                    return Err(AppError(anyhow!("403 Cannot delete invite code you did not create.")));
                }
            },
            None => {
                return Err(AppError(anyhow!("404 Invite code not found.")));
            }
        }
    }

    community_db.user_view.delete_invite_code(&session.user_id, &invite_uuid, &ctx).await?;

    Ok(Json(AppOk{
        message: "Invite code deleted.".to_string()
    }))
}

// POST /api/community/{:slug}/invite/{:invite_code}
//   given an invite code, create a user
//   (and, if the invite code is a one-time use code, delete it after use)
#[axum::debug_handler]
pub async fn create_user_with_invite_code(
    jar: CookieJar,
    Path((slug, invite_code)): Path<(String, String)>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(new_user): AppJson<NewUser>) -> Result<(CookieJar, Json<Session>), AppError> {

    if new_user.tos != true {
        return Err(AppError(anyhow!("You must agree to the terms of service to create a user.")));
    }

    let community_db = state.community_service.get_database(&slug).await?;
    let user_view = community_db.user_view;
    let invite_code_uuid = invite_code.parse::<Uuid>()?;

    let user_id = user_view.create_user(&invite_code_uuid, new_user, &ctx).await?;
    let session = user_view.create_session(&user_id).await?;

    let cookie: Cookie = session.clone().into();
    let jar = jar.add(cookie);

    Ok((jar, Json(session)))
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: Option<String>,
    pub phone_number: Option<String>,
    pub password: Option<String>,
}

// POST /api/community/{:slug}/login
#[axum::debug_handler]
pub async fn login(
    jar: CookieJar,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(login_request): AppJson<LoginRequest>) -> Result<(CookieJar, Json<Session>), AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let user_view = community_db.user_view;

    let session = user_view.login(
        login_request.email,
        login_request.phone_number,
        login_request.password,
        &ctx
    ).await?;

    let cookie: Cookie = session.clone().into();
    let jar = jar.add(cookie);

    Ok((jar, Json(session)))
}

// login token sends a token to the user's email or phone number
//  that they can use to log in (instead of a password)
// POST /api/community/{:slug}/login/token
#[axum::debug_handler]
pub async fn login_token(
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(login_request): AppJson<LoginRequest>) -> Result<Json<HashMap<String, Uuid>>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let user_service = community_db.user_service;

    if login_request.email.is_none() && login_request.phone_number.is_none() {
        return Err(AppError(anyhow!("400 No email or phone number provided.")));
    }
    if login_request.password.is_some() {
        return Err(AppError(anyhow!("400 Password not allowed.")));
    }
    let user_view = community_db.user_view;

    let user = match (login_request.email, login_request.phone_number) {
        (Some(email), None) => {
            // email, password
            let user = user_service.get_user_by_email(&email).await?;
            let user = match user{
                Some(user) => {
                    user
                },
                None => {
                    return Err(AppError(anyhow!("404 user not found")));
                }
            };
            user_view.create_and_send_verification_code(&user.id, VerificationCodeType::Login, Some(&ctx)).await?;

            user
        },
        (None, Some(phone_number)) => {
            // phone number, password
            let user = user_service.get_user_by_phone_number(&phone_number).await?;
            let user = match user{
                Some(user) => {
                    user
                },
                None => {
                    return Err(AppError(anyhow!("404 user not found")));
                }
            };

            user_view.create_and_send_verification_code(&user.id, VerificationCodeType::LoginSMS, Some(&ctx)).await?;

            user
        },
        _ => {
            return Err(AppError(anyhow!("400 No email or phone number provided.")));
        }
    };

    let mut map = HashMap::new();
    map.insert("userId".to_string(), user.id);
    map.insert("user_id".to_string(), user.id);

    Ok(Json(map))
}

// POST /api/community/{:slug}/login/token/complete
#[axum::debug_handler]
pub async fn complete_token_login(
    jar: CookieJar,
    Path(slug): Path<String>,
    Query(code_query): Query<VerificationCode>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<(CookieJar, Json<AppOk>), AppError> {
    //tracing::info!("code: {:?}", code_query.code);

    let community_db = state.community_service.get_database(&slug).await?;
    let user_view = community_db.user_view;

    // then give the session token to the requestor, in a cookie
    let session = user_view.complete_token_login(&code_query.user_id, &code_query.code, &ctx).await?;

    let cookie: Cookie = session.into();
    let jar = jar.add(cookie);

    let app_ok = AppOk{
        message: "Login successful!".to_string()
    };
    Ok((jar, Json(app_ok)))
}

// POST /api/community/{:slug}/logout
//    this will log a (logged in) user out of the system
#[axum::debug_handler]
pub async fn logout(
    UnverifiedSessionExtractor{session}: UnverifiedSessionExtractor,
    jar: CookieJar,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext
) -> Result<(CookieJar, Json<AppOk>), AppError> {

    // send a Logout event
    state.community_service.get_database(&slug).await?.user_view.logout(&session.session_key, &session.user_id, &ctx).await?;

    let jar = jar.remove(format!("session_{}", slug));

    let cookie_name = format!("session_{}", slug);

    // Build an expired cookie
    let expired_cookie = Cookie::build(cookie_name)
        .path("/") // Must match the original cookie's path
        .max_age(Duration::nanoseconds(0)) // Set max age to 0 to expire it
        .build();

    // Add the expired cookie to the jar
    let jar = jar.add(expired_cookie);

    Ok((jar, Json(AppOk{
        message: "Logged out.".to_string()
    })))
}

// GET /api/community/{:slug}/users
//     this will return all users in the community
#[axum::debug_handler]
pub async fn get_users(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>) -> Result<Json<Vec<ApiUser>>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    let users = community_db.user_view.get_users(&session.user_id).await?;

    Ok(Json(users))
}

// GET /api/community/{:slug}/admin_users
//     this will return all admin users in the community
#[axum::debug_handler]
pub async fn get_admin_users(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>) -> Result<Json<Vec<ApiUser>>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    let users = community_db.user_view.get_admin_users(&session.user_id).await?;

    Ok(Json(users))
}

// GET /api/community/{:slug}/user/{:user_id}
//    this will return a single user by their id
#[axum::debug_handler]
pub async fn get_user(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>) -> Result<Json<ApiUser>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let api_user = community_db.user_view.get_user(&user_id, &session.user_id).await?;

    Ok(Json(api_user))
}

// GET /api/community/{:slug}/slug/{:user_slug}
//    this will return a single user by their slug
#[axum::debug_handler]
pub async fn get_user_by_slug(
    SessionExtractor{session}: SessionExtractor,
    Path((slug, user_slug)): Path<(String, String)>,
    State(state): State<AppState>) -> Result<Json<ApiUser>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let api_user = community_db.user_view.get_user_by_slug(&user_slug, &session.user_id).await?;

    Ok(Json(api_user))
}

// DELETE /api/community/{:slug}/user/{:user_id}
#[axum::debug_handler]
pub async fn delete_user(
    AdminSessionExtractor{session}: AdminSessionExtractor,
    Path((slug, user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    community_db.user_view.delete_user(&session.user_id, &user_id, &ctx).await?;

    Ok(Json(AppOk{
        message: "User deleted.".to_string()
    }))
}

// POST /api/community/{:slug}/auth/change/password"
//    allow the current logged in user to change their password
//    I know what you're thinking, "what about password recovery?" - well, with login-via-token, we don't need that!
#[axum::debug_handler]
pub async fn change_password(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(new_password): AppJson<String>) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    community_db.user_view.change_password(&session.user_id, &new_password, &ctx).await?;

    Ok(Json(AppOk{
        message: "Password changed.".to_string()
    }))
}


// POST /api/community/{:slug}/auth/change/email
//   allow the current logged in user to change their email
//   note: this works kind of how you think it does: storing the new email in a "prospective_email" bin
//   and then sending a verification code to that email
//   and then once the user verifies the code, we can mark the email as verified and moving it to the "email" column
#[axum::debug_handler]
pub async fn change_email(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(new_email): AppJson<String>) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    community_db.user_view.change_email(&session.user_id, &new_email, &ctx).await?;

    Ok(Json(AppOk{
        message: "Email changed.".to_string()
    }))
}

// POST /api/community/{:slug}/auth/change/phone
//   allow the current logged in user to change their phone number
//   storing the new phone number in a "prospective_phone_number" bin
//   and then sending a verification code to that number
//   and then once the user verifies the code, we can mark the phone number as verified and moving it to the "phone_number" column
#[axum::debug_handler]
pub async fn change_phone_number(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(new_phone_number): AppJson<String>) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    let user_view = community_db.user_view;

    user_view.change_phone_number(&session.user_id, &new_phone_number, &ctx).await?;

    Ok(Json(AppOk{
        message: "Phone number changed.".to_string()
    }))
}

// POST /api/community/{:slug}/auth/change/name
//   allow the current logged in user to change their name
#[axum::debug_handler]
pub async fn change_name(
    SessionExtractor{session}: SessionExtractor,
    Path(slug): Path<String>,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(new_name): AppJson<String>) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    if new_name.is_empty() {
        return Err(AppError(anyhow!("400 Name cannot be empty.")));
    }

    community_db.user_view.change_name(&session.user_id, &new_name, &ctx).await?;

    Ok(Json(AppOk{
        message: "Name changed.".to_string()
    }))
}


// POST /community/{:slug}/user/{:user_id}/lock
#[axum::debug_handler]
pub async fn lock_user(
    AdminSessionExtractor{session}: AdminSessionExtractor,
    Path((slug, user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;

    community_db.user_view.lock_user(&session.user_id, &user_id, &ctx).await?;

    Ok(Json(AppOk{
        message: "User locked.".to_string()
    }))
}

// POST /community/{:slug}/user/{:user_id}/unlock
#[axum::debug_handler]
pub async fn unlock_user(
    AdminSessionExtractor{session}: AdminSessionExtractor,
    Path((slug, user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext
) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    community_db.user_view.unlock_user(&session.user_id, &user_id, &ctx).await?;

    Ok(Json(AppOk{
        message: "User unlocked.".to_string()
    }))
}

// POST /community/{:slug}/user/{:user_id}/admin
#[axum::debug_handler]
pub async fn make_user_admin(
    AdminSessionExtractor{session}: AdminSessionExtractor,
    Path((slug, user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    community_db.user_view.admin_user(&session.user_id, &user_id, &ctx).await?;

    Ok(Json(AppOk{
        message: "User made admin.".to_string()
    }))
}

// POST /api/community/{:slug}/user/{:user_id}/unadmin
#[axum::debug_handler]
pub async fn unmake_user_admin(
    AdminSessionExtractor{session}: AdminSessionExtractor,
    Path((slug, user_id)): Path<(String, Uuid)>,
    State(state): State<AppState>,
    ctx: RequestContext,
) -> Result<Json<AppOk>, AppError> {

    let community_db = state.community_service.get_database(&slug).await?;
    community_db.user_view.unadmin_user(&session.user_id, &user_id, &ctx).await?;

    Ok(Json(AppOk{
        message: "User unmade admin.".to_string()
    }))
}

// POST /api/community/{:slug}/force/verify
// a cheating endpoint that will force verify a user (for testing)
#[axum::debug_handler]
pub async fn force_verify(
    UnverifiedSessionExtractor{session}: UnverifiedSessionExtractor,
    jar: CookieJar,
    Path(slug): Path<String>,
    State(state): State<AppState>
) -> Result<(CookieJar, Json<AppOk>), AppError> {
    let config = state.config.clone();
    if config.is_prod() {
        return Err(AppError(anyhow!("400 This endpoint is only available in development.")));
    }

    let community_db = state.community_service.get_database(&slug).await?;
    let user_service = community_db.user_service;

    if session.user_tags.contains(&"has_email".to_string()) {
        user_service.verify_email(&session.user_id).await?;
    }
    if session.user_tags.contains(&"has_phone".to_string()) {
        user_service.verify_sms(&session.user_id).await?;

        if session.user_tags.contains(&"owner".to_string()){
            state.community_service.verify(&session.community_id).await?;
        }
    }

    let community = state.community_service.get_slug(&slug).await?.ok_or(anyhow!("404 community not found"))?;
    let user = user_service.get_user(&session.user_id).await?.ok_or(anyhow!("404 user not found"))?;
    let session = state.session_service.update_session(&session, &community, &user).await?;

    let cookie: Cookie = session.into();
    let jar = jar.add(cookie);

    Ok((jar, Json(AppOk{
        message: "Forced verification.".to_string()
    })))
}

// POST /api/community/{:slug}/force/admin
// a cheating endpoint that will force admin a user (for testing)
#[axum::debug_handler]
pub async fn force_admin(
    UnverifiedSessionExtractor{session}: UnverifiedSessionExtractor,
    jar: CookieJar,
    Path(slug): Path<String>,
    State(state): State<AppState>
) -> Result<(CookieJar, Json<AppOk>), AppError> {
    let config = state.config.clone();
    if config.is_prod() {
        return Err(AppError(anyhow!("400 This endpoint is only available in development.")));
    }

    let community_db = state.community_service.get_database(&slug).await?;
    let user_service = community_db.user_service;
    user_service.admin_user(&session.user_id).await?;

    let user = user_service.get_user(&session.user_id).await?.ok_or(anyhow!("404 user not found"))?;
    let community = state.community_service.get_slug(&slug).await?.ok_or(anyhow!("404 community not found"))?;
    let session = state.session_service.update_session(&session, &community, &user).await?;

    let cookie: Cookie = session.into();
    let jar = jar.add(cookie);

    Ok((jar, Json(AppOk{
        message: "Forced admin.".to_string()
    })))
}
