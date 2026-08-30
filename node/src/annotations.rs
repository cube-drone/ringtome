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

// ---------------------------------------------------------------------------------------------
// The viral road (ANNOTATIONS.md slice 3): labels ride the fragment as the annotator's own
// signed proofs, verified at the receiving edge, noted into the memo, and KEPT - so the
// next hop's fragment carries them onward. Virality is a relay of proofs, never hearsay.

/// Byte budget for the proofs attached to one fragment answer: comfortably under the 16KB
/// frame cap with the header and its path beside them. Author-first order means the labels
/// most worth carrying are the last to be dropped.
const PROOF_BYTES_BUDGET: usize = 6 * 1024;

/// Keep one verified proof servable.
#[allow(clippy::too_many_arguments)] // a proof IS eight facts; a params struct would name them worse
pub async fn keep_proof(
    node_db: &Db,
    annotator: &str,
    target_author: &str,
    target_doc: &str,
    key: &str,
    value: &str,
    entry: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO annotation_proofs
               (annotator, target_author, target_doc, key, value, entry, auth_path)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (annotator, target_author, target_doc, key, value) DO UPDATE SET
               entry = excluded.entry, auth_path = excluded.auth_path",
            (
                annotator,
                target_author,
                target_doc,
                key,
                value,
                entry.to_vec(),
                crate::fragments::pack_path(auth_path),
            ),
        )
        .await
        .context("keeping an annotation proof")?;
    Ok(())
}

async fn drop_proof(
    node_db: &Db,
    annotator: &str,
    target_author: &str,
    target_doc: &str,
    key: &str,
    value: &str,
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM annotation_proofs
             WHERE annotator = ?1 AND target_author = ?2 AND target_doc = ?3
               AND key = ?4 AND value = ?5",
            (annotator, target_author, target_doc, key, value),
        )
        .await
        .context("dropping an annotation proof")?;
    Ok(())
}

/// Every proof this node can attach to a fragment of (author, doc), author's labels first,
/// budget-capped by bytes. Sources, cheapest first: the kept-proofs table (labels that
/// arrived by fragment), then each annotator's held chain (the memo row's statement,
/// resolved through the entries log with its delegation path).
pub async fn proofs_for(
    state: &AppState,
    target_author: &str,
    target_doc: &str,
) -> Vec<ringtome_proto::fragment::AnnotationProof> {
    let rows = match for_posts(
        &state.node_db,
        &[(target_author.to_string(), target_doc.to_string())],
    )
    .await
    {
        Ok(mut known) => known
            .remove(&(target_author.to_string(), target_doc.to_string()))
            .unwrap_or_default(),
        Err(e) => {
            tracing::debug!(error = ?e, "annotation proofs read failed");
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    let mut spent = 0usize;
    for row in rows {
        if out.len() >= ringtome_proto::fragment::MAX_ANNOTATIONS_PER_FRAGMENT {
            break;
        }
        let Some(annotator) = crate::pubkey::decode(&row.annotator) else {
            continue;
        };
        let resolved = resolve_proof(state, &row, target_author, target_doc).await;
        let Some((entry, auth_path)) = resolved else {
            continue;
        };
        let cost = entry.len() + auth_path.iter().map(Vec::len).sum::<usize>() + 64;
        if spent + cost > PROOF_BYTES_BUDGET {
            break;
        }
        spent += cost;
        out.push(ringtome_proto::fragment::AnnotationProof {
            annotator,
            entry,
            auth_path,
        });
    }
    out
}

async fn resolve_proof(
    state: &AppState,
    row: &KnownAnnotation,
    target_author: &str,
    target_doc: &str,
) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
    let kept: Option<(Vec<u8>, Vec<u8>)> = state
        .node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM annotation_proofs
             WHERE annotator = ?1 AND target_author = ?2 AND target_doc = ?3
               AND key = ?4 AND value = ?5",
            (
                row.annotator.as_str(),
                target_author,
                target_doc,
                row.key.as_str(),
                row.value.as_str(),
            ),
        )
        .await
        .ok()
        .flatten();
    if let Some((entry, packed)) = kept {
        return Some((entry, crate::fragments::unpack_path(&packed)));
    }
    let doc_bytes = hex::decode(target_doc).ok()?;
    let doc_id = <[u8; 16]>::try_from(doc_bytes.as_slice()).ok()?;
    let db = state.user_dbs.get(&row.annotator).await.ok().flatten()?;
    let entry = crate::record::imaol::annotation_entry(
        &db,
        target_author,
        &doc_id,
        &row.key,
        &row.value,
    )
    .await
    .ok()
    .flatten()?;
    let path = crate::record::documents::auth_path_for(&db, &row.annotator, &entry)
        .await
        .ok()?;
    Some((entry.bytes().to_vec(), path))
}

/// Learn the proofs that rode a fragment of (author, doc): verify each against ITS
/// annotator and exactly this target, then fold - a present statement notes and keeps,
/// a retraction forgets and drops. Best-effort per proof; a forged one moves nothing.
pub async fn learn_proofs(
    state: &AppState,
    target_author: &[u8; 32],
    target_doc: &[u8; 16],
    proofs: &[ringtome_proto::fragment::AnnotationProof],
) {
    let author_hex = hex::encode(target_author);
    let doc_hex = hex::encode(target_doc);
    for p in proofs {
        let a = match ringtome_proto::fragment::verify_annotation(
            p.annotator,
            *target_author,
            *target_doc,
            &p.entry,
            &p.auth_path,
        ) {
            Ok(a) => a,
            Err(e) => {
                tracing::warn!(annotator = %hex::encode(p.annotator), error = ?e,
                    "an annotation that rode a fragment failed its own proof - skipped");
                continue;
            }
        };
        let annotator_hex = hex::encode(p.annotator);
        let outcome = if a.present {
            let noted =
                note(&state.node_db, &author_hex, &doc_hex, &annotator_hex, &a.key, &a.value).await;
            match noted {
                Ok(()) => keep_proof(
                    &state.node_db,
                    &annotator_hex,
                    &author_hex,
                    &doc_hex,
                    &a.key,
                    &a.value,
                    &p.entry,
                    &p.auth_path,
                )
                .await,
                e => e,
            }
        } else {
            let forgot =
                forget(&state.node_db, &author_hex, &doc_hex, &annotator_hex, &a.key, &a.value)
                    .await;
            match forgot {
                Ok(()) => {
                    drop_proof(&state.node_db, &annotator_hex, &author_hex, &doc_hex, &a.key, &a.value)
                        .await
                }
                e => e,
            }
        };
        if let Err(e) = outcome {
            tracing::debug!(error = ?e, "folding a ridden annotation failed");
        }
    }
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
