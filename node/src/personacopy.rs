//! Copy to another persona (Curtis, 2026-11-23): one of a persona's own pictures, sounds or videos,
//! copied into another persona of the same account - "right from hrseFiles, in single or in bulk",
//! "carrying file metadata along the way", and "anywhere" the account has two personas.
//!
//! The bytes were crushed once, at upload: a copy is the publish's own trick (`bake_private_media`)
//! with another persona's keys on the far side - read under the one's epoch key, written under the
//! other's - never decoded, re-encoded or queued for ingest. What travels with them: the title,
//! every field (a song's track, artist, album, loudness...) but the publishing machinery's own,
//! every tag, and every notebook it is in (made in the other persona, as this one has it, where
//! that one has no notebook of the name).
//!
//! The other persona remembers what each document became (`COPIED_IN`), so copying the same file
//! again names the copy already made: a run of a thousand that stopped halfway is run again and
//! picks up where it was. A copy deleted since is made again.
//!
//! One request per document, as every bulk action is (js/doc/bulk.js): the page sends them a few
//! at a time and counts them as they go.

use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::documents::Format;
use crate::record::store;
use crate::AppState;

/// The receiving persona's private register: `<from root>.<from doc>` -> the copy's id.
const COPIED_IN: &str = "copied_in";

/// The fields a copy leaves behind: what the publishing machinery wrote about the original's own
/// posts and keys, which are nothing of the copy's.
const LEFT_BEHIND: &[&str] = &[
    store::TRUSTED_KEY,
    store::PUBLISHED_AS,
    store::PUBLISHED_HEAD,
    store::PUBLISH_PLAN,
    store::PUBLISH_REFUSED,
];

fn doc_of(hex_id: &str) -> Result<[u8; 16], AppError> {
    hex::decode(hex_id).ok().and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok()).ok_or_else(
        || AppError::BadRequest(crate::msg!("personacopy.not-a-document", "that isn't a document")),
    )
}

/// POST `/api/identity/{root}/docs/{doc}/copy-to/{to}` - copy `doc`, one of `root`'s own pictures,
/// sounds or videos, into `to`, another persona of the same account. Answers the copy's id, and
/// `already` when it was made by an earlier copy and still stands.
pub async fn copy_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc, to)): Path<(String, String, String)>,
) -> Result<Json<Value>, AppError> {
    // Both are this account's: opening each through the session is the check.
    let from = store::open(&state, &session.account.id, &root).await?;
    if to == root {
        return Err(AppError::BadRequest(crate::msg!(
            "personacopy.same-persona",
            "that's this persona - choose another"
        )));
    }
    let into = store::open(&state, &session.account.id, &to).await?;
    let doc_id = doc_of(&doc)?;
    let remembered = format!("{root}.{doc}");

    // Made already, and still there: named, not made again.
    let (copied, _) = into.private_registers(COPIED_IN).all().await?;
    if let Some(earlier) = copied.iter().find(|r| r.key == remembered).map(|r| r.value.clone()) {
        if let Ok(id) = doc_of(&earlier) {
            let standing = into.documents().one(&id).await?.is_some()
                && !into.documents().deleted().await?.contains(&id);
            if standing {
                return Ok(Json(json!({ "doc_id": earlier, "already": true })));
            }
        }
    }

    if crate::builtin::get(&doc_id).is_some() {
        return Err(AppError::BadRequest(crate::msg!(
            "personacopy.came-with-the-app",
            "that one came with the app - every persona has it already"
        )));
    }
    let original = from.documents().one(&doc_id).await?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("personacopy.no-such-file", "no such file"))
    })?;
    let head = original.display_head().ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "personacopy.unreadable",
            "that file can't be read on this computer"
        ))
    })?;
    let format = Format::from_wire(head.header.format);
    if !matches!(format, Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus) {
        return Err(AppError::BadRequest(crate::msg!(
            "personacopy.only-files",
            "only pictures, sounds and videos copy to another persona, for now"
        )));
    }
    let body = from.documents().body(head).await?.ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "personacopy.not-here-yet",
            "that file hasn't reached this computer yet - try again once it has"
        ))
    })?;
    // Its thumbnail and a film's preview, where this computer holds them: a copy without one is
    // still the file.
    let thumb_avif = match head.header.thumb_hash {
        Some(h) => from.documents().blob(h).await?,
        None => None,
    };
    let preview_webm = match head.header.preview_hash {
        Some(h) => from.documents().blob(h).await?,
        None => None,
    };
    let ingested = crate::media::Ingested {
        body,
        format,
        thumb_avif,
        preview_webm,
        width: head.header.width,
        height: head.header.height,
        duration_ms: head.header.duration_ms,
        animation: head.header.animation,
        tags: Vec::new(),
    };
    let title = head.header.title.clone();

    // Written under the other persona's keys, as the ingest writes an upload.
    let new_id = crate::record::documents::new_doc_id();
    let writer = crate::ingest::Writer::of(&state, &to).await.map_err(AppError::Internal)?;
    writer
        .save(&state, new_id, Vec::new(), title, ingested, None)
        .await
        .map_err(AppError::Internal)?;

    // What it says of itself, and where it is filed.
    for (key, value) in from.annotations().fields(&doc_id).await? {
        if !LEFT_BEHIND.contains(&key.as_str()) {
            into.annotations().set_field(&new_id, &key, &value).await?;
        }
    }
    for tag in from.annotations().tags(&doc_id).await? {
        into.annotations().tag(&new_id, &tag).await?;
    }
    let notebooks = from.buckets().of(&doc_id).await?;
    if !notebooks.is_empty() {
        let theirs = into.buckets().roster().await?;
        let ours = from.buckets().roster().await?;
        for name in &notebooks {
            // A notebook the other persona lacks is made as this one has it, so the copy lands in
            // the same app.
            if !theirs.iter().any(|b| &b.name == name && !b.app.is_empty()) {
                if let Some(app) = ours
                    .iter()
                    .find(|b| &b.name == name)
                    .map(|b| b.app.clone())
                    .filter(|a| !a.is_empty())
                {
                    into.buckets().define(name, &app).await?;
                }
            }
            into.buckets().place(&new_id, name).await?;
        }
    }
    into.private_registers(COPIED_IN).set(&remembered, &hex::encode(new_id)).await?;
    Ok(Json(json!({ "doc_id": hex::encode(new_id), "already": false })))
}
