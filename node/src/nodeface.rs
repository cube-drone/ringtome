//! The node's public face, the doors (UNAUTHED.md, slice 1): what a stranger may ask this
//! node with no session - the node feed (every listed hosted persona's open posts and live
//! shares, newest first, narrowed and searched like a reader's feed), its labels, and the
//! personas the node lists; and the one authenticated door beside them, the persona's own
//! "listed on this node's front page" switch (ruling 3).
//!
//! Every answer here is a stranger's answer: no viewer, so no sealed post, no sealed label
//! and no key (ruling 2) - the doors read the node shelf memo (nodeshelf.rs) and the node
//! memos every other listing reads, and never open a user database.

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;

use crate::auth::Session;
use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize, Default)]
pub struct NodeFeedQuery {
    before_ms: Option<i64>,
    before_doc: Option<String>,
    q: Option<String>,
}

fn decode_root(hex_root: &str) -> Option<[u8; 32]> {
    hex::decode(hex_root).ok().and_then(|b| <[u8; 32]>::try_from(b).ok())
}

/// `GET /api/node/personas`: the personas this node lists, with the byline it holds.
pub async fn node_personas(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let roots = crate::nodeshelf::listed_roots(&state.node_db).await.map_err(AppError::Internal)?;
    let bylines = crate::profiles::bylines(&state.node_db, &roots).await.unwrap_or_default();
    let mut people: Vec<serde_json::Value> = Vec::with_capacity(roots.len());
    for r in &roots {
        let b = bylines.get(r).cloned().unwrap_or_default();
        let (slug, _) = crate::slugs::of_root(&state.node_db, r).await.map_err(AppError::Internal)?;
        people.push(serde_json::json!({
            "root": r,
            "speakable": decode_root(r).map(|k| crate::speakable::speakable(&k)),
            "name": b.name,
            "avatar": b.avatar,
            "slug": slug,
        }));
    }
    people.sort_by(|a, b| {
        let name = |v: &serde_json::Value| v["name"].as_str().unwrap_or("").to_lowercase();
        name(a).cmp(&name(b)).then_with(|| a["root"].as_str().cmp(&b["root"].as_str()))
    });
    Ok(Json(serde_json::json!({ "people": people })))
}

/// `GET /api/node/feed`: the front page. Paged like the reader's feed when nothing narrows;
/// the whole held shelf judged by `search::matching` when something does (viewer none).
pub async fn node_feed(
    State(state): State<AppState>,
    Query(q): Query<NodeFeedQuery>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Result<Json<serde_json::Value>, AppError> {
    let page = crate::idface::POSTS_PAGE;
    let narrow = crate::search::Narrow::parse(raw.as_deref(), q.q.as_deref());
    let (rows, more) = if narrow.is_empty() {
        let before = match (q.before_ms, q.before_doc) {
            (Some(ms), Some(doc)) => Some((ms, doc)),
            _ => None,
        };
        let mut rows = crate::nodeshelf::page(&state.node_db, before, page + 1).await.map_err(AppError::Internal)?;
        let more = rows.len() as i64 > page;
        rows.truncate(page as usize);
        (rows, more)
    } else {
        let all = crate::nodeshelf::page(&state.node_db, None, 5000).await.map_err(AppError::Internal)?;
        let candidates: Vec<crate::search::Candidate> = all
            .iter()
            .map(|r| crate::search::Candidate {
                author_root: r.author_root.clone(),
                doc_hex: r.doc_id.clone(),
                title: r.title.clone(),
                updated_ms: r.updated_ms,
                kind: r.kind(),
            })
            .collect();
        let keep = crate::search::matching(&state, &candidates, &narrow, None).await.map_err(AppError::Internal)?;
        let mut i = 0;
        let mut all = all;
        all.retain(|_| {
            let k = keep.contains(&i);
            i += 1;
            k
        });
        (all, false)
    };
    let mut roots: Vec<String> = rows.iter().map(|r| r.author_root.clone()).collect();
    roots.extend(rows.iter().filter_map(|r| r.via_root.clone()));
    roots.sort();
    roots.dedup();
    let bylines = crate::profiles::bylines(&state.node_db, &roots).await.unwrap_or_default();
    let pairs: Vec<(String, String)> = rows.iter().map(|r| (r.author_root.clone(), r.doc_id.clone())).collect();
    let labels = crate::annotations::for_posts(&state, &pairs, None).await.map_err(AppError::Internal)?;
    let replies = crate::replies::known_counts(&state.node_db, &pairs).await.map_err(AppError::Internal)?;
    let items: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|r| {
            let b = bylines.get(&r.author_root).cloned().unwrap_or_default();
            let via = r.via_root.as_ref().map(|v| (v.clone(), bylines.get(v).cloned().unwrap_or_default()));
            let key = (r.author_root.clone(), r.doc_id.clone());
            serde_json::json!({
                "author": r.author_root,
                "doc_id": r.doc_id,
                "title": r.title,
                "format": r.format,
                "published_ms": r.published_ms,
                "updated_ms": r.updated_ms,
                "arrived_ms": r.updated_ms,
                "settled": r.settled,
                "dated_ms": r.dated_ms,
                "mine": false,
                "author_name": b.name,
                "author_avatar": b.avatar,
                "via": via.as_ref().map(|(v, _)| v.clone()),
                "via_name": via.as_ref().and_then(|(_, b)| b.name.clone()),
                "via_avatar": via.as_ref().and_then(|(_, b)| b.avatar.clone()),
                "replies": replies.get(&key).copied().filter(|n| *n > 0),
                "reply_to": r.reply_to.as_ref().map(|(a, d)| serde_json::json!({ "author": a, "doc_id": d })),
                "annotations": labels.get(&key).map(|v| v.iter().map(|a| serde_json::json!({ "annotator": a.annotator, "key": a.key, "value": a.value })).collect::<Vec<_>>()).unwrap_or_default(),
            })
        })
        .collect();
    Ok(Json(serde_json::json!({ "items": items, "more": more })))
}

/// `GET /api/node/feed/labels`: the facets over the whole stranger's shelf.
pub async fn node_feed_labels(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    let all = crate::nodeshelf::page(&state.node_db, None, 5000).await.map_err(AppError::Internal)?;
    let pairs: Vec<(String, String)> = all.iter().map(|r| (r.author_root.clone(), r.doc_id.clone())).collect();
    let (buckets, tags) = crate::annotations::label_counts(&state, &pairs, None).await.map_err(AppError::Internal)?;
    let kinds = crate::search::kind_counts(all.iter().map(|r| r.kind()));
    let facet = |v: Vec<(String, i64)>| -> Vec<serde_json::Value> {
        v.into_iter().map(|(value, count)| serde_json::json!({ "value": value, "count": count })).collect()
    };
    Ok(Json(serde_json::json!({ "kinds": facet(kinds), "buckets": facet(buckets), "tags": facet(tags) })))
}

#[derive(Deserialize)]
pub struct SlugPut {
    slug: String,
}

/// `GET /api/identity/{root}/slug`: the persona's current and last slug on this node.
pub async fn slug_get(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let (current, last) = crate::slugs::of_root(&state.node_db, &root).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "slug": current, "last": last })))
}

/// `PUT /api/identity/{root}/slug`: claim one (ruling 7); `""` gives the current one up.
pub async fn slug_put(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<SlugPut>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    if req.slug.trim().is_empty() {
        crate::slugs::drop_current(&state.node_db, &root).await.map_err(AppError::Internal)?;
    } else {
        match crate::slugs::claim(&state.node_db, &root, &req.slug).await.map_err(AppError::Internal)? {
            crate::slugs::Outcome::Claimed => {}
            crate::slugs::Outcome::Taken => {
                return Err(AppError::BadRequest(crate::msg!(
                    "nodeface.somebody-here-already-has-that-name",
                    "somebody on this node already has that name"
                )))
            }
            crate::slugs::Outcome::Invalid => {
                return Err(AppError::BadRequest(crate::msg!(
                    "nodeface.a-name-is-three-to-thirty-two",
                    "a name is three to thirty-two lowercase letters, digits and hyphens"
                )))
            }
        }
    }
    let (current, last) = crate::slugs::of_root(&state.node_db, &root).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "slug": current, "last": last })))
}

/// `GET /api/node/slugs/{slug}`: who a slug names here, and whether it is their current one.
pub async fn slug_resolve(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    match crate::slugs::resolve(&state.node_db, &slug).await.map_err(AppError::Internal)? {
        Some((root, current)) => {
            let (now, _) = crate::slugs::of_root(&state.node_db, &root).await.map_err(AppError::Internal)?;
            Ok(Json(serde_json::json!({
                "root": root,
                "speakable": decode_root(&root).map(|k| crate::speakable::speakable(&k)),
                "current": current,
                "slug": now,
            })))
        }
        None => Err(AppError::NotFound(crate::msg!("nodeface.nobody-here-by-that-name", "nobody on this node goes by that name"))),
    }
}

/// `GET /@{slug}`: the persona's page under its short name (ruling 6); the last slug sends
/// the reader on to the current; an unknown one is the app under a 404, which says so.
pub async fn slug_page(State(state): State<AppState>, Path(slug): Path<String>) -> Result<axum::response::Response, AppError> {
    use axum::response::IntoResponse;
    match crate::slugs::resolve(&state.node_db, &slug).await.map_err(AppError::Internal)? {
        Some((root, true)) => {
            let Some(key) = decode_root(&root) else {
                return Err(AppError::NotFound(crate::msg!("nodeface.nobody-here-by-that-name", "nobody on this node goes by that name")));
            };
            crate::idface::persona_page(&state, key).await
        }
        Some((root, false)) => {
            let (current, _) = crate::slugs::of_root(&state.node_db, &root).await.map_err(AppError::Internal)?;
            match current {
                Some(c) => Ok(axum::response::Redirect::temporary(&format!("/@{c}")).into_response()),
                None => Err(AppError::NotFound(crate::msg!("nodeface.nobody-here-by-that-name", "nobody on this node goes by that name"))),
            }
        }
        None => Ok((
            axum::http::StatusCode::NOT_FOUND,
            axum::response::Html(crate::ui::app_page(&state, "<title>nobody here by that name</title>")),
        )
            .into_response()),
    }
}

#[derive(Deserialize)]
pub struct ListedPut {
    listed: bool,
}

/// `GET /api/identity/{root}/listed`: the persona's own switch, as it stands.
pub async fn listed_get(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    // Opening the store proves the session owns the persona, as every identity door does.
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let on = crate::nodeshelf::listed(&state.node_db, &root).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "listed": on })))
}

/// `PUT /api/identity/{root}/listed`: flip it.
pub async fn listed_put(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<ListedPut>,
) -> Result<Json<serde_json::Value>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    crate::nodeshelf::set_listed(&state.node_db, &root, req.listed).await.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "listed": req.listed })))
}
