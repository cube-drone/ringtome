use axum::extract::{Json, State, Query};
use serde::{Serialize};
use anyhow::anyhow;
use std::collections::BTreeMap;

use crate::{AppState, AppError};

#[derive(Debug, Serialize)]
pub struct WebfingerLink {
    pub rel: String,
    pub r#type: Option<String>,
    pub template: Option<String>,
    pub href: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct WebfingerResponse {
    pub subject: String,
    pub aliases: Vec<String>,
    pub links: Vec<WebfingerLink>,
}

fn webfinger_response(resource: &str, community_slug: &str, user_slug: &str, site_url: &str) -> WebfingerResponse {
    let subject = resource.to_string();
    let aliases = vec![
        format!("{}/community/{}/user/{}", site_url, community_slug, user_slug),
    ];
    let links = vec![
        // this is where people get sent when they want to view the profile page in a browser
        WebfingerLink {
            rel: "http://webfinger.net/rel/profile-page".to_string(),
            r#type: Some("text/html".to_string()),
            template: None,
            href: Some(format!("{}/community/{}/user/{}", site_url, community_slug, user_slug)),
        },
        // this is the important one: the ActivityPub actor link
        WebfingerLink {
            rel: "self".to_string(),
            r#type: Some("application/activity+json".to_string()),
            template: None,
            href: Some(format!("{}/api/community/{}/user/{}/actor", site_url, community_slug, user_slug)),
        },
        WebfingerLink{
            rel: "http://webfinger.net/rel/avatar".to_string(),
            r#type: Some("image/png".to_string()),
            template: None,
            href: Some(format!("{}/api/community/{}/user/{}/avatar", site_url, community_slug, user_slug)),
        },
        // this one, afaict, doesn't change at all
        // also not sure what it's for, yet, but Mastodon includes it
        WebfingerLink {
            rel: "http://ostatus.org/schema/1.0/subscribe".to_string(),
            r#type: None,
            template: Some(format!("{}/api/authorize_interaction?uri={}", site_url, "{uri}")),
            href: None,
        },
    ];

    WebfingerResponse {
        subject,
        aliases,
        links,
    }
}

// GET /.well-known/webfinger
#[axum::debug_handler]
pub async fn webfinger(
    Query(params): Query<std::collections::HashMap<String, String>>,
    State(state): State<AppState>) -> Result<Json<WebfingerResponse>, AppError> {

    let community_service = state.community_service;

    let resource = params.get("resource").ok_or(AppError(anyhow!("400 Missing resource parameter.")))?;

    // the resource should be of the form acct:username:community_slug@domain
    // OR acct:username@community_slug.domain
    // either way, we need to extract the community slug, then check for a user with that username in that community

    // resource might be structured like

    let parts = resource.split('@').collect::<Vec<&str>>();
    if parts.len() != 2 {
        return Err(AppError(anyhow!("400 Invalid resource parameter.")));
    }

    let username_part = parts[0];
    let domain_part = parts[1];

    let username_split = username_part.split(':').collect::<Vec<&str>>();
    // either _username is split into 2 or 3 parts:
    // acct:username or acct:username:community_slug
    let community_slug: String;
    let username: String;
    if username_split.len() < 2 || username_split.len() > 3 {
        return Err(AppError(anyhow!("400 Invalid resource parameter.")));
    }
    if username_split.len() == 3 {
        username = username_split[1].to_string();
        community_slug = username_split[2].to_string();
    } else {
        username = username_split[1].to_string();
        // extract community slug from domain_part
        let domain_split = domain_part.split('.').collect::<Vec<&str>>();
        if domain_split.len() < 2 {
            return Err(AppError(anyhow!("400 Invalid resource parameter.")));
        }
        community_slug = domain_split[0].to_string();
    }

    // now, look up the user in the community
    let community_db = community_service.get_database(&community_slug).await?;
    let user_service = community_db.user_service.clone();
    let user = user_service.get_user_by_slug(&username).await?.ok_or(AppError(anyhow!("404 User not found.")))?;

    // despite having to do those lookups, we actually have all the info we need to build the webfinger response without any of that data
    // (we just wanted to helpfully 404 if the user or community didn't exist)
    let site_url = state.config.site_url.clone();
    let webfinger_response = webfinger_response(resource, &community_slug, &user.slug, &site_url);

    Ok(Json(webfinger_response))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPubPublicKey {
    pub id: String,                     // URI to the public key object (in the example, it's the actor's URI + "#main-key")
    pub owner: String,                  // URI to the actor (again, this URI)
    pub public_key_pem: String,         // the actual public key in PEM format
    /*
    e.g.
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvNDR1W7dlQXUF2aRHcqG\nWJ/yk07kud9mzO45w+8NPxDrSN6J1HlKHyXrOauDb33rlmOG/oLb/e6LkNb2P1B4\n3LKQBnbWWPKTJwVFt1XUIEy0Sqa7kgKjaYYZxE7BvMRXaHwXMC9jCtVvJQ2MOyHz\nLgL5LprxoAnfL7zEucI9wgldySogUhbI9RYrMtjZcJnfJb17jdNFefwgGfpy8ND9\n77BJe2rx15+KtOhDKX2dooVxSJEBtpbsIYUTdRHImPY39eJMVbsF0fgQHaa5jAbD\nn16WDKV7soIShbpFo6TR4mmYu5utrcblNmmMQhan1fO09mqk98OB9nJODr8KllnV\nkwIDAQAB\n-----END PUBLIC KEY-----\n"
    */
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
// each of these is, I think, one of the users' links to another site
pub struct ActivityPubAttachment {
    pub r#type: String,                 // In the example I see, this is "PropertyValue" every single time
    pub name: String,                   // "web page", "blog",
    pub value: String,                  // you'd think this would be a url, but it's actually some _HTML_. Gross.
    /*
        Here's an example of an attachment value:
        why "invisible" spans?
        "<a href=\"https://jennschiffer.com\" target=\"_blank\" rel=\"nofollow noopener me\" translate=\"no\"><span class=\"invisible\">https://</span><span class=\"\">jennschiffer.com</span><span class=\"invisible\"></span></a>
     */
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
// endpoints
pub struct ActivityPubEndpoints {
    pub shared_inbox: Option<String>,   // URI to the shared inbox ( ??? TODO: what's a shared inbox? )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPubImage {
    pub r#type: String,                 // "Image"
    pub media_type: String,             // it's a mimetype! "image/png"
    pub url: String,                    // URI to the image
}

/*
    "manuallyApprovesFollowers": "as:manuallyApprovesFollowers",
    "toot": "http://joinmastodon.org/ns#",
    "featured": {
        "@id": "toot:featured",
        "@type": "@id"
    },
    "featuredTags": {
        "@id": "toot:featuredTags",
        "@type": "@id"
    },
    "alsoKnownAs": {
        "@id": "as:alsoKnownAs",
        "@type": "@id"
    },
    "movedTo": {
        "@id": "as:movedTo",
        "@type": "@id"
    },
    "schema": "http://schema.org#",
    "PropertyValue": "schema:PropertyValue",
    "value": "schema:value",
    "discoverable": "toot:discoverable",
    "suspended": "toot:suspended",
    "memorial": "toot:memorial",
    "indexable": "toot:indexable",
    "attributionDomains": {
        "@id": "toot:attributionDomains",
        "@type": "@id"
    },
    "focalPoint": {
        "@container": "@list",
        "@id": "toot:focalPoint"
    }
*/

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPubContext{
    manually_approves_followers: String,
    toot: String,
    featured: BTreeMap<String, String>,
    featured_tags: BTreeMap<String, String>,
    also_known_as: BTreeMap<String, String>,
    moved_to: BTreeMap<String, String>,
    schema: String,
    #[serde(rename = "PropertyValue")]
    property_value: String,
    value: String,
    discoverable: String,
    suspended: String,
    memorial: String,
    indexable: String,
    attribution_domains: BTreeMap<String, String>,
    focal_point: BTreeMap<String, String>,
}

fn standard_context() -> ActivityPubContext {
    ActivityPubContext {
        manually_approves_followers: "as:manuallyApprovesFollowers".to_string(),
        toot: "http://joinmastodon.org/ns#".to_string(),
        featured: {
            let mut map = BTreeMap::new();
            map.insert("@id".to_string(), "toot:featured".to_string());
            map.insert("@type".to_string(), "@id".to_string());
            map
        },
        featured_tags: {
            let mut map = BTreeMap::new();
            map.insert("@id".to_string(), "toot:featuredTags".to_string());
            map.insert("@type".to_string(), "@id".to_string());
            map
        },
        also_known_as: {
            let mut map = BTreeMap::new();
            map.insert("@id".to_string(), "as:alsoKnownAs".to_string());
            map.insert("@type".to_string(), "@id".to_string());
            map
        },
        moved_to: {
            let mut map = BTreeMap::new();
            map.insert("@id".to_string(), "as:movedTo".to_string());
            map.insert("@type".to_string(), "@id".to_string());
            map
        },
        schema: "http://schema.org#".to_string(),
        property_value: "schema:PropertyValue".to_string(),
        value: "schema:value".to_string(),
        discoverable: "toot:discoverable".to_string(),
        suspended: "toot:suspended".to_string(),
        memorial: "toot:memorial".to_string(),
        indexable: "toot:indexable".to_string(),
        attribution_domains: {
            let mut map = BTreeMap::new();
            map.insert("@id".to_string(), "toot:attributionDomains".to_string());
            map.insert("@type".to_string(), "@id".to_string());
            map
        },
        focal_point: {
            let mut map = BTreeMap::new();
            map.insert("@container".to_string(), "@list".to_string());
            map.insert("@id".to_string(), "toot:focalPoint".to_string());
            map
        },
    }
}


#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum JsonLdContextItem {
    Iri(String),
    // Usually a JSON object: { "toot": "...", "featured": { "@id": "...", "@type": "@id" }, ... }
    Object(ActivityPubContext),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPubActor {
    #[serde(rename = "@context")]
    pub context: Vec<JsonLdContextItem>,
    pub id: String,                     // the actor's URI (where we are, right now!)
    pub r#type: String,                 // "Person"
    pub following: String,              // URI to the following collection
    pub followers: String,              // URI to the followers collection
    pub inbox: String,                  // URI to the inbox
    pub outbox: String,                 // URI to the outbox
    pub featured: String,               // URI to the featured collection
    pub featured_tags: String,          // URI to the featured tags collection
    pub name: String,                   // the user's display name, "Harble Darble: Wonderfunk Dudestar" - easily changeable
    pub preferred_username: String,     // the user's slug - machine stable, ASCII-safe identifier that should not change
    pub summary: String,                // the user's bio (HTML allowed)
    pub url: String,                    // the user's profile page URL
    pub manually_approves_followers: bool, // whether the user manually approves followers (it's going to be always false for now, we don't support this feature)
    pub discoverable: bool,             // whether the account should appear in server-side discoverability features, like local directories, "suggested users", search, etc.
    pub indexable: bool,                // whether the account should be indexed by search engines
    pub memorial: bool,                 // I _think_ this is whether or not the user is dead.
    pub published: String,              // timestamp of when the actor was created, (2025-04-05T00:00:00Z) - so, ISO 8601 format
    pub also_known_as: Vec<String>,     // other URIs for this user
    pub public_key: ActivityPubPublicKey,
    pub tag: Vec<String>,               // TODO: figure out what this is for
    pub attachment: Vec<ActivityPubAttachment>,
    pub endpoints: ActivityPubEndpoints,
    pub icon: Option<ActivityPubImage>, // a small, squarish image
    pub image: Option<ActivityPubImage>,// a larger, decorative "banner" image.
}

pub struct ActivityPubActorInput {
    pub user_slug: String,
    pub display_name: String,
    pub bio_html: String,
    pub site_url: String,
    pub community_slug: String,
    pub public_key_pem: String,
    pub published: String,
    pub manually_approves_followers: bool,
    pub discoverable: bool,
    pub indexable: bool,
    pub memorial: bool,
}

fn activitypub_response(input: ActivityPubActorInput) -> ActivityPubActor {

    let user_base_url = format!("{}/api/community/{}/user/{}", input.site_url, input.community_slug, input.user_slug);

    ActivityPubActor {
        context: vec![
            JsonLdContextItem::Iri("https://www.w3.org/ns/activitystreams".to_string()),
            JsonLdContextItem::Iri("https://w3id.org/security/v1".to_string()),
            JsonLdContextItem::Object(standard_context()),
        ],
        id: format!("{}/actor", user_base_url),
        r#type: "Person".to_string(),
        following: format!("{}/following", user_base_url),
        followers: format!("{}/followers", user_base_url),
        inbox: format!("{}/inbox", user_base_url),
        outbox: format!("{}/outbox", user_base_url),
        featured: format!("{}/featured", user_base_url),
        featured_tags: format!("{}/featured/tags", user_base_url),
        name: input.display_name.to_string(),
        preferred_username: input.user_slug.to_string(),
        summary: input.bio_html.to_string(),
        url: format!("{}/community/{}/user/{}", input.site_url, input.community_slug, input.user_slug),
        published: input.published.to_string(),
        manually_approves_followers: input.manually_approves_followers,
        discoverable: input.discoverable,
        indexable: input.indexable,
        memorial: input.memorial,
        also_known_as: vec![],
        public_key: ActivityPubPublicKey {
            id: format!("{}/actor#main-key", user_base_url),
            owner: format!("{}/actor", user_base_url),
            public_key_pem: input.public_key_pem.to_string(),
        },
        tag: vec![],
        attachment: vec![],
        endpoints: ActivityPubEndpoints {
            shared_inbox: None,
        },
        icon: None,
        image: None,
    }
}


// GET /api/community/{:slug}/user/{:user_slug}/actor
pub async fn get_actor(
    State(state): State<AppState>,
    axum::extract::Path((slug, user_slug)): axum::extract::Path<(String, String)>,
) -> Result<axum::Json<ActivityPubActor>, AppError> {
    let community_service = state.community_service;

    let community_db = community_service.get_database(&slug).await?;
    let user_service = community_db.user_service.clone();
    let user = user_service.get_user_by_slug(&user_slug).await?.ok_or(AppError(anyhow!("404 User not found.")))?;

    let actor = activitypub_response(ActivityPubActorInput {
        user_slug: user.slug,
        display_name: "Johnny Realperson".to_string(),
        bio_html: "<div>This is my bio. <strong>Hello world!</strong></div>".to_string(),
        site_url: state.config.site_url.clone(),
        published: user.created_at.clone(),
        community_slug: slug,
        public_key_pem: "-----BEGIN PUBLIC KEY-----JIBBLYJIBBLYJIBBLY-----END PUBLIC KEY-----".to_string(),
        manually_approves_followers: false,
        discoverable: true,
        indexable: true,
        memorial: false,
    });

    Ok(axum::Json(actor))
}