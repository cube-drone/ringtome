//! Rebroadcast: the node-side half of a share.
//!
//! A share is two things (PROJECT_PLAN, Rebroadcast: Pointer Plus Pinned Replica). The **pointer**
//! is a signed entry on the sharer's own chain and lives in `record::imaol`; this module is the
//! **pin** - the obligation that pointer creates for the node hosting the sharer.
//!
//! ## The pin is a demand signal, not a favour
//!
//! *Pull, Not Push* (Doctrine) says a node fronts an identity because someone accountable on that
//! node asked for it, never because the identity asked. A share is exactly that ask, made by a
//! local persona who is answerable for it - so fronting the shared author is the policy working
//! as written, and bounded operator liability holds: the node carries what its own users chose to
//! carry, and no more.
//!
//! ## What the pin is FOR (corrected 2026-08-11)
//!
//! It records that a persona here SHARES this document, so the node knows to keep a copy of it
//! fresh. That is all. It used to do more, and the more was wrong: pins fed the subscription
//! worklist, so every share pulled the author's entire chain. Ten thousand shares of one post
//! meant ten thousand full subscriptions to its author, and - worse - it made the share graph a
//! STAR, where every sharer went straight to the author and no node ever relayed. Deletion could
//! then travel exactly two hops, `fragments::relayable` was unreachable, and a four-hop cascade
//! was not constructible at all.
//!
//! Reachability never needed a subscription: asking the author whether one document still lives
//! is a single round trip on the fragment ALPN. Revalidation now asks the author first and the
//! sharer second (`net::fragment::revalidate`) - authority where it is reachable, resilience
//! where it is not - and the tree the design always described is the one that runs.
//!
//! Retract the share and the pin goes with it, on the same fold.

use anyhow::{Context, Result};

use crate::db::Db;
use crate::AppState;

/// Re-fold one sharer's rebroadcast pointers into this node's pins.
///
/// Best-effort at every call site, the memo way: a missed pass is caught by the next frontier
/// move or sweep, so this logs rather than erroring.
pub async fn refresh_from(state: &AppState, sharer_root: &str) {
    if let Err(e) = refresh_from_inner(state, sharer_root).await {
        tracing::debug!(sharer = %sharer_root, error = ?e, "rebroadcast pin fold failed");
    }
}

async fn refresh_from_inner(state: &AppState, sharer_root: &str) -> Result<()> {
    // The cheap gate first (the notifications-fold discipline): this hook fires on every public
    // frontier move, and almost nobody has a rebroadcast chain, so ask the chain-heads memo -
    // one node.db probe - before paying for a user-database open.
    if !crate::net::frontier::has_service_chain(
        &state.node_db,
        sharer_root,
        ringtome_proto::registry::service::REBROADCASTS,
    )
    .await?
    {
        return Ok(());
    }
    tracing::debug!(sharer = %sharer_root, "rebroadcast fold: this identity has a share chain");
    let Some(db) = state
        .user_dbs
        .get(sharer_root)
        .await
        .context("opening the sharer's database")?
    else {
        return Ok(());
    };
    let pointers = crate::record::imaol::rebroadcasts(&db)
        .await
        .map_err(|e| anyhow::anyhow!("folding {sharer_root}'s rebroadcasts: {e}"))?;
    drop(db);
    if pointers.is_empty() {
        return Ok(());
    }

    // **Two acts, two audiences, and they need different gates** (split 2026-08-10, after one
    // guard was found doing both jobs and getting the second one wrong).
    //
    // PINNING is an obligation this node takes on: it fronts a stranger's document because one
    // of ITS OWN personas asked. Hosted-only is correct and load-bearing - fronting on a foreign
    // persona's say-so would be push, and *Pull, Not Push* forbids it.
    //
    // JOURNALING is not an obligation, it is delivery: writing a row into a local reader's feed
    // because that reader follows the sharer for exactly this. It must happen for FOREIGN
    // sharers - that is the whole normal case, a reader on one node following a sharer on
    // another - and gating it on hosting made a synced share do nothing at all, which is the
    // bug this split fixes.
    if crate::identity::is_agented(&state.node_db, sharer_root)
        .await
        .unwrap_or(false)
    {
        for row in &pointers {
            // A withdrawn share drops its pin in the same pass that folds the retraction. This
            // is the "speech deletes" half: stop sharing and this node stops carrying, without
            // anyone having to sweep for it later.
            if row.is_retracted() {
                unpin(&state.node_db, sharer_root, &row.author_root, &row.doc_id).await?;
            } else {
                pin(&state.node_db, sharer_root, row).await?;
            }
        }
    }

    // The same "speech deletes" half for the feed's CROWD, outside the hosted gate on purpose:
    // the people in a reader's "and four others" are mostly on other computers, so a withdrawal
    // has to shrink the crowd whether or not this node hosts the person withdrawing.
    for row in pointers.iter().filter(|r| r.is_retracted()) {
        crate::fanout::forget_sharer(
            &state.node_db,
            sharer_root,
            &row.author_root,
            &hex::encode(row.doc_id),
        )
        .await?;
    }

    crate::fanout::journal_shares_by(state, sharer_root, &pointers).await;
    Ok(())
}

async fn pin(
    node_db: &Db,
    holder_root: &str,
    row: &crate::record::imaol::RebroadcastRow,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO rebroadcast_pins
               (holder_root, author_root, doc_id, version_seen, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (holder_root, author_root, doc_id) DO UPDATE SET
                 version_seen = excluded.version_seen,
                 updated_ms = excluded.updated_ms",
            (
                holder_root,
                row.author_root.as_str(),
                hex::encode(row.doc_id),
                row.version_seen.map(hex::encode),
                row.received_at_ms,
            ),
        )
        .await
        .context("pinning a rebroadcast author")?;
    Ok(())
}

async fn unpin(
    node_db: &Db,
    holder_root: &str,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM rebroadcast_pins
             WHERE holder_root = ?1 AND author_root = ?2 AND doc_id = ?3",
            (holder_root, author_root, hex::encode(doc_id)),
        )
        .await
        .context("dropping a rebroadcast pin")?;
    Ok(())
}

/// Drop every pin a persona holds - the counterpart to `excise_unfollowed`, for the case where
/// the persona itself leaves this node. Their shares stop obliging a node that no longer
/// answers for them.
pub async fn forget_holder(node_db: &Db, holder_root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM rebroadcast_pins WHERE holder_root = ?1",
            (holder_root,),
        )
        .await
        .context("dropping a departing persona's pins")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn node_db() -> Db {
        crate::db::test_node_db().await
    }

    fn row(author: &str, doc: [u8; 16], version: Option<[u8; 32]>) -> crate::record::imaol::RebroadcastRow {
        crate::record::imaol::RebroadcastRow {
            author_root: author.to_string(),
            doc_id: doc,
            version_seen: version,
            received_at_ms: 1,
        }
    }

    /// **The inverse of what this test used to say**, and the correction is the point. It once
    /// asserted that a share alone puts the author in the sync worklist - which was true, and
    /// wrong: it made every share a full chain subscription, so ten thousand shares of one post
    /// meant ten thousand nodes pulling that author's entire history. Worse, it made the share
    /// graph a star, where nobody ever relays, and deletion could travel exactly two hops.
    ///
    /// Sharing now obliges a COPY, not a subscription. Reachability comes from asking the author
    /// one question on the fragment ALPN, which costs a round trip rather than a history.
    #[tokio::test]
    async fn a_share_does_not_subscribe_you_to_the_author() {
        let db = node_db().await;
        let alice = "a".repeat(64);
        let me = "b".repeat(64);

        pin(&db, &me, &row(&alice, [1u8; 16], Some([9u8; 32])))
            .await
            .unwrap();

        assert!(
            crate::net::subscriptions::followed_foreign(&db)
                .await
                .unwrap()
                .is_empty(),
            "a share must never become a chain subscription - that is the fan-out this whole \
             design refuses, arriving through the door marked accountable"
        );

        // But the node does record that it shares the document, because it owes a fresh copy.
        let (pins,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM rebroadcast_pins", ())
            .await
            .unwrap();
        assert_eq!(pins, 1, "the obligation is to the DOCUMENT, and it is recorded");
    }

    /// Pins are per document, so sharing two posts by one author records two obligations and
    /// un-sharing one leaves the other standing.
    #[tokio::test]
    async fn pins_are_per_document() {
        let db = node_db().await;
        let alice = "a".repeat(64);
        let me = "b".repeat(64);

        pin(&db, &me, &row(&alice, [1u8; 16], Some([9u8; 32]))).await.unwrap();
        pin(&db, &me, &row(&alice, [2u8; 16], Some([8u8; 32]))).await.unwrap();
        let (n,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM rebroadcast_pins", ())
            .await
            .unwrap();
        assert_eq!(n, 2);

        unpin(&db, &me, &alice, &[1u8; 16]).await.unwrap();
        let (n,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM rebroadcast_pins", ())
            .await
            .unwrap();
        assert_eq!(n, 1, "the other share still obliges us");
    }

    /// A persona leaving takes its obligations with it.
    #[tokio::test]
    async fn a_departing_persona_stops_obliging_the_node() {
        let db = node_db().await;
        let me = "b".repeat(64);
        pin(&db, &me, &row(&"a".repeat(64), [1u8; 16], Some([9u8; 32]))).await.unwrap();
        forget_holder(&db, &me).await.unwrap();
        assert!(crate::net::subscriptions::followed_foreign(&db).await.unwrap().is_empty());
    }
}
