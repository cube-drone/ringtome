//! The notifications memo: derived events worth telling a local persona about.
//!
//! This is the DERIVED side of Arrival and Attention (PROJECT_PLAN): the source facts are
//! signed entries on chains this node already syncs because a local persona follows their
//! author - "a follow-edge produces no inbox row, ever; the fold derives it locally." The
//! envelope/inbox path for strangers is a different, future machine; nothing here touches it.
//!
//! Same memo idiom as `fanout::feed_journal`, one level smaller: the fold writes rows on the
//! frontier edge (whenever an author's public lane moves, and after a local persona's own
//! reconcile mints statements - locally-authored entries never take the sync gate), and reads
//! never fold. Rows collapse per (reader, author, kind) - a re-published edge updates, never
//! stacks - and a retraction deletes, because "X no longer publicly follows you" is not a
//! notification, just the absence of one. Disposable like every memo: rebuildable from the
//! held chains times the subscriptions table.

use anyhow::{Context, Result};

use crate::db::Db;
use crate::AppState;

/// The one kind this fold produces today. Future kinds (comment, tag, rebroadcast) add words
/// here and their own fold sources; the table and the app read kinds they don't know and
/// render what they do.
pub const KIND_PUBLIC_EDGE: &str = "public-edge";

/// One notification, as the endpoint serves it.
#[derive(Debug, serde::Serialize)]
pub struct NotificationRow {
    pub author_root: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interest: Option<String>,
    pub updated_ms: i64,
}

/// Re-fold one author's published edges into notification rows for the local personas that
/// follow them. Best-effort at every call site (a missed pass is caught by the next frontier
/// move or sweep, the memo way) - so this logs instead of erroring.
pub async fn refresh_from(state: &AppState, author_root: &str) {
    if let Err(e) = refresh_from_inner(state, author_root).await {
        tracing::debug!(author = %author_root, error = ?e, "notification fold failed");
    }
}

async fn refresh_from_inner(state: &AppState, author_root: &str) -> Result<()> {
    // The cheap gate first: most authors have published no edges, and this hook fires on
    // every public frontier move - so ask the chain_heads memo (one node.db probe) before
    // paying for a user-database open.
    if !crate::net::frontier::has_service_chain(
        &state.node_db,
        author_root,
        ringtome_proto::registry::service::FOLLOWS_PUBLIC,
    )
    .await?
    {
        return Ok(());
    }
    // One database open, the fold edge's allowance (the same shape as fanout::journal_for).
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .context("opening the author's database")?
    else {
        return Ok(()); // an author we hold nothing of has published nothing we can read
    };
    let published = crate::record::imaol::published_edges(&db)
        .await
        .map_err(|e| anyhow::anyhow!("folding {author_root}'s published edges: {e}"))?;
    drop(db);
    if published.is_empty() {
        return Ok(());
    }

    let hosted: std::collections::BTreeSet<String> =
        crate::identity::hosted_roots(&state.node_db)
            .await
            .map_err(|e| anyhow::anyhow!("listing hosted personas: {e}"))?
            .into_iter()
            .collect();

    for (subject_hex, row) in published {
        if subject_hex == author_root || !hosted.contains(&subject_hex) {
            continue;
        }
        // The follow check is what makes this the derived path: we only speak about authors
        // this reader chose to sync. (An edge published about a non-following local persona
        // is deliberately NOT surfaced here - reaching someone who doesn't follow you is the
        // inbox path's job, gates and all.)
        if !crate::net::subscriptions::follows(&state.node_db, &subject_hex, author_root).await? {
            continue;
        }
        if row.edge.is_empty() {
            delete_row(&state.node_db, &subject_hex, author_root).await?;
        } else {
            upsert_row(
                &state.node_db,
                &subject_hex,
                author_root,
                row.edge.trust.as_deref(),
                row.edge.interest.as_deref(),
                row.received_at_ms,
            )
            .await?;
        }
    }
    Ok(())
}

/// Upsert one public-edge notification. Stamps come from the winning entry's arrival, so
/// re-folding the same chains is a no-op rather than a resurrection of old rows as "new".
async fn upsert_row(
    node_db: &Db,
    reader_root: &str,
    author_root: &str,
    trust: Option<&str>,
    interest: Option<&str>,
    updated_ms: i64,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO notifications
               (reader_root, author_root, kind, trust, interest, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (reader_root, author_root, kind) DO UPDATE SET
                 trust = excluded.trust,
                 interest = excluded.interest,
                 updated_ms = excluded.updated_ms",
            (
                reader_root,
                author_root,
                KIND_PUBLIC_EDGE,
                trust,
                interest,
                updated_ms,
            ),
        )
        .await
        .context("storing a notification")?;
    Ok(())
}

async fn delete_row(node_db: &Db, reader_root: &str, author_root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM notifications
             WHERE reader_root = ?1 AND author_root = ?2 AND kind = ?3",
            (reader_root, author_root, KIND_PUBLIC_EDGE),
        )
        .await
        .context("retracting a notification")?;
    Ok(())
}

/// One reader's notifications, newest first. Small and bounded on purpose: the memo collapses
/// per (author, kind), so the row count is the reader's social circle, not their history.
pub async fn page(node_db: &Db, reader_root: &str, limit: u32) -> Result<Vec<NotificationRow>> {
    /// `(author_root, kind, trust, interest, updated_ms)`, as the row comes back.
    type Row = (String, String, Option<String>, Option<String>, i64);
    let rows: Vec<Row> = node_db
        .fetch_all(
            "SELECT author_root, kind, trust, interest, updated_ms FROM notifications
             WHERE reader_root = ?1 ORDER BY updated_ms DESC LIMIT ?2",
            (reader_root, i64::from(limit)),
        )
        .await
        .context("reading notifications")?;
    Ok(rows
        .into_iter()
        .map(
            |(author_root, kind, trust, interest, updated_ms)| NotificationRow {
                author_root,
                kind,
                trust,
                interest,
                updated_ms,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rows_collapse_per_author_and_retraction_deletes() {
        let db = crate::db::test_node_db().await;
        let reader = "aa".repeat(32);
        let author = "bb".repeat(32);

        upsert_row(&db, &reader, &author, None, Some("high"), 1000).await.unwrap();
        upsert_row(&db, &reader, &author, Some("max"), Some("high"), 2000).await.unwrap();

        let rows = page(&db, &reader, 50).await.unwrap();
        assert_eq!(rows.len(), 1, "collapse by (sender, kind): one row however often they publish");
        assert_eq!(rows[0].trust.as_deref(), Some("max"));
        assert_eq!(rows[0].updated_ms, 2000);

        delete_row(&db, &reader, &author).await.unwrap();
        assert!(page(&db, &reader, 50).await.unwrap().is_empty(), "a retraction is an absence");
    }

    #[tokio::test]
    async fn pages_are_per_reader_newest_first() {
        let db = crate::db::test_node_db().await;
        let me = "aa".repeat(32);
        let housemate = "cc".repeat(32);

        upsert_row(&db, &me, &"b1".repeat(32), None, Some("low"), 100).await.unwrap();
        upsert_row(&db, &me, &"b2".repeat(32), Some("high"), None, 300).await.unwrap();
        upsert_row(&db, &housemate, &"b3".repeat(32), None, Some("max"), 200).await.unwrap();

        let mine = page(&db, &me, 50).await.unwrap();
        assert_eq!(
            mine.iter().map(|r| r.updated_ms).collect::<Vec<_>>(),
            vec![300, 100],
            "newest first, and the housemate's rows are not mine"
        );
    }
}
