//! The `/id/<root>` surface (PROJECT_PLAN, Addressing: "The prefix gets its name") - one URL,
//! two audiences, and the split that keeps both simple: **a session gets the SPA, anonymity
//! gets a server-rendered face.** The browser app stays session-only (its whole substrate -
//! mirror, stream, lens - assumes one); the anonymous face is deliberately tiny, static HTML
//! with hardened headers, because the stranger-facing surface should have as little machinery
//! behind it as possible.
//!
//! The anonymous rungs shipped here (Moderation, The Web Gateway):
//!   - **shelf**: a root this node hosts -> its public profile (name, bio - the public lane).
//!   - **tombstone, warmly**: a root not carried -> an honest dead end with directions.
//!   - **checksum refusal**: worded address whose words lie -> refused loudly, with the true
//!     words in hand ("did you mean").
//!
//! The **signpost** rung waits on serving records carrying public web URLs; the fetch-and-serve
//! behavior for members waits on the resolution ladder. Both are NEXT_STEPS' next bricks, not
//! forgotten scope.

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::imaol;
use crate::speakable::{self, Parsed};
use crate::AppState;

/// Escape untrusted text into HTML body/attribute position. The profile is user-authored;
/// the face renders nothing unescaped.
fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

/// The anonymous face's response envelope: plain HTML under the hardened serving headers
/// (the gateway posture, applied from the first byte this surface ever serves - validated
/// type, nosniff, a CSP that permits our own inline style and nothing else).
fn face(status: StatusCode, body: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; style-src 'unsafe-inline'",
            ),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        body,
    )
        .into_response()
}

/// The shared page skeleton: system fonts, one card, no scripts, no fetches.
fn page(title: &str, card: String) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #f6f2ea; color: #2d2a26;
         font: 16px/1.5 system-ui, -apple-system, sans-serif; }}
  .card {{ max-width: 34rem; margin: 2rem; padding: 2rem 2.2rem; background: #fffdf8;
          border: 1px solid #e0d8c8; border-radius: 14px; }}
  .chip {{ display: inline-block; width: 0.9em; height: 0.9em; border-radius: 50%;
          margin-right: 0.45rem; vertical-align: baseline; }}
  h1 {{ font-size: 1.35rem; margin: 0 0 0.2rem; }}
  .words {{ color: #8a7f6e; font-size: 0.9rem; margin: 0 0 1rem; }}
  .bio {{ white-space: pre-wrap; }}
  .addr {{ font-family: ui-monospace, monospace; font-size: 0.78rem; word-break: break-all;
          background: #f2ecdf; border-radius: 8px; padding: 0.6rem 0.8rem; }}
  .foot {{ color: #8a7f6e; font-size: 0.8rem; margin-top: 1.4rem; }}
  a {{ color: #2a7f78; }}
</style>
</head>
<body><div class="card">{card}</div></body>
</html>
"#,
        title = esc(title),
    )
}

/// The deterministic hue chip - the same humble seed the SPA uses, so the face and the
/// console agree on a persona's color.
fn hue(root: &[u8; 32]) -> u32 {
    u32::from(root[0]) * 65536 + u32::from(root[1]) * 256 + u32::from(root[2])
}

fn chip(root: &[u8; 32]) -> String {
    format!(
        r#"<span class="chip" style="background: hsl({}, 60%, 55%)"></span>"#,
        hue(root) % 360
    )
}

/// Is this root hosted by any account on this node? (The shelf, v1: hosting is the only
/// demand edge that exists - member follows join it when follows do.)
async fn hosted_here(state: &AppState, root_hex: &str) -> Result<bool, AppError> {
    let row: Option<(i64,)> = state
        .node_db
        .fetch_optional(
            "SELECT 1 FROM identities WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(row.is_some())
}

/// The public profile straight off the identity's own db - the public lane, no account in
/// the question. Absent fields render as absent; a profile-less persona is still a page.
async fn public_profile(state: &AppState, root_hex: &str) -> Result<Vec<imaol::ProfileField>, AppError> {
    let db = state.user_dbs.get(root_hex).await.map_err(AppError::Internal)?;
    imaol::get_profile(&db).await
}

fn profile_value<'a>(fields: &'a [imaol::ProfileField], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|f| f.field == name)
        .map(|f| f.value.as_str())
}

/// GET `/id/{seg}` (and any deeper path, for now): the one URL, both audiences.
pub async fn idface(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
) -> Result<Response, AppError> {
    // The segment may arrive with a deeper path attached (`{*rest}` routes land here too);
    // only the first segment names the root.
    let seg = seg.split('/').next().unwrap_or("").to_string();

    let Some(parsed) = speakable::parse(&seg) else {
        return Ok(face(
            StatusCode::NOT_FOUND,
            page(
                "not a ringtome address",
                "<h1>that's not an address</h1>\
                 <p>The path after <code>/id/</code> should be a persona's address - two words \
                 and a key, like <code>sway-broke-AwTy…</code></p>"
                    .into(),
            ),
        ));
    };

    let root = match parsed {
        Parsed::Ok(root) => root,
        Parsed::Mismatch { root, expected } => {
            // Refused loudly, with the truth in hand - lenient acceptance would train
            // everyone to ignore the words, which deletes the feature.
            let key = seg.rsplit('-').next().unwrap_or("");
            let _ = root; // the claimed root is never rendered as if it were good
            return Ok(face(
                StatusCode::BAD_REQUEST,
                page(
                    "this address arrived mangled",
                    format!(
                        "<h1>this address arrived mangled</h1>\
                         <p>The words on this address don't match its key, so something got \
                         mixed up in transit.</p>\
                         <p>Did you mean <a href=\"/id/{expected}-{key}\"><code>{expected}-{key_short}…</code></a>?</p>",
                        expected = esc(&expected),
                        key = esc(key),
                        key_short = esc(&key.chars().take(8).collect::<String>()),
                    ),
                ),
            ));
        }
    };
    let root_hex = hex::encode(root);
    let speak = speakable::speakable(&root);
    let words = speak.rsplit_once('-').map(|x| x.0).unwrap_or("").to_string();

    // A session gets the SPA - the lens is the console's job, and the app router owns /id.
    if session.is_some() {
        return Ok(crate::ui::homepage(State(state)).await.into_response());
    }

    if hosted_here(&state, &root_hex).await? {
        // The shelf: this node chose to host the persona, so its public face serves. The
        // address is the FULL shareable form - origin (when declared), `?via=` hints (this
        // node first, then the persona's liveliest peers, capped at three - the SPA row's
        // rule) - shown above the bio and linked to itself, exactly as the lens shows it.
        // No separate words line: the words are the address's own prefix.
        let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
        let name = profile_value(&fields, "name").unwrap_or(&words).to_string();
        let bio = profile_value(&fields, "bio").unwrap_or("").to_string();
        let mut via = vec![state.endpoint.id().to_string()];
        for peer in crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 8)
            .await
            .unwrap_or_default()
        {
            if via.len() >= 3 {
                break;
            }
            if !via.contains(&peer) {
                via.push(peer);
            }
        }
        let base = state.config.public_url.clone().unwrap_or_default();
        let addr = format!("{base}/id/{speak}?via={}", via.join(","));
        return Ok(face(
            StatusCode::OK,
            page(
                &name,
                format!(
                    "<h1>{chip}{name}</h1>\
                     <p class=\"addr\"><a href=\"{addr}\">{addr}</a></p>\
                     {bio}\
                     <p class=\"foot\">a persona on ringtome, served from this node</p>",
                    chip = chip(&root),
                    name = esc(&name),
                    bio = if bio.is_empty() {
                        String::new()
                    } else {
                        format!("<p class=\"bio\">{}</p>", esc(&bio))
                    },
                    addr = esc(&addr),
                ),
            ),
        ));
    }

    // The warm tombstone: not carried here, and (until serving records carry public web
    // URLs - the signpost rung) nowhere to point. An honest dead end with directions.
    Ok(face(
        StatusCode::NOT_FOUND,
        page(
            &words,
            format!(
                "<h1>{chip}{words}</h1>\
                 <p>This persona lives on the quiet side of ringtome - it isn't served from \
                 this node, and it hasn't told the web where else to find it.</p>\
                 <p>If you're on ringtome, open it from your own node:</p>\
                 <p class=\"addr\">/id/{speak}</p>\
                 <p class=\"foot\">nothing about this persona is hosted here</p>",
                chip = chip(&root),
                words = esc(&words),
                speak = esc(&speak),
            ),
        ),
    ))
}

/// GET `/api/id/{root}/profile` - the anonymous JSON face, same shelf rule as the HTML:
/// hosted -> the public profile; not carried -> 404. The SPA's lens page reads this (it works
/// for any hosted persona, not just the caller's own), and it is deliberately anonymous:
/// it serves only what the HTML face already shows the whole web.
pub async fn id_profile(
    State(state): State<AppState>,
    Path(seg): Path<String>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound("no such persona here".into()));
    };
    let root_hex = hex::encode(root);
    if !hosted_here(&state, &root_hex).await? {
        return Err(AppError::NotFound("no such persona here".into()));
    }
    let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
    Ok(axum::Json(serde_json::json!({
        "root": root_hex,
        "speakable": speakable::speakable(&root),
        "fields": fields.iter().map(|f| serde_json::json!({
            "field": f.field, "value": f.value,
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}
