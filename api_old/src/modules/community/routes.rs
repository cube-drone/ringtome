use axum::extract::{Json, State, Path, Query};
use serde::{Serialize, Deserialize};
use anyhow::anyhow;
use validator::Validate;
use axum_extra::extract::cookie::{CookieJar, Cookie};
use regex::Regex;
use std::sync::LazyLock;

use crate::{AppState, AppError, AppJson, AppOk};
use crate::modules::user::routes::NewUser;
use super::Community;
use crate::modules::session::Session;
use crate::request_context::RequestContext;


static RE_PHONE_NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[0-9]*").unwrap()
});

#[derive(Debug, Validate, Clone, Serialize, Deserialize)]
pub struct NewCommunity {
    #[validate(length(min = 1, max = 100))]
    pub community_name: String,
    #[validate(length(min = 1))]
    pub name: String,
    #[validate(length(min = 8, max = 100))]
    pub password: Option<String>,
    #[validate(length(min = 1), email)]
    pub email: Option<String>,
    #[validate(length(min = 7), regex(path = *RE_PHONE_NUMBER))]
    pub phone_number: Option<String>,
    pub tos: bool,
}

#[derive(Debug, Serialize)]
pub struct ApiCommunity{
    pub community_name: String,
    pub community_slug: String,
}

impl From<Community> for ApiCommunity{
    fn from(community: Community) -> Self {
        Self{
            community_name: community.name.clone(),
            community_slug: community.slug.clone(),
        }
    }
}

impl From<NewCommunity> for NewUser{
    fn from(new_community: NewCommunity) -> Self {
        Self{
            name: new_community.name.clone(),
            email: new_community.email.clone(),
            phone_number: new_community.phone_number.clone(),
            password: new_community.password.clone(),
            tos: new_community.tos,
        }
    }
}

// POST /community
#[axum::debug_handler]
pub async fn create_community(
    jar: CookieJar,
    State(state): State<AppState>,
    ctx: RequestContext,
    AppJson(community): AppJson<NewCommunity>
) -> Result<(CookieJar, Json<Session>), AppError> {
    let community_service = state.community_service;

    state.rate_limiting_service.ctx_limit_per_minute("create_community", &ctx, 1).await?;
    state.rate_limiting_service.ctx_limit_per_day("create_community", &ctx, 8).await?;

    if community.tos != true {
        return Err(AppError(anyhow!("You must agree to the terms of service to create a community.")));
    }

    match community.validate() {
        Ok(_) => {},
        Err(e) => return Err(AppError(e.into()))
    }

    // first, create the community
    let created_community = community_service.create(community.clone()).await?;

    // then create the database for the community
    let community_db = match community_service.get_database(&created_community.slug).await {
        Ok(db) => db,
        Err(e) => {
            tracing::info!("Error creating database: {:?}", e);
            tracing::info!("Deleting community.");
            community_service.delete(&created_community.slug).await?;
            return Err(AppError(e));
        }
    };
    let user_service = community_db.user_service.clone();

    // then create a user for the community
    let new_user = community.into();
    let created_user = match user_service.create_user(new_user, true).await {
        Ok(created_user) => {created_user},
        Err(e) => {
            // if we can't create the user, we should delete the community and database (because an empty community is useless and confusing)
            tracing::info!("Error creating user: {:?}", e);
            tracing::info!("Deleting community and database.");
            community_db.delete().await?;
            community_service.delete(&created_community.slug).await?;
            return Err(AppError(e));
        }
    };

    // then create a session for the user
    let session_service = state.session_service.clone();
    let session = session_service.create_session(&created_community, &created_user).await?;

    // then give the session token to the requestor, in a cookie
    let cookie: Cookie = session.clone().into();
    let jar = jar.add(cookie);

    Ok((jar, Json(session)))
}

#[derive(Debug, Deserialize)]
pub struct StubTestRequest{
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct StubTestResponse{
    pub slug: String,
}

// POST /community/name
#[axum::debug_handler]
pub async fn test_name(State(state): State<AppState>, AppJson(request_body): AppJson<StubTestRequest>) -> Result<Json<StubTestResponse>, AppError> {
    let community_service = state.community_service;
    let name = request_body.name.clone();

    let slug = community_service.get_valid_slug(&name).await?;

    Ok(Json(StubTestResponse{
        slug
    }))
}

// GET /community/:slug
#[axum::debug_handler]
pub async fn get_community(Path(slug): Path<String>, State(state): State<AppState>) -> Result<Json<ApiCommunity>, AppError> {
    let community_service = state.community_service;

    let community = community_service.get_slug(&slug).await?;

    match community {
        Some(community) => Ok(Json(community.into())),
        None => Err(AppError(anyhow!("Community not found.")))
    }
}

// PUT /community/:slug/admin
#[axum::debug_handler]
pub async fn make_admin(
    Path(slug): Path<String>,
    State(state): State<AppState>) -> Result<Json<AppOk>, AppError> {

    if state.config.is_prod(){
        return Err(AppError(anyhow!("This endpoint is not available in production.")));
    }

    let community_service = state.community_service;
    let community = community_service.get_slug(&slug).await?.ok_or(anyhow!("404 community not found"))?;
    community_service.add_tag(&community.id, &"admin").await?;

    Ok(Json(AppOk{
        message: "Admin added.".to_string()
    }))
}

#[derive(Debug, Deserialize)]
pub struct ListCommunityQuery {
    pub prefix: Option<String>,
    pub n: Option<i64>,
    pub offset: Option<i64>,
}

// GET /community
#[axum::debug_handler]
pub async fn get_communities(
    Query(list_community_query): Query<ListCommunityQuery>,
    State(state): State<AppState>,
    jar: CookieJar) -> Result<(CookieJar, Json<Vec<ApiCommunity>>), AppError> {
    let community_service = state.community_service;
    let communities = community_service.list_communities(list_community_query.prefix, list_community_query.n, list_community_query.offset).await?;

    let communities: Vec<ApiCommunity> = communities.into_iter().map(|c| c.into()).collect();

    Ok((jar, Json(communities)))
}