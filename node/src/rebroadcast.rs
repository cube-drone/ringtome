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
//! ## What the pin is FOR, which is not what it looks like
//!
//! The obvious reading is "keep a copy so we can serve it", and that is half of it. The other
//! half is the half that matters: **a pin is what keeps the author's retraction reachable.** A
//! copy nobody refreshes is a copy that can never learn it was withdrawn - which is precisely the
//! permanence full-copy rebroadcast would have handed out for free, arriving by the back door. So
//! the pin's real job is to hold the author in the sync worklist, past the moment every contact
//! dial pointing at them goes back to nothing, for as long as the share stands.
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
    // Only a persona this node HOSTS can oblige it. A foreign identity's shares are their own
    // node's business - fronting on their say-so would be push, and the policy forbids it.
    if !crate::identity::is_agented(&state.node_db, sharer_root)
        .await
        .unwrap_or(false)
    {
        return Ok(());
    }

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

    for row in pointers {
        // A withdrawn share drops its pin in the same pass that folds the retraction. This is
        // the whole "speech deletes" half of the design: stop sharing and this node stops
        // carrying, without anyone having to sweep for it later.
        if row.is_retracted() {
            unpin(&state.node_db, sharer_root, &row.author_root, &row.doc_id).await?;
        } else {
            pin(&state.node_db, sharer_root, &row).await?;
        }
    }
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

/// Every foreign identity this node must keep refreshing because one of its personas shares a
/// document of theirs - the sync worklist's third source, beside interest and rebroadcast
/// interest (`net::subscriptions::followed_foreign`).
///
/// Deliberately NOT deduplicated against the subscription dials here: the caller unions them,
/// and a pinned author who is also followed simply appears once with the stronger eagerness.
pub async fn pinned_authors(node_db: &Db) -> Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> = node_db
        .fetch_all(
            "SELECT DISTINCT author_root, holder_root FROM rebroadcast_pins",
            (),
        )
        .await
        .context("listing pinned rebroadcast authors")?;
    Ok(rows)
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

    /// **The property the whole pin exists for.** A share must keep its author in the sync
    /// worklist on its own, without any contact dial - because a copy nobody refreshes is a
    /// copy that can never learn it was retracted, which is exactly the permanence that
    /// pointer-plus-replica refuses to hand out.
    #[tokio::test]
    async fn a_share_keeps_its_author_synced_with_no_dial_at_all() {
        let db = node_db().await;
        let alice = "a".repeat(64);
        let me = "b".repeat(64);

        // No subscriptions row anywhere: nobody here follows Alice.
        assert!(
            crate::net::subscriptions::followed_foreign(&db)
                .await
                .unwrap()
                .is_empty(),
            "precondition: an unfollowed author is not synced"
        );

        pin(&db, &me, &row(&alice, [1u8; 16], Some([9u8; 32])))
            .await
            .unwrap();

        let synced = crate::net::subscriptions::followed_foreign(&db).await.unwrap();
        assert_eq!(
            synced,
            vec![(alice.clone(), me.clone(), 1)],
            "a share alone is reason enough to keep fetching them"
        );

        // Withdraw it, and the obligation goes with it - "speech deletes", from the other side.
        unpin(&db, &me, &alice, &[1u8; 16]).await.unwrap();
        assert!(
            crate::net::subscriptions::followed_foreign(&db)
                .await
                .unwrap()
                .is_empty(),
            "un-sharing stops this node carrying them"
        );
    }

    /// One pin per document, so sharing two of someone's posts does not enter them twice in the
    /// worklist - and un-sharing one leaves the other's obligation standing.
    #[tokio::test]
    async fn pins_are_per_document_and_the_author_survives_until_the_last_one_goes() {
        let db = node_db().await;
        let alice = "a".repeat(64);
        let me = "b".repeat(64);

        pin(&db, &me, &row(&alice, [1u8; 16], Some([9u8; 32]))).await.unwrap();
        pin(&db, &me, &row(&alice, [2u8; 16], Some([8u8; 32]))).await.unwrap();
        assert_eq!(
            crate::net::subscriptions::followed_foreign(&db).await.unwrap().len(),
            1,
            "two shares of one author are one entry in the worklist"
        );

        unpin(&db, &me, &alice, &[1u8; 16]).await.unwrap();
        assert_eq!(
            crate::net::subscriptions::followed_foreign(&db).await.unwrap().len(),
            1,
            "the other share still obliges us"
        );
        unpin(&db, &me, &alice, &[2u8; 16]).await.unwrap();
        assert!(crate::net::subscriptions::followed_foreign(&db).await.unwrap().is_empty());
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
