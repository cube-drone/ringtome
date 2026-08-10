//! The outbox: envelopes this node owes to strangers, and the patience to deliver them.
//!
//! When a persona publishes an edge naming someone, that fact reaches the subject one of two
//! ways (PROJECT_PLAN, Arrival and Attention). If the subject follows the author, their node
//! is already syncing the author's chains and derives it locally - nothing to send. If they do
//! not, the only way it reaches them is an envelope handed to one of their nodes.
//!
//! **The sender cannot tell which case it is**, and should not try: whether the subject syncs
//! you is a fact only the subject's node holds. So the rule is *always queue, let the recipient
//! decide* - their gate discards a redundant notice and answers "accepted", because from the
//! sender's side the job is done either way. Guessing here would mean either missing people
//! (silently, forever) or asking strangers questions about their own follow lists.
//!
//! Durable, because delivery is best-effort against machines that are mostly asleep: the
//! ledger is a node.db table with an exponential backoff ladder, swept on a beat, exactly the
//! shape `net::bodies` uses for missing blobs. A notice that cannot land inside its relevance
//! window expires quietly, which is correct behaviour for a store whose charter is "recent,
//! relevant, forgettable".

use anyhow::{anyhow, Context, Result};
use ringtome_proto::deliver::{notice_kind, Envelope, SignedEnvelope};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Payload, SignedEntry, SigningKey};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// Rows per delivery sweep. A politeness budget, not a throughput target: publishing a
/// three-hundred-contact ledger for the first time should trickle out over minutes rather than
/// dialing three hundred strangers in one breath (PROJECT_PLAN calls this "backfill is the
/// burst to bound").
const SWEEP_DIAL_CAP: usize = 8;

/// After this long unlanded, a notice stops being news. Give up and forget it.
const GIVE_UP_MS: i64 = 3 * 24 * 60 * 60 * 1000;

/// How long a row rests after `tries` failed attempts: 30s doubling to a one-hour ceiling.
/// Pure, so the ladder is testable without a clock (the `net::bodies` discipline).
fn backoff_ms(tries: i64) -> i64 {
    let capped = tries.clamp(0, 7) as u32;
    (30_000i64 << capped).min(3_600_000)
}

/// Is a row worth another attempt now? Never-tried rows are always due.
fn due(tries: i64, last_tried_ms: i64, now: i64) -> bool {
    last_tried_ms == 0 || last_tried_ms + backoff_ms(tries) <= now
}

/// Has this notice stopped being news?
fn expired(first_noted_ms: i64, now: i64) -> bool {
    now.saturating_sub(first_noted_ms) > GIVE_UP_MS
}

/// Build the signed envelope announcing `evidence` (a `public-edge` entry) to its subject.
///
/// The authorization path is assembled from the author's own identity chain: the `authorize`
/// entries from the root down to the signing leaf, root first. That is what lets a total
/// stranger verify "this leaf speaks for this root" from the envelope alone, with no fetch
/// (`deliver::verify_claim`).
pub async fn seal_notice(
    db: &Db,
    signer: &SigningKey,
    root: &[u8; 32],
    recipient_root: &[u8; 32],
    evidence: &SignedEntry,
) -> Result<SignedEnvelope> {
    let signer_pub = signer.verifying_key().to_bytes();
    let envelope = Envelope {
        sender_root: *root,
        signer: signer_pub,
        recipient_root: *recipient_root,
        kind: notice_kind::PUBLIC_EDGE,
        auth_path: auth_path(db, root, &signer_pub).await?,
        evidence: Some(evidence.bytes().to_vec()),
        greeting: None,
        // The dial rests at zero and a price is only ever quoted by a node under flood; when
        // reject-with-price exists, this is the slot the retry fills in.
        stamp: None,
    };
    SignedEnvelope::create(&envelope, signer).map_err(|e| anyhow!("sealing a notice: {e}"))
}

/// The `authorize` entries from `root` down to `leaf`, root first. Empty when the root signs
/// for itself, which is what a single-node persona's founding key does.
async fn auth_path(db: &Db, root: &[u8; 32], leaf: &[u8; 32]) -> Result<Vec<Vec<u8>>> {
    if root == leaf {
        return Ok(Vec::new());
    }
    // child -> (its authorizing parent, the entry's exact bytes). One pass over a chain that is
    // tiny by design (a key tree's design center is a handful of keys).
    let mut by_child: std::collections::HashMap<[u8; 32], ([u8; 32], Vec<u8>)> =
        std::collections::HashMap::new();
    for signed in crate::record::imaol::entries_of_type(
        db,
        service::IDENTITY_PUBLIC,
        entry_type::AUTHORIZE,
    )
    .await
    .map_err(|e| anyhow!("{e}"))?
    {
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(authorization) = ringtome_proto::Authorize::decode(payload) else {
            continue;
        };
        by_child.insert(
            authorization.child,
            (signed.entry().chain.author, signed.bytes().to_vec()),
        );
    }

    // Walk up from the leaf, then reverse: the verifier reads root-first.
    let mut path: Vec<Vec<u8>> = Vec::new();
    let mut cursor = *leaf;
    while cursor != *root {
        let Some((parent, bytes)) = by_child.get(&cursor) else {
            return Err(anyhow!(
                "no authorization path from {} to {}",
                hex::encode(root),
                hex::encode(leaf)
            ));
        };
        path.push(bytes.clone());
        cursor = *parent;
        if path.len() > ringtome_proto::deliver::MAX_AUTH_PATH {
            return Err(anyhow!("authorization path is implausibly deep"));
        }
    }
    path.reverse();
    Ok(path)
}

/// Queue one envelope for delivery. Collapses per (sender, recipient, kind): a re-published
/// edge replaces whatever was waiting, because only the newest statement is worth delivering.
pub async fn queue(
    node_db: &Db,
    sender_root: &str,
    recipient_root: &str,
    envelope: &SignedEnvelope,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO outbound_notices
               (sender_root, recipient_root, kind, envelope, first_noted_ms, last_tried_ms, tries)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, 0)
             ON CONFLICT (sender_root, recipient_root, kind) DO UPDATE SET
                 envelope = excluded.envelope,
                 first_noted_ms = excluded.first_noted_ms,
                 last_tried_ms = 0,
                 tries = 0",
            (
                sender_root,
                recipient_root,
                notice_kind::name(notice_kind::PUBLIC_EDGE),
                envelope.bytes(),
                now_ms(),
            ),
        )
        .await
        .context("queueing an outbound notice")?;
    Ok(())
}

async fn retire(node_db: &Db, sender_root: &str, recipient_root: &str, kind: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM outbound_notices
             WHERE sender_root = ?1 AND recipient_root = ?2 AND kind = ?3",
            (sender_root, recipient_root, kind),
        )
        .await
        .context("retiring an outbound notice")?;
    Ok(())
}

async fn mark_tried(node_db: &Db, sender_root: &str, recipient_root: &str, kind: &str) -> Result<()> {
    node_db
        .execute(
            "UPDATE outbound_notices SET tries = tries + 1, last_tried_ms = ?4
             WHERE sender_root = ?1 AND recipient_root = ?2 AND kind = ?3",
            (sender_root, recipient_root, kind, now_ms()),
        )
        .await
        .context("advancing the delivery backoff")?;
    Ok(())
}

/// One pass of the rounds: take the due envelopes, knock once each, and retire whatever landed
/// or was refused. Only "nobody answered" earns another turn on the ladder.
pub async fn sweep(state: AppState) -> Result<()> {
    /// `(sender, recipient, kind, envelope, first_noted_ms, last_tried_ms, tries)`.
    type Row = (String, String, String, Vec<u8>, i64, i64, i64);
    let rows: Vec<Row> = state
        .node_db
        .fetch_all(
            "SELECT sender_root, recipient_root, kind, envelope, first_noted_ms, last_tried_ms, tries
             FROM outbound_notices ORDER BY first_noted_ms",
            (),
        )
        .await
        .context("reading the outbound ledger")?;
    let now = now_ms();
    let mut dialed = 0usize;
    for (sender, recipient, kind, envelope, first_noted, last_tried, tries) in rows {
        if expired(first_noted, now) {
            tracing::info!(
                sender = %sender, recipient = %recipient,
                "an undeliverable notice expired - the fact survives on the chain, only the knock is lost"
            );
            retire(&state.node_db, &sender, &recipient, &kind).await?;
            continue;
        }
        if !due(tries, last_tried, now) {
            continue;
        }
        if dialed >= SWEEP_DIAL_CAP {
            break;
        }
        dialed += 1;
        match crate::net::deliver::deliver(&state, &recipient, &envelope).await {
            crate::net::deliver::Outcome::Accepted => {
                retire(&state.node_db, &sender, &recipient, &kind).await?;
            }
            crate::net::deliver::Outcome::Refused(reason) => {
                // A refusal is an answer. Retrying it is what a spammer does, and the doctrine
                // takes the one-bit leak precisely so the sender can stop.
                tracing::info!(
                    sender = %sender, recipient = %recipient,
                    reason = %ringtome_proto::deliver::refusal::name(reason),
                    "a notice was refused"
                );
                retire(&state.node_db, &sender, &recipient, &kind).await?;
            }
            crate::net::deliver::Outcome::Unreachable => {
                mark_tried(&state.node_db, &sender, &recipient, &kind).await?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_backoff_ladder_climbs_and_then_stops() {
        assert_eq!(backoff_ms(0), 30_000);
        assert_eq!(backoff_ms(1), 60_000);
        assert_eq!(backoff_ms(7), 3_600_000, "the ceiling is one hour");
        assert_eq!(backoff_ms(9000), 3_600_000, "and it stays there");
    }

    #[test]
    fn a_fresh_row_is_due_immediately() {
        assert!(due(0, 0, 1_000_000), "never tried is always due");
        assert!(!due(0, 1_000_000, 1_000_001), "just tried, not yet");
        assert!(due(0, 1_000_000, 1_000_000 + 30_000));
    }

    #[test]
    fn news_stops_being_news() {
        let noted = 1_000_000_000;
        assert!(!expired(noted, noted + GIVE_UP_MS - 1));
        assert!(expired(noted, noted + GIVE_UP_MS + 1));
    }

    #[tokio::test]
    async fn a_root_signing_for_itself_needs_no_path() {
        let db = crate::db::test_user_db().await;
        let root = [4u8; 32];
        assert!(auth_path(&db, &root, &root).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_unreachable_leaf_is_an_error_not_an_empty_path() {
        // An empty path CLAIMS the root signed for itself. Returning one for a leaf we cannot
        // actually chain to would mint an envelope that every recipient refuses - better to
        // fail here, where the reason is visible.
        let db = crate::db::test_user_db().await;
        assert!(auth_path(&db, &[4u8; 32], &[5u8; 32]).await.is_err());
    }
}
