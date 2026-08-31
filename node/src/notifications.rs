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

/// "Someone you follow shared something of yours." The derived twin of
/// `deliver::notice_kind::REBROADCAST` - a follow edge produces no inbox row, ever, so where the
/// author already syncs the sharer this fold is the only thing that speaks.
pub const KIND_REBROADCAST: &str = "rebroadcast";

/// "Someone you follow replied to your post." The derived twin of
/// `deliver::notice_kind::COMMENT` (PROJECT_PLAN's Replies slice 4) - first-class by ruling, tiered by
/// sender like the public edge, and the row's doc is the PARENT: the reader's own post,
/// where the thread assembles and the bell's mini-card points.
pub const KIND_COMMENT: &str = "comment";

/// "Someone you follow labelled your post." The derived twin of
/// `deliver::notice_kind::TAGGED` (ANNOTATIONS.md slice 4) - a murmur; the row's doc is
/// the post, and rows collapse per (reader, annotator, post): three tags from one person
/// on one post are one line in the bell.
pub const KIND_TAGGED: &str = "tagged";

/// One notification, as the endpoint serves it.
#[derive(Debug, serde::Serialize)]
pub struct NotificationRow {
    pub author_root: String,
    pub kind: String,
    /// Which object, for kinds that are about one - the shared document, hex. Empty for kinds
    /// about a relationship.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interest: Option<String>,
    /// The row's own words, for kinds that carry some - 'tagged': every current label
    /// that annotator has on that post, joined.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub updated_ms: i64,
}

/// Re-fold one author's published edges into notification rows for the local personas that
/// follow them. Best-effort at every call site (a missed pass is caught by the next frontier
/// move or sweep, the memo way) - so this logs instead of erroring.
pub async fn refresh_from(state: &AppState, author_root: &str) {
    use ringtome_proto::registry::service;
    // Forced: this caller's trigger is not a chain move (a new follow reshaping who the
    // rows are for), so no fingerprint may stand in its way.
    refresh_parts(
        state,
        author_root,
        &[
            service::FOLLOWS_PUBLIC,
            service::REBROADCASTS,
            service::POSTS,
            service::ANNOTATIONS_PUBLIC,
        ],
        true,
    )
    .await;
}

/// The fold, restricted to the legs whose source chain is in `moved` (2026-08-28): edges
/// read FOLLOWS_PUBLIC, the share murmurs read REBROADCASTS, the comment rows read POSTS -
/// and a post must not re-walk every share ever made. `refresh_from` is all three, for the
/// callers whose trigger is not a chain move (a new follow reshaping who the rows are for).
pub async fn refresh_parts(state: &AppState, author_root: &str, moved: &[u32], force: bool) {
    if let Err(e) = refresh_from_inner(state, author_root, moved, force).await {
        tracing::debug!(author = %author_root, error = ?e, "notification fold failed");
    }
}

async fn refresh_from_inner(
    state: &AppState,
    author_root: &str,
    moved: &[u32],
    force: bool,
) -> Result<()> {
    use ringtome_proto::registry::service;
    let wants = |s: u32| moved.contains(&s);

    // The cheap gates first: most authors have published no edges and shared nothing, and this
    // hook fires on every public frontier move - so ask the chain_heads memo (node.db probes)
    // before paying for a user-database open. A leg whose chain did not move is off, whatever
    // the memo says it holds.
    let has_edges = wants(service::FOLLOWS_PUBLIC)
        && crate::net::frontier::has_service_chain(&state.node_db, author_root, service::FOLLOWS_PUBLIC)
            .await?;
    let has_shares = wants(service::REBROADCASTS)
        && crate::net::frontier::has_service_chain(&state.node_db, author_root, service::REBROADCASTS)
            .await?;
    let has_posts = wants(service::POSTS)
        && crate::net::frontier::has_service_chain(&state.node_db, author_root, service::POSTS)
            .await?;
    let has_labels = wants(service::ANNOTATIONS_PUBLIC)
        && crate::net::frontier::has_service_chain(&state.node_db, author_root, service::ANNOTATIONS_PUBLIC)
            .await?;
    // Reads below open the database once for whichever legs run; the comment leg then asks
    // the reply-set fingerprint (replies::replies_moved) and steps aside for a plain post.
    if !has_edges && !has_shares && !has_posts && !has_labels {
        return Ok(());
    }
    // ONE database open for both folds, the fold edge's allowance (the same shape as
    // fanout::journal_for). Two folds reading one handle beats two handles, and the
    // conventions cop counts opens per file for exactly this reason.
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .context("opening the author's database")?
    else {
        return Ok(()); // an author we hold nothing of has published nothing we can read
    };
    let published = if has_edges {
        crate::record::imaol::published_edges(&db)
            .await
            .map_err(|e| anyhow::anyhow!("folding {author_root}'s published edges: {e}"))?
    } else {
        Default::default()
    };
    let shared = if has_shares {
        crate::record::imaol::rebroadcasts(&db)
            .await
            .map_err(|e| anyhow::anyhow!("folding {author_root}'s rebroadcasts: {e}"))?
    } else {
        Vec::new()
    };
    // The replies list serves two legs: the comment rows (POSTS) and the share leg's
    // parent-pin suppression (REBROADCASTS) - read it when either runs. The comment leg
    // itself runs only when the reply SET moved (the fingerprint, 2026-08-28) - a plain
    // post is a POSTS move that touched no reply, and must not re-walk every comment row.
    let comment_leg = has_posts
        && (crate::replies::replies_moved(state, &db, author_root, "comment-notices").await?
            || force);
    // The labels leg (ANNOTATIONS.md slice 4) reads the whole folded view: it is small
    // (one row per statement, tombstones included) and the leg diffs against standing rows.
    let labels = if has_labels {
        crate::record::imaol::public_annotations(&db)
            .await
            .map_err(|e| anyhow::anyhow!("folding {author_root}'s labels: {e}"))?
    } else {
        Vec::new()
    };
    let replies = if comment_leg || has_shares {
        crate::record::documents::public_replies(&db)
            .await
            .map_err(|e| anyhow::anyhow!("folding {author_root}'s replies: {e}"))?
    } else {
        Vec::new()
    };
    drop(db);
    if published.is_empty() && shared.is_empty() && replies.is_empty() && labels.is_empty() {
        return Ok(());
    }

    let hosted: std::collections::BTreeSet<String> =
        crate::identity::hosted_roots(&state.node_db)
            .await
            .map_err(|e| anyhow::anyhow!("listing hosted personas: {e}"))?
            .into_iter()
            .collect();
    // Every reader whose rows this pass touches gets a stream nudge at the end (the dock
    // badge, 2026-08-28): these rows live in node.db, invisible to the stream's user-db
    // stamp, so the fold is what tells the open tabs "recount now". Delivered notices need
    // nothing here - their transcription is a user-db append, which nudges on its own.
    let mut touched: std::collections::BTreeSet<String> = Default::default();

    // "Someone you follow shared something of yours." The reader here is the shared document's
    // AUTHOR, not a follower of the sharer - which is the whole difference between this fold and
    // the feed's. Same follow-edge rule as below: we only speak about authors this reader chose
    // to sync, because reaching someone who does not follow you is the inbox path's job.
    // Which (author, doc) pairs this author's replies answer: their parent pins. A pin's
    // share row must not ALSO murmur "shared your post" at the parent's author - the
    // comment row below is the same act said properly (the envelope road applies the same
    // rule by never minting the parent pin's notice). The ROOT pin of a nested reply is
    // not in this set, deliberately: for the root's author the news really is a share.
    let answered: std::collections::BTreeSet<(String, String)> = replies
        .iter()
        .flat_map(|(_, parent, root, _)| {
            // The root pin too, when the parent's author owns the root: for them the
            // comment already says it (the envelope road's `announce` rule, 2026-08-29).
            let mut pins = vec![(parent.0.clone(), parent.1.clone())];
            if root.0 == parent.0 {
                pins.push((root.0.clone(), root.1.clone()));
            }
            pins
        })
        .collect();

    for row in &shared {
        if !hosted.contains(&row.author_root) || row.author_root == author_root {
            continue;
        }
        if answered.contains(&(row.author_root.clone(), hex::encode(row.doc_id))) {
            continue;
        }
        if !crate::net::subscriptions::follows(&state.node_db, &row.author_root, author_root).await?
        {
            continue;
        }
        let doc_hex = hex::encode(row.doc_id);
        touched.insert(row.author_root.clone());
        if row.is_retracted() {
            // Un-sharing removes the notification rather than announcing itself. "X no longer
            // shares your post" is not news, just the absence of some - the same rule the
            // retracted edge follows below, and the same one `verify_claim` applies to the
            // delivered twin.
            delete_row(
                &state.node_db,
                &row.author_root,
                author_root,
                KIND_REBROADCAST,
                &doc_hex,
            )
            .await?;
        } else {
            upsert_row(
                &state.node_db,
                &row.author_root,
                author_root,
                KIND_REBROADCAST,
                &doc_hex,
                None,
                None,
                None,
                row.received_at_ms,
            )
            .await?;
        }
    }

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
        touched.insert(subject_hex.clone());
        if row.edge.is_empty() {
            delete_row(&state.node_db, &subject_hex, author_root, KIND_PUBLIC_EDGE, "").await?;
        } else {
            upsert_row(
                &state.node_db,
                &subject_hex,
                author_root,
                KIND_PUBLIC_EDGE,
                "",
                row.edge.trust.as_deref(),
                row.edge.interest.as_deref(),
                None,
                row.received_at_ms,
            )
            .await?;
        }
    }

    // "Someone you follow replied to your post." The reader is the PARENT's author, the
    // row's doc is the parent (their own post - the thread's address), and the stamp is the
    // reply's own claim, replay-stable like the shelf it folds from. Same follow-edge rule
    // as everything above. Deletion has no retraction entry to read - a deleted reply's
    // header simply leaves the shelf - so the fold diffs: rows this author no longer backs
    // recede with the pass that noticed (the replies memo's sweep, one table over).
    // "Someone you follow labelled your post" (ANNOTATIONS.md slice 4). The reader is the
    // post's author; the row collapses per (reader, annotator, post). Same follow-edge
    // rule as the share leg; recedes by diff when the annotator withdraws every label on
    // that post.
    if has_labels {
        // Gather first, speak once: the collapsed row carries every current label that
        // annotator has on that post ("labelled it" without the label is half the news -
        // Curtis, 2026-08-31), stamped by the newest of them.
        let mut fresh: std::collections::BTreeMap<(String, String), (Vec<String>, i64)> =
            Default::default();
        for l in labels.iter().filter(|l| l.present) {
            if !hosted.contains(&l.target_author) || l.target_author == author_root {
                continue;
            }
            if !crate::net::subscriptions::follows(&state.node_db, &l.target_author, author_root)
                .await?
            {
                continue;
            }
            let words = if l.key == "tag" {
                l.value.clone()
            } else {
                format!("{}: {}", l.key, l.value)
            };
            let e = fresh
                .entry((l.target_author.clone(), hex::encode(l.target_doc)))
                .or_insert((Vec::new(), 0));
            e.0.push(words);
            e.1 = e.1.max(l.received_at_ms);
        }
        for ((reader, doc_hex), (words, newest_ms)) in &fresh {
            touched.insert(reader.clone());
            upsert_row(
                &state.node_db,
                reader,
                author_root,
                KIND_TAGGED,
                doc_hex,
                None,
                None,
                Some(&words.join(", ")),
                *newest_ms,
            )
            .await?;
        }
        let standing: Vec<(String, String)> = state
            .node_db
            .fetch_all(
                "SELECT reader_root, doc_id FROM notifications
                 WHERE author_root = ?1 AND kind = ?2",
                (author_root, KIND_TAGGED),
            )
            .await
            .context("reading standing tagged rows")?;
        for (reader, doc) in standing {
            if !fresh.contains_key(&(reader.clone(), doc.clone())) {
                touched.insert(reader.clone());
                delete_row(&state.node_db, &reader, author_root, KIND_TAGGED, &doc).await?;
            }
        }
    }
    if !comment_leg {
        nudge_streams(state, &touched);
        return Ok(()); // the comment leg below is reply-set-sourced; its diff must not run blind
    }
    let mut fresh: std::collections::BTreeSet<(String, String)> = Default::default();
    for (_, parent, _, claimed_ms) in &replies {
        if !hosted.contains(&parent.0) || parent.0 == author_root {
            continue;
        }
        if !crate::net::subscriptions::follows(&state.node_db, &parent.0, author_root).await? {
            continue;
        }
        fresh.insert((parent.0.clone(), parent.1.clone()));
        touched.insert(parent.0.clone());
        upsert_row(
            &state.node_db,
            &parent.0,
            author_root,
            KIND_COMMENT,
            &parent.1,
            None,
            None,
            None,
            *claimed_ms,
        )
        .await?;
    }
    let standing: Vec<(String, String)> = state
        .node_db
        .fetch_all(
            "SELECT reader_root, doc_id FROM notifications
             WHERE author_root = ?1 AND kind = ?2",
            (author_root, KIND_COMMENT),
        )
        .await
        .context("reading standing comment rows")?;
    for (reader, doc) in standing {
        if !fresh.contains(&(reader.clone(), doc.clone())) {
            touched.insert(reader.clone());
            delete_row(&state.node_db, &reader, author_root, KIND_COMMENT, &doc).await?;
        }
    }
    nudge_streams(state, &touched);
    Ok(())
}

/// Wake the open streams of these readers: the write-nudge bus, fired with the READER's
/// root the way a user-db write would fire it for its own persona. The eager-sync loop
/// hears it too and finds nothing moved - the tick is its backstop either way.
fn nudge_streams(state: &AppState, readers: &std::collections::BTreeSet<String>) {
    let bus = state.user_dbs.write_nudge();
    for reader in readers {
        let _ = bus.send(reader.clone());
    }
}

/// Upsert one public-edge notification. Stamps come from the winning entry's arrival, so
/// re-folding the same chains is a no-op rather than a resurrection of old rows as "new".
#[allow(clippy::too_many_arguments)]
async fn upsert_row(
    node_db: &Db,
    reader_root: &str,
    author_root: &str,
    kind: &str,
    doc_id: &str,
    trust: Option<&str>,
    interest: Option<&str>,
    detail: Option<&str>,
    updated_ms: i64,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO notifications
               (reader_root, author_root, kind, doc_id, trust, interest, detail, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT (reader_root, author_root, kind, doc_id) DO UPDATE SET
                 trust = excluded.trust,
                 interest = excluded.interest,
                 detail = excluded.detail,
                 updated_ms = excluded.updated_ms",
            (
                reader_root,
                author_root,
                kind,
                doc_id,
                trust,
                interest,
                detail,
                updated_ms,
            ),
        )
        .await
        .context("storing a notification")?;
    Ok(())
}

async fn delete_row(
    node_db: &Db,
    reader_root: &str,
    author_root: &str,
    kind: &str,
    doc_id: &str,
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM notifications
             WHERE reader_root = ?1 AND author_root = ?2 AND kind = ?3 AND doc_id = ?4",
            (reader_root, author_root, kind, doc_id),
        )
        .await
        .context("retracting a notification")?;
    Ok(())
}

/// One reader's notifications, newest first. Small and bounded on purpose: the memo collapses
/// per (author, kind), so the row count is the reader's social circle, not their history.
pub async fn page(node_db: &Db, reader_root: &str, limit: u32) -> Result<Vec<NotificationRow>> {
    /// `(author_root, kind, doc_id, trust, interest, detail, updated_ms)`, as the row comes back.
    type Row = (String, String, String, Option<String>, Option<String>, Option<String>, i64);
    let rows: Vec<Row> = node_db
        .fetch_all(
            "SELECT author_root, kind, doc_id, trust, interest, detail, updated_ms FROM notifications
             WHERE reader_root = ?1 ORDER BY updated_ms DESC LIMIT ?2",
            (reader_root, i64::from(limit)),
        )
        .await
        .context("reading notifications")?;
    Ok(rows
        .into_iter()
        .map(
            |(author_root, kind, doc_id, trust, interest, detail, updated_ms)| NotificationRow {
                author_root,
                kind,
                detail,
                doc_id,
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

        upsert_row(&db, &reader, &author, KIND_PUBLIC_EDGE, "", None, Some("high"), None, 1000).await.unwrap();
        upsert_row(&db, &reader, &author, KIND_PUBLIC_EDGE, "", Some("max"), Some("high"), None, 2000).await.unwrap();

        let rows = page(&db, &reader, 50).await.unwrap();
        assert_eq!(rows.len(), 1, "collapse by (sender, kind): one row however often they publish");
        assert_eq!(rows[0].trust.as_deref(), Some("max"));
        assert_eq!(rows[0].updated_ms, 2000);

        delete_row(&db, &reader, &author, KIND_PUBLIC_EDGE, "").await.unwrap();
        assert!(page(&db, &reader, 50).await.unwrap().is_empty(), "a retraction is an absence");
    }

    /// The seam the object key exists for. A re-published edge is the SAME fact restated, so it
    /// collapses; two of your posts being shared are two facts, and collapsing them would
    /// silently drop one - the reader would be told about the first share and never the second.
    #[tokio::test]
    async fn shares_are_per_document_where_edges_are_per_person() {
        let db = crate::db::test_node_db().await;
        let me = "aa".repeat(32);
        let sharer = "bb".repeat(32);
        let (first, second) = ("11".repeat(16), "22".repeat(16));

        upsert_row(&db, &me, &sharer, KIND_REBROADCAST, &first, None, None, None, 1000)
            .await
            .unwrap();
        upsert_row(&db, &me, &sharer, KIND_REBROADCAST, &second, None, None, None, 2000)
            .await
            .unwrap();
        assert_eq!(
            page(&db, &me, 50).await.unwrap().len(),
            2,
            "two documents shared is two pieces of news"
        );

        // The same document again (they re-shared after an edit) still collapses.
        upsert_row(&db, &me, &sharer, KIND_REBROADCAST, &first, None, None, None, 3000)
            .await
            .unwrap();
        let rows = page(&db, &me, 50).await.unwrap();
        assert_eq!(rows.len(), 2, "re-sharing one document updates its row");
        assert_eq!(rows[0].doc_id, first, "and moves it to the top");
        assert_eq!(rows[0].updated_ms, 3000);

        // And an edge from the same person is a third, independent row - the kinds do not
        // collide even though the author is the same.
        upsert_row(&db, &me, &sharer, KIND_PUBLIC_EDGE, "", None, Some("high"), None, 4000)
            .await
            .unwrap();
        assert_eq!(page(&db, &me, 50).await.unwrap().len(), 3);

        // Un-sharing one leaves the other standing.
        delete_row(&db, &me, &sharer, KIND_REBROADCAST, &first)
            .await
            .unwrap();
        let rows = page(&db, &me, 50).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.doc_id == second));
    }

    #[tokio::test]
    async fn pages_are_per_reader_newest_first() {
        let db = crate::db::test_node_db().await;
        let me = "aa".repeat(32);
        let housemate = "cc".repeat(32);

        upsert_row(&db, &me, &"b1".repeat(32), KIND_PUBLIC_EDGE, "", None, Some("low"), None, 100).await.unwrap();
        upsert_row(&db, &me, &"b2".repeat(32), KIND_PUBLIC_EDGE, "", Some("high"), None, None, 300).await.unwrap();
        upsert_row(&db, &housemate, &"b3".repeat(32), KIND_PUBLIC_EDGE, "", None, Some("max"), None, 200).await.unwrap();

        let mine = page(&db, &me, 50).await.unwrap();
        assert_eq!(
            mine.iter().map(|r| r.updated_ms).collect::<Vec<_>>(),
            vec![300, 100],
            "newest first, and the housemate's rows are not mine"
        );
    }
}
