//! The node's public face, the data half (UNAUTHED.md, slice 1): `node_shelf`, every public
//! post and live share by every persona hosted here, folded on the fold lane when a hosted
//! persona's POSTS or REBROADCASTS chain moves; and `node_listing`, the per-persona "listed
//! on this node's front page" switch. The anonymous doors (nodeface.rs) read these two tables
//! and nothing else, so a stranger's page never opens a user database.
//!
//! Owns the `node_shelf` and `node_listing` SQL (tests/conventions.rs).

use anyhow::{Context, Result};

use crate::db::Db;
use crate::AppState;

/// One row of the node's shelf, as the doors read it.
#[derive(Debug, Clone)]
pub struct ShelfRow {
    pub author_root: String,
    pub doc_id: String,
    /// The sharer, for a share; None for a post.
    pub via_root: Option<String>,
    pub title: String,
    pub format: Option<String>,
    pub published_ms: i64,
    pub updated_ms: i64,
    pub settled: bool,
    pub dated_ms: Option<i64>,
    pub reply_to: Option<(String, String)>,
}

impl ShelfRow {
    /// One of `search::KINDS`.
    pub fn kind(&self) -> &'static str {
        if self.via_root.is_some() {
            "rebroadcast"
        } else if self.format.as_deref() == Some("book") {
            "book"
        } else if self.reply_to.is_some() {
            "reply"
        } else {
            "post"
        }
    }
}

/// The fold-lane hook: re-say one hosted persona's shelf. A persona not hosted here has no
/// place on this node's face; a whole re-fold per move, since a persona's shelf is small
/// and the alternative is a second incremental discipline for a table the doors read whole.
pub async fn refresh_from(state: &AppState, root: &str, _force: bool) {
    if let Err(e) = refresh_inner(state, root).await {
        tracing::debug!(root = %root, error = ?e, "node shelf refresh failed");
    }
}

async fn refresh_inner(state: &AppState, root: &str) -> Result<()> {
    if !crate::identity::is_agented(&state.node_db, root).await.unwrap_or(false) {
        return Ok(());
    }
    // user-db open 1 of 2 (tests/conventions.rs): the hosted persona's own shelf, once per
    // move of their chain - the annotations memo's discipline.
    let Ok(Some(db)) = state.user_dbs.get(root).await else { return Ok(()) };
    let posts = crate::record::documents::public_docs(&db, None, 5000)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    let shares = crate::record::imaol::rebroadcasts(&db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(db);
    let now = crate::clock::now_ms();
    let node_db = &state.node_db;
    node_db
        .execute(
            "DELETE FROM node_shelf WHERE (author_root = ?1 AND via_root = '') OR via_root = ?1",
            (root,),
        )
        .await
        .context("clearing a persona's node shelf rows")?;
    // One statement per chunk, not per post (2026-09-15): a whole re-fold of a long shelf
    // is a few round trips, not thousands - the fold lane is shared with the feed's own
    // digging, and the history-dig suite felt every extra statement under a full gate.
    let rows: Vec<crate::record::documents::PublicDoc> = posts.into_iter().filter(|p| p.part_of.is_none()).collect();
    for chunk in rows.chunks(100) {
        let mut sql = String::from(
            "INSERT INTO node_shelf
               (author_root, doc_id, via_root, title, format, published_ms, updated_ms, settled, trusted_only, dated_ms, reply_to_author, reply_to_doc)
             VALUES ",
        );
        let mut params: Vec<turso::Value> = Vec::with_capacity(chunk.len() * 12);
        for (i, p) in chunk.iter().enumerate() {
            if i > 0 {
                sql.push_str(", ");
            }
            let base = i * 12;
            sql.push('(');
            sql.push_str(&(1..=12).map(|k| format!("?{}", base + k)).collect::<Vec<_>>().join(", "));
            sql.push(')');
            let format = p.format.map(|f| crate::record::documents::Format::from_wire(Some(f)).as_str().to_string());
            params.push(root.into());
            params.push(hex::encode(p.doc_id).into());
            params.push("".into());
            params.push(p.title.clone().into());
            params.push(format.map(turso::Value::from).unwrap_or(turso::Value::Null));
            params.push(p.dated_ms.unwrap_or(p.genesis_ms).into());
            params.push(p.head_ms.into());
            params.push((p.settled as i64).into());
            params.push((p.trusted_only as i64).into());
            params.push(p.dated_ms.map(turso::Value::from).unwrap_or(turso::Value::Null));
            params.push(p.reply_to.as_ref().map(|(a, _)| turso::Value::from(a.clone())).unwrap_or(turso::Value::Null));
            params.push(p.reply_to.as_ref().map(|(_, d)| turso::Value::from(d.clone())).unwrap_or(turso::Value::Null));
        }
        node_db.execute(&sql, params).await.context("noting node shelf posts")?;
    }
    for s in shares.iter().filter(|s| s.version_seen.is_some()) {
        // The original's header, as this node holds it: a hosted original's own user db
        // (user-db open 2 of 2, once per distinct original author per fold), else the
        // fragment store. A share of words this node has never seen has no row - the
        // reader's feed treats it the same.
        let Some(head) = original_head(state, &s.author_root, &s.doc_id).await else { continue };
        if head.part_of.is_some() {
            continue;
        }
        let format = head.format.map(|f| crate::record::documents::Format::from_wire(Some(f)).as_str().to_string());
        node_db
            .execute(
                "INSERT OR REPLACE INTO node_shelf
                   (author_root, doc_id, via_root, title, format, published_ms, updated_ms, settled, trusted_only, dated_ms, reply_to_author, reply_to_doc)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                (
                    s.author_root.as_str(),
                    hex::encode(s.doc_id),
                    root,
                    head.title.as_str(),
                    format,
                    s.received_at_ms,
                    now,
                    head.settled as i64,
                    head.trusted_only as i64,
                    head.dated_ms,
                    head.reply_to.as_ref().map(|(a, _)| a.clone()),
                    head.reply_to.as_ref().map(|(_, d)| d.clone()),
                ),
            )
            .await
            .context("noting a node shelf share")?;
    }
    Ok(())
}

/// A shared original's public doc, hosted here or held as a fragment.
async fn original_head(state: &AppState, author_hex: &str, doc_id: &[u8; 16]) -> Option<crate::record::documents::PublicDoc> {
    if crate::identity::is_agented(&state.node_db, author_hex).await.unwrap_or(false) {
        let db = state.user_dbs.get(author_hex).await.ok().flatten()?;
        return crate::record::documents::public_doc(&db, doc_id).await.ok().flatten();
    }
    let all = crate::fragments::shelf_of(&state.node_db, author_hex, 5000).await.ok()?;
    all.into_iter().find(|p| &p.doc_id == doc_id)
}

/// Whether a hosted persona is listed on this node's front page: absent means yes.
pub async fn listed(node_db: &Db, root: &str) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional("SELECT listed FROM node_listing WHERE root_pubkey = ?1", (root,))
        .await
        .context("reading a node listing")?;
    Ok(row.map(|(l,)| l != 0).unwrap_or(true))
}

pub async fn set_listed(node_db: &Db, root: &str, on: bool) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO node_listing (root_pubkey, listed, noted_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (root_pubkey) DO UPDATE SET listed = excluded.listed, noted_ms = excluded.noted_ms",
            (root, on as i64, crate::clock::now_ms()),
        )
        .await
        .context("setting a node listing")?;
    Ok(())
}

type RowTuple = (String, String, String, String, Option<String>, i64, i64, i64, i64, Option<i64>, Option<String>, Option<String>);

fn row_of(t: RowTuple) -> ShelfRow {
    let (author_root, doc_id, via, title, format, published_ms, updated_ms, settled, _trusted_only, dated_ms, ra, rd) = t;
    ShelfRow {
        author_root,
        doc_id,
        via_root: (!via.is_empty()).then_some(via),
        title,
        format,
        published_ms,
        updated_ms,
        settled: settled != 0,
        dated_ms,
        reply_to: match (ra, rd) {
            (Some(a), Some(d)) => Some((a, d)),
            _ => None,
        },
    }
}

/// The stranger's view of the whole shelf: open posts and shares by LISTED personas (a
/// share counts as the sharer's), newest first, keyset-paged on (published_ms, doc_id).
const LISTED: &str = "NOT EXISTS (SELECT 1 FROM node_listing l WHERE l.listed = 0
                        AND l.root_pubkey = CASE WHEN s.via_root = '' THEN s.author_root ELSE s.via_root END)";

pub async fn page(node_db: &Db, before: Option<(i64, String)>, limit: i64) -> Result<Vec<ShelfRow>> {
    let rows: Vec<RowTuple> = match before {
        Some((ms, doc)) => {
            node_db
                .fetch_all(
                    &format!(
                        "SELECT author_root, doc_id, via_root, title, format, published_ms, updated_ms, settled, trusted_only, dated_ms, reply_to_author, reply_to_doc
                         FROM node_shelf s WHERE trusted_only = 0 AND {LISTED}
                           AND (published_ms < ?1 OR (published_ms = ?1 AND doc_id < ?2))
                         ORDER BY published_ms DESC, doc_id DESC LIMIT ?3"
                    ),
                    (ms, doc, limit),
                )
                .await
        }
        None => {
            node_db
                .fetch_all(
                    &format!(
                        "SELECT author_root, doc_id, via_root, title, format, published_ms, updated_ms, settled, trusted_only, dated_ms, reply_to_author, reply_to_doc
                         FROM node_shelf s WHERE trusted_only = 0 AND {LISTED}
                         ORDER BY published_ms DESC, doc_id DESC LIMIT ?1"
                    ),
                    (limit,),
                )
                .await
        }
    }
    .context("reading the node shelf")?;
    Ok(rows.into_iter().map(row_of).collect())
}

/// The hosted personas a stranger may see: hosted here and listed.
pub async fn listed_roots(node_db: &Db) -> Result<Vec<String>> {
    let hosted = crate::identity::hosted_roots(node_db).await.map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut out = Vec::with_capacity(hosted.len());
    for r in hosted {
        if listed(node_db, &r).await? {
            out.push(r);
        }
    }
    Ok(out)
}
