//! hrseAmp (plans/AUDIO.md): the music app. The node's part of the library is the sound a reader can
//! see in their feed - every sound posted on its own, or embedded in a post, that reached them, at
//! their curiosity dial's stop (ruling 10). Their own sounds the browser already holds, in its
//! mirror; this is the rest.
//!
//! The journal says which posts reached the reader; the node-wide label memo says which of them carry
//! sound (the implicit `audio` tag publishing restates); and the node's memo of them (`amp_sounds`)
//! says which documents the sound is and how long it plays - read from the author's database once
//! per version of a post, the first time a library meets it, never once per request.

use std::collections::{BTreeMap, HashMap};

use axum::extract::{Path, Query, State};
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::auth::Session;
use crate::error::AppError;
use crate::record::store;
use crate::AppState;

/// At most this many posts with sound are read for one library: a reader's year of music, and
/// then some. The newest arrive first.
const LIBRARY_POSTS: usize = 5_000;

/// The notebooks no folder of music is named for: the apps' own, where things simply land.
const QUIET_NOTEBOOKS: &[&str] = &["feed", "files", "default"];

#[derive(Deserialize)]
pub struct LibraryQuery {
    /// The curiosity dial's stop, as the feed takes it.
    stop: Option<String>,
}

/// GET `/api/identity/{root}/amp/library[?stop=]` - the sound in the reader's feed: one row per
/// sound, with the post it arrived in, who it came through, its author's fields and tags, the
/// notebook its author filed it in, how long it plays, and the post's score for this reader.
pub async fn library_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Query(q): Query<LibraryQuery>,
) -> Result<Json<Value>, AppError> {
    let owned = store::open(&state, &session.account.id, &root).await?;
    let facts: crate::selectivity::Facts = owned.contacts().await?.into_iter().collect();
    let filter = crate::identity::feed_filter(
        &state,
        &facts,
        &root,
        crate::fanout::Own::Out,
        None,
        q.stop.as_deref(),
    )
    .await?;
    let journal =
        crate::fanout::journal_all(&state.node_db, &filter).await.map_err(AppError::Internal)?;
    let with_sound =
        crate::annotations::sound_posts(&state.node_db).await.map_err(AppError::Internal)?;

    // One row per post, the newest arrival kept; sealed posts left out - their sound is for the
    // author's trusted readers, and the reading copy of it here would need their key.
    let mut posts: BTreeMap<(String, String), crate::fanout::FeedRow> = BTreeMap::new();
    for row in journal {
        if row.trusted_only || !with_sound.contains(&(row.author_root.clone(), row.doc_id.clone()))
        {
            continue;
        }
        let key = (row.author_root.clone(), row.doc_id.clone());
        match posts.get(&key) {
            Some(held) if held.arrived_ms >= row.arrived_ms => {}
            _ => {
                posts.insert(key, row);
            }
        }
        if posts.len() >= LIBRARY_POSTS {
            break;
        }
    }
    let pairs: Vec<(String, String)> = posts.keys().cloned().collect();
    // The scores kept up to this reader's dials as they are now, as a "best" page has them.
    crate::score::refresh_dials(&state, &root, &facts).await.map_err(AppError::Internal)?;
    let mut scores = crate::score::stored_for(&state.node_db, &root, &pairs)
        .await
        .map_err(AppError::Internal)?;

    // The memo first; an author's database only for their posts it hasn't read at this version.
    let memo = sound_memo(&state.node_db).await.map_err(AppError::Internal)?;
    let mut stale: BTreeMap<String, Vec<&crate::fanout::FeedRow>> = BTreeMap::new();
    for ((author, doc), row) in &posts {
        let fresh = memo
            .get(&(author.clone(), doc.clone()))
            .is_some_and(|m| m.first().is_some_and(|s| s.post_updated_ms >= row.updated_ms));
        if !fresh {
            stale.entry(author.clone()).or_default().push(row);
        }
    }
    let mut memo = memo;
    for (author, rows) in stale {
        let Ok(Some(db)) = state.user_dbs.get(&author).await else { continue };
        for row in rows {
            let read = read_sounds(&db, row).await?;
            remember(&state.node_db, &author, row, &read).await.map_err(AppError::Internal)?;
            memo.insert((author.clone(), row.doc_id.clone()), read);
        }
    }
    let mut found: Vec<(String, crate::fanout::FeedRow, Sound)> = Vec::new();
    for (key, row) in posts {
        for sound in memo.get(&key).into_iter().flatten() {
            if !sound.sound_doc.is_empty() {
                found.push((key.0.clone(), row.clone(), sound.clone()));
            }
        }
    }
    // One row per sound: a song posted again, or in several posts, is the newest post it came in.
    found.sort_by_key(|a| std::cmp::Reverse(a.1.arrived_ms));
    let mut seen = std::collections::HashSet::new();
    found.retain(|(author, _, sound)| seen.insert((author.clone(), sound.sound_doc.clone())));

    // Kept in a mixtape (section 1): someone else's song in one of the reader's mixtapes stays in
    // their library when it no longer arrives in their feed - unfollowed, or past the dial - read
    // from the node's memo of sound, which remembers it from when it did.
    let mut kept: std::collections::HashSet<(String, String)> = Default::default();
    let wanted = mixtape_members(&owned, &root).await?;
    if wanted.iter().any(|k| !seen.contains(k)) {
        let mut known: HashMap<(String, String), (String, Sound)> = HashMap::new();
        for ((author, post), sounds) in &memo {
            for sound in sounds.iter().filter(|s| !s.sound_doc.is_empty()) {
                known
                    .entry((author.clone(), sound.sound_doc.clone()))
                    .or_insert_with(|| (post.clone(), sound.clone()));
            }
        }
        let mut posts_kept: Vec<(String, String)> = Vec::new();
        for key in wanted.into_iter().filter(|k| !seen.contains(k)) {
            let Some((post, sound)) = known.get(&key).cloned() else { continue };
            posts_kept.push((key.0.clone(), post.clone()));
            found.push((key.0.clone(), kept_row(&key.0, &post, &sound), sound));
            kept.insert(key);
        }
        scores.extend(
            crate::score::stored_for(&state.node_db, &root, &posts_kept)
                .await
                .map_err(AppError::Internal)?,
        );
    }

    // Every label on the sounds and the posts they came in, as this reader may see them, in one read.
    let mut asked: Vec<(String, String)> = found
        .iter()
        .flat_map(|(author, row, sound)| {
            [(author.clone(), sound.sound_doc.clone()), (author.clone(), row.doc_id.clone())]
        })
        .collect();
    asked.sort();
    asked.dedup();
    let labels = crate::annotations::for_posts(&state, &asked, Some(&root))
        .await
        .map_err(AppError::Internal)?;

    // On a node whose operator refuses tagged songs, a tagged one isn't carried (rights.rs): the
    // row stays, saying so, and the player passes it by.
    let fenced = crate::rights::fenced(&state).await;
    let mut tagged_of: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    let mut sounds = Vec::with_capacity(found.len());
    for (author, row, media) in found {
        let sound_hex = media.sound_doc.clone();
        let on_sound =
            labels.get(&(author.clone(), sound_hex.clone())).cloned().unwrap_or_default();
        let on_post =
            labels.get(&(author.clone(), row.doc_id.clone())).cloned().unwrap_or_default();
        // The author's fields: on the sound itself (a sound posted alone, or a twin that carries
        // them), else on its post.
        let mut fields: HashMap<String, String> = HashMap::new();
        for a in on_post.iter().chain(on_sound.iter()) {
            if a.annotator == author && crate::media::audio::SOUND_FIELDS.contains(&a.key.as_str())
            {
                fields.insert(a.key.clone(), a.value.clone());
            }
        }
        // Every tag this reader can see on it, and the author's and their own among them - the
        // filter strip's "whose tags" chip (ruling 12) narrows to the second.
        let mut tags: Vec<String> = Vec::new();
        let mut our_tags: Vec<String> = Vec::new();
        // How many people said each tag - the Score column shows the reactions among them, with
        // their counts (Curtis, 2026-10-12).
        let mut said: BTreeMap<String, std::collections::BTreeSet<String>> = BTreeMap::new();
        for a in on_sound.iter().chain(on_post.iter()) {
            if a.key != "tag"
                || crate::search::MEDIA_TAGS.contains(&a.value.as_str())
                || crate::search::SIZE_TAGS.contains(&a.value.as_str())
            {
                continue;
            }
            if !tags.contains(&a.value) {
                tags.push(a.value.clone());
            }
            said.entry(a.value.clone()).or_default().insert(a.annotator.clone());
            if (a.annotator == author || a.annotator == root) && !our_tags.contains(&a.value) {
                our_tags.push(a.value.clone());
            }
        }
        let notebook = on_post
            .iter()
            .chain(on_sound.iter())
            .find(|a| {
                a.annotator == author
                    && a.key == "bucket"
                    && !QUIET_NOTEBOOKS.contains(&a.value.as_str())
            })
            .map(|a| a.value.clone());
        let score = scores.get(&(author.clone(), row.doc_id.clone())).copied().unwrap_or(0);
        sounds.push(json!({
            "author": author,
            "doc": sound_hex,
            "post": row.doc_id,
            "via": row.via_root,
            "title": media.title,
            "fields": fields,
            "tags": tags,
            "our_tags": our_tags,
            "tag_counts": said.iter().map(|(v, who)| (v.clone(), who.len())).collect::<BTreeMap<_, _>>(),
            "notebook": notebook,
            "duration_ms": media.duration_ms,
            "thumb": media.has_thumb,
            "arrived_ms": row.arrived_ms,
            "published_ms": row.dated_ms.unwrap_or(row.published_ms),
            "score": score,
            "kept": kept.contains(&(author.clone(), sound_hex.clone())),
            "carried": !fenced || {
                if !tagged_of.contains_key(&author) {
                    let tagged = crate::annotations::tagged_docs(&state.node_db, &author)
                        .await
                        .unwrap_or_default();
                    tagged_of.insert(author.clone(), tagged);
                }
                !tagged_of[&author].contains(&sound_hex)
            },
        }));
    }
    // Who made them and who they came through, by name, for the By and From columns.
    let roots: Vec<String> = sounds
        .iter()
        .flat_map(|s| [s["author"].as_str(), s["via"].as_str()])
        .flatten()
        .map(str::to_string)
        .collect();
    let names: BTreeMap<String, String> = crate::profiles::bylines(&state.node_db, &roots)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(root, b)| b.name.map(|n| (root, n)))
        .collect();
    Ok(Json(json!({ "sounds": sounds, "names": names })))
}

/// The title a mixtape's taxonomy wears (plans/AUDIO.md, section 5): `mixtape:<name>`, as a
/// notebook's tree is `wiki:<name>`.
pub const MIXTAPE: &str = "mixtape:";

/// Someone else's songs in the reader's mixtapes, `(author, sound)` in hex.
async fn mixtape_members(
    owned: &store::Store,
    me: &str,
) -> Result<std::collections::HashSet<(String, String)>, AppError> {
    let mut out = std::collections::HashSet::new();
    for tape in owned.taxonomies().all().await? {
        if !tape.title.starts_with(MIXTAPE) {
            continue;
        }
        for member in owned.taxonomies().members(&tape.taxonomy_id).await? {
            let author = hex::encode(member.root);
            if author != me {
                out.insert((author, hex::encode(member.doc_id)));
            }
        }
    }
    Ok(out)
}

/// A kept song's row, standing in for the journal's: the post the memo read it in, no arrival.
fn kept_row(author: &str, post: &str, sound: &Sound) -> crate::fanout::FeedRow {
    crate::fanout::FeedRow {
        author_root: author.to_string(),
        via_root: None,
        suggested_via: None,
        doc_id: post.to_string(),
        title: String::new(),
        format: None,
        published_ms: 0,
        updated_ms: sound.post_updated_ms,
        arrived_ms: 0,
        settled: false,
        trusted_only: false,
        onward: false,
        dated_ms: None,
        minted_ms: 0,
    }
}

/// One sound a post carries, as the memo keeps it (`amp_sounds`, migration 0080).
#[derive(Clone)]
struct Sound {
    sound_doc: String,
    post_updated_ms: i64,
    title: String,
    duration_ms: Option<i64>,
    has_thumb: bool,
}

type Memo = HashMap<(String, String), Vec<Sound>>;

/// author, post, sound, post_updated_ms, title, duration_ms, has_thumb
type MemoRow = (String, String, String, i64, String, Option<i64>, i64);

/// The whole memo: as many rows as there are posts with sound on this node, which
/// `annotations::sound_posts` reads whole already.
async fn sound_memo(node_db: &crate::db::Db) -> anyhow::Result<Memo> {
    let rows: Vec<MemoRow> = node_db
        .fetch_all(
            "SELECT author_root, post_doc, sound_doc, post_updated_ms, title, duration_ms, has_thumb
             FROM amp_sounds",
            (),
        )
        .await
        .map_err(|e| anyhow::anyhow!("reading the sound memo: {e}"))?;
    let mut memo: Memo = HashMap::new();
    for (author, post, sound_doc, post_updated_ms, title, duration_ms, thumb) in rows {
        memo.entry((author, post)).or_default().push(Sound {
            sound_doc,
            post_updated_ms,
            title,
            duration_ms,
            has_thumb: thumb != 0,
        });
    }
    Ok(memo)
}

/// The sound a post carries, from its author's database: the post itself, for a sound posted on
/// its own, else the embedded twins it names that are sound. None is one row with no sound, so the
/// post isn't read again until it changes.
async fn read_sounds(
    db: &crate::db::Db,
    row: &crate::fanout::FeedRow,
) -> Result<Vec<Sound>, AppError> {
    let none = || {
        vec![Sound {
            sound_doc: String::new(),
            post_updated_ms: row.updated_ms,
            title: String::new(),
            duration_ms: None,
            has_thumb: false,
        }]
    };
    let Ok(doc) = <[u8; 16]>::try_from(hex::decode(&row.doc_id).unwrap_or_default().as_slice())
    else {
        return Ok(none());
    };
    let Some(post) = crate::record::documents::public_media(db, &doc).await? else {
        return Ok(none());
    };
    let opus = ringtome_proto::registry::doc_format::OGG_OPUS;
    let sound = |id: &[u8; 16], m: crate::record::documents::PublicMedia| Sound {
        sound_doc: hex::encode(id),
        post_updated_ms: row.updated_ms,
        title: m.title,
        duration_ms: m.duration_ms,
        has_thumb: m.has_thumb,
    };
    let mut out = Vec::new();
    if post.format == Some(opus) {
        out.push(sound(&doc, post));
    } else {
        for twin in &post.refs {
            if let Some(media) = crate::record::documents::public_media(db, twin).await? {
                if media.format == Some(opus) {
                    out.push(sound(twin, media));
                }
            }
        }
    }
    Ok(if out.is_empty() { none() } else { out })
}

/// Keep what a post was read to carry, in place of what it carried before.
async fn remember(
    node_db: &crate::db::Db,
    author: &str,
    row: &crate::fanout::FeedRow,
    sounds: &[Sound],
) -> anyhow::Result<()> {
    node_db
        .execute(
            "DELETE FROM amp_sounds WHERE author_root = ?1 AND post_doc = ?2",
            (author, row.doc_id.as_str()),
        )
        .await
        .map_err(|e| anyhow::anyhow!("clearing a post's sound memo: {e}"))?;
    for s in sounds {
        node_db
            .execute(
                "INSERT OR REPLACE INTO amp_sounds
                 (author_root, post_doc, sound_doc, post_updated_ms, title, duration_ms, has_thumb)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    author,
                    row.doc_id.as_str(),
                    s.sound_doc.as_str(),
                    s.post_updated_ms,
                    s.title.as_str(),
                    s.duration_ms,
                    s.has_thumb as i64,
                ),
            )
            .await
            .map_err(|e| anyhow::anyhow!("keeping a post's sound memo: {e}"))?;
    }
    Ok(())
}
