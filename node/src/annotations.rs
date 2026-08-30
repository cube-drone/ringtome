//! The annotations memo (ANNOTATIONS.md slice 2): what every post is said to be, by whom,
//! as this node can verify it from the chains it holds.
//!
//! Source: each held persona's `ANNOTATIONS_PUBLIC` chain, folded on the fold lane per
//! annotator - only when that chain moved, and only the statements past the last mark
//! (the share fold's discipline; a boot-reset mark makes the first pass after a restart
//! the full one). A present statement upserts a row; a retraction deletes it. Slice 3
//! adds the fragment road: proofs that arrive with a post note the same rows.
//!
//! Reads are page-scoped by the posts on screen. The memo never decides whose labels a
//! reader sees - that is the display register's, applied at read - so it holds everything
//! it can verify, blocked annotators included (a block stays home).
//!
//! Owns the `doc_annotations` SQL (tests/conventions.rs).

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// One known label, as the surfaces serve it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct KnownAnnotation {
    pub annotator: String,
    pub key: String,
    pub value: String,
}

/// The fold-lane hook: fold one annotator's statements past the mark.
pub async fn refresh_from(state: &AppState, annotator: &str, force: bool) {
    if let Err(e) = refresh_inner(state, annotator, force).await {
        tracing::debug!(annotator = %annotator, error = ?e, "annotations memo refresh failed");
    }
}

async fn refresh_inner(state: &AppState, annotator: &str, force: bool) -> Result<()> {
    let Ok(Some(db)) = state.user_dbs.get(annotator).await else {
        return Ok(());
    };
    let rows = crate::record::imaol::public_annotations(&db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(db);
    let mark = if force { None } else { state.sweep_marks.last("annotations", annotator) };
    if let Some(newest) = rows.iter().map(|r| r.received_at_ms).max() {
        state.sweep_marks.record("annotations", annotator, newest);
    }
    for r in rows {
        if let Some(m) = mark {
            if r.received_at_ms < m {
                continue;
            }
        }
        let doc_hex = hex::encode(r.target_doc);
        if r.present {
            note(&state.node_db, &r.target_author, &doc_hex, annotator, &r.key, &r.value).await?;
        } else {
            forget(&state.node_db, &r.target_author, &doc_hex, annotator, &r.key, &r.value).await?;
        }
    }
    Ok(())
}

/// Note one verified statement. Idempotent.
pub async fn note(
    node_db: &Db,
    target_author: &str,
    target_doc: &str,
    annotator: &str,
    key: &str,
    value: &str,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO doc_annotations
               (target_author, target_doc, annotator, key, value, noted_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (target_author, target_doc, annotator, key, value) DO UPDATE SET
               noted_ms = excluded.noted_ms",
            (target_author, target_doc, annotator, key, value, now_ms()),
        )
        .await
        .context("noting an annotation")?;
    Ok(())
}

/// A retraction: the row goes.
pub async fn forget(
    node_db: &Db,
    target_author: &str,
    target_doc: &str,
    annotator: &str,
    key: &str,
    value: &str,
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM doc_annotations
             WHERE target_author = ?1 AND target_doc = ?2 AND annotator = ?3
               AND key = ?4 AND value = ?5",
            (target_author, target_doc, annotator, key, value),
        )
        .await
        .context("forgetting an annotation")?;
    Ok(())
}

/// Every known label on each of these posts - the page's dressing, one IN query. The
/// author's own first (they filed it), then others by arrival; the display register
/// decides at the client which of the others render.
pub async fn for_posts(
    node_db: &Db,
    posts: &[(String, String)],
) -> Result<std::collections::HashMap<(String, String), Vec<KnownAnnotation>>> {
    let docs: Vec<String> = posts
        .iter()
        .map(|(_, d)| d)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|d| format!("'{d}'"))
        .collect();
    if docs.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, String, String, String, String)> = node_db
        .fetch_all(
            &format!(
                "SELECT target_author, target_doc, annotator, key, value FROM doc_annotations
                 WHERE target_doc IN ({}) ORDER BY (annotator = target_author) DESC, noted_ms",
                docs.join(",")
            ),
            (),
        )
        .await
        .context("reading known annotations")?;
    let mut out: std::collections::HashMap<(String, String), Vec<KnownAnnotation>> =
        Default::default();
    for (ta, td, annotator, key, value) in rows {
        if posts.contains(&(ta.clone(), td.clone())) {
            out.entry((ta, td)).or_default().push(KnownAnnotation {
                annotator,
                key,
                value,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Noted, re-noted (idempotent), read page-scoped with the author's own first, and
    /// forgotten on retraction.
    #[tokio::test]
    async fn noted_read_and_forgotten() {
        let db = crate::db::test_node_db().await;
        let (a, d) = ("aa".repeat(32), "11".repeat(16));
        note(&db, &a, &d, &"bb".repeat(32), "tag", "goopy").await.unwrap();
        note(&db, &a, &d, &a, "tag", "saucy").await.unwrap();
        note(&db, &a, &d, &a, "tag", "saucy").await.unwrap();
        let known = for_posts(&db, &[(a.clone(), d.clone())]).await.unwrap();
        let labels = known.get(&(a.clone(), d.clone())).unwrap();
        assert_eq!(labels.len(), 2, "idempotent: one row per statement");
        assert_eq!(labels[0].annotator, a, "the author's own label comes first");
        forget(&db, &a, &d, &"bb".repeat(32), "tag", "goopy").await.unwrap();
        let known = for_posts(&db, &[(a.clone(), d.clone())]).await.unwrap();
        assert_eq!(known.get(&(a, d)).unwrap().len(), 1, "a retraction takes its row");
    }
}
