//! The front door's own words, and the posts pinned above its feed (Curtis, 2026-09-30).
//!
//! **The name and the taglines.** A server's front page calls itself Horse Drawing Tycoon 2 and
//! scrolls a marquee of taglines beneath it; its administrator may rename it and rewrite the lines
//! in the Server app's *server customization*. Nothing chosen is stored as NULL, and the page
//! supplies the app's own words - so the defaults read in the stranger's language, and a later
//! release's defaults reach every server that never chose.
//!
//! **Super-pins.** A node administrator may pin a public post hosted here to the top of the front
//! page, above "lately on this node". Only on a server: a desktop app has no front page for
//! strangers (`registration::is_device`). A pin points at a post the stranger's shelf holds; one
//! whose post has since left the shelf (taken down, made private, its author unlisted) is simply
//! not shown, and stays until an administrator unpins it.
//!
//! Owns the `front_door` and `super_pins` SQL (tests/conventions.rs).

use anyhow::Context;
use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;

use crate::auth::NodeAdminSession;
use crate::error::AppError;
use crate::AppState;

/// A name's longest, in characters: a header's worth.
const NAME_MAX: usize = 80;
/// The most taglines, and each one's longest, in characters.
const TAGLINES_MAX: usize = 100;
const TAGLINE_MAX: usize = 500;
/// The most super-pins shown: the front page is a door, not a second feed.
const PINS_SHOWN: i64 = 20;

/// The administrator's choices; None is "the app's own".
struct Choices {
    name: Option<String>,
    taglines: Option<Vec<String>>,
}

async fn choices(state: &AppState) -> Result<Choices, AppError> {
    let row: Option<(Option<String>, Option<String>)> = state
        .node_db
        .fetch_optional("SELECT name, taglines FROM front_door WHERE id = 1", ())
        .await
        .context("reading the front door")
        .map_err(AppError::Internal)?;
    let (name, taglines) = row.unwrap_or((None, None));
    Ok(Choices { name, taglines: taglines.and_then(|t| serde_json::from_str(&t).ok()) })
}

async fn pinned(state: &AppState) -> Result<Vec<(String, String)>, AppError> {
    state
        .node_db
        .fetch_all(
            "SELECT author_root, doc_id FROM super_pins ORDER BY pinned_ms DESC LIMIT ?1",
            (PINS_SHOWN,),
        )
        .await
        .context("reading the super-pins")
        .map_err(AppError::Internal)
}

/// GET `/api/node/front`: what the front page needs beyond its feed - the name, the taglines
/// (each null for the app's own), and the super-pinned posts as feed cards, newest pin first.
pub async fn front_handler(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let choices = choices(&state).await?;
    let mut rows = Vec::new();
    if !crate::registration::is_device(&state) {
        for (author, doc) in pinned(&state).await? {
            if let Some(row) = crate::nodeshelf::post_row(&state.node_db, &author, &doc)
                .await
                .map_err(AppError::Internal)?
            {
                rows.push(row);
            }
        }
    }
    let pins = crate::nodeface::feed_items(&state, rows).await?;
    Ok(Json(
        serde_json::json!({ "name": choices.name, "taglines": choices.taglines, "pins": pins }),
    ))
}

#[derive(Deserialize)]
pub struct SetFront {
    /// Empty or absent: the app's own name.
    #[serde(default)]
    name: Option<String>,
    /// Absent: the app's own taglines. Blank lines are dropped.
    #[serde(default)]
    taglines: Option<Vec<String>>,
}

/// PUT `/api/admin/front`: the Server app's *server customization*.
pub async fn set_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    Json(req): Json<SetFront>,
) -> Result<Json<serde_json::Value>, AppError> {
    let name = req.name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty());
    if name.as_ref().is_some_and(|n| n.chars().count() > NAME_MAX) {
        return Err(AppError::BadRequest(crate::msg!(
            "frontdoor.name-too-long",
            "that name is longer than a header can hold"
        )));
    }
    let taglines: Option<Vec<String>> = req.taglines.map(|lines| {
        lines.into_iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
    });
    if let Some(lines) = &taglines {
        if lines.len() > TAGLINES_MAX || lines.iter().any(|l| l.chars().count() > TAGLINE_MAX) {
            return Err(AppError::BadRequest(crate::msg!(
                "frontdoor.too-many-taglines",
                "at most a hundred taglines, each under 500 characters"
            )));
        }
    }
    let taglines_json = taglines.as_ref().map(|l| serde_json::to_string(l).unwrap_or_default());
    state
        .node_db
        .execute(
            "INSERT INTO front_door (id, name, taglines, updated_ms) VALUES (1, ?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, taglines = excluded.taglines, updated_ms = excluded.updated_ms",
            (name.as_deref(), taglines_json.as_deref(), crate::clock::now_ms()),
        )
        .await
        .context("writing the front door")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "name": name, "taglines": taglines })))
}

/// PUT `/api/admin/super-pins/{author}/{doc}`: pin a public post hosted here to the front page.
pub async fn pin_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    Path((author, doc)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    if crate::registration::is_device(&state) {
        return Err(AppError::BadRequest(crate::msg!(
            "frontdoor.only-a-server",
            "only a server has a front page to pin to"
        )));
    }
    if crate::nodeshelf::post_row(&state.node_db, &author, &doc)
        .await
        .map_err(AppError::Internal)?
        .is_none()
    {
        return Err(AppError::BadRequest(crate::msg!(
            "frontdoor.only-public-posts-here",
            "only a public post hosted here can go on the front page"
        )));
    }
    state
        .node_db
        .execute(
            "INSERT INTO super_pins (author_root, doc_id, pinned_ms) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
            (author.as_str(), doc.as_str(), crate::clock::now_ms()),
        )
        .await
        .context("super-pinning a post")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "pinned": true })))
}

/// DELETE `/api/admin/super-pins/{author}/{doc}`: take it back off.
pub async fn unpin_handler(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
    Path((author, doc)): Path<(String, String)>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .node_db
        .execute(
            "DELETE FROM super_pins WHERE author_root = ?1 AND doc_id = ?2",
            (author.as_str(), doc.as_str()),
        )
        .await
        .context("unpinning a post")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "pinned": false })))
}
