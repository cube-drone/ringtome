//! Front matter (Curtis, 2026-11-01): the terms of service, the privacy policy and the license a
//! person agrees to when they make an account here, and the pages that show them - `/tos`,
//! `/privacy` and `/eula`.
//!
//! Each page is layered, and nothing a server's operator writes takes anything away:
//!
//! - **the application's own** - `TERMS_OF_SERVICE.md` and `PRIVACY.md` at the repository's root,
//!   written by the project, embedded in the build;
//! - **every server's default** - `NODE_OPERATOR_TERMS_OF_SERVICE.mq` and `NODE_OPERATOR_PRIVACY.mq`,
//!   embedded the same way;
//! - **this server's additions** - what its operator wrote in a private note in hrseWriter and
//!   published here (hrseServer's _Front Matter_), appended after the default, with every version
//!   they ever published listed at the end of the page, dated, as a diff of the one before.
//!
//! The license (`/eula`) is the software's own: `LICENSE.md`, the GNU AGPL, shown as written.
//!
//! An account records which version of the terms it agreed to (`terms_agreed`): a hash of
//! everything the two pages show, so a change to any layer is a new version.
//!
//! This module owns the `front_matter` and `terms_agreed` tables.

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{NodeAdminSession, Session};
use crate::clock::now_ms;
use crate::db::Db;
use crate::error::AppError;
use crate::reading::esc;
use crate::record::documents::Format;
use crate::AppState;

const APP_TERMS: &str = include_str!("../../TERMS_OF_SERVICE.md");
const APP_PRIVACY: &str = include_str!("../../PRIVACY.md");
const OPERATOR_TERMS: &str = include_str!("../../NODE_OPERATOR_TERMS_OF_SERVICE.mq");
const OPERATOR_PRIVACY: &str = include_str!("../../NODE_OPERATOR_PRIVACY.mq");
const LICENSE: &str = include_str!("../../LICENSE.md");

/// Where the software's source is - what the AGPL asks a server to offer the people who use it.
const SOURCE: &str = "https://github.com/cube-drone/ringtome";

/// The longest addition an operator may publish: a few pages of policy, not a book.
const ADDITION_MAX: usize = 64 * 1024;

/// The documents an operator adds to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Terms,
    Privacy,
}

impl Kind {
    fn parse(s: &str) -> Result<Kind, AppError> {
        match s {
            "tos" => Ok(Kind::Terms),
            "privacy" => Ok(Kind::Privacy),
            _ => Err(AppError::NotFound(crate::msg!(
                "frontmatter.no-such-document",
                "no such document"
            ))),
        }
    }

    /// Its key in `front_matter`, its address, and the `front_matter` field of the note it's
    /// written in (js/frontmatter.js).
    fn key(self) -> &'static str {
        match self {
            Kind::Terms => "tos",
            Kind::Privacy => "privacy",
        }
    }
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/tos", get(terms_page))
        .route("/privacy", get(privacy_page))
        .route("/eula", get(license_page))
        .route("/api/admin/front-matter", get(admin_view))
        .route("/api/admin/front-matter/{kind}", post(publish_handler))
}

// ---------------------------------------------------------------------------------------------
// The tables.

/// Every version of an operator's addition, oldest first: `(at_ms, body)`.
async fn history(db: &Db, kind: Kind) -> Result<Vec<(i64, String)>, AppError> {
    db.fetch_all(
        "SELECT at_ms, body FROM front_matter WHERE kind = ?1 ORDER BY at_ms ASC",
        (kind.key(),),
    )
    .await
    .map_err(AppError::Internal)
}

/// The operator's addition as it stands ("" for none).
async fn current(db: &Db, kind: Kind) -> Result<(String, Option<i64>), AppError> {
    let row: Option<(String, i64)> = db
        .fetch_optional(
            "SELECT body, at_ms FROM front_matter WHERE kind = ?1 ORDER BY at_ms DESC LIMIT 1",
            (kind.key(),),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(match row {
        Some((body, at)) => (body, Some(at)),
        None => (String::new(), None),
    })
}

/// The version of the terms a person agrees to now: everything `/tos` and `/privacy` show, hashed.
pub async fn version(db: &Db) -> Result<String, AppError> {
    let (terms, _) = current(db, Kind::Terms).await?;
    let (privacy, _) = current(db, Kind::Privacy).await?;
    let mut hasher = blake3::Hasher::new();
    for part in
        [APP_TERMS, APP_PRIVACY, OPERATOR_TERMS, OPERATOR_PRIVACY, &terms, &privacy, LICENSE]
    {
        hasher.update(&(part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    Ok(hasher.finalize().to_hex()[..16].to_string())
}

/// Record that an account agreed to the terms as they stand now.
pub async fn agree(db: &Db, account_id: &Uuid) -> Result<(), AppError> {
    let version = version(db).await?;
    db.execute(
        "INSERT OR IGNORE INTO terms_agreed (account_id, version, at_ms) VALUES (?1, ?2, ?3)",
        (account_id.to_string(), version, now_ms()),
    )
    .await
    .map_err(AppError::Internal)?;
    Ok(())
}

/// The versions an account agreed to, and when: `(version, at_ms)`, oldest first.
pub async fn agreed(db: &Db, account_id: &Uuid) -> Result<Vec<(String, i64)>, AppError> {
    db.fetch_all(
        "SELECT version, at_ms FROM terms_agreed WHERE account_id = ?1 ORDER BY at_ms ASC",
        (account_id.to_string(),),
    )
    .await
    .map_err(AppError::Internal)
}

/// An account gone (leaving.rs, accounts.rs): its agreements go with it.
pub async fn forget_account(db: &Db, account_id: &str) -> Result<(), AppError> {
    db.execute("DELETE FROM terms_agreed WHERE account_id = ?1", (account_id,))
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The pages.

/// Marquee as HTML, through the renderer the public pages use.
fn marquee(source: &str) -> String {
    crate::reading::words_html(source, Format::Marquee)
}

/// The application's Markdown, through the Markdown bridge to Marquee, then as Marquee is.
fn markdown(source: &str) -> String {
    marquee(&marquee_markdown::to_marquee(source))
}

/// An operator's addition and its history: the addition as it stands, then every version they
/// published, newest first, each the diff from the one before.
fn addition(title: &str, history: &[(i64, String)]) -> String {
    let mut out = String::new();
    if let Some((_, now)) = history.last() {
        if !now.trim().is_empty() {
            out.push_str(&format!(
                "<section class=\"addition\"><h2>{}</h2>{}</section>",
                esc(title),
                marquee(now)
            ));
        }
    }
    if history.is_empty() {
        return out;
    }
    out.push_str("<section class=\"changes\"><h2>Changes this server's operator made</h2>");
    for (i, (at, body)) in history.iter().enumerate().rev() {
        let before = if i == 0 { "" } else { history[i - 1].1.as_str() };
        let patch = diffy::create_patch(before, body).to_string();
        // A reader's diff, not a tool's: no file names, no "\ No newline at end of file", and each
        // hunk's line numbers a quiet break between the parts that changed.
        let lines: String = patch
            .lines()
            .filter(|l| !l.starts_with("--- ") && !l.starts_with("+++ ") && !l.starts_with('\\'))
            .map(|l| match l.chars().next() {
                Some('@') => "<span class=\"hunk\">⋯</span>\n".to_string(),
                Some('+') => format!("<span class=\"add\">{}</span>\n", esc(l)),
                Some('-') => format!("<span class=\"del\">{}</span>\n", esc(l)),
                _ => format!("<span class=\"same\">{}</span>\n", esc(l)),
            })
            .collect();
        out.push_str(&format!(
            "<h3>{} UTC</h3><pre class=\"diff\">{}</pre>",
            esc(&crate::record::documents::civil_utc(*at)),
            if lines.is_empty() { "(emptied)\n".into() } else { lines }
        ));
    }
    out.push_str("</section>");
    out
}

/// Whether the reader is their own server's operator, so the pages leave out the operator's layers
/// (Curtis, 2026-11-01: on a personal device "they are their own single-node operator"): inside
/// the desktop or Android app, while nobody else has an account there - before the first account,
/// which is its owner's, or with one account and its owner signed in. Someone not signed in where
/// one account already exists is about to be hosted by that owner, and reads the operator's terms.
fn own_server(in_app: bool, accounts: i64, signed_in: bool) -> bool {
    in_app && (accounts == 0 || (accounts == 1 && signed_in))
}

/// What stands in for the operator's layers on a reader's own server.
const OWN_SERVER: &str = "<p class=\"own\">This server is the app on your own computer, and you \
     are its operator, so no one else's terms apply here.</p>";

async fn reads_own(state: &AppState, session: &Option<Session>) -> Result<bool, AppError> {
    let accounts = crate::auth::account_count(&state.node_db).await?;
    Ok(own_server(state.shell.present(), accounts, session.is_some()))
}

async fn terms_page(
    State(state): State<AppState>,
    session: Option<Session>,
) -> Result<Response, AppError> {
    let body = if reads_own(&state, &session).await? {
        format!("{}<hr>{OWN_SERVER}", markdown(APP_TERMS))
    } else {
        let history = history(&state.node_db, Kind::Terms).await?;
        format!(
            "{}<hr>{}{}",
            markdown(APP_TERMS),
            marquee(OPERATOR_TERMS),
            addition("This server's own terms", &history)
        )
    };
    Ok(page("Terms of Service", &body))
}

async fn privacy_page(
    State(state): State<AppState>,
    session: Option<Session>,
) -> Result<Response, AppError> {
    let body = if reads_own(&state, &session).await? {
        format!("{}<hr>{OWN_SERVER}", markdown(APP_PRIVACY))
    } else {
        let history = history(&state.node_db, Kind::Privacy).await?;
        format!(
            "{}<hr>{}{}",
            markdown(APP_PRIVACY),
            marquee(OPERATOR_PRIVACY),
            addition("This server's own privacy policy", &history)
        )
    };
    Ok(page("Privacy Policy", &body))
}

async fn license_page() -> Response {
    let body = format!(
        "<h1>License</h1>\
         <p>Horse Drawing Tycoon 2 is free software: you may use, study, share and change it under \
         the terms of the GNU Affero General Public License, version 3, below. Its source is at \
         <a href=\"{SOURCE}\">{SOURCE}</a>.</p><pre class=\"license\">{}</pre>",
        esc(LICENSE)
    );
    page("License", &body)
}

/// The pages' skeleton: one column of reading, the three documents linked at the foot, no scripts.
fn page(title: &str, body: &str) -> Response {
    let html = format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} - Horse Drawing Tycoon 2</title>
<style>
  body {{ margin: 0; background: #f6f2ea; color: #2d2a26;
         font: 16px/1.6 system-ui, -apple-system, sans-serif; }}
  main {{ max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 3rem; }}
  h1 {{ font-size: 1.6rem; line-height: 1.25; }}
  h2 {{ font-size: 1.2rem; margin-top: 2rem; }}
  h3 {{ font-size: 0.95rem; color: #8a7f6e; }}
  hr {{ border: 0; border-top: 1px solid #e0d8c8; margin: 2.5rem 0; }}
  a {{ color: #2a7f78; }}
  pre {{ white-space: pre-wrap; word-break: break-word; font-size: 0.8rem;
        background: #fffdf8; border: 1px solid #e0d8c8; border-radius: 8px; padding: 0.8rem; }}
  .diff .add {{ color: #2a7f78; }}
  .diff .del {{ color: #b4483b; }}
  .diff .hunk {{ color: #8a7f6e; }}
  .addition {{ border-left: 3px solid #2a7f78; padding-left: 1rem; }}
  .own {{ color: #8a7f6e; }}
  nav {{ display: flex; gap: 1.2rem; flex-wrap: wrap; font-size: 0.9rem;
        border-top: 1px solid #e0d8c8; margin-top: 3rem; padding-top: 1rem; }}
</style>
</head>
<body><main>{body}
<nav><a href="/tos">Terms of Service</a><a href="/privacy">Privacy Policy</a><a href="/eula">License</a><a href="/">Horse Drawing Tycoon 2</a></nav>
</main></body>
</html>
"#,
        title = esc(title),
    );
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response()
}

// ---------------------------------------------------------------------------------------------
// hrseServer's Front Matter.

#[derive(Serialize)]
struct Addition {
    body: String,
    /// When it was last published; absent when never.
    #[serde(skip_serializing_if = "Option::is_none")]
    at_ms: Option<i64>,
}

#[derive(Serialize)]
struct AdminView {
    tos: Addition,
    privacy: Addition,
}

/// An addition as published: its whole-line Marquee comments (`%%`) dropped - they never show on
/// the page, and the change list shows each version's source, where a note to oneself (the new
/// note's own hint, say) doesn't belong.
fn uncommented(body: &str) -> String {
    let kept: Vec<&str> =
        body.lines().filter(|line| !line.trim_start().starts_with("%%")).collect();
    kept.join("\n").trim().to_string()
}

/// GET `/api/admin/front-matter`: this server's additions as they stand.
async fn admin_view(
    State(state): State<AppState>,
    _admin: NodeAdminSession,
) -> Result<Json<AdminView>, AppError> {
    let (tos, tos_at) = current(&state.node_db, Kind::Terms).await?;
    let (privacy, privacy_at) = current(&state.node_db, Kind::Privacy).await?;
    Ok(Json(AdminView {
        tos: Addition { body: tos, at_ms: tos_at },
        privacy: Addition { body: privacy, at_ms: privacy_at },
    }))
}

#[derive(Deserialize)]
struct PublishRequest {
    /// The administrator's persona the note is in, and the note.
    root: String,
    doc_id: String,
}

#[derive(Serialize)]
struct Published {
    /// Whether this was a new version - false when the words were already what's published.
    changed: bool,
    at_ms: Option<i64>,
}

/// POST `/api/admin/front-matter/{tos|privacy}`: publish one of the administrator's notes as this
/// server's addition - read from their persona here, as its words stand now. The same words
/// again change nothing.
async fn publish_handler(
    State(state): State<AppState>,
    admin: NodeAdminSession,
    Path(kind): Path<String>,
    Json(req): Json<PublishRequest>,
) -> Result<Json<Published>, AppError> {
    let kind = Kind::parse(&kind)?;
    let doc_id = crate::identity::routes::hex_fixed::<16>(&req.doc_id, "doc id")?;
    let data = crate::record::store::open(&state, &admin.account.id, &req.root).await?;
    let doc = data.documents().one(&doc_id).await?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("frontmatter.note-not-found", "that note isn't here"))
    })?;
    let body =
        data.documents().resolved(&doc).await?.body.map(|b| uncommented(&b)).ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "frontmatter.words-not-here-yet",
                "that note's words haven't reached this server yet"
            ))
        })?;
    if body.len() > ADDITION_MAX {
        return Err(AppError::BadRequest(crate::msg!(
            "frontmatter.too-long",
            "that's too long for an addition - keep it under {max} KB",
            max = ADDITION_MAX / 1024
        )));
    }
    let (now, at) = current(&state.node_db, kind).await?;
    if now == body {
        return Ok(Json(Published { changed: false, at_ms: at }));
    }
    let at_ms = now_ms();
    state
        .node_db
        .execute(
            "INSERT INTO front_matter (kind, at_ms, body) VALUES (?1, ?2, ?3)",
            (kind.key(), at_ms, body),
        )
        .await
        .map_err(AppError::Internal)?;
    tracing::info!(kind = kind.key(), by = %admin.account.id, "a server operator published front matter");
    Ok(Json(Published { changed: true, at_ms: Some(at_ms) }))
}

#[cfg(test)]
mod tests {
    use super::own_server;

    #[test]
    fn an_addition_keeps_its_words_and_drops_its_comments() {
        use super::uncommented;
        assert_eq!(
            uncommented("%% a hint\n\n# House rules\n\nBe kind.\n"),
            "# House rules\n\nBe kind."
        );
        assert_eq!(uncommented("%% only a hint\n\n"), "", "the hint alone is nothing added");
        assert_eq!(uncommented("Fees: 50%% off"), "Fees: 50%% off", "a %% mid-line stays");
    }

    #[test]
    fn the_operator_layers_go_only_where_nobody_else_is_hosted() {
        assert!(own_server(true, 0, false), "an app before its owner's account");
        assert!(own_server(true, 1, true), "an app, its one account signed in");
        assert!(!own_server(true, 1, false), "someone about to be the second account");
        assert!(!own_server(true, 2, true), "an app hosting somebody else");
        assert!(!own_server(false, 0, false), "a server, always");
        assert!(!own_server(false, 1, true));
    }
}
