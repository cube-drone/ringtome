//! hrseAmp's trash (plans/MIXTAPES.md, section 3; Curtis, 2026-11-22): "A user can delete a shared
//! mixtape, or a single shared track from another user, removing it from their storage (if that
//! was the only copy). Deleted shared tracks go into a 'trash' row in hrseAmp, where the user can
//! choose to undelete them (re-requesting them from the original source)."
//!
//! A reader can already decline a KIND of a person's files (net::subscriptions, `skip_kinds`).
//! This is finer - one document - and shaped the same way:
//!
//! - **A private ledger** on the persona, `amp_trash`: one register per document thrown away,
//!   `<author>.<doc>`, saying when, what it was called and - for a song that went with a mixtape -
//!   which. An empty value is a line struck: the document is wanted again.
//! - **A node memo** of it, `trashed`, rebuilt from the ledger whenever the persona's ledgers are
//!   read (`mirror`), so the body lane and the reaper can ask without opening anyone's database.
//! - **The same rule as for kinds**: a file is not fetched, and not kept on its author's account,
//!   only when EVERYONE here who dials that author threw it away (`trashed_hashes`) - and then
//!   whatever else on the node points at it still keeps it (a rebroadcast, a report, quarantine),
//!   as the reaper already decides for a declined kind.
//!
//! The two ledgers agree by union: `subscriptions::declined_hashes` and `purged_hashes` each
//! include what is trashed, so every reader of either sees both.

use std::collections::{BTreeMap, HashSet};

use anyhow::{Context, Result};
use axum::extract::{Path, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::Session;
use crate::clock::now_ms;
use crate::error::AppError;
use crate::record::store;
use crate::AppState;

/// The persona's private ledger of what they threw away.
const LEDGER: &str = "amp_trash";

/// The most documents one request throws away or brings back: a mixtape and its thirty songs,
/// with room to spare.
const MOST: usize = 64;

/// One line of the ledger: a document thrown away.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Thrown {
    /// When.
    pub at: i64,
    /// `mixtape` for a mixtape's post, else a song.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kind: String,
    /// What it was called, for the trash row: its bytes may be gone by the time it is read.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub artist: String,
    /// The mixtape (its post) a song went with: it comes back when the mixtape does.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tape: String,
    /// The group it was posted in, for a group's document: its files are the group's, kept and
    /// fetched by the group's own machinery (roster.rs), which asks `group_trashed`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub group: String,
}

const fn is_hex(len: usize, s: &str) -> bool {
    if s.len() != len {
        return false;
    }
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_hexdigit() || b[i].is_ascii_uppercase() {
            return false;
        }
        i += 1;
    }
    true
}

fn key_of(author: &str, doc: &str) -> String {
    format!("{author}.{doc}")
}

/// What `data`'s persona has thrown away and not taken back, by `(author, doc)`.
pub async fn ledger(data: &store::Store) -> Result<BTreeMap<(String, String), Thrown>, AppError> {
    let (registers, _) = data.private_registers(LEDGER).all().await?;
    Ok(registers
        .into_iter()
        .filter_map(|r| {
            let (author, doc) = r.key.split_once('.')?;
            if !is_hex(64, author) || !is_hex(32, doc) {
                return None;
            }
            let thrown: Thrown = serde_json::from_str(&r.value).ok()?;
            Some(((author.to_string(), doc.to_string()), thrown))
        })
        .collect())
}

/// Rebuild the node's memo of one persona's ledger. A whole-persona rewrite, as the subscription
/// rows are: the ledger is small, and a delta would be bookkeeping the memo exists to avoid.
pub async fn mirror(state: &AppState, data: &store::Store, root_hex: &str) -> Result<()> {
    let held =
        ledger(data).await.map_err(|e| anyhow::anyhow!("reading the trash ledger: {e:?}"))?;
    let have: Vec<(String, Vec<u8>)> = state
        .node_db
        .fetch_all("SELECT foreign_root, doc_id FROM trashed WHERE local_root = ?1", (root_hex,))
        .await
        .context("reading a persona's trashed rows")?;
    let have: HashSet<(String, String)> =
        have.into_iter().map(|(author, doc)| (author, hex::encode(doc))).collect();
    let want: HashSet<(String, String)> = held.keys().cloned().collect();
    for (author, doc) in have.difference(&want) {
        state
            .node_db
            .execute(
                "DELETE FROM trashed WHERE local_root = ?1 AND foreign_root = ?2 AND doc_id = ?3",
                (root_hex, author.as_str(), hex::decode(doc).unwrap_or_default()),
            )
            .await
            .context("forgetting a document taken out of the trash")?;
    }
    for (author, doc) in want.difference(&have) {
        state
            .node_db
            .execute(
                "INSERT INTO trashed (local_root, foreign_root, doc_id, at_ms, group_id)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (local_root, foreign_root, doc_id) DO NOTHING",
                (
                    root_hex,
                    author.as_str(),
                    hex::decode(doc).unwrap_or_default(),
                    held[&(author.clone(), doc.clone())].at,
                    hex::decode(&held[&(author.clone(), doc.clone())].group)
                        .ok()
                        .filter(|g| g.len() == 16),
                ),
            )
            .await
            .context("noting a trashed document")?;
    }
    Ok(())
}

/// Every author somebody here threw a public document of away.
pub async fn authors(node_db: &crate::db::Db) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all("SELECT DISTINCT foreign_root FROM trashed WHERE group_id IS NULL", ())
        .await
        .context("listing the authors of trashed documents")?;
    Ok(rows.into_iter().map(|(a,)| a).collect())
}

/// The documents of `foreign_root` that EVERYONE they reached here threw away: everyone who
/// dials the author, and everyone with the document - or, for a song a rebroadcast brought, a
/// post that covers it - in their feed. One person on a shared server who still wants a song is
/// enough to keep it, since the bytes are kept once. Nothing for a persona of this node's own,
/// whose files are theirs.
pub async fn trashed_docs(
    node_db: &crate::db::Db,
    foreign_root: &str,
) -> Result<HashSet<[u8; 16]>> {
    let rows: Vec<(String, Vec<u8>)> = node_db
        .fetch_all(
            "SELECT local_root, doc_id FROM trashed WHERE foreign_root = ?1 AND group_id IS NULL",
            (foreign_root,),
        )
        .await
        .context("reading what a persona's followers threw away")?;
    if rows.is_empty() || crate::identity::is_agented(node_db, foreign_root).await.unwrap_or(true) {
        return Ok(HashSet::new());
    }
    let dialers: HashSet<String> =
        crate::net::subscriptions::dialed_by(node_db, foreign_root).await?.into_iter().collect();
    let mut by: BTreeMap<[u8; 16], HashSet<String>> = BTreeMap::new();
    for (local, doc) in rows {
        if let Ok(doc) = <[u8; 16]>::try_from(doc.as_slice()) {
            by.entry(doc).or_default().insert(local);
        }
    }
    let mut out = HashSet::new();
    for (doc, threw) in by {
        let doc_hex = hex::encode(doc);
        let mut posts = crate::fragments::covering_posts(node_db, foreign_root, &doc_hex).await?;
        posts.push(doc_hex);
        let mut reached = dialers.clone();
        reached.extend(crate::fanout::readers_with(node_db, foreign_root, &posts).await?);
        if !reached.is_empty() && reached.iter().all(|r| threw.contains(r)) {
            out.insert(doc);
        }
    }
    Ok(out)
}

/// The documents of a group that every member of it hosted here threw away (`members`, hex): the
/// group's files are kept once for all of them, so one who still wants a song keeps it. Nothing
/// when no member is hosted here.
pub async fn group_trashed(
    node_db: &crate::db::Db,
    group: &[u8; 16],
    members: &[String],
) -> Result<HashSet<[u8; 16]>> {
    if members.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<(String, Vec<u8>)> = node_db
        .fetch_all("SELECT local_root, doc_id FROM trashed WHERE group_id = ?1", (group.to_vec(),))
        .await
        .context("reading what a group's members threw away")?;
    let mut by: BTreeMap<[u8; 16], HashSet<String>> = BTreeMap::new();
    for (local, doc) in rows {
        if let (true, Ok(doc)) = (members.contains(&local), <[u8; 16]>::try_from(doc.as_slice())) {
            by.entry(doc).or_default().insert(local);
        }
    }
    Ok(by.into_iter().filter(|(_, who)| who.len() == members.len()).map(|(doc, _)| doc).collect())
}

/// The files of `foreign_root` this node neither fetches nor keeps on their account, because
/// everyone here who follows them threw the document away: each public blob a trashed document's
/// versions name - its thumbnail with it - unless a document still wanted names it too. Empty
/// for a persona of this node's own, whose files are theirs.
pub async fn trashed_hashes(
    state: &AppState,
    foreign_root: &str,
    held: Option<&crate::db::Db>,
) -> Result<HashSet<[u8; 32]>> {
    let docs = trashed_docs(&state.node_db, foreign_root).await?;
    if docs.is_empty() {
        return Ok(HashSet::new());
    }
    // What a rebroadcast brought is on the fragment shelf, whoever's chain is held here.
    let hex_docs: HashSet<String> = docs.iter().map(hex::encode).collect();
    let mut out = crate::fragments::blobs_only_of(&state.node_db, foreign_root, &hex_docs).await?;
    let opened;
    let db = match held {
        Some(db) => db,
        None => match state.user_dbs.get(foreign_root).await? {
            Some(db) => {
                opened = db;
                &opened
            }
            None => return Ok(out),
        },
    };
    let refs = crate::record::documents::version_blobs(db)
        .await
        .map_err(|e| anyhow::anyhow!("reading the blobs the versions name: {e}"))?;
    let (mut gone, mut wanted): (HashSet<[u8; 32]>, HashSet<[u8; 32]>) = Default::default();
    for r in refs.iter().filter(|r| r.public) {
        if docs.contains(&r.doc) { &mut gone } else { &mut wanted }.insert(r.hash);
    }
    out.extend(gone);
    out.retain(|h| !wanted.contains(h));
    Ok(out)
}

/// One document named in a request.
#[derive(Deserialize)]
pub struct Item {
    author: String,
    doc: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    artist: String,
    #[serde(default)]
    tape: String,
    #[serde(default)]
    group: String,
}

#[derive(Deserialize)]
pub struct Items {
    items: Vec<Item>,
}

fn checked(root: &str, req: &Items) -> Result<(), AppError> {
    let bad = || AppError::BadRequest(crate::msg!("trash.not-a-document", "that isn't a document"));
    if req.items.is_empty() || req.items.len() > MOST {
        return Err(bad());
    }
    for item in &req.items {
        if !is_hex(64, &item.author) || !is_hex(32, &item.doc) {
            return Err(bad());
        }
        // Your own files are deleted where they live, in hrseFiles: the trash is for what
        // other people sent.
        if item.author == root {
            return Err(AppError::BadRequest(crate::msg!(
                "trash.not-your-own",
                "the trash is for other people's songs - delete your own in hrseFiles"
            )));
        }
    }
    Ok(())
}

/// POST `/api/identity/{root}/amp/trash` - throw other people's songs, or a mixtape with its
/// songs, out of this persona's storage. `{ items: [{ author, doc, kind?, title?, artist?,
/// tape? }] }`: a mixtape is one item of `kind: "mixtape"` and one per song naming it as `tape`.
pub async fn throw_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<Items>,
) -> Result<Json<Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    checked(&root, &req)?;
    let clip = |s: &str| s.chars().take(200).collect::<String>();
    let at = now_ms();
    for item in &req.items {
        let line = Thrown {
            at,
            kind: if item.kind == "mixtape" { "mixtape".into() } else { String::new() },
            title: clip(&item.title),
            artist: clip(&item.artist),
            tape: if is_hex(32, &item.tape) { item.tape.clone() } else { String::new() },
            group: if is_hex(32, &item.group) { item.group.clone() } else { String::new() },
        };
        let value = serde_json::to_string(&line)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("a trash line: {e}")))?;
        data.private_registers(LEDGER).set(&key_of(&item.author, &item.doc), &value).await?;
    }
    mirror(&state, &data, &root).await.map_err(AppError::Internal)?;
    Ok(Json(json!({ "trashed": req.items.len() })))
}

/// POST `/api/identity/{root}/amp/trash/restore` - take documents back out: `{ items: [{ author,
/// doc }] }`. A mixtape brings the songs that went with it. Each is wanted again at once: its
/// files are asked of its author, or of anyone who still holds them, at the body lane's next pass.
pub async fn restore_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<Items>,
) -> Result<Json<Value>, AppError> {
    let data = store::open(&state, &session.account.id, &root).await?;
    checked(&root, &req)?;
    let held = ledger(&data).await?;
    let mut back: Vec<(String, String)> = Vec::new();
    let mut groups: HashSet<String> = HashSet::new();
    for item in &req.items {
        let key = (item.author.clone(), item.doc.clone());
        let Some(line) = held.get(&key) else { continue };
        if !line.group.is_empty() {
            groups.insert(line.group.clone());
        }
        if line.kind == "mixtape" {
            back.extend(
                held.iter()
                    .filter(|((author, _), l)| *author == item.author && l.tape == item.doc)
                    .map(|(k, _)| k.clone()),
            );
        }
        back.push(key);
    }
    back.sort();
    back.dedup();
    for (author, doc) in &back {
        data.private_registers(LEDGER).set(&key_of(author, doc), "").await?;
    }
    mirror(&state, &data, &root).await.map_err(AppError::Internal)?;
    // Wanted again: every file the restored documents name, noted for the body lane. Best-effort -
    // a walk of the author's chain would note them too, when it next runs.
    let mut by_author: BTreeMap<&str, HashSet<[u8; 16]>> = BTreeMap::new();
    for (author, doc) in &back {
        if let Ok(doc) = <[u8; 16]>::try_from(hex::decode(doc).unwrap_or_default().as_slice()) {
            by_author.entry(author.as_str()).or_default().insert(doc);
        }
    }
    for (author, docs) in by_author {
        // What a rebroadcast brought is on the fragment shelf.
        let hex_docs: HashSet<String> = docs.iter().map(hex::encode).collect();
        for hash in crate::fragments::blobs_only_of(&state.node_db, author, &hex_docs)
            .await
            .unwrap_or_default()
        {
            if let Err(e) = crate::net::bodies::want(&state.node_db, author, &hash).await {
                tracing::debug!(error = ?e, "a restored file was not noted as wanted");
            }
        }
        let Ok(Some(db)) = state.user_dbs.get(author).await else { continue };
        let Ok(refs) = crate::record::documents::version_blobs(&db).await else { continue };
        for r in refs.iter().filter(|r| r.public && docs.contains(&r.doc)) {
            if let Err(e) = crate::net::bodies::want(&state.node_db, author, &r.hash).await {
                tracing::debug!(error = ?e, "a restored file was not noted as wanted");
            }
        }
    }
    // A group's files come from the group's members: asked for now, in the background.
    for group in groups {
        let state = state.clone();
        tokio::spawn(async move { crate::roster::refetch(&state, &group).await });
    }
    Ok(Json(json!({ "restored": back.len() })))
}
