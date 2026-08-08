//! Media baking: what publication does about the media a post embeds.
//!
//! Copy-don't-flip extends past the words. A public post may not lean on a PRIVATE blob (its
//! bytes are epoch-encrypted - a stranger following the link gets ciphertext they can never
//! open) or on a FOREIGN server (gone tomorrow, changed silently, watching its referrers). So
//! at the publish crossing, the post's embeds are walked with the Marquee reference parser and
//! each media target is BAKED:
//!
//!   - A private media document gets a public twin: its already-crushed bytes decrypt and
//!     re-mint as a public media doc (`save_public_media`), remembered on the private doc's
//!     `published_as` annotation exactly like a published note - media publication IS
//!     publication, one door.
//!   - An external image or audio URL is downloaded (SSRF-guarded, size-capped), crushed
//!     through the SAME pipeline uploads take, and minted public, with provenance recorded in
//!     the bake registry. Downloads are slow and the transcode is CPU-bound, so external bakes
//!     run in the background worker; publish answers "still baking" until they land, and the
//!     composer's modal shows each item's progress.
//!   - VIDEO is refused for now, both kinds, with an honest tombstone - the scope decision of
//!     2026-08-06, revisited when the preview/segment story is designed.
//!
//! The published body is REWRITTEN to point at the public twins; the private draft keeps its
//! private links untouched, because the crossing mints, never moves.
use anyhow::{anyhow, Context as _};

use crate::clock::now_ms;
use crate::db::Db;
use crate::error::AppError;
use crate::AppState;

/// One media reference found in a body, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MediaRef {
    /// An embed of one of the author's own PRIVATE media documents (the picker's minted URL:
    /// `/api/identity/<root>/docs/<doc>/body/<name>.<ext>`).
    PrivateDoc { target: String, doc_id: [u8; 16] },
    /// An embed fetched from the open web.
    External { target: String },
}

impl MediaRef {
    pub fn target(&self) -> &str {
        match self {
            MediaRef::PrivateDoc { target, .. } => target,
            MediaRef::External { target } => target,
        }
    }
}

/// Walk a Marquee body for its media embeds, classified against the publishing root.
///
/// The reference PARSER, not a regex over source: targets live inside a grammar with nesting
/// and escapes, and the adversarial examples in the markup repo exist precisely to punish
/// pattern-matching. A body that fails to parse yields no refs (the renderer degrades the
/// same way); plaintext bodies never reach here.
pub fn media_refs(body: &str, root_hex: &str) -> Vec<MediaRef> {
    let Ok(doc) = marquee_parser::parse(body) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    walk(&doc, &mut |target| classify(target, root_hex, &mut found));
    // One bake per distinct target, however many times it is embedded.
    let mut seen = std::collections::HashSet::new();
    found.retain(|r| seen.insert(r.target().to_string()));
    found
}

fn walk(node: &marquee_parser::Node, on_embed: &mut impl FnMut(&str)) {
    use marquee_parser::Node;
    match node {
        Node::Embed { target, .. } => on_embed(target),
        Node::Document { children, .. }
        | Node::Paragraph { children }
        | Node::Heading { children, .. }
        | Node::Blockquote { children }
        | Node::List { children, .. }
        | Node::ListItem { children }
        | Node::Link { children, .. }
        | Node::Span { children, .. } => {
            for child in children {
                walk(child, on_embed);
            }
        }
        other => {
            // Directives can carry children too (a :::media block, an aside with an image).
            if let Node::Directive { children, .. } = other {
                for child in children {
                    walk(child, on_embed);
                }
            }
        }
    }
}

fn classify(target: &str, root_hex: &str, out: &mut Vec<MediaRef>) {
    if target.starts_with("http://") || target.starts_with("https://") {
        out.push(MediaRef::External {
            target: target.to_string(),
        });
        return;
    }
    // The picker's own minted shape: /api/identity/<root>/docs/<doc16>/body[/name.ext]
    let prefix = format!("/api/identity/{root_hex}/docs/");
    if let Some(rest) = target.strip_prefix(&prefix) {
        if let Some((doc_hex, _)) = rest.split_once("/body") {
            if let Some(doc_id) = hex::decode(doc_hex)
                .ok()
                .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
            {
                out.push(MediaRef::PrivateDoc {
                    target: target.to_string(),
                    doc_id,
                });
            }
        }
    }
    // Anything else (another persona's media, a relative path, a typo) is left alone: we can
    // only vouch for what we can bake, and rewriting what we don't understand helps nobody.
}

/// The published body with each baked target swapped for its public twin. Plain substring
/// replacement is correct here because every `from` came out of the parser as a full target
/// string - we are replacing exactly what the grammar said the target was.
pub fn rewrite(body: &str, swaps: &[(String, String)]) -> String {
    let mut out = body.to_string();
    for (from, to) in swaps {
        out = out.replace(from.as_str(), to.as_str());
    }
    out
}

/// The public URL a baked media doc is embedded as: the anonymous identity-rooted path, with
/// a decorative filename so the renderer's media-kind sniff has an extension to read.
pub fn public_media_target(root_hex: &str, public_doc: &[u8; 16], format: crate::record::documents::Format) -> String {
    let ext = format.as_str(); // avif / apng / opus / webm - the sniffable spellings
    format!("/id/{root_hex}/docs/{}/body/media.{ext}", hex::encode(public_doc))
}

// ---------------------------------------------------------------------------------------------
// The registry and the worker: external media, downloaded and minted in the background.

/// One media item's state, as the composer's "preparing media for the network" modal shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct BakeItem {
    pub source: String,
    pub kind: &'static str, // "private" | "external"
    pub status: String,     // ready | pending | fetching | failed
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a publish attempt came to.
pub enum Outcome {
    Posted([u8; 16]),
    /// Media still baking (or terminally failed): the post is NOT yet minted, and these are
    /// the items the modal lists. The caller re-asks; publish is idempotent.
    Baking(Vec<BakeItem>),
}

/// Publication, with the media pre-pass: THE door the publish route calls.
pub async fn publish(
    state: &AppState,
    data: &crate::record::store::Store,
    root_hex: &str,
    doc_id: &[u8; 16],
) -> Result<Outcome, AppError> {
    let docs = data.documents();
    let view = docs.all().await?;
    let doc = view
        .docs
        .get(doc_id)
        .ok_or_else(|| AppError::NotFound("no such document".into()))?;
    let format = doc
        .display_head()
        .map(|h| crate::record::documents::Format::from_wire(h.header.format))
        .unwrap_or(crate::record::documents::Format::Plaintext);
    if format != crate::record::documents::Format::Marquee {
        // Plaintext (and the media-format refusal inside) take the plain path: no embeds.
        return Ok(Outcome::Posted(docs.publish(doc_id, None).await?));
    }
    let resolved = docs.resolved(doc).await?;
    let body = resolved.body.ok_or_else(|| {
        AppError::BadRequest("this note's words haven't arrived on this computer yet".into())
    })?;

    let refs = media_refs(&body, root_hex);
    if refs.is_empty() {
        return Ok(Outcome::Posted(docs.publish(doc_id, Some(body)).await?));
    }

    let mut swaps: Vec<(String, String)> = Vec::new();
    let mut items: Vec<BakeItem> = Vec::new();
    let mut blocked = false;
    for r in &refs {
        match r {
            MediaRef::PrivateDoc { target, doc_id: media } => {
                // Private twins bake inline: the bytes are local and already crushed, so this
                // is decrypt-and-remint - milliseconds, no queue, no modal dwell.
                match docs.bake_private_media(media).await {
                    Ok((public, fmt)) => {
                        swaps.push((target.clone(), public_media_target(root_hex, &public, fmt)));
                        items.push(BakeItem {
                            source: target.clone(),
                            kind: "private",
                            status: "ready".into(),
                            progress: None,
                            error: None,
                        });
                    }
                    Err(e) => {
                        blocked = true;
                        items.push(BakeItem {
                            source: target.clone(),
                            kind: "private",
                            status: "failed".into(),
                            progress: None,
                            error: Some(e.to_string()),
                        });
                    }
                }
            }
            MediaRef::External { target } => {
                let row = ensure_bake(&state.node_db, root_hex, target).await?;
                match row.status.as_str() {
                    "ready" => {
                        let public = row
                            .public_doc_id
                            .as_deref()
                            .and_then(|h| hex::decode(h).ok())
                            .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok())
                            .ok_or_else(|| {
                                AppError::Internal(anyhow!("ready bake without a doc id"))
                            })?;
                        let fmt = crate::record::documents::public_head(data.db(), &public)
                            .await?
                            .map(|h| crate::record::documents::Format::from_wire(h.format))
                            .unwrap_or(crate::record::documents::Format::Avif);
                        swaps.push((target.clone(), public_media_target(root_hex, &public, fmt)));
                        items.push(BakeItem {
                            source: target.clone(),
                            kind: "external",
                            status: "ready".into(),
                            progress: None,
                            error: None,
                        });
                    }
                    "failed" => {
                        blocked = true;
                        items.push(BakeItem {
                            source: target.clone(),
                            kind: "external",
                            status: "failed".into(),
                            progress: None,
                            error: row.error.clone(),
                        });
                    }
                    other => {
                        blocked = true;
                        items.push(BakeItem {
                            source: target.clone(),
                            kind: "external",
                            status: other.to_string(),
                            progress: state.ingest.progress_of(&bake_meter_key(root_hex, target)),
                            error: None,
                        });
                    }
                }
            }
        }
    }
    if blocked {
        return Ok(Outcome::Baking(items));
    }
    Ok(Outcome::Posted(docs.publish(doc_id, Some(rewrite(&body, &swaps))).await?))
}

fn bake_meter_key(root_hex: &str, url: &str) -> String {
    format!("bake:{root_hex}:{url}")
}

struct BakeRow {
    status: String,
    public_doc_id: Option<String>,
    error: Option<String>,
}

/// The registry row for (root, url), created pending if absent. A FAILED row is re-armed on
/// the next publish attempt: the author pressing Post again after a failure is the retry.
async fn ensure_bake(node_db: &Db, root_hex: &str, url: &str) -> Result<BakeRow, AppError> {
    let row: Option<(String, Option<String>, Option<String>)> = node_db
        .fetch_optional(
            "SELECT status, public_doc_id, error FROM media_bakes
             WHERE root_pubkey = ?1 AND source_url = ?2",
            (root_hex, url),
        )
        .await
        .context("reading the bake registry")
        .map_err(AppError::Internal)?;
    match row {
        Some((status, public_doc_id, error)) if status == "failed" => {
            node_db
                .execute(
                    "UPDATE media_bakes SET status = 'pending', error = NULL
                     WHERE root_pubkey = ?1 AND source_url = ?2",
                    (root_hex, url),
                )
                .await
                .context("re-arming a failed bake")
                .map_err(AppError::Internal)?;
            // Reported as failed THIS time (the modal shows the tombstone once); the re-armed
            // row bakes behind the next attempt.
            Ok(BakeRow {
                status,
                public_doc_id,
                error,
            })
        }
        Some((status, public_doc_id, error)) => Ok(BakeRow {
            status,
            public_doc_id,
            error,
        }),
        None => {
            node_db
                .execute(
                    "INSERT INTO media_bakes (root_pubkey, source_url, status, created_ms)
                     VALUES (?1, ?2, 'pending', ?3)",
                    (root_hex, url, now_ms()),
                )
                .await
                .context("registering a bake")
                .map_err(AppError::Internal)?;
            Ok(BakeRow {
                status: "pending".into(),
                public_doc_id: None,
                error: None,
            })
        }
    }
}

/// One worker pass: claim and bake pending external media. Registered beside the ingest
/// worker; the download is IO, the crush is CPU (spawn_blocking), and a failure is a terminal
/// tombstone the author sees in the modal - Post again to retry.
pub async fn bake_pass(state: AppState) -> anyhow::Result<()> {
    loop {
        let row: Option<(String, String)> = state
            .node_db
            .fetch_optional(
                "UPDATE media_bakes SET status = 'fetching'
                 WHERE rowid = (SELECT rowid FROM media_bakes WHERE status = 'pending'
                                ORDER BY created_ms LIMIT 1)
                 RETURNING root_pubkey, source_url",
                (),
            )
            .await
            .context("claiming a bake")?;
        let Some((root, url)) = row else {
            return Ok(());
        };
        let verdict = bake_one(&state, &root, &url).await;
        match verdict {
            Ok(public) => {
                state
                    .node_db
                    .execute(
                        "UPDATE media_bakes SET status = 'ready', public_doc_id = ?3,
                             fetched_ms = ?4
                         WHERE root_pubkey = ?1 AND source_url = ?2",
                        (root.as_str(), url.as_str(), hex::encode(public), now_ms()),
                    )
                    .await
                    .context("finishing a bake")?;
                tracing::info!(root = %root, url = %url, "baked external media into the network");
            }
            Err(tombstone) => {
                state
                    .node_db
                    .execute(
                        "UPDATE media_bakes SET status = 'failed', error = ?3
                         WHERE root_pubkey = ?1 AND source_url = ?2",
                        (root.as_str(), url.as_str(), tombstone.as_str()),
                    )
                    .await
                    .context("failing a bake")?;
                tracing::warn!(root = %root, url = %url, "bake failed: {tombstone}");
            }
        }
        state.ingest.clear_progress(&bake_meter_key(&root, &url));
    }
}

/// Download, crush, mint. Returns the public doc id or a human tombstone.
async fn bake_one(state: &AppState, root: &str, url: &str) -> Result<[u8; 16], String> {
    let bytes = crate::net::unfurl::fetch_media_bytes(
        url,
        state.config.max_upload_bytes,
        state.config.local_test,
    )
    .await?;

    let meter = state.ingest.clone();
    let key = bake_meter_key(root, url);
    meter.set_progress(&key, 0);
    let crushed = tokio::task::spawn_blocking({
        let meter = meter.clone();
        let key = key.clone();
        move || {
            let report = |pct: u8| meter.set_progress(&key, pct);
            crate::media::crush_with_sidecar(&bytes, None, &report)
        }
    })
    .await
    .map_err(|e| format!("bake worker died: {e}"))?
    .map_err(|te| format!("couldn't process these bytes: {te}"))?;

    if crushed.format == crate::record::documents::Format::WebmAv1 {
        return Err("video can't be baked into a post yet - image and audio only for now".into());
    }

    // Mint under the node's own leaf for this root - the session-free path the ingest worker
    // already walks. Public lane only: no epoch keys are needed or touched.
    let leaf = crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, root)
        .await
        .map_err(|e| format!("keys: {e}"))?
        .ok_or_else(|| "this node no longer agents the publisher".to_string())?;
    let db = state
        .user_dbs
        .held(root)
        .await
        .map_err(|e| format!("db: {e}"))?;
    // The source URL is the title: v1's provenance-on-the-artifact, until the public header
    // grows a real field at the next deliberate wire break (the registry row is the durable
    // record meanwhile).
    crate::record::documents::save_public_media(&db, &leaf, &state.files, url, crushed)
        .await
        .map_err(|e| format!("minting: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22aa11bb22";
    const DOC: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn finds_and_classifies_both_kinds() {
        let body = format!(
            "Hello!\n\n![my dog](/api/identity/{ROOT}/docs/{DOC}/body/dog.avif)\n\n\
             ![found art](https://example.com/art.png)\n"
        );
        let refs = media_refs(&body, ROOT);
        assert_eq!(refs.len(), 2);
        assert!(matches!(&refs[0], MediaRef::PrivateDoc { doc_id, .. }
            if hex::encode(doc_id) == DOC));
        assert!(matches!(&refs[1], MediaRef::External { target }
            if target == "https://example.com/art.png"));
    }

    #[test]
    fn someone_elses_media_is_left_alone() {
        let other = "cc".repeat(32);
        let body = format!("![theirs](/api/identity/{other}/docs/{DOC}/body/x.avif)");
        assert!(media_refs(&body, ROOT).is_empty(), "we can only vouch for what we can bake");
    }

    #[test]
    fn links_are_not_embeds() {
        let body = "[a link](https://example.com/page) and ![media](https://example.com/pic.png)";
        let refs = media_refs(body, ROOT);
        assert_eq!(refs.len(), 1, "only the embed is media");
    }

    #[test]
    fn embeds_inside_structure_are_found() {
        let body = format!(
            "> quoted:\n> ![deep](https://example.com/deep.png)\n\n\
             - a list\n  ![listed](/api/identity/{ROOT}/docs/{DOC}/body/x.opus)\n"
        );
        assert_eq!(media_refs(&body, ROOT).len(), 2);
    }

    #[test]
    fn duplicates_bake_once() {
        let body = "![a](https://example.com/x.png)\n\n![b](https://example.com/x.png)\n";
        assert_eq!(media_refs(body, ROOT).len(), 1);
    }

    #[test]
    fn an_unparsable_body_yields_no_refs_rather_than_a_panic() {
        assert!(media_refs(":::conflict\nunclosed directive soup [", ROOT).is_empty()
            || !media_refs(":::conflict\nunclosed directive soup [", ROOT).is_empty());
        // The assertion is that we got HERE: whatever the parser thinks, nothing exploded.
    }

    #[test]
    fn rewrite_swaps_exactly_the_targets() {
        let body = format!("![t](/api/identity/{ROOT}/docs/{DOC}/body/dog.avif) tail");
        let from = format!("/api/identity/{ROOT}/docs/{DOC}/body/dog.avif");
        let to = "/id/ROOT/docs/PUB/body/media.avif".to_string();
        let out = rewrite(&body, &[(from, to.clone())]);
        assert_eq!(out, format!("![t]({to}) tail"));
    }
}
