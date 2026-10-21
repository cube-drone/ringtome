//! Upload links (plans/MCP.md, _Pictures_): a short-lived, single-use address a file can be sent
//! to without signing in - how an AI agent gets a picture onto the node, since MCP carries no
//! files from a client to a server (ruling 11, Curtis, 2026-10-10: "Making the MCP able to deal
//! with images!").
//!
//! The `upload_link` tool mints one through [`mint_handler`], as the persona it acts for; the
//! address is the capability. An agent with a shell sends the file to it (`curl --data-binary`),
//! and a person whose assistant lives in a chat window opens it in a browser, where the app draws a
//! page to choose the file (js/uploadlink.js). Either way the upload is an ordinary one: queued for
//! ingest under the document id the link was minted with, filed where uploads live, and marked with
//! what it was made with when an agent asked for the link (made_with.rs). Its answer waits a while
//! for the picture to be made, and hands back the embed to put in a note or a post.
//!
//! - **Single use, and short-lived.** A link opens once ([`Links::take`]) and lives
//!   [`LIFETIME_MS`]: an address that found its way into a log or a transcript is spent, or soon
//!   will be. Only its hash is kept.
//! - **Held in memory.** A link outlives no restart - a node that restarts in the half hour costs
//!   the agent one more `upload_link`, and nothing about it is ever written down.
//! - **Bounded.** At most [`OPEN_PER_ACCOUNT`] open links an account, and each upload is held to
//!   the node's upload cap, as the app's own upload door is.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::Session;
use crate::clock::now_ms;
use crate::error::AppError;
use crate::AppState;

/// How long a link opens: long enough for a person to find the picture, short enough that a
/// spent address isn't worth finding.
pub const LIFETIME_MS: i64 = 30 * 60 * 1000;
/// The most links an account may hold open at once.
pub const OPEN_PER_ACCOUNT: usize = 32;
/// How long an upload's answer waits for its picture to be made before saying it is still being
/// made: a photo takes a second or two, a long video minutes.
const WAIT_MS: u64 = 45_000;
/// The notebook every upload lives in (pure/apps.js `FILES_BUCKET`).
const FILES_BUCKET: &str = "files";

/// One open link.
#[derive(Clone)]
struct Link {
    account: Uuid,
    root: String,
    doc_id: [u8; 16],
    title: String,
    /// A notebook to file the upload in as well (2026-10-11, an agent's batch of uploads into
    /// one notebook): filed at the top of its tree too, when it has one.
    notebook: Option<String>,
    expires_ms: i64,
    /// What the upload was made with (made_with.rs), from the request that minted the link.
    made_with: Option<&'static str>,
}

/// The open links, by the hash of their token.
#[derive(Clone, Default)]
pub struct Links(Arc<Mutex<HashMap<[u8; 32], Link>>>);

impl Links {
    fn put(&self, token_hash: [u8; 32], link: Link) -> Result<(), AppError> {
        let mut all = self.0.lock().expect("upload links poisoned");
        let now = now_ms();
        all.retain(|_, l| l.expires_ms > now);
        if all.values().filter(|l| l.account == link.account).count() >= OPEN_PER_ACCOUNT {
            return Err(AppError::BadRequest(crate::msg!(
                "upload-link.too-many",
                "this account has {n} upload links open already - use one, or wait half an hour",
                n = OPEN_PER_ACCOUNT
            )));
        }
        all.insert(token_hash, link);
        Ok(())
    }

    /// The link `token` opens, if it is open.
    fn peek(&self, token: &str) -> Option<Link> {
        let all = self.0.lock().expect("upload links poisoned");
        all.get(&hash(token)).filter(|l| l.expires_ms > now_ms()).cloned()
    }

    /// The link `token` opens, spent: the first upload takes it, and no second one finds it.
    fn take(&self, token: &str) -> Option<Link> {
        let mut all = self.0.lock().expect("upload links poisoned");
        all.remove(&hash(token)).filter(|l| l.expires_ms > now_ms())
    }
}

fn hash(token: &str) -> [u8; 32] {
    *blake3::hash(token.as_bytes()).as_bytes()
}

fn gone() -> AppError {
    AppError::NotFound(crate::msg!(
        "upload-link.gone",
        "this upload link has been used, or has expired - ask for another"
    ))
}

#[derive(Deserialize, Default)]
pub struct MintRequest {
    /// What the file is called, as its document's title. Defaults to "picture".
    #[serde(default)]
    title: Option<String>,
    /// A notebook to file it in, beside the files notebook every upload lives in.
    #[serde(default)]
    notebook: Option<String>,
}

#[derive(Serialize)]
pub struct Minted {
    /// The address, as a path on this node: `/upload/<token>`.
    path: String,
    /// The document the upload becomes.
    doc_id: String,
    expires_ms: i64,
}

/// POST `/api/identity/{root}/upload-links` - a link for one upload into this persona.
pub async fn mint_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    body: Option<Json<MintRequest>>,
) -> Result<Json<Minted>, AppError> {
    crate::record::store::open(&state, &session.account.id, &root).await?;
    let asked = body.map(|Json(b)| b).unwrap_or_default();
    let title = asked
        .title
        .map(|t| t.trim().chars().take(200).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "picture".to_string());
    let token = {
        use rand::Rng;
        let mut b = [0u8; 32];
        crate::random::OsRng.fill_bytes(&mut b);
        hex::encode(b)
    };
    let doc_id = crate::record::documents::new_doc_id();
    let expires_ms = now_ms() + LIFETIME_MS;
    state.upload_links.put(
        hash(&token),
        Link {
            account: session.account.id,
            root,
            doc_id,
            title,
            notebook: asked
                .notebook
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty() && n != FILES_BUCKET),
            expires_ms,
            made_with: session.made_with(),
        },
    )?;
    Ok(Json(Minted { path: format!("/upload/{token}"), doc_id: hex::encode(doc_id), expires_ms }))
}

#[derive(Serialize)]
pub struct Described {
    title: String,
    expires_ms: i64,
    max_bytes: usize,
}

/// GET `/api/upload/{token}` - what the page shows before the file is chosen. Nothing about the
/// persona: the address is all a holder has, and it says only that an upload is waiting.
pub async fn describe_handler(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<Described>, AppError> {
    let link = state.upload_links.peek(&token).ok_or_else(gone)?;
    Ok(Json(Described {
        title: link.title,
        expires_ms: link.expires_ms,
        max_bytes: state.config.max_upload_bytes,
    }))
}

#[derive(Serialize)]
pub struct Uploaded {
    doc_id: String,
    /// "ready", "pending" (still being made when the wait ran out), or "failed".
    status: &'static str,
    /// The stored format once made: avif, apng, webm or opus.
    #[serde(skip_serializing_if = "Option::is_none")]
    format: Option<&'static str>,
    /// The markup that shows it in a note or a post, once made.
    #[serde(skip_serializing_if = "Option::is_none")]
    embed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// POST `/upload/{token}` (the address handed out) or `/api/upload/{token}` (the page's) - the file, as the request's body. Spends the link, queues the file
/// as an upload, and waits up to [`WAIT_MS`] for it to be made.
pub async fn upload_handler(
    State(state): State<AppState>,
    Path(token): Path<String>,
    body: Bytes,
) -> Result<(StatusCode, Json<Uploaded>), AppError> {
    if body.is_empty() {
        return Err(AppError::BadRequest(crate::msg!(
            "upload-link.empty",
            "that upload was empty - send the file as the request's body"
        )));
    }
    let link = state.upload_links.take(&token).ok_or_else(gone)?;
    let data = crate::record::store::open(&state, &link.account, &link.root).await?;
    state
        .ingest
        .enqueue(
            &state.node_db,
            crate::ingest::Upload {
                account: &link.account.to_string(),
                root: &link.root,
                doc_id: link.doc_id,
                parents: &[],
                title: &link.title,
                bytes: &body,
                audio: None,
            },
        )
        .await?;
    // Filed where uploads live, and marked as an agent's, as the app's upload and an agent's
    // writes are - both annotations, which may come before the picture they describe.
    data.buckets().place(&link.doc_id, FILES_BUCKET).await?;
    if let Some(notebook) = &link.notebook {
        data.buckets().place(&link.doc_id, notebook).await?;
        file_into_tree(&data, notebook, &link.doc_id).await?;
    }
    if let Some(tag) = link.made_with {
        data.annotations().tag(&link.doc_id, tag).await?;
    }
    let answer = made(&state, &data, &link).await;
    let code = if answer.status == "pending" { StatusCode::ACCEPTED } else { StatusCode::OK };
    Ok((code, Json(answer)))
}

/// File a document at the end of its notebook's tree, when the notebook has one - as the app
/// files a document copied into a notebook (js/doc/tree.js `fileIntoTree`): the tree is the
/// taxonomy titled `wiki:<notebook>` (pure/naming.js `rootTitleFor`), the lowest id winning a
/// tie two computers minted at once.
async fn file_into_tree(
    data: &crate::record::store::Store,
    notebook: &str,
    doc_id: &[u8; 16],
) -> Result<(), AppError> {
    let title = format!("wiki:{notebook}");
    let tree = data
        .taxonomies()
        .all()
        .await?
        .into_iter()
        .filter(|t| t.title == title)
        .map(|t| t.taxonomy_id)
        .min();
    if let Some(tree) = tree {
        data.taxonomies().place(&tree, &data.root(), doc_id, None).await?;
    }
    Ok(())
}

/// Wait for ingest to make the upload: ready, with its embed; failed, with why; or still pending
/// when [`WAIT_MS`] runs out.
async fn made(state: &AppState, data: &crate::record::store::Store, link: &Link) -> Uploaded {
    let doc_hex = hex::encode(link.doc_id);
    let started = std::time::Instant::now();
    loop {
        if let Ok(Some(head)) = data.documents().head(&link.doc_id).await {
            let format = crate::record::documents::Format::from_wire(head.format);
            let (ext, name) = match format {
                crate::record::documents::Format::Apng => ("apng", "apng"),
                crate::record::documents::Format::WebmAv1 => ("webm", "webm"),
                crate::record::documents::Format::OggOpus => ("ogg", "opus"),
                _ => ("avif", "avif"),
            };
            let url = crate::import::media_url(
                &link.root,
                &link.doc_id,
                &link.title,
                ext,
                head.animation,
            );
            return Uploaded {
                doc_id: doc_hex,
                status: "ready",
                format: Some(name),
                embed: Some(format!("![{}]({url})", alt(&link.title))),
                error: None,
            };
        }
        let job =
            crate::ingest::latest_job_for_doc(&state.node_db, &link.account.to_string(), &doc_hex)
                .await;
        if let Ok(Some((status, error))) = job {
            if status == "failed" {
                return Uploaded {
                    doc_id: doc_hex,
                    status: "failed",
                    format: None,
                    embed: None,
                    error: Some(error.unwrap_or_else(|| "it couldn't be read".to_string())),
                };
            }
        }
        if started.elapsed().as_millis() as u64 >= WAIT_MS {
            return Uploaded {
                doc_id: doc_hex,
                status: "pending",
                format: None,
                embed: None,
                error: None,
            };
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}

/// Alt text as the composer writes it (pure/mediakind.js `altLabel`): one line, no brackets.
fn alt(title: &str) -> String {
    let cleaned: String = title.chars().filter(|c| !matches!(c, '[' | ']' | '(' | ')')).collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(account: Uuid, expires_ms: i64) -> Link {
        Link {
            account,
            root: "r".into(),
            doc_id: [1; 16],
            title: "t".into(),
            notebook: None,
            expires_ms,
            made_with: None,
        }
    }

    #[test]
    fn a_link_opens_once_and_not_after_it_expires() {
        let links = Links::default();
        let me = Uuid::new_v4();
        links.put(hash("open"), link(me, now_ms() + 60_000)).unwrap();
        links.put(hash("stale"), link(me, now_ms() - 1)).unwrap();
        assert!(links.peek("open").is_some(), "looking doesn't spend it");
        assert!(links.take("open").is_some());
        assert!(links.take("open").is_none(), "single use");
        assert!(links.take("stale").is_none(), "expired");
        assert!(links.take("never").is_none());
    }

    #[test]
    fn an_account_holds_only_so_many_open() {
        let links = Links::default();
        let (me, them) = (Uuid::new_v4(), Uuid::new_v4());
        for i in 0..OPEN_PER_ACCOUNT {
            links.put(hash(&format!("t{i}")), link(me, now_ms() + 60_000)).unwrap();
        }
        assert!(links.put(hash("one more"), link(me, now_ms() + 60_000)).is_err());
        assert!(links.put(hash("theirs"), link(them, now_ms() + 60_000)).is_ok(), "per account");
    }

    #[test]
    fn alt_text_is_one_line_without_brackets() {
        assert_eq!(alt("a [brown]  horse\n(tall)"), "a brown horse tall");
    }
}
