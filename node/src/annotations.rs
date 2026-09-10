//! The annotations memo (PROJECT_PLAN's Public annotations, slice 2): what every post is said to be, by whom,
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
//! Sealed labels (PROJECT_PLAN's Replies under the author's seal, ruling 7, 2026-09-10): a
//! statement about a sealed post rides the lane as `sealed=<hex>` - the real `key=value`
//! encrypted under the post's key, so "divorce" never leaves the room. The fold notes it raw
//! until this node holds the key, then opens it in place (`open_sealed`, which the body door
//! calls with the key in hand); every reader filters opened rows by the viewer's standing
//! with the seal's holder, and a raw row is never served. One decrypt point, every consumer
//! unchanged.
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

/// The lane's key for a sealed statement: its value is the ciphertext, hex.
pub const SEALED_KEY: &str = "sealed";

/// Seal one statement under a post's key: `key=value` encrypted, as the lane carries it.
pub fn seal_statement(post_key: &[u8; 32], key: &str, value: &str) -> Result<String> {
    let plain = format!("{key}={value}");
    let sealed = crate::record::private::seal_post_body(post_key, plain.as_bytes())
        .map_err(|e| anyhow::anyhow!("sealing a label: {e}"))?;
    Ok(hex::encode(sealed))
}

/// Open one sealed statement with the post's key: the `(key, value)` it carries, or None
/// when the key is wrong or the bytes are not a statement.
pub fn open_statement(sealed_hex: &str, post_key: &[u8; 32]) -> Option<(String, String)> {
    let bytes = hex::decode(sealed_hex).ok()?;
    let plain = crate::record::private::open_post_body(&bytes, post_key)?;
    let text = String::from_utf8(plain).ok()?;
    let (k, v) = text.split_once('=')?;
    if k.is_empty() {
        return None;
    }
    Some((k.to_string(), v.to_string()))
}

/// Who may see an opened sealed row: the holder themself, or anyone the holder publishes
/// trust for (the body door's rule, PROJECT_PLAN's Replies under the author's seal).
async fn holder_admits(state: &AppState, holder: &str, viewer: Option<&str>) -> bool {
    let Some(v) = viewer else { return false };
    if v == holder {
        return true;
    }
    match state.user_dbs.get(holder).await {
        Ok(Some(db)) => crate::record::imaol::published_edges(&db)
            .await
            .map(|edges| edges.get(v).is_some_and(|e| e.edge.trust.is_some()))
            .unwrap_or(false),
        _ => false,
    }
}

/// Which of these rows the viewer may see: every open row, and a sealed row only when its
/// holder admits the viewer - judged once per holder. Raw `sealed` rows never.
async fn admitted(
    state: &AppState,
    rows: Vec<MemoRow>,
    viewer: Option<&str>,
) -> Vec<MemoRow> {
    let mut verdicts: std::collections::HashMap<String, bool> = Default::default();
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        if r.key == SEALED_KEY {
            continue;
        }
        if r.sealed {
            let Some(holder) = r.holder.clone() else { continue };
            let ok = match verdicts.get(&holder) {
                Some(v) => *v,
                None => {
                    let v = holder_admits(state, &holder, viewer).await;
                    verdicts.insert(holder.clone(), v);
                    v
                }
            };
            if !ok {
                continue;
            }
        }
        out.push(r);
    }
    out
}

/// The memo's rows for these documents (hex, quoted for SQL), the author's own first.
async fn fetch_rows(node_db: &Db, docs: &[String]) -> Result<Vec<MemoRow>> {
    let rows: Vec<MemoTuple> = node_db
        .fetch_all(
            &format!(
                "SELECT target_author, target_doc, annotator, key, value, sealed, holder_root FROM doc_annotations
                 WHERE target_doc IN ({}) ORDER BY (annotator = target_author) DESC, noted_ms",
                docs.join(",")
            ),
            (),
        )
        .await
        .context("reading known annotations")?;
    Ok(rows.into_iter().map(memo_row).collect())
}

/// A memo row as the readers fetch it.
struct MemoRow {
    target_author: String,
    target_doc: String,
    annotator: String,
    key: String,
    value: String,
    sealed: bool,
    holder: Option<String>,
}

type MemoTuple = (String, String, String, String, String, i64, Option<String>);

fn memo_row((ta, td, annotator, key, value, sealed, holder): MemoTuple) -> MemoRow {
    MemoRow { target_author: ta, target_doc: td, annotator, key, value, sealed: sealed != 0, holder }
}

/// Open every raw sealed statement about one post with its key, in place: the row becomes
/// the plain label, marked sealed, naming the holder whose trust admits readers. The body
/// door calls this with the key it just used - the moment a reader is proven entitled to
/// the words is the moment their node may hold the labels open.
pub async fn open_sealed(
    node_db: &Db,
    target_author: &str,
    target_doc: &str,
    holder: &str,
    post_key: &[u8; 32],
) -> Result<()> {
    let raw: Vec<(String, String, i64, String)> = node_db
        .fetch_all(
            "SELECT annotator, value, noted_ms, learned_via FROM doc_annotations
             WHERE target_author = ?1 AND target_doc = ?2 AND key = ?3",
            (target_author, target_doc, SEALED_KEY),
        )
        .await
        .context("reading raw sealed labels")?;
    for (annotator, sealed_hex, noted_ms, learned_via) in raw {
        let Some((k, v)) = open_statement(&sealed_hex, post_key) else { continue };
        node_db
            .execute(
                "INSERT INTO doc_annotations
                   (target_author, target_doc, annotator, key, value, noted_ms, learned_via, sealed, holder_root, sealed_as)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9)
                 ON CONFLICT (target_author, target_doc, annotator, key, value) DO UPDATE SET
                   sealed = 1, holder_root = excluded.holder_root, sealed_as = excluded.sealed_as",
                (target_author, target_doc, annotator.as_str(), k.as_str(), v.as_str(), noted_ms, learned_via.as_str(), holder, sealed_hex.as_str()),
            )
            .await
            .context("opening a sealed label")?;
        node_db
            .execute(
                "DELETE FROM doc_annotations
                 WHERE target_author = ?1 AND target_doc = ?2 AND annotator = ?3 AND key = ?4 AND value = ?5",
                (target_author, target_doc, annotator.as_str(), SEALED_KEY, sealed_hex.as_str()),
            )
            .await
            .context("retiring a raw sealed label")?;
    }
    Ok(())
}

/// Note a sealed statement as the fold meets it: opened when this node already holds the
/// post's own key (the author's node, or a reader who has read it), else raw, to be opened
/// by `open_sealed` when the key arrives.
async fn note_sealed(
    node_db: &Db,
    target_author: &str,
    target_doc: &str,
    annotator: &str,
    sealed_hex: &str,
    learned_via: &str,
) -> Result<()> {
    let opened = match crate::postkeys::lookup(node_db, target_author, target_doc).await? {
        Some(key) => open_statement(sealed_hex, &key),
        None => None,
    };
    match opened {
        Some((k, v)) => {
            node_db
                .execute(
                    "INSERT INTO doc_annotations
                       (target_author, target_doc, annotator, key, value, noted_ms, learned_via, sealed, holder_root, sealed_as)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?1, ?8)
                     ON CONFLICT (target_author, target_doc, annotator, key, value) DO UPDATE SET
                       noted_ms = excluded.noted_ms, learned_via = excluded.learned_via,
                       sealed = 1, holder_root = excluded.holder_root, sealed_as = excluded.sealed_as",
                    (target_author, target_doc, annotator, k.as_str(), v.as_str(), now_ms(), learned_via, sealed_hex),
                )
                .await
                .context("noting an opened sealed label")?;
        }
        None => {
            node_db
                .execute(
                    "INSERT INTO doc_annotations
                       (target_author, target_doc, annotator, key, value, noted_ms, learned_via, sealed, holder_root, sealed_as)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, NULL, ?5)
                     ON CONFLICT (target_author, target_doc, annotator, key, value) DO UPDATE SET
                       noted_ms = excluded.noted_ms, learned_via = excluded.learned_via",
                    (target_author, target_doc, annotator, SEALED_KEY, sealed_hex, now_ms(), learned_via),
                )
                .await
                .context("noting a raw sealed label")?;
        }
    }
    Ok(())
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
        if r.present && r.key == SEALED_KEY {
            note_sealed(&state.node_db, &r.target_author, &doc_hex, annotator, &r.value, "chain").await?;
        } else if r.present {
            note(&state.node_db, &r.target_author, &doc_hex, annotator, &r.key, &r.value, "chain")
                .await?;
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
    learned_via: &str,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO doc_annotations
               (target_author, target_doc, annotator, key, value, noted_ms, learned_via)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (target_author, target_doc, annotator, key, value) DO UPDATE SET
               noted_ms = excluded.noted_ms,
               learned_via = excluded.learned_via",
            (target_author, target_doc, annotator, key, value, now_ms(), learned_via),
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
    if key == SEALED_KEY {
        // The lane retracts the ciphertext; the memo may hold it opened.
        node_db
            .execute(
                "DELETE FROM doc_annotations
                 WHERE target_author = ?1 AND target_doc = ?2 AND annotator = ?3 AND sealed_as = ?4",
                (target_author, target_doc, annotator, value),
            )
            .await
            .context("forgetting an opened sealed annotation")?;
    }
    Ok(())
}

/// The facets (2026-09-07): how often each bucket and each tag appears across `posts` -
/// counted per POST, however many people said it. Buckets are the author's own (a bucket
/// is where they filed it), and the automatic "feed" bucket stays out (every composed post
/// is in it, so it says nothing - the card hides the same chip). Tags are anyone's, the
/// way the cards show them (Curtis, 2026-09-07: the list had counted only the author's).
/// Sorted by count, then by value, buckets and tags apart. One IN query, like `for_posts`.
pub async fn label_counts(
    state: &AppState,
    posts: &[(String, String)],
    viewer: Option<&str>,
) -> Result<(Vec<(String, i64)>, Vec<(String, i64)>)> {
    let docs: Vec<String> = posts
        .iter()
        .map(|(_, d)| d)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|d| !d.is_empty() && d.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|d| format!("'{d}'"))
        .collect();
    if docs.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let wanted: std::collections::HashSet<&(String, String)> = posts.iter().collect();
    let rows: Vec<MemoTuple> = state
        .node_db
        .fetch_all(
            &format!(
                "SELECT target_author, target_doc, annotator, key, value, sealed, holder_root FROM doc_annotations
                 WHERE target_doc IN ({}) AND key IN ('bucket', 'tag')",
                docs.join(",")
            ),
            (),
        )
        .await
        .context("counting labels")?;
    let rows = admitted(state, rows.into_iter().map(memo_row).collect(), viewer).await;
    let mut seen: std::collections::HashSet<(String, String, String, String)> = Default::default();
    let mut buckets: std::collections::BTreeMap<String, i64> = Default::default();
    let mut tags: std::collections::BTreeMap<String, i64> = Default::default();
    for MemoRow { target_author: ta, target_doc: td, annotator, key, value, .. } in rows {
        if !wanted.contains(&(ta.clone(), td.clone())) {
            continue;
        }
        if key == "bucket" && (annotator != ta || value == "feed") {
            continue;
        }
        if !seen.insert((ta, td, key.clone(), value.clone())) {
            continue; // said by two people: one post, one count
        }
        let into = if key == "bucket" { &mut buckets } else { &mut tags };
        *into.entry(value).or_insert(0) += 1;
    }
    let sorted = |m: std::collections::BTreeMap<String, i64>| {
        let mut v: Vec<(String, i64)> = m.into_iter().collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    };
    Ok((sorted(buckets), sorted(tags)))
}

/// Every known label on each of these posts - the page's dressing, one IN query. The
/// author's own first (they filed it), then others by arrival; the display register
/// decides at the client which of the others render.
pub async fn for_posts(
    state: &AppState,
    posts: &[(String, String)],
    viewer: Option<&str>,
) -> Result<std::collections::HashMap<(String, String), Vec<KnownAnnotation>>> {
    for_posts_inner(state, posts, Some(viewer)).await
}

/// `for_posts` for a caller the BODY DOOR has already admitted to one sealed post (the copy
/// door, which just read the words): every opened label, no viewer asked. Never for a
/// listing.
pub async fn for_post_admitted(
    state: &AppState,
    author: &str,
    doc: &str,
) -> Result<Vec<KnownAnnotation>> {
    let mut known = for_posts_inner(state, &[(author.to_string(), doc.to_string())], None).await?;
    Ok(known.remove(&(author.to_string(), doc.to_string())).unwrap_or_default())
}

async fn for_posts_inner(
    state: &AppState,
    posts: &[(String, String)],
    viewer: Option<Option<&str>>,
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
    let rows = fetch_rows(&state.node_db, &docs).await?;
    let rows = match viewer {
        Some(v) => admitted(state, rows, v).await,
        None => rows.into_iter().filter(|r| r.key != SEALED_KEY).collect(),
    };
    let mut out: std::collections::HashMap<(String, String), Vec<KnownAnnotation>> =
        Default::default();
    for MemoRow { target_author: ta, target_doc: td, annotator, key, value, .. } in rows {
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
// The viral road (PROJECT_PLAN's Public annotations, slice 3): labels ride the fragment as the annotator's own
// signed proofs, verified at the receiving edge, noted into the memo, and KEPT - so the
// next hop's fragment carries them onward. Virality is a relay of proofs, never hearsay.

/// Byte budget for the proofs attached to one fragment answer: comfortably under the 16KB
/// frame cap with the header and its path beside them. Author-first order means the labels
/// most worth carrying are the last to be dropped.
const PROOF_BYTES_BUDGET: usize = 6 * 1024;

/// The dossier's label ledger (2026-08-31): every label the memo holds for one post with
/// the road it arrived by - `(annotator, key, value, noted_ms, learned_via)`, oldest-noted
/// first - and the set of (annotator, key, value) whose proofs this node keeps for onward
/// relay. A kept proof means this node CARRIES the label - carriage, named.
pub async fn ledger_for(
    node_db: &Db,
    root: &str,
    doc: &str,
) -> Result<(
    Vec<(String, String, String, i64, String)>,
    std::collections::HashSet<(String, String, String)>,
)> {
    let labels: Vec<(String, String, String, i64, String)> = node_db
        .fetch_all(
            "SELECT annotator, key, value, noted_ms, learned_via FROM doc_annotations
             WHERE target_author = ?1 AND target_doc = ?2 ORDER BY noted_ms",
            (root, doc),
        )
        .await
        .context("reading the label ledger")?;
    let kept: Vec<(String, String, String)> = node_db
        .fetch_all(
            "SELECT annotator, key, value FROM annotation_proofs
             WHERE target_author = ?1 AND target_doc = ?2",
            (root, doc),
        )
        .await
        .unwrap_or_default();
    Ok((labels, kept.into_iter().collect()))
}

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
    // A stranger's view: no sealed label rides a fragment (a raw ciphertext could, but the
    // memo's raw rows are retired as they open, so the lane is the sealed road for now).
    let rows = match for_posts(
        state,
        &[(target_author.to_string(), target_doc.to_string())],
        None,
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
    taught_by: &str,
) {
    // The dossier's key fact (Curtis, 2026-08-31): every statement here is signed, but
    // CARRIAGE was anonymous - a relay could launder a legion's labels into view with no
    // name on the act. The road now records who handed the proof over.
    let road = format!("relay:{taught_by}");
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
            let noted = note(
                &state.node_db,
                &author_hex,
                &doc_hex,
                &annotator_hex,
                &a.key,
                &a.value,
                &road,
            )
            .await;
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
    async fn rows_of(db: &Db, d: &str) -> Vec<MemoRow> {
        fetch_rows(db, &[format!("'{d}'")]).await.unwrap()
    }

    #[tokio::test]
    async fn noted_read_and_forgotten() {
        let db = crate::db::test_node_db().await;
        let (a, d) = ("aa".repeat(32), "11".repeat(16));
        note(&db, &a, &d, &"bb".repeat(32), "tag", "goopy", "chain").await.unwrap();
        note(&db, &a, &d, &a, "tag", "saucy", "chain").await.unwrap();
        note(&db, &a, &d, &a, "tag", "saucy", "chain").await.unwrap();
        let labels = rows_of(&db, &d).await;
        assert_eq!(labels.len(), 2, "idempotent: one row per statement");
        assert_eq!(labels[0].annotator, a, "the author's own label comes first");
        forget(&db, &a, &d, &"bb".repeat(32), "tag", "goopy").await.unwrap();
        assert_eq!(rows_of(&db, &d).await.len(), 1, "a retraction takes its row");
    }

    /// The sealed road (ruling 7): a statement rides as ciphertext, folds raw where the key
    /// is not held, opens in place once it is, and a retraction of the ciphertext takes the
    /// opened row with it.
    #[tokio::test]
    async fn a_sealed_label_folds_raw_opens_with_the_key_and_retracts_by_its_ciphertext() {
        let db = crate::db::test_node_db().await;
        let (a, d) = ("aa".repeat(32), "11".repeat(16));
        let key = [7u8; 32];
        let sealed = seal_statement(&key, "tag", "divorce").unwrap();
        assert_eq!(open_statement(&sealed, &key), Some(("tag".into(), "divorce".into())));
        assert_eq!(open_statement(&sealed, &[8u8; 32]), None, "the wrong key opens nothing");
        note_sealed(&db, &a, &d, &a, &sealed, "chain").await.unwrap();
        let raw = rows_of(&db, &d).await;
        assert_eq!((raw[0].key.as_str(), raw[0].sealed, raw[0].holder.is_none()), (SEALED_KEY, true, true), "folded raw");
        open_sealed(&db, &a, &d, &a, &key).await.unwrap();
        let opened = rows_of(&db, &d).await;
        assert_eq!(opened.len(), 1, "the raw row retired as it opened");
        assert_eq!((opened[0].key.as_str(), opened[0].value.as_str(), opened[0].sealed, opened[0].holder.as_deref()), ("tag", "divorce", true, Some(a.as_str())));
        forget(&db, &a, &d, &a, SEALED_KEY, &sealed).await.unwrap();
        assert!(rows_of(&db, &d).await.is_empty(), "retracting the ciphertext takes the opened row");
        // Held key at fold time: opened on the spot.
        crate::postkeys::remember(&db, &a, &d, &key).await.unwrap();
        note_sealed(&db, &a, &d, &"bb".repeat(32), &sealed, "chain").await.unwrap();
        let now = rows_of(&db, &d).await;
        assert_eq!((now[0].key.as_str(), now[0].value.as_str()), ("tag", "divorce"), "opened as it folded");
    }
}
