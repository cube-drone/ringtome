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
                "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'",
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
  .avatar {{ width: 4.5rem; height: 4.5rem; border-radius: 12px; object-fit: cover;
            display: block; margin-bottom: 0.8rem; border: 1px solid #e0d8c8;
            overflow: hidden; }}
  .avatar svg {{ width: 100%; height: 100%; display: block; }}
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

/// The persona's colour dot beside their name - the same hue their identicon and the
/// console's hexagon ring wear (crate::identicon::hue is the one source).
fn chip(root: &[u8; 32]) -> String {
    format!(
        r#"<span class="chip" style="background: hsl({}, 60%, 55%)"></span>"#,
        crate::identicon::hue(root)
    )
}

/// Is this root hosted by any account on this node? (The shelf, v1: hosting is the only
/// demand edge that exists - member follows join it when follows do.) The identities table
/// belongs to identity.rs; this is its question, asked through its door.
async fn hosted_here(state: &AppState, root_hex: &str) -> Result<bool, AppError> {
    crate::identity::is_hosted(&state.node_db, root_hex).await
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

/// GET `/id/{seg}/{*rest}` - any deeper path under a persona. Its own handler because axum
/// extracts path params POSITIONALLY: a two-parameter route destructured as one `Path<String>`
/// is a 500, not a fallback (found 2026-08-03 by the first deep /id link the app ever
/// followed - the widget gallery). The deeper path is the SPA's business: routes under a
/// persona (their pages, the gallery) resolve in the client, so this hands back the same
/// answer the bare address does.
pub async fn idface_deep(
    session: Option<Session>,
    state: State<AppState>,
    Path((seg, _rest)): Path<(String, String)>,
) -> Result<Response, AppError> {
    idface(session, state, Path(seg)).await
}

/// GET `/id/{seg}`: the one URL, both audiences.
pub async fn idface(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
) -> Result<Response, AppError> {

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
        // Their picture if they chose one, else their identicon - the same glyph the
        // console draws (crate::identicon and its JS twin). Inlined, not linked: the face's
        // CSP allows no data: images, and an inline <svg> needs no permission at all.
        let avatar = match profile_value(&fields, "avatar") {
            Some(doc) => format!(
                "<img class=\"avatar\" src=\"/id/{speak}/docs/{}/thumb\" alt=\"\">",
                esc(doc)
            ),
            None => format!(
                "<span class=\"avatar\">{}</span>",
                crate::identicon::identicon_svg(&root)
            ),
        };
        return Ok(face(
            StatusCode::OK,
            page(
                &name,
                format!(
                    "{avatar}<h1>{chip}{name}</h1>\
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

/// How long a fetched foreign profile is served without even trying to revalidate.
///
/// This was ten minutes, back when a visit's fetch sat in the request path and a long window
/// was the only thing keeping a dead peer from making a slow page. It is thirty seconds now,
/// because the fetch no longer blocks anything: a visit serves what we hold and revalidates
/// BEHIND the response. What remains is an anti-hammer floor - a reload loop must not become a
/// dial loop - and the exchange it guards is cheap in the common case (an up-to-date frontier
/// swap transfers nothing; only a persona that actually moved costs more than a kilobyte).
const FOREIGN_REVALIDATE_MS: i64 = 30 * 1000;

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

/// Drop a root's fetch memory - called when this node starts HOSTING it (identity.rs), the
/// one transition that makes the record wrong rather than merely old.
pub async fn forget_foreign_fetch(node_db: &crate::db::Db, root_hex: &str) -> Result<(), AppError> {
    node_db
        .execute("DELETE FROM foreign_fetches WHERE root_pubkey = ?1", (root_hex,))
        .await
        .map_err(AppError::Internal)?;
    Ok(())
}

/// The fetch memory for a root: (fetched_at_ms, the endpoint key that last answered).
/// Every foreign root this node has fetched and still carries. The other half of "personas we
/// hold" - deliberately NOT in the identities table (that is what keeps the anonymous face
/// tombstoning them), so the frontier sweep has to ask both.
pub async fn fetched_roots(node_db: &crate::db::Db) -> anyhow::Result<Vec<String>> {
    use anyhow::Context;
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT root_pubkey FROM foreign_fetches", ())
        .await
        .context("listing fetched identities")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Has this node ever fetched-and-carried this foreign root? The sync responder's question
/// when a push arrives for a persona we don't host: a carried persona's updates are welcome.
pub async fn has_fetched(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<bool> {
    use anyhow::Context;
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM foreign_fetches WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("checking the fetch registry")?;
    Ok(row.is_some())
}

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

/// Start a background revalidation of a foreign persona, unless one is already running for it.
///
/// Returns whether a refresh is now in flight - true if this call started one OR found one
/// already going, because either way the answer being served may be superseded shortly, and
/// that is what the caller is asking.
///
/// The in-flight set is what keeps a reload loop from becoming a dial loop: ten page loads in a
/// second dial the stranger's node once. It is released in every exit path (the guard is
/// dropped by the task's own end, success or failure), because a root that leaked into the set
/// would never be refreshed again for the life of the process.
fn spawn_revalidate(state: &AppState, root_hex: String, via: Vec<String>) -> bool {
    {
        let mut running = state.refreshing.lock().unwrap();
        if !running.insert(root_hex.clone()) {
            return true; // already being fetched; the caller's answer is superseded either way
        }
    }
    let task_state = state.clone();
    tokio::spawn(async move {
        let ok = fetch_foreign(&task_state, &root_hex, &via).await;
        if !ok {
            tracing::debug!(root = %root_hex, "background revalidation reached nobody");
        }
        task_state.refreshing.lock().unwrap().remove(&root_hex);
    });
    true
}

#[derive(serde::Serialize)]
pub struct DirectoryRow {
    pub root: String,
    pub speakable: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Hosted here (a neighbor), or merely known here (someone a member once reached).
    pub hosted: bool,
}

/// GET `/api/directory` - the personas this node KNOWS, for its members: a proto-discovery
/// surface, and the first place anywhere that ENUMERATES identities, which is why its rules
/// are consent lines rather than reach:
///
///   - Hosted personas appear only once SERVED. `served_at_ms` is the publication act
///     ("identities are born dark"), and it gates local listing for the same reason it gates
///     the DHT record - a housemate's dark pseudonym must not be volunteered to housemates.
///   - Fetched personas appear because acquaintance is the surface's whole value - but the
///     trail is node-level and anonymous WITHIN the node by construction: `foreign_fetches`
///     has no account column, so a row says "someone here has met them", never who.
///   - Members only. The anonymous face keeps tombstoning everything it already tombstones;
///     a stranger enumerating who this node knows would be reading its members' interests.
///   - Follows are never consulted. A quiet follow is quiet (Edge-Endpoint Visibility), and
///     this list must not be a way to notice one.
///
/// Bylines come from the cache - one query, no database per face (the conventions test pins
/// this surface to zero `user_dbs.get` calls simply by counting).
pub async fn directory(
    _session: Session,
    State(state): State<AppState>,
) -> Result<axum::Json<Vec<DirectoryRow>>, AppError> {
    let served: std::collections::BTreeSet<String> =
        crate::identity::served_roots(&state.node_db)
            .await?
            .into_iter()
            .collect();
    let fetched = fetched_roots(&state.node_db)
        .await
        .map_err(AppError::Internal)?;
    let mut roots: Vec<String> = served.iter().cloned().collect();
    roots.extend(fetched.into_iter().filter(|r| !served.contains(r)));

    let bylines = crate::profiles::bylines(&state.node_db, &roots)
        .await
        .map_err(AppError::Internal)?;
    let mut rows: Vec<DirectoryRow> = roots
        .into_iter()
        .filter_map(|root| {
            let raw = crate::pubkey::decode(&root)?;
            let byline = bylines.get(&root).cloned().unwrap_or_default();
            Some(DirectoryRow {
                speakable: speakable::speakable(&raw),
                hosted: served.contains(&root),
                name: byline.name,
                avatar: byline.avatar,
                root,
            })
        })
        .collect();
    // The named before the nameless, each alphabetically - a directory people can scan.
    rows.sort_by(|a, b| match (&a.name, &b.name) {
        (Some(x), Some(y)) => x.to_lowercase().cmp(&y.to_lowercase()),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.speakable.cmp(&b.speakable),
    });
    Ok(axum::Json(rows))
}

/// GET `/id/{seg}/docs/{doc}/body` and `/thumb` - a public document's bytes, anonymously.
/// The lane check is the whole gate: `public_head` answers only for POSTS-lane documents, so
/// a private doc_id asked through this door is a 404, never a leak. Bytes are served with
/// the stored format's own Content-Type, nosniff, and immutable caching (content-addressed:
/// a different avatar is a different document).
async fn public_doc_bytes(
    state: &AppState,
    seg: &str,
    doc_hex: &str,
    thumb: bool,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(seg) else {
        return Err(AppError::NotFound("no such persona here".into()));
    };
    let root_hex = hex::encode(root);
    // exists, not get: an anonymous probe for a stranger's bytes must not mint a database.
    if !state.user_dbs.exists(&root_hex) {
        return Err(AppError::NotFound("nothing of theirs is held here".into()));
    }
    let doc_id: [u8; 16] = hex::decode(doc_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::NotFound("no such document".into()))?;
    let db = state.user_dbs.get(&root_hex).await.map_err(AppError::Internal)?;
    let Some(head) = crate::record::documents::public_head(&db, &doc_id).await? else {
        return Err(AppError::NotFound("no such public document here".into()));
    };
    let (hash, mime) = if thumb {
        let Some(t) = head.thumb_hash else {
            return Err(AppError::NotFound("this document has no thumbnail".into()));
        };
        (t, "image/avif")
    } else {
        (
            head.file_hash,
            crate::record::documents::Format::from_wire(head.format).mime(),
        )
    };
    let Some(bytes) = state
        .files
        .get_public(iroh_blobs::Hash::from_bytes(hash))
        .await
        .map_err(AppError::Internal)?
    else {
        return Err(AppError::NotFound(
            "the bytes haven't arrived here yet - headers travel ahead of bodies".into(),
        ));
    };
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

pub async fn public_body_route(
    State(state): State<AppState>,
    Path((seg, doc_hex)): Path<(String, String)>,
) -> Result<Response, AppError> {
    public_doc_bytes(&state, &seg, &doc_hex, false).await
}

pub async fn public_thumb_route(
    State(state): State<AppState>,
    Path((seg, doc_hex)): Path<(String, String)>,
) -> Result<Response, AppError> {
    public_doc_bytes(&state, &seg, &doc_hex, true).await
}

/// GET `/api/id/{root}/profile` - the JSON face. Anonymous callers get the shelf rule (hosted
/// -> the public profile; not carried -> 404: only what the HTML face already shows the whole
/// web). A MEMBER asking about an off-shelf root triggers fetch-and-serve: a demand edge in
/// miniature - funnel 2 with a named human - synced at request time, cached with a TTL,
/// ephemeral by design (the anonymous shelf grows only through durable demand; a fetch here
/// never touches the identities table, so the HTML face still tombstones this root).
/// How many posts a page of the public shelf carries. The profile's first page and the
/// "further back" pages are the same size, so the reader's scroll is even.
pub const POSTS_PAGE: i64 = 20;

#[derive(serde::Deserialize)]
pub struct PostsQuery {
    /// The cursor: the `published_ms` and `doc_id` of the last post already shown.
    pub after_ms: Option<i64>,
    pub after_doc: Option<String>,
}

/// GET `/api/id/{root}/posts` - further back down someone's public shelf.
///
/// The shelf rule, same as the profile's: anonymous callers get personas this node HOSTS, and
/// nothing else. A member may page a foreign persona too, but only one this node has already
/// reached - paging is a continuation of a visit, so it reads what an earlier fetch brought
/// home rather than reaching across the network again per page turn.
pub async fn id_posts(
    session: Option<Session>,
    State(state): State<AppState>,
    Path(seg): Path<String>,
    axum::extract::Query(query): axum::extract::Query<PostsQuery>,
) -> Result<Response, AppError> {
    let Some(Parsed::Ok(root)) = speakable::parse(&seg) else {
        return Err(AppError::NotFound("no such persona here".into()));
    };
    let root_hex = hex::encode(root);
    let missing = || AppError::NotFound("no such persona here".into());
    if !hosted_here(&state, &root_hex).await?
        && (session.is_none() || foreign_fetch_row(&state, &root_hex).await?.is_none())
    {
        return Err(missing());
    }
    // A cursor that doesn't parse is a bad REQUEST, and says so: answering "no such persona"
    // to a malformed doc_id sends the reader looking for the wrong problem entirely (it did:
    // this was written against a 32-byte id, and document ids are 16).
    let after = match (query.after_ms, query.after_doc.as_deref()) {
        (Some(ms), Some(doc)) => {
            let bad = || AppError::BadRequest("that cursor isn't a document id".into());
            let raw = hex::decode(doc).map_err(|_| bad())?;
            let id: [u8; 16] = raw.try_into().map_err(|_| bad())?;
            Some((ms, id))
        }
        _ => None,
    };
    // One more than the page, to learn whether there IS a further page without counting the
    // whole shelf - the extra row is the answer and never reaches the reader.
    let mut posts = match state.user_dbs.get(&root_hex).await {
        Ok(db) => crate::record::documents::public_docs(&db, after, POSTS_PAGE + 1)
            .await
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let more = posts.len() as i64 > POSTS_PAGE;
    posts.truncate(POSTS_PAGE as usize);
    Ok(axum::Json(serde_json::json!({
        "posts": posts.iter().map(post_json).collect::<Vec<_>>(),
        "more": more,
    }))
    .into_response())
}

/// One post, as every surface reports it.
fn post_json(p: &crate::record::documents::PublicDoc) -> serde_json::Value {
    serde_json::json!({
        "doc_id": hex::encode(p.doc_id),
        "title": p.title,
        "format": crate::record::documents::Format::from_wire(p.format).as_str(),
        // When it was first said - what it is dated by and sorted by. A re-publication
        // improves a post; it does not make a new one, and does not move it.
        "published_ms": p.genesis_ms,
        "updated_ms": p.head_ms,
        "thumb": p.thumb_hash.map(hex::encode),
    })
}

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

    // Whether a refresh is running behind this response, so the caller knows to look again, and
    // when this node last successfully reached them. Both are honest only for a FOREIGN
    // persona: one we host has no "last synced" - its words are written here.
    let mut refreshing = false;
    let mut synced_ms: Option<i64> = None;
    if !hosted {
        let Some(_member) = session else {
            return Err(AppError::NotFound("no such persona here".into()));
        };
        let now = crate::clock::now_ms();
        let row = foreign_fetch_row(&state, &root_hex).await?;
        // Candidates: the address's own hints first, then the endpoint that answered last time
        // (the durable half of the ladder - it works even when the URL was typed bare, and it
        // is what keeps a quiet identity reachable after every friendly node has rebooted).
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
        match &row {
            // Nothing held: there is nothing to serve stale, so this one waits. A first visit
            // to a stranger is the only case that pays the network's latency.
            None => {
                synced_ms = Some(now); // this request IS the sync; saying so beats saying nothing
                if !fetch_foreign(&state, &root_hex, &via).await {
                    return Err(AppError::NotFound(
                        "not carried here, and none of the address's computers answered".into(),
                    ));
                }
            }
            // Something held: answer NOW and revalidate behind it. A visit is the demand
            // signal the pull model is built on, so it always means "go and look" - but the
            // reader should not wait on a stranger's node to find that out.
            Some((at, _)) => {
                synced_ms = Some(*at);
                if now - at >= FOREIGN_REVALIDATE_MS {
                    refreshing = spawn_revalidate(&state, root_hex.clone(), via);
                }
            }
        }
    }

    let fields = public_profile(&state, &root_hex).await.unwrap_or_default();
    // What they have PUBLISHED - the public lane's documents, newest first. Keyless and
    // lane-checked like everything on this surface; a private note cannot appear here
    // because the query cannot name one.
    let mut posts = match state.user_dbs.get(&root_hex).await {
        Ok(db) => crate::record::documents::public_docs(&db, None, POSTS_PAGE + 1)
            .await
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let posts_more = posts.len() as i64 > POSTS_PAGE;
    posts.truncate(POSTS_PAGE as usize);
    // How to REACH this persona, as this node honestly knows it - the `?via=` hints any
    // address minted here should carry (Addressing: hints are keys, never addresses).
    //
    // Hosted: this node serves them to anyone, so it hints ITSELF first, then their
    // liveliest known peers. NOT hosted: this node serves them to nobody (fetch-and-serve
    // is member-scoped and the anonymous face still tombstones them), so hinting itself
    // would hand strangers a dead end - the honest hints are the ones that reached them,
    // whatever the caller's URL carried plus the endpoint that last answered for them.
    let mut via: Vec<String> = Vec::new();
    if hosted {
        via.push(state.endpoint.id().to_string());
        via.extend(
            crate::net::sync::liveliest_peers(&state.node_db, &root_hex, 16)
                .await
                .unwrap_or_default(),
        );
    } else {
        via.extend(
            query
                .via
                .as_deref()
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .filter_map(speakable::node_key_from_via),
        );
        if let Some((_, Some(last))) = foreign_fetch_row(&state, &root_hex).await? {
            via.push(last);
        }
    }
    let mut seen = std::collections::BTreeSet::new();
    let via: Vec<String> = via
        .into_iter()
        .filter(|k| seen.insert(k.clone()))
        .take(10)
        .filter_map(|k| speakable::node_key_b58(&k))
        .collect();

    Ok(axum::Json(serde_json::json!({
        "root": root_hex,
        "speakable": speakable::speakable(&root),
        "foreign": !hosted,
        // Whether an address minted here may wear this node's ORIGIN: only for personas it
        // actually serves. A foreign persona's address mints origin-free, which re-homes at
        // whatever node the reader has.
        "hosted": hosted,
        "via": via,
        // A refresh is running behind this answer: what you are reading may be a moment old,
        // and asking again shortly will say so honestly either way.
        "refreshing": refreshing,
        // When this node last reached them, for a persona it does not host. Absent for one it
        // does: a persona we host has no "last synced" - its words are written here.
        "synced_ms": synced_ms,
        "posts": posts.iter().map(post_json).collect::<Vec<_>>(),
        // Whether the shelf goes further back than this first page.
        "posts_more": posts_more,
        "fields": fields.iter().map(|f| serde_json::json!({
            "field": f.field, "value": f.value,
        })).collect::<Vec<_>>(),
    }))
    .into_response())
}
