//! The inbox: notices delivered by people the recipient does not sync.
//!
//! This is the **delivered** half of Arrival and Attention (PROJECT_PLAN). Its twin is
//! `notifications.rs`, the derived half, and the split is the whole design: where a follow-edge
//! exists, evidence travels by pull and the fold derives a row locally; where none exists,
//! evidence travels by envelope and is transcribed here, under quota.
//!
//! ## Strangers cannot write your chains - they can only induce your node to
//!
//! Single-writer is foundational, so the flow is: a stranger *delivers* to one of your nodes
//! (`net::deliver`); that node applies **The Inbound Gate** ([`accept`]); and if it passes,
//! **your node transcribes** - appending a notice to one of its inbox chains, encrypted under
//! your epoch key, signed by its own leaf. The gate therefore runs at **transcription, not
//! delivery**, and everything it does exists to bound the blast radius of a mistake to a few
//! kilobytes in a bounded pool.
//!
//! The envelope is stored **verbatim** inside the encryption, so your *other* nodes re-run
//! `deliver::verify_claim` themselves rather than trusting whichever node answered the door.
//!
//! ## Two chains, one list
//!
//! Notices land on [`service::INBOX_TRUSTED`] or [`service::INBOX_STRANGER`] - two chains so
//! that retention and sync depth are per-chain policy rather than per-row bookkeeping - and
//! fold into one view collapsed per (sender, kind), so the tier seam is invisible to a reader
//! and a promoted sender keeps their row.

use anyhow::{anyhow, Context, Result};
use ringtome_proto::deliver::{notice_kind, SignedEnvelope, VerifiedClaim};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{Payload, PrivateRecord, SignedEntry};

use crate::db::Db;
use crate::error::AppError;
use crate::record::private::{self, EpochKeys, Opened};
use crate::AppState;

/// How many stranger-tier notices one persona will hold before the door shuts.
///
/// The pool is sized in ROWS, and rows collapse per (sender, kind), so this is really "how many
/// distinct strangers may be waiting" - a number that should comfortably exceed any real
/// person's unanswered-doorbell count and stay far below what a flood wants.
pub const STRANGER_POOL_CAP: i64 = 256;

/// Which chain a notice lands on. The pre-Trust classifier (PROJECT_PLAN, the degenerate
/// classifier): a recorded relationship earns the trusted tier, everyone else waits in the
/// stranger pool. When the flow computation ships it replaces this function and nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Trusted,
    Stranger,
}

impl Tier {
    fn service(self) -> u32 {
        match self {
            Self::Trusted => service::INBOX_TRUSTED,
            Self::Stranger => service::INBOX_STRANGER,
        }
    }
}

/// What the gate did with an envelope. Note that **discarding is a success**: a notice from
/// someone the recipient already syncs is redundant by the follow-edge rule, and the sender's
/// job is done - telling them "refused" would be a lie that provokes a pointless retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Written to an inbox chain (or already there - transcription is idempotent).
    Transcribed,
    /// Correctly dropped: the recipient already pulls this sender's chains.
    AlreadyPulled,
    /// The gate said no. Deliberately one verdict for blocked and over-quota alike.
    Refused,
}

/// One notice, as a reader sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Notice {
    pub sender_root: String,
    pub kind: String,
    pub trust: Option<String>,
    pub interest: Option<String>,
    /// The transcribing node's claimed time - the recipient's own clock, not the sender's.
    pub timestamp_ms: i64,
    /// Which tier chain the winning notice sits on.
    pub service: u32,
}

/// The ledger keys the gate consults (mirroring `js/pure/contact.js`).
const BLOCKED: &str = "blocked";
const TRUST: &str = "trust";
const INTEREST: &str = "interest";

/// Run the gate over one delivered envelope and, if it passes, transcribe it.
///
/// ## Check order, and where it departs from the written one
///
/// Doctrine orders the gate cheapest-first with "floor and mute" leading, on the assumption
/// that a mute is a local lookup. In this codebase it is not: `blocked` is an LWW register on
/// the persona's epoch-encrypted ledger, deliberately never projected into node.db ("a block
/// stays home"), so reading it costs a keystore open and an epoch unseal. The order below
/// keeps the *principle* - never pay for a check until the cheaper ones have passed - while
/// putting the expensive one where it actually belongs:
///
/// 1. do we serve this persona at all (node.db);
/// 2. does the recipient already pull this sender (node.db) - the follow-edge rule;
/// 3. is the envelope well-formed, correctly signed, with evidence that names this recipient
///    (pure CPU, no IO, and the caller has already applied the size cap at decode);
/// 4. open the persona's credentials - which transcription needs anyway, so a passing notice
///    pays nothing extra and only a blocked sender wastes the open;
/// 5. blocked? refuse;
/// 6. classify the tier and, for a stranger who has no row yet, check the pool;
/// 7. transcribe.
pub async fn accept(
    state: &AppState,
    recipient_root: &str,
    signed: &SignedEnvelope,
    claim: &VerifiedClaim,
) -> Result<Verdict> {
    let sender_hex = hex::encode(claim.sender_root);

    // (2) The follow-edge rule, enforced HERE because only the recipient can know it: an
    // envelope from someone whose chains we already sync would be a second surface for a fact
    // the pull path owns. The sender cannot check this and should not try.
    if crate::net::subscriptions::follows(&state.node_db, recipient_root, &sender_hex).await? {
        return Ok(Verdict::AlreadyPulled);
    }

    // (4) The persona's own write credentials, session-free (the `ingest.rs` pattern): a peer
    // handler has no logged-in account, and does not need one - a node writes for a persona it
    // agents.
    let leaf = crate::identity::load_node_leaf_key(&state.node_db, &state.keystore, recipient_root)
        .await
        .map_err(|e| anyhow!("{e}"))?
        .ok_or_else(|| anyhow!("this node does not agent {recipient_root}"))?;
    let leaf_pub = leaf.verifying_key().to_bytes();
    let enc = private::load_enc_keypair(&state.keystore, &hex::encode(leaf_pub))
        .map_err(|e| anyhow!("{e}"))?;
    let db = state.user_dbs.held(recipient_root).await?;
    let keys = private::unseal_epoch_keys(&db, &leaf_pub, &enc)
        .await
        .map_err(|e| anyhow!("{e}"))?;
    let (epoch, epoch_key) = keys
        .current()
        .ok_or_else(|| anyhow!("{recipient_root} has no epoch key to seal a notice under"))?;

    // (5) and (6): the recipient's own ledger decides both questions, and one collection read
    // answers them together.
    let facts = contact_facts(&db, &keys, &sender_hex).await?;
    if facts_say_blocked(&facts) {
        return Ok(Verdict::Refused);
    }
    let tier = classify(&facts);

    // Idempotence: the same envelope delivered twice - or to a sibling node, then synced here -
    // is already this notice. Transcribing again would be a second chain entry saying the same
    // thing.
    catch_up(&db, &keys).await?;
    let kind = notice_kind::name(claim.kind).to_string();
    let held = held_envelope(&db, &sender_hex, &kind).await?;
    if held.as_deref() == Some(signed.bytes()) {
        return Ok(Verdict::Transcribed);
    }

    // The pool bounds how many DISTINCT strangers may be waiting, so a sender who already has
    // a row is updating it rather than taking a new slot, and a full pool must not freeze the
    // news they already sent.
    if tier == Tier::Stranger && held.is_none() && stranger_rows(&db).await? >= STRANGER_POOL_CAP
    {
        // Refuse before signing: a chain append is permanent, and garbage must die at the
        // network edge. (The doctrine's ring-buffer eviction - newest wins, oldest stranger
        // leaves - needs chain pruning, which does not exist yet; see the residual noted in
        // HISTORY. Until then a full pool is a closed door rather than a rotating one.)
        tracing::info!(
            recipient = %recipient_root,
            sender = %sender_hex,
            "stranger inbox pool is full; refusing a notice"
        );
        return Ok(Verdict::Refused);
    }

    // (7) Transcribe: the envelope verbatim, sealed under the persona's epoch key, signed by
    // this node's own leaf. The sender never writes the chain - nobody but the persona can.
    let record = private::encrypt_notice(epoch, &epoch_key, signed.bytes())
        .map_err(|e| anyhow!("{e}"))?;
    let payload = record
        .encode()
        .map_err(|e| anyhow!("encoding a notice record: {e}"))?;
    crate::record::imaol::append(
        &db,
        &leaf,
        tier.service(),
        entry_type::INBOX_NOTICE,
        Payload::Inline(payload),
    )
    .await
    .map_err(|e| anyhow!("{e}"))?;

    // Fold our own write immediately, so the reader sees it without waiting for a read to
    // catch up (and so the quota count above is honest on the next delivery).
    catch_up(&db, &keys).await?;
    Ok(Verdict::Transcribed)
}

/// One contact's ledger facts, read straight from the encrypted registers. This is what
/// `Store::contacts` does for the whole roster; the gate wants exactly one collection, so it
/// seeks instead of scanning.
async fn contact_facts(
    db: &Db,
    keys: &EpochKeys,
    sender_hex: &str,
) -> Result<std::collections::BTreeMap<String, String>> {
    let collection = format!("contact:{sender_hex}");
    let (rows, _) =
        private::collection_registers(db, keys, service::GENERAL_PRIVATE, &collection)
            .await
            .map_err(|e| anyhow!("{e}"))?;
    Ok(rows.into_iter().map(|r| (r.key, r.value)).collect())
}

fn facts_say_blocked(facts: &std::collections::BTreeMap<String, String>) -> bool {
    facts.get(BLOCKED).map(String::as_str) == Some("yes")
}

/// The pre-Trust classifier: any recorded relationship - a trust band or an interest band -
/// puts a sender in the trusted tier. Everyone else is a stranger. When the flow computation
/// arrives this becomes "clears my floor", and nothing around it changes.
fn classify(facts: &std::collections::BTreeMap<String, String>) -> Tier {
    let has = |k: &str| facts.get(k).is_some_and(|v| !v.is_empty() && v != "none");
    if has(TRUST) || has(INTEREST) {
        Tier::Trusted
    } else {
        Tier::Stranger
    }
}

async fn held_envelope(db: &Db, sender_hex: &str, kind: &str) -> Result<Option<Vec<u8>>> {
    let row: Option<(Vec<u8>,)> = db
        .fetch_optional(
            "SELECT envelope FROM inbox_notices WHERE sender_root = ?1 AND kind = ?2",
            (sender_hex, kind),
        )
        .await
        .context("reading a held notice")?;
    Ok(row.map(|(bytes,)| bytes))
}

async fn stranger_rows(db: &Db) -> Result<i64> {
    let row: Option<(i64,)> = db
        .fetch_optional(
            "SELECT COUNT(*) FROM inbox_notices WHERE service = ?1",
            (i64::from(service::INBOX_STRANGER),),
        )
        .await
        .context("counting the stranger pool")?;
    Ok(row.map(|(n,)| n).unwrap_or(0))
}

/// Fold both inbox chains into the view: decrypt each notice, **re-verify it from scratch**,
/// and upsert under the LWW stamp.
///
/// Re-verification is the point of storing the envelope verbatim. This node may not be the one
/// that judged the notice - a sibling transcribed it and it arrived by sync - and the doctrine
/// is that evidence crosses wires while opinions stay home. A notice whose claim no longer
/// checks out is skipped, not stored.
pub(crate) async fn catch_up(db: &Db, keys: &EpochKeys) -> Result<()> {
    for service_id in [service::INBOX_TRUSTED, service::INBOX_STRANGER] {
        let entries =
            crate::record::imaol::entries_past_watermarks(db, service_id, entry_type::INBOX_NOTICE)
                .await
                .map_err(|e| anyhow!("{e}"))?;
        // Per author, stop advancing the watermark at the first entry we cannot open: an epoch
        // key may still arrive by adoption resealing (the stall rule, record::private).
        let mut stalled: std::collections::HashSet<String> = std::collections::HashSet::new();
        let mut advance: std::collections::BTreeMap<String, u64> =
            std::collections::BTreeMap::new();
        for signed in entries {
            let author = hex::encode(signed.entry().chain.author);
            if stalled.contains(&author) {
                continue;
            }
            match fold_notice(db, service_id, &signed, keys).await? {
                Folded::Done => {
                    advance.insert(author, signed.entry().seq);
                }
                Folded::Stall => {
                    stalled.insert(author);
                }
            }
        }
        for (author, seq) in advance {
            crate::record::imaol::advance_watermark(db, &author, service_id, seq)
                .await
                .map_err(|e| anyhow!("{e}"))?;
        }
    }
    Ok(())
}

enum Folded {
    Done,
    Stall,
}

async fn fold_notice(
    db: &Db,
    service_id: u32,
    signed: &SignedEntry,
    keys: &EpochKeys,
) -> Result<Folded> {
    let Payload::Inline(bytes) = &signed.entry().payload else {
        return Ok(Folded::Done); // structurally impossible from our own writer; skip and pass
    };
    let Ok(record) = PrivateRecord::decode(bytes) else {
        return Ok(Folded::Done);
    };
    let envelope_bytes = match private::open_notice(&record, keys) {
        Opened::Plain(bytes) => bytes,
        Opened::NoKey => return Ok(Folded::Stall),
        Opened::Garbage => return Ok(Folded::Done),
    };
    // Re-verify from the stored bytes: this node trusts the claim, never the transcriber.
    let Ok(envelope) = SignedEnvelope::decode(&envelope_bytes) else {
        return Ok(Folded::Done);
    };
    let Ok(claim) = ringtome_proto::deliver::verify_claim(&envelope) else {
        return Ok(Folded::Done);
    };

    db.execute(
        "INSERT INTO inbox_notices
           (sender_root, kind, service, envelope, trust, interest, timestamp_ms, seq, entry_hash)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(sender_root, kind) DO UPDATE SET
           service = excluded.service,
           envelope = excluded.envelope,
           trust = excluded.trust,
           interest = excluded.interest,
           timestamp_ms = excluded.timestamp_ms,
           seq = excluded.seq,
           entry_hash = excluded.entry_hash
         WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
             > (inbox_notices.timestamp_ms, inbox_notices.seq, inbox_notices.entry_hash)",
        (
            hex::encode(claim.sender_root),
            notice_kind::name(claim.kind),
            i64::from(service_id),
            envelope_bytes.as_slice(),
            claim.trust.as_deref(),
            claim.interest.as_deref(),
            signed.entry().timestamp_ms,
            signed.entry().seq as i64,
            signed.hash().as_slice(),
        ),
    )
    .await
    .context("folding an inbox notice")?;
    Ok(Folded::Done)
}

/// The reader's notices, newest first. Catches up first: like every private view in this
/// codebase, the fold happens on read, because sync ingest deliberately holds no epoch keys.
pub async fn page(db: &Db, keys: &EpochKeys, limit: u32) -> Result<Vec<Notice>, AppError> {
    catch_up(db, keys).await.map_err(AppError::Internal)?;
    /// `(sender_root, kind, trust, interest, timestamp_ms, service)`.
    type Row = (String, String, Option<String>, Option<String>, i64, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT sender_root, kind, trust, interest, timestamp_ms, service FROM inbox_notices
             ORDER BY timestamp_ms DESC LIMIT ?1",
            (i64::from(limit),),
        )
        .await
        .context("reading the inbox")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(
            |(sender_root, kind, trust, interest, timestamp_ms, service)| Notice {
                sender_root,
                kind,
                trust,
                interest,
                timestamp_ms,
                service: service as u32,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn a_recorded_relationship_earns_the_trusted_tier() {
        assert_eq!(classify(&facts(&[("interest", "low")])), Tier::Trusted);
        assert_eq!(classify(&facts(&[("trust", "medium")])), Tier::Trusted);
    }

    #[test]
    fn an_unknown_sender_waits_in_the_stranger_pool() {
        assert_eq!(classify(&facts(&[])), Tier::Stranger);
        assert_eq!(
            classify(&facts(&[("nickname", "Bee")])),
            Tier::Stranger,
            "a name is not a relationship"
        );
        assert_eq!(
            classify(&facts(&[("interest", "none"), ("trust", "none")])),
            Tier::Stranger,
            "dials turned to their bottom stop are an opinion, but not a welcome"
        );
        assert_eq!(classify(&facts(&[("interest", "")])), Tier::Stranger);
    }

    #[test]
    fn a_block_is_the_word_yes() {
        assert!(facts_say_blocked(&facts(&[("blocked", "yes")])));
        assert!(!facts_say_blocked(&facts(&[("blocked", "no")])));
        assert!(!facts_say_blocked(&facts(&[])));
    }

    #[test]
    fn the_tiers_are_two_distinct_chains() {
        assert_ne!(Tier::Trusted.service(), Tier::Stranger.service());
        // Both must be gated as private, or an inbox syncs to strangers.
        assert!(crate::net::sync::is_private_service(Tier::Trusted.service()));
        assert!(crate::net::sync::is_private_service(Tier::Stranger.service()));
    }
}
