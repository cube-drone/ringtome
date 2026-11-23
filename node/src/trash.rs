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
                "INSERT INTO trashed (local_root, foreign_root, doc_id, at_ms)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (local_root, foreign_root, doc_id) DO NOTHING",
                (
                    root_hex,
                    author.as_str(),
                    hex::decode(doc).unwrap_or_default(),
                    held[&(author.clone(), doc.clone())].at,
                ),
            )
            .await
            .context("noting a trashed document")?;
    }
    Ok(())
}

/// The documents of `foreign_root` that everyone here who dials them threw away: one person on a
/// shared server who still wants a song is enough to keep it, since the bytes are kept once.
/// Nothing when nobody here dials them at all, as for a declined kind.
async fn trashed_docs(node_db: &crate::db::Db, foreign_root: &str) -> Result<HashSet<[u8; 16]>> {
    let rows: Vec<(String, Vec<u8>)> = node_db
        .fetch_all(
            "SELECT local_root, doc_id FROM trashed WHERE foreign_root = ?1",
            (foreign_root,),
        )
        .await
        .context("reading what a persona's followers threw away")?;
    if rows.is_empty() {
        return Ok(HashSet::new());
    }
    let dialers: HashSet<String> =
        crate::net::subscriptions::dialed_by(node_db, foreign_root).await?.into_iter().collect();
    let mut by: BTreeMap<[u8; 16], HashSet<String>> = BTreeMap::new();
    for (local, doc) in rows {
        if let (true, Ok(doc)) = (dialers.contains(&local), <[u8; 16]>::try_from(doc.as_slice())) {
            by.entry(doc).or_default().insert(local);
        }
    }
    Ok(by
        .into_iter()
        .filter(|(_, who)| !dialers.is_empty() && who.len() == dialers.len())
        .map(|(doc, _)| doc)
        .collect())
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
    if docs.is_empty()
        || crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, foreign_root)
            .await?
            .is_some()
    {
        return Ok(HashSet::new());
    }
    let opened;
    let db = match held {
        Some(db) => db,
        None => match state.user_dbs.get(foreign_root).await? {
            Some(db) => {
                opened = db;
                &opened
            }
            None => return Ok(HashSet::new()),
        },
    };
    let refs = crate::record::documents::version_blobs(db)
        .await
        .map_err(|e| anyhow::anyhow!("reading the blobs the versions name: {e}"))?;
    let (mut out, mut wanted): (HashSet<[u8; 32]>, HashSet<[u8; 32]>) = Default::default();
    for r in refs.iter().filter(|r| r.public) {
        if docs.contains(&r.doc) { &mut out } else { &mut wanted }.insert(r.hash);
    }
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
    for item in &req.items {
        let key = (item.author.clone(), item.doc.clone());
        let Some(line) = held.get(&key) else { continue };
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
        let Ok(Some(db)) = state.user_dbs.get(author).await else { continue };
        let Ok(refs) = crate::record::documents::version_blobs(&db).await else { continue };
        for r in refs.iter().filter(|r| r.public && docs.contains(&r.doc)) {
            if let Err(e) = crate::net::bodies::want(&state.node_db, author, &r.hash).await {
                tracing::debug!(error = ?e, "a restored file was not noted as wanted");
            }
        }
    }
    Ok(Json(json!({ "restored": back.len() })))
}
