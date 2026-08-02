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
        // node first, then the persona's liveliest peers, up to ten, base58-dressed - the
        // SPA row's rule; the wide list keeps fast-moving identities alive) - shown above
        // the bio and linked to itself, exactly as the lens shows it. No separate words
        // line: the words are the address's own prefix.
        let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
        let name = profile_value(&fields, "name").unwrap_or(&words).to_string();
        let bio = profile_value(&fields, "bio").unwrap_or("").to_string();
        let mut via = vec![state.endpoint.id().to_string()];
        for peer in crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 16)
            .await
            .unwrap_or_default()
        {
            if via.len() >= 10 {
                break;
            }
            if !via.contains(&peer) {
                via.push(peer);
            }
        }
        let via: Vec<String> = via
            .iter()
            .map(|k| speakable::node_key_b58(k).unwrap_or_else(|| k.clone()))
            .collect();
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

/// A fetched foreign profile stays fresh this long before a member's next visit re-syncs it.
const FOREIGN_TTL_MS: i64 = 10 * 60 * 1000;

/// Record a successful foreign fetch - ON DISK (amended 2026-08-02 from an in-memory map):
/// once an identity's own nodes go permanently dark, it survives exactly in the nodes that
/// fetched it and their memory of having done so; a fleet of friendly nodes rebooting must
/// not orphan chains they still hold. Durable KNOWLEDGE, still member-scoped SERVING - this
/// table never touches the identities table (the anonymous shelf) or identity_peers (the
/// background sync worklist): a fetch is remembered, never promoted to fronting.
async fn record_foreign_fetch(state: &AppState, root_hex: &str, via: &str) -> Result<(), AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO foreign_fetches (root_pubkey, fetched_at_ms, last_via)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(root_pubkey) DO UPDATE SET fetched_at_ms = ?2, last_via = ?3",
            (root_hex, crate::clock::now_ms(), via),
        )
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

/// The fetch memory for a root: (fetched_at_ms, the endpoint key that last answered).
async fn foreign_fetch_row(
    state: &AppState,
    root_hex: &str,
) -> Result<Option<(i64, Option<String>)>, AppError> {
    state
        .node_db
        .fetch_optional(
            "SELECT fetched_at_ms, last_via FROM foreign_fetches WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .map_err(AppError::Internal)
}

/// Per-candidate ceiling on the whole dial-and-sync; the ladder tries at most three, so a
/// page's worst case stays bounded even when every hinted node is dark.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(serde::Deserialize)]
pub struct IdQuery {
    /// Comma-separated node endpoint keys - the address's own `?via=` hints, passed through
    /// by the lens page. Hints are keys, never addresses; anything unparseable is skipped.
    pub via: Option<String>,
}

/// Fetch a foreign identity's PUBLIC chains at request time: dial the candidate node keys IN
/// PARALLEL and take the first success - with the `?via=` list widened to ten keys
/// (2026-08-02, keeping fast-moving identities alive), a sequential ladder's worst case
/// would be ten timeouts end to end, and a page can't wait for that. Each task runs the
/// ordinary sync exchange (an unproven requester with empty frontiers receives exactly the
/// public lane - the same from-empty path adoption exercises), the gate validates everything
/// against `root`, and concurrent winners are safe (single-writer chains, duplicate-skip
/// ingest; the also-rans are aborted). Candidates arrive base58 or hex; the resolve-a-bare-
/// root directory backstop does not exist yet (serving records publish under LEAF keys;
/// ledgered in NEXT_STEPS).
async fn fetch_foreign(state: &AppState, root_hex: &str, via: &[String]) -> bool {
    let mut set = tokio::task::JoinSet::new();
    for candidate in via.iter().take(10) {
        // A hint in neither spelling costs a shrug, never the ladder.
        let Some(key_hex) = speakable::node_key_from_via(candidate) else {
            continue;
        };
        let task_state = state.clone();
        let task_root = root_hex.to_string();
        set.spawn(async move {
            let addr = crate::net::sync::dial_addr(&task_state, &key_hex).await.ok()?;
            match tokio::time::timeout(
                FETCH_TIMEOUT,
                crate::net::sync::sync_with_peer(&task_state, &task_root, addr),
            )
            .await
            {
                Ok(Ok(stats)) => Some((key_hex, stats.received)),
                Ok(Err(e)) => {
                    tracing::debug!(root = %task_root, via = %key_hex, "foreign fetch failed: {e:#}");
                    None
                }
                Err(_) => {
                    tracing::debug!(root = %task_root, via = %key_hex, "foreign fetch timed out");
                    None
                }
            }
        });
    }
    while let Some(joined) = set.join_next().await {
        if let Ok(Some((key_hex, received))) = joined {
            set.abort_all();
            tracing::info!(root = %root_hex, via = %key_hex, received,
                "fetched foreign identity on member request");
            if let Err(e) = record_foreign_fetch(state, root_hex, &key_hex).await {
                tracing::warn!(root = %root_hex, "could not record foreign fetch: {e:#}");
            }
            return true;
        }
    }
    false
}

/// GET `/api/id/{root}/profile` - the JSON face. Anonymous callers get the shelf rule (hosted
/// -> the public profile; not carried -> 404: only what the HTML face already shows the whole
/// web). A MEMBER asking about an off-shelf root triggers fetch-and-serve: a demand edge in
/// miniature - funnel 2 with a named human - synced at request time, cached with a TTL,
/// ephemeral by design (the anonymous shelf grows only through durable demand; a fetch here
/// never touches the identities table, so the HTML face still tombstones this root).
pub async fn id_profile(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<IdQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound("no such persona here".into()));
    };
    let root_hex = hex::encode(root);
    let hosted = hosted_here(&state, &root_hex).await?;

    if !hosted {
        let Some(_member) = session else {
            return Err(AppError::NotFound("no such persona here".into()));
        };
        let now = crate::clock::now_ms();
        let row = foreign_fetch_row(&state, &root_hex).await?;
        let fresh = row
            .as_ref()
            .is_some_and(|(at, _)| now - at < FOREIGN_TTL_MS);
        if !fresh {
            // Candidates: the address's own hints first, then the endpoint that answered
            // last time (the durable half of the ladder - it works even when the URL was
            // typed bare, and it is what keeps a quiet identity reachable after every
            // friendly node has rebooted).
            let mut via: Vec<String> = query
                .via
                .as_deref()
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            if let Some((_, Some(last))) = &row {
                if !via.contains(last) {
                    via.push(last.clone());
                }
            }
            let fetched = fetch_foreign(&state, &root_hex, &via).await;
            // A failed fetch still serves what an earlier one left behind (stale beats
            // blank); a root we've never reached at all is honestly not-found.
            if !fetched && row.is_none() {
                return Err(AppError::NotFound(
                    "not carried here, and none of the address's computers answered".into(),
                ));
            }
        }
    }

    let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
    Ok(axum::Json(serde_json::json!({
        "root": root_hex,
        "speakable": speakable::speakable(&root),
        "foreign": !hosted,
        "fields": fields.iter().map(|f| serde_json::json!({
            "field": f.field, "value": f.value,
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}
