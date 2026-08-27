//! The replies memo: "replies known here", per post (COMMENTS.md slice 2).
//!
//! Nobody's chain holds "all replies to P" - assembly is honest-partial by ruling. This
//! node-level table folds the reply links it can VERIFY from things it already holds: the
//! signed headers on mirrored chains (a followed or visited replier), and the signed
//! headers on the fragment shelf (a reply met as a share). Each row is a claim this node
//! checked itself; the thread the permalink renders is exactly this set, cursor-paged,
//! and slice 6's author door serves from the same well.
//!
//! Two sources, two lifecycles:
//!   * **chain-held** rows ride the fold lane (`fold::run_chain` -> [`refresh_from`]) and
//!     are stamp-swept per reply author on every fold - a deleted reply's header leaves
//!     the shelf, and its row recedes on the same edge;
//!   * **fragment-held** rows are noted at intake ([`note_reply`], from `fragments::
//!     remember`) and forgotten when the fragment dies ([`forget_reply`], from the drop
//!     path) - the fragment lifecycle IS the row's.
//!
//! Owns the `post_replies` SQL (tests/conventions.rs).

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// One page of the thread read - keyset, oldest first (a conversation reads downward).
pub const REPLIES_PAGE: i64 = 20;

/// One known reply, as the memo serves it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct KnownReply {
    pub author: String,
    pub doc_id: String,
    /// The reply's claimed stamp - ordering only, replay-stable, the author's own number.
    pub claimed_ms: i64,
}

/// Note one verified reply link. Idempotent; the stamp refreshes so the chain sweep's
/// rewrite keeps rows it still sees.
async fn note(
    node_db: &Db,
    parent: &(String, String),
    root: &(String, String),
    reply_author: &str,
    reply_doc: &str,
    claimed_ms: i64,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO post_replies
               (parent_author, parent_doc, reply_author, reply_doc,
                root_author, root_doc, claimed_ms, noted_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (parent_author, parent_doc, reply_author, reply_doc) DO UPDATE SET
               root_author = excluded.root_author,
               root_doc = excluded.root_doc,
               claimed_ms = excluded.claimed_ms,
               noted_ms = excluded.noted_ms",
            (
                parent.0.as_str(),
                parent.1.as_str(),
                reply_author,
                reply_doc,
                root.0.as_str(),
                root.1.as_str(),
                claimed_ms,
                now_ms(),
            ),
        )
        .await
        .context("noting a reply link")?;
    Ok(())
}

/// A reply arrived as a FRAGMENT: note its link from the verified header. The fragment
/// lifecycle owns the row from here ([`forget_reply`]).
pub async fn note_reply(
    node_db: &Db,
    reply_author: &str,
    verified: &ringtome_proto::fragment::VerifiedFragment,
) -> Result<()> {
    let Some((parent_root, parent_doc)) = verified.header.reply_to else {
        return Ok(());
    };
    let parent = (hex::encode(parent_root), hex::encode(parent_doc));
    let root = match verified.header.thread_root {
        Some((r, d)) => (hex::encode(r), hex::encode(d)),
        None => parent.clone(),
    };
    note(
        node_db,
        &parent,
        &root,
        reply_author,
        &hex::encode(verified.doc_id),
        verified.timestamp_ms,
    )
    .await
}

/// A fragment died (takedown, withdrawal, eviction): its reply row goes with it - unless
/// the replier's CHAIN is also held here, in which case the fold lane's sweep owns the
/// row and will keep or recede it on its own evidence.
pub async fn forget_reply(node_db: &Db, reply_author: &str, reply_doc: &str) -> Result<()> {
    let chain_held = crate::net::frontier::has_service_chain(
        node_db,
        reply_author,
        ringtome_proto::registry::service::POSTS,
    )
    .await
    .unwrap_or(false);
    if chain_held {
        return Ok(());
    }
    node_db
        .execute(
            "DELETE FROM post_replies WHERE reply_author = ?1 AND reply_doc = ?2",
            (reply_author, reply_doc),
        )
        .await
        .context("forgetting a dead fragment's reply link")?;
    Ok(())
}

/// The fold-lane hook: rewrite one REPLIER's slice of the memo from their public shelf as
/// held right now. Stamp-swept like every whole-slice memo rewrite (subscriptions, the
/// demand memo): a reply whose header left the shelf - deleted, repudiated - recedes on
/// the same fold that noticed.
pub async fn refresh_from(state: &AppState, author_root: &str) {
    if let Err(e) = refresh_inner(state, author_root).await {
        tracing::debug!(author = %author_root, error = ?e, "replies memo refresh failed");
    }
}

async fn refresh_inner(state: &AppState, author_root: &str) -> Result<()> {
    let Ok(Some(db)) = state.user_dbs.get(author_root).await else {
        return Ok(()); // nothing held of them: the fragment path owns any rows
    };
    let replies = crate::record::documents::public_replies(&db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    drop(db);
    let now = now_ms();
    for (doc_id, parent, root, claimed_ms) in &replies {
        note(
            &state.node_db,
            parent,
            root,
            author_root,
            &hex::encode(doc_id),
            *claimed_ms,
        )
        .await?;
    }
    // The stamp sweep: chain-sourced rows this rewrite did not touch lost the header that
    // justified them - a deleted reply recedes on the fold that noticed. Runs whenever the
    // CHAIN is genuinely held (we just read its shelf), fragment-sourced rows included:
    // if the chain is here, the shelf is the truth about this author's replies.
    state
        .node_db
        .execute(
            "DELETE FROM post_replies WHERE reply_author = ?1 AND noted_ms < ?2",
            (author_root, now),
        )
        .await
        .context("sweeping receded reply links")?;
    Ok(())
}

/// The thread read: one page of a post's DIRECT replies, oldest first, keyset by
/// (claimed_ms, reply_doc). The UI recurses per level, depth-capped - a thousand-reply
/// tree is a read whose cost grows with history, so it pages or it does not ship.
pub async fn replies_of(
    node_db: &Db,
    parent_author: &str,
    parent_doc: &str,
    after: Option<(i64, String)>,
) -> Result<(Vec<KnownReply>, bool)> {
    let rows: Vec<(String, String, i64)> = match after {
        None => {
            node_db
                .fetch_all(
                    "SELECT reply_author, reply_doc, claimed_ms FROM post_replies
                     WHERE parent_author = ?1 AND parent_doc = ?2
                     ORDER BY claimed_ms, reply_doc LIMIT ?3",
                    (parent_author, parent_doc, REPLIES_PAGE + 1),
                )
                .await
        }
        Some((ms, doc)) => {
            node_db
                .fetch_all(
                    "SELECT reply_author, reply_doc, claimed_ms FROM post_replies
                     WHERE parent_author = ?1 AND parent_doc = ?2
                       AND (claimed_ms > ?3 OR (claimed_ms = ?3 AND reply_doc > ?4))
                     ORDER BY claimed_ms, reply_doc LIMIT ?5",
                    (parent_author, parent_doc, ms, doc.as_str(), REPLIES_PAGE + 1),
                )
                .await
        }
    }
    .context("reading the replies memo")?;
    let more = rows.len() as i64 > REPLIES_PAGE;
    let mut out: Vec<KnownReply> = rows
        .into_iter()
        .map(|(author, doc_id, claimed_ms)| KnownReply {
            author,
            doc_id,
            claimed_ms,
        })
        .collect();
    out.truncate(REPLIES_PAGE as usize);
    Ok((out, more))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The memo's lifecycle in miniature: noted, re-noted (idempotent), paged in claimed
    /// order, and receded by the stamp sweep when a rewrite no longer sees it.
    #[tokio::test]
    async fn noted_paged_and_receded() {
        let db = crate::db::test_node_db().await;
        let parent = ("aa".repeat(32), "11".repeat(16));
        let root = parent.clone();
        note(&db, &parent, &root, &"bb".repeat(32), &"22".repeat(16), 5).await.unwrap();
        note(&db, &parent, &root, &"cc".repeat(32), &"33".repeat(16), 3).await.unwrap();
        note(&db, &parent, &root, &"bb".repeat(32), &"22".repeat(16), 5).await.unwrap();

        let (page, more) = replies_of(&db, &parent.0, &parent.1, None).await.unwrap();
        assert!(!more);
        assert_eq!(page.len(), 2, "idempotent noting: one row per reply");
        assert_eq!(page[0].claimed_ms, 3, "oldest first - a conversation reads downward");

        // The sweep, in production's exact order: cutoff FIRST, then the rewrite's notes
        // (stamped at-or-after it), then the delete of what the rewrite did not touch.
        // The tick of separation kills the same-millisecond hazard the first version of
        // this test had and the serialized fold lane never does.
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let cutoff = now_ms();
        note(&db, &parent, &root, &"cc".repeat(32), &"33".repeat(16), 3).await.unwrap();
        db.execute(
            "DELETE FROM post_replies WHERE reply_author = ?1 AND noted_ms < ?2",
            ("bb".repeat(32), cutoff),
        )
        .await
        .unwrap();
        let (page, _) = replies_of(&db, &parent.0, &parent.1, None).await.unwrap();
        assert_eq!(page.len(), 1, "the header left the shelf; the row went with it");
        assert_eq!(page[0].author, "cc".repeat(32));
    }
}
