//! Rights (plans/AUDIO.md, section 8): a peer-to-peer SoundCloud, not a Napster. Two safeguards,
//! both about a *tagged* song - one whose artist or album is set (ruling 15):
//!
//!   - **The sign** (ruling 16): the app asks, every time a person publishes something carrying a
//!     tagged song, whether they have the right to. The node doesn't check it - agents and the API
//!     aren't asked - but answers the app's question of which tagged songs a draft carries
//!     ([`tagged_handler`]).
//!   - **The fence** (ruling 17): an operator's setting that refuses tagged audio altogether. The
//!     publishing half: the bake refuses a post carrying a tagged song, for everyone on this node,
//!     agents included ([`refuse_if_fenced`]). The carrying half (slice 10): a tagged song's audio
//!     file - anyone's, this node's own people's published ones too - is neither fetched
//!     (net::bodies, the body walk), kept (reaper.rs) nor served (idface's body door)
//!     ([`fenced_hashes`], [`is_fenced_sound`]). Its thumbnail, its post and its words all stay;
//!     only the sound goes. Private files are untouched: ruling 17 is about public chains.
//!
//! Owns the `audio_policy` SQL (tests/conventions.rs).

use anyhow::Context as _;
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::bake::{media_refs, public_links, twin_address, MediaRef};
use crate::record::store;
use crate::AppState;

/// The fields that make a song tagged (ruling 15).
const TAGGED_BY: &[&str] = &["artist", "album"];

/// Does this node publish tagged audio? Yes unless its operator said no.
pub async fn tagged_allowed(state: &AppState) -> bool {
    let row: Option<(i64,)> = state
        .node_db
        .fetch_optional("SELECT tagged FROM audio_policy WHERE id = 1", ())
        .await
        .ok()
        .flatten();
    row.is_none_or(|(on,)| on != 0)
}

/// One tagged song a draft carries, as the warning names it.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Tagged {
    pub title: String,
    pub artist: String,
    pub album: String,
}

fn tagged_from(fields: &std::collections::BTreeMap<String, String>) -> Option<Tagged> {
    let get = |k: &str| fields.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
    TAGGED_BY.iter().any(|k| !get(k).is_empty()).then(|| Tagged {
        title: get("track"),
        artist: get("artist"),
        album: get("album"),
    })
}

/// The tagged songs among a draft's embeds: the author's own sounds, by their fields; someone
/// else's copied in, by what their author said on theirs. Media from the open web carries no
/// fields to read, and passes.
pub async fn tagged_among(
    state: &AppState,
    data: &store::Store,
    refs: &[MediaRef],
) -> Result<Vec<Tagged>, AppError> {
    let mut out = Vec::new();
    for r in refs {
        match r {
            MediaRef::PrivateDoc { doc_id, .. } => {
                let docs = data.documents();
                let Some(doc) = docs.one(doc_id).await? else { continue };
                let is_sound = doc.display_head().is_some_and(|h| {
                    crate::record::documents::Format::from_wire(h.header.format)
                        == crate::record::documents::Format::OggOpus
                });
                if !is_sound {
                    continue;
                }
                let fields = data.annotations().fields(doc_id).await?;
                if let Some(mut t) = tagged_from(&fields) {
                    if t.title.is_empty() {
                        t.title =
                            doc.display_head().map(|h| h.header.title.clone()).unwrap_or_default();
                    }
                    out.push(t);
                }
            }
            MediaRef::Foreign { target, author } => {
                let Some((_, twin)) = twin_address(target) else { continue };
                let asked = [(hex::encode(author), hex::encode(twin))];
                let said: std::collections::BTreeMap<String, String> =
                    crate::annotations::for_posts(state, &asked, None)
                        .await
                        .map_err(AppError::Internal)?
                        .remove(&asked[0])
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|a| a.annotator == asked[0].0)
                        .map(|a| (a.key, a.value))
                        .collect();
                if let Some(t) = tagged_from(&said) {
                    out.push(t);
                }
            }
            MediaRef::External { .. } => {}
        }
    }
    Ok(out)
}

/// The fence, at publish (ruling 17): on a node whose operator said no, a post carrying a tagged
/// song is refused before any of it is baked, with words that say whose choice it is.
pub async fn refuse_if_fenced(
    state: &AppState,
    data: &store::Store,
    refs: &[MediaRef],
) -> Result<(), AppError> {
    if tagged_allowed(state).await {
        return Ok(());
    }
    let tagged = tagged_among(state, data, refs).await?;
    if let Some(first) = tagged.first() {
        return Err(AppError::BadRequest(crate::msg!(
            "rights.this-server-doesnt-publish-tagged",
            "this server doesn't publish songs that name their artist or album - its operator's choice (\"{title}\"{more})",
            title = if first.title.is_empty() { first.artist.clone() } else { first.title.clone() },
            more = if tagged.len() > 1 { format!(" and {} more", tagged.len() - 1) } else { String::new() }
        )));
    }
    Ok(())
}

/// Is the fence up: does this node refuse tagged audio?
pub async fn fenced(state: &AppState) -> bool {
    !tagged_allowed(state).await
}

fn is_sound(format: Option<u64>) -> bool {
    format == Some(ringtome_proto::registry::doc_format::OGG_OPUS)
}

/// Is this one of `author`'s tagged songs, refused here (the body door's question)? `format` is
/// the document's, so a post that happens to wear an artist label never loses its words.
pub async fn is_fenced_sound(
    state: &AppState,
    author_hex: &str,
    doc_hex: &str,
    format: Option<u64>,
) -> bool {
    is_sound(format)
        && fenced(state).await
        && crate::annotations::tagged_docs(&state.node_db, author_hex)
            .await
            .map(|d| d.contains(doc_hex))
            .unwrap_or(false)
}

/// The audio files of `author`'s tagged songs, when the fence is up (empty when it isn't): what
/// this node must neither fetch nor keep. Read from the fragment shelf, and from the author's
/// chain where this node holds it - `held` when the caller already has it open, else opened here.
pub async fn fenced_hashes(
    state: &AppState,
    author_hex: &str,
    held: Option<&crate::db::Db>,
) -> anyhow::Result<std::collections::HashSet<[u8; 32]>> {
    let mut out = std::collections::HashSet::new();
    if !fenced(state).await {
        return Ok(out);
    }
    let docs = crate::annotations::tagged_docs(&state.node_db, author_hex).await?;
    if docs.is_empty() {
        return Ok(out);
    }
    let opened;
    let db = match held {
        Some(db) => Some(db),
        None => {
            opened = state.user_dbs.get(author_hex).await?;
            opened.as_ref()
        }
    };
    for doc_hex in docs {
        let Some(doc) = hex::decode(&doc_hex).ok().and_then(|b| <[u8; 16]>::try_from(b).ok())
        else {
            continue;
        };
        if let Some(h) = crate::fragments::serving_header(&state.node_db, author_hex, &doc).await? {
            if is_sound(h.format) {
                out.insert(h.file_hash);
            }
        }
        if let Some(db) = db {
            if let Some(head) = crate::record::documents::public_head(db, &doc)
                .await
                .map_err(|e| anyhow::anyhow!("reading a tagged song's head: {e:?}"))?
            {
                if is_sound(head.format) {
                    out.insert(head.file_hash);
                }
            }
        }
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct TaggedAsk {
    /// The drafts about to be published.
    #[serde(default)]
    docs: Vec<String>,
    /// Or a notebook whose pages a book's rollout is about to publish.
    #[serde(default)]
    bucket: Option<String>,
}

/// POST `/api/identity/{root}/tagged-songs` - the tagged songs these drafts (or this notebook's
/// pages) carry, for the app's warning (the sign, ruling 16), and whether this node publishes them
/// at all (the fence, ruling 17).
pub async fn tagged_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(ask): Json<TaggedAsk>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    let mut ids: Vec<[u8; 16]> = ask
        .docs
        .iter()
        .filter_map(|h| <[u8; 16]>::try_from(hex::decode(h).ok()?.as_slice()).ok())
        .collect();
    if let Some(bucket) = &ask.bucket {
        ids.extend(data.buckets().own_docs_in(bucket).await?);
    }
    let docs = data.documents();
    let mut songs: Vec<Tagged> = Vec::new();
    for id in ids {
        let Some(doc) = docs.one(&id).await? else { continue };
        let Some(body) = docs.resolved(&doc).await?.body else { continue };
        let refs = media_refs(&public_links(&body, &root), &root);
        for t in tagged_among(&state, &data, &refs).await? {
            if !songs.contains(&t) {
                songs.push(t);
            }
        }
    }
    Ok(Json(serde_json::json!({ "songs": songs, "allowed": tagged_allowed(&state).await })))
}

#[derive(Deserialize)]
pub struct SetPolicy {
    pub tagged: bool,
}

/// GET `/api/admin/audio-policy` - the Server app: whether tagged audio is published here.
pub async fn policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
) -> Result<Json<serde_json::Value>, AppError> {
    Ok(Json(serde_json::json!({ "tagged": tagged_allowed(&state).await })))
}

/// PUT `/api/admin/audio-policy` - publish tagged audio here, or refuse it.
pub async fn set_policy_handler(
    State(state): State<AppState>,
    _admin: crate::auth::NodeAdminSession,
    Json(req): Json<SetPolicy>,
) -> Result<Json<serde_json::Value>, AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO audio_policy (id, tagged, updated_ms) VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET tagged = excluded.tagged, updated_ms = excluded.updated_ms",
            (i64::from(req.tagged), crate::clock::now_ms()),
        )
        .await
        .context("writing the audio policy")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "tagged": req.tagged })))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fields(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_song_is_tagged_by_its_artist_or_album_not_its_title() {
        assert!(tagged_from(&fields(&[("track", "Voice memo")])).is_none(), "a title alone");
        assert!(tagged_from(&fields(&[("artist", "  ")])).is_none(), "a blank artist");
        let t = tagged_from(&fields(&[("track", "Giorgio"), ("artist", "Daft Punk")])).unwrap();
        assert_eq!((t.title.as_str(), t.artist.as_str()), ("Giorgio", "Daft Punk"));
        assert!(tagged_from(&fields(&[("album", "Random Access Memories")])).is_some());
    }
}
