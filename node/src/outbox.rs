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
use ringtome_proto::pow;
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
    kind: u32,
    price_bits: u32,
) -> Result<SignedEnvelope> {
    let signer_pub = signer.verifying_key().to_bytes();
    let mut envelope = Envelope {
        sender_root: *root,
        signer: signer_pub,
        recipient_root: *recipient_root,
        kind,
        auth_path: auth_path(db, root, &signer_pub).await?,
        evidence: Some(evidence.bytes().to_vec()),
        greeting: None,
        stamp: None,
        // What we call ourselves publicly, so a stranger's door can render a name rather than a
        // hash. Read from our OWN published profile rather than taken as a parameter: there is
        // exactly one honest answer to "what is this persona called", and letting a caller pass
        // a different one is how a per-recipient name becomes possible by accident.
        display_name: published_name(db).await,
    };
    // **Stamp, then sign, in that order.** The challenge is the body with the stamp field
    // absent, and the signature covers the body with it present - so the work binds every
    // other field (recipient included, which is what makes a stamp untransferable) and the
    // signature then binds the work. Reversing these two lines produces envelopes that
    // verify as signatures and fail as stamps, which is a confusing way to lose every notice.
    if price_bits > 0 {
        envelope.stamp = Some(solve_blocking(envelope.challenge(), price_bits).await?);
    }
    SignedEnvelope::create(&envelope, signer).map_err(|e| anyhow!("sealing a notice: {e}"))
}

/// This persona's published display name, capped to what an envelope may carry.
///
/// Best-effort and quiet: a notice with no name is worse-looking but perfectly valid, and a
/// profile read failing must never stop a notice going out.
async fn published_name(db: &Db) -> Option<String> {
    let fields = crate::record::imaol::get_profile(db).await.ok()?;
    let name = fields
        .into_iter()
        .find(|f| f.field == "name")
        .map(|f| f.value)?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    // Truncated on a CHARACTER boundary, not a byte one: the cap is in bytes, and slicing a
    // multi-byte name mid-codepoint would panic on the way to telling someone who followed them.
    let mut out = String::new();
    for c in name.chars() {
        if out.len() + c.len_utf8() > ringtome_proto::deliver::MAX_DISPLAY_NAME_LEN {
            break;
        }
        out.push(c);
    }
    Some(out)
}

/// Pay the price off the reactor.
///
/// [`pow::solve`] is a tight CPU loop for tens of milliseconds by design. Awaiting it inline
/// would park every other task on this thread for the duration - and the whole point of a price
/// this small is that it runs on the ordinary path, every time, not in some rare corner where a
/// stall would go unnoticed.
async fn solve_blocking(challenge: [u8; 32], bits: u32) -> Result<Vec<u8>> {
    tokio::task::spawn_blocking(move || pow::solve(&challenge, bits))
        .await
        .context("joining the stamp solver")
}

/// The `authorize` entries from `root` down to `leaf`, root first. Empty when the root signs
/// for itself, which is what a single-node persona's founding key does.
pub(crate) async fn auth_path_from(
    db: &Db,
    root: &[u8; 32],
    leaf: &[u8; 32],
) -> Result<Vec<Vec<u8>>> {
    auth_path(db, root, leaf).await
}

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
                notice_kind::name(envelope.envelope().kind),
                envelope.bytes(),
                now_ms(),
            ),
        )
        .await
        .context("queueing an outbound notice")?;
    Ok(())
}

/// Does this envelope already carry a stamp that clears `bits`? Cheap - one hash - and the
/// difference between answering a re-quote and being farmed by one.
fn already_paid(envelope: &[u8], bits: u32) -> bool {
    let Ok(signed) = SignedEnvelope::decode(envelope) else {
        return false;
    };
    let plain = signed.envelope();
    pow::verify(
        &plain.challenge(),
        plain.stamp.as_deref().unwrap_or_default(),
        bits,
    )
    .is_ok()
}

/// Re-stamp a queued envelope at a newly quoted price and re-sign it.
///
/// Works from the stored bytes alone rather than from the persona's store: everything the
/// envelope needs is already inside it, and `Envelope::challenge` strips whatever stamp is
/// there before hashing, so a re-stamp of an already-stamped envelope is the same operation as
/// a first stamp. The only thing that must be fetched is the signing leaf - and it must be the
/// same leaf the envelope names, which `SignedEnvelope::create` enforces rather than trusts.
async fn restamp(state: &AppState, envelope: &[u8], bits: u32) -> Result<Vec<u8>> {
    // The one place a price arrives from OUTSIDE this node, so the one place willingness has to
    // be checked. A door asking more than we think a notice is worth gets a shrug, not our CPU.
    let willing = state.config.pow_willing_bits;
    if bits > willing {
        return Err(anyhow!(
            "a door wants {bits} bits; this node pays at most {willing}"
        ));
    }
    let signed = SignedEnvelope::decode(envelope).map_err(|e| anyhow!("{e}"))?;
    let mut plain = signed.envelope().clone();
    let sender_hex = hex::encode(plain.sender_root);
    let leaf = crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, &sender_hex)
        .await
        .map_err(|e| anyhow!("{e}"))?
        .ok_or_else(|| anyhow!("this node no longer holds a leaf for {sender_hex}"))?;
    plain.stamp = Some(solve_blocking(plain.challenge(), bits).await?);
    Ok(SignedEnvelope::create(&plain, &leaf)
        .map_err(|e| anyhow!("re-sealing a stamped notice: {e}"))?
        .bytes()
        .to_vec())
}

/// Swap in a re-stamped envelope, advancing the try count. Deliberately NOT `queue`, which
/// resets the ladder to zero: paying a price is a retry, not a fresh knock, and a door that
/// quotes a new price on every attempt must not be able to hold a sender in a loop that never
/// ages out.
async fn replace_envelope(
    node_db: &Db,
    sender_root: &str,
    recipient_root: &str,
    kind: &str,
    envelope: &[u8],
) -> Result<()> {
    node_db
        .execute(
            "UPDATE outbound_notices SET envelope = ?4, last_tried_ms = ?5, tries = tries + 1
             WHERE sender_root = ?1 AND recipient_root = ?2 AND kind = ?3",
            (sender_root, recipient_root, kind, envelope, now_ms()),
        )
        .await
        .context("replacing a queued notice with its stamped form")?;
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

/// Zero the knock backoff - the test beat's "knock again NOW" (test_endpoints).
pub(crate) async fn force_due(node_db: &Db) -> Result<()> {
    node_db
        .execute("UPDATE outbound_notices SET last_tried_ms = 0", ())
        .await?;
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
            crate::net::deliver::Outcome::NeedsStamp(bits) if already_paid(&envelope, bits) => {
                // **The door is lying.** We hold a stamp that clears the price it just quoted,
                // so solving again would produce the identical nonce (the challenge is the same
                // body, and `solve` is deterministic) and be rejected the identical way. A door
                // that can make a sender re-grind on demand is a CPU amplifier pointed at
                // everyone who follows it; refusing to pay twice for the same quote is what
                // takes that away, and it costs an honest door nothing because an honest door
                // does not do this.
                //
                // Treated as unreachable rather than refused: a buggy door should not be able
                // to destroy a notice permanently, and the backoff ladder plus the three-day
                // expiry already bound how long we keep asking. The point is that we stop
                // paying, not that we stop trying.
                tracing::warn!(
                    sender = %sender, recipient = %recipient, bits,
                    "a door re-quoted a price this envelope already pays - not grinding again"
                );
                mark_tried(&state.node_db, &sender, &recipient, &kind).await?;
            }
            crate::net::deliver::Outcome::NeedsStamp(bits) => {
                // Price discovery, completed: the door quoted, we pay. The re-stamped envelope
                // replaces the queued one so the work is not repeated on every sweep, and the
                // try count advances so a door that keeps raising its price meets the backoff
                // ladder rather than an infinite grind.
                match restamp(&state, &envelope, bits).await {
                    Ok(paid) => {
                        tracing::info!(
                            sender = %sender, recipient = %recipient, bits,
                            "a door quoted a price; re-stamped and requeued"
                        );
                        replace_envelope(&state.node_db, &sender, &recipient, &kind, &paid).await?;
                    }
                    Err(e) => {
                        // Above the ceiling, or a leaf we can no longer load. Either way this
                        // node cannot pay, and pretending otherwise burns CPU forever.
                        tracing::warn!(
                            sender = %sender, recipient = %recipient, bits, error = ?e,
                            "cannot pay a quoted price - retiring the knock"
                        );
                        retire(&state.node_db, &sender, &recipient, &kind).await?;
                    }
                }
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
