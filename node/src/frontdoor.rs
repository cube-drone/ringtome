//! The front door's own words, and the posts pinned above its feed (Curtis, 2026-09-30).
//!
//! **The name and the taglines.** A server's front page calls itself Horse Drawing Tycoon 2 and
//! scrolls a marquee of taglines beneath it; its administrator may rename it and rewrite the lines
//! in the server settings' *server customization*. Nothing chosen is stored as NULL, and the page
//! supplies the app's own words - so the defaults read in the stranger's language, and a later
//! release's defaults reach every server that never chose.
//!
//! **The colourway** (Curtis, 2026-11-22): what everyone who isn't signed in sees the place in -
//! any of the app's colourways, the sold ones too, since this is the server's choice and not a
//! persona's. A person's own page still wears theirs, and anyone signed in their own. Every page's
//! head names it (`colorway_meta`, for `ui::app_page_with`), so it is on before anything draws;
//! the choice is kept in memory beside its row (`AppState::front_look`) because a page is
//! rendered without a database read.
//!
//! **The effects** (the same day: "can the site operator set the outward facing CRT and snowflake
//! settings?"): whether a stranger sees the CRT screen, and whether it snows on them. Each is the
//! app's own until chosen - the CRT on, no snow - and travels as the colourway does, in the head.
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
    look: Look,
}

/// How the place looks to a stranger; each None is "the app's own".
#[derive(Clone, Default)]
pub struct Look {
    pub colorway: Option<String>,
    /// The CRT screen: the app's own is on.
    pub crt: Option<bool>,
    /// The snow: the app's own is none.
    pub snow: Option<bool>,
}

type LookRow = (Option<String>, Option<i64>, Option<i64>);

fn look_of((colorway, crt, snow): LookRow) -> Look {
    Look { colorway, crt: crt.map(|n| n != 0), snow: snow.map(|n| n != 0) }
}

async fn choices(state: &AppState) -> Result<Choices, AppError> {
    type Row = (Option<String>, Option<String>, Option<String>, Option<i64>, Option<i64>);
    let row: Option<Row> = state
        .node_db
        .fetch_optional(
            "SELECT name, taglines, colorway, crt, snow FROM front_door WHERE id = 1",
            (),
        )
        .await
        .context("reading the front door")
        .map_err(AppError::Internal)?;
    let (name, taglines, colorway, crt, snow) = row.unwrap_or((None, None, None, None, None));
    Ok(Choices {
        name,
        taglines: taglines.and_then(|t| serde_json::from_str(&t).ok()),
        look: look_of((colorway, crt, snow)),
    })
}

/// At boot: the chosen look into memory, where every page's head reads it.
pub async fn load(state: &AppState) -> anyhow::Result<()> {
    let row: Option<LookRow> = state
        .node_db
        .fetch_optional("SELECT colorway, crt, snow FROM front_door WHERE id = 1", ())
        .await
        .context("reading the front door's look")?;
    *state.front_look.lock().expect("front look poisoned") =
        row.map(look_of).unwrap_or_default();
    Ok(())
}

/// The lines of a page's head that say how the server looks to a stranger - nothing for whatever
/// was left the app's own: index.html's first script puts them on for a reader with no choices of
/// their own, before anything draws (js/colorway.js and js/crtpref.js read them again).
pub fn look_meta(state: &AppState) -> String {
    let look = state.front_look.lock().expect("front look poisoned").clone();
    let mut head = String::new();
    // A colourway's name is letters, digits and hyphens (`bank::is_colorway` held it to the
    // list on the way in), so it needs no escaping.
    if let Some(c) = look.colorway {
        head.push_str(&format!("\n<meta name=\"node-colorway\" content=\"{c}\">"));
    }
    let said = |on: bool| if on { "on" } else { "off" };
    if let Some(on) = look.crt {
        head.push_str(&format!("\n<meta name=\"node-crt\" content=\"{}\">", said(on)));
    }
    if let Some(on) = look.snow {
        head.push_str(&format!("\n<meta name=\"node-snow\" content=\"{}\">", said(on)));
    }
    head
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
        serde_json::json!({
            "name": choices.name,
            "taglines": choices.taglines,
            "colorway": choices.look.colorway,
            "crt": choices.look.crt,
            "snow": choices.look.snow,
            "pins": pins,
        }),
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
    /// Empty or absent: the app's own colourway.
    #[serde(default)]
    colorway: Option<String>,
    /// Absent: the app's own - the CRT screen on.
    #[serde(default)]
    crt: Option<bool>,
    /// Absent: the app's own - no snow.
    #[serde(default)]
    snow: Option<bool>,
}

/// PUT `/api/admin/front`: the server settings' *server customization*.
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
    let colorway = req.colorway.map(|c| c.trim().to_ascii_lowercase()).filter(|c| !c.is_empty());
    if colorway.as_ref().is_some_and(|c| !crate::bank::is_colorway(c)) {
        return Err(AppError::BadRequest(crate::msg!(
            "frontdoor.not-a-colorway",
            "that isn't one of the app's colourways"
        )));
    }
    let taglines_json = taglines.as_ref().map(|l| serde_json::to_string(l).unwrap_or_default());
    state
        .node_db
        .execute(
            "INSERT INTO front_door (id, name, taglines, colorway, crt, snow, updated_ms) VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (id) DO UPDATE SET name = excluded.name, taglines = excluded.taglines, colorway = excluded.colorway, crt = excluded.crt, snow = excluded.snow, updated_ms = excluded.updated_ms",
            (
                name.as_deref(),
                taglines_json.as_deref(),
                colorway.as_deref(),
                req.crt.map(i64::from),
                req.snow.map(i64::from),
                crate::clock::now_ms(),
            ),
        )
        .await
        .context("writing the front door")
        .map_err(AppError::Internal)?;
    *state.front_look.lock().expect("front look poisoned") =
        Look { colorway: colorway.clone(), crt: req.crt, snow: req.snow };
    Ok(Json(serde_json::json!({
        "name": name,
        "taglines": taglines,
        "colorway": colorway,
        "crt": req.crt,
        "snow": req.snow,
    })))
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
