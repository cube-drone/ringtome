//! The node's IM-AOL storage: appending signed entries to per-identity chains and materializing
//! views from them.
//!
//! The `entries` table in each per-user DB is the local copy of the signed log - the author's
//! exact bytes, one row per entry. Everything else in that DB is a *view*: rebuildable at any
//! time by replaying and re-validating the log (`rebuild_views`), which is the disposability
//! promise the per-user databases are built on. In M3 the entries table is also exactly what
//! replicates between nodes; nothing in this module may trust a row without re-validating it.

use crate::db::Db;
use crate::error::AppError;
use crate::pubkey;
use anyhow::{anyhow, Context};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{
    ChainId, Entry, Payload, ProfileSet, PublicEdge, SignedEntry, SigningKey, ENTRY_VERSION,
    ZERO_HASH,
};
use std::collections::BTreeMap;

/// The stored head of one chain: highest seq, that entry's hash, and its claimed timestamp.
async fn chain_head(
    db: &Db,
    author_hex: &str,
    service_id: u32,
) -> Result<Option<(u64, [u8; 32], i64)>, AppError> {
    let row: Option<(i64, Vec<u8>, i64)> = db
        .fetch_optional(
            "SELECT seq, entry_hash, timestamp_ms FROM entries
         WHERE author_pubkey = ?1 AND service = ?2
         ORDER BY seq DESC LIMIT 1",
            (author_hex, i64::from(service_id)),
        )
        .await
        .context("reading chain head")
        .map_err(AppError::Internal)?;

    match row {
        None => Ok(None),
        Some((seq, hash, timestamp_ms)) => {
            let hash: [u8; 32] = hash
                .try_into()
                .map_err(|_| AppError::Internal(anyhow!("corrupt entry_hash at chain head")))?;
            Ok(Some((seq as u64, hash, timestamp_ms)))
        }
    }
}

/// Append one entry to this key's (service) chain: derive seq and prev_hash from the stored
/// head, sign, store the exact envelope bytes.
pub async fn append(
    db: &Db,
    key: &SigningKey,
    service_id: u32,
    type_id: u32,
    payload: Payload,
) -> Result<SignedEntry, AppError> {
    let author = key.verifying_key().to_bytes();
    let author_hex = hex::encode(author);

    // Everything from here to the insert is one read-then-write: the seq comes from the chain
    // head, and nobody else may take that seq in between. Held for the signing too, which is
    // cheap next to the two statements it sits between and keeps the guard's scope equal to
    // the invariant's (db.rs, `lock_append`).
    let _appending = db.lock_append().await;

    // A revoked key may read its era; it may not speak. The check is the local tree's own
    // verdict about the SIGNER, at the one place every locally-authored entry passes -
    // without it, a revoked node keeps writing entries the network refuses and its own next
    // sweep evicts, a silent read-only limbo (field-found 2026-07-30; the farewell flow rides
    // this refusal). Unknown stays allowed on purpose: genesis and a just-adopted leaf both
    // write before the local tree can know them. Only an explicit revocation refuses.
    if let Some(root_hex) = db.root() {
        use ringtome_proto::crown::KeyStatus;
        let tree = load_key_tree(db, root_hex).await?;
        match tree.status(&author) {
            KeyStatus::Retired | KeyStatus::Repudiated | KeyStatus::Invalid => {
                return Err(AppError::RevokedSigner(crate::msg!("record.imaol.this-computers-key-is-no", "this computer's key is no longer part of the persona")));
            }
            KeyStatus::Active | KeyStatus::Unknown => {}
        }
    }

    // Ephemeral services (the inbox tiers) take a different durability deal end to end: their
    // cargo skips the journal, and the one fact that must survive a database catastrophe -
    // where this chain ENDED - lives in the flat-file checkpoint instead (record::heads).
    let ephemeral = crate::net::sync::service_allows_suffix(service_id);

    let (seq, prev_hash, head_claim_ms) = match chain_head(db, &author_hex, service_id).await? {
        Some((head_seq, head_hash, head_ts)) => (head_seq + 1, head_hash, head_ts),
        // The database has no head. For a durable chain that means genesis; for an ephemeral
        // one it might instead mean a REBUILT database (inbox chains were never journaled, so
        // replay could not restore them) - and minting a genesis then would fork this chain
        // against every sibling still holding the old one. The checkpoint remembers: continue
        // from its head, producing a chain whose missing prefix is exactly the shape suffix
        // admission already forgives. Claimed-time clamp restarts at 0, which the max(now)
        // below handles like any cold chain.
        None => match db.ephemeral_head(&author_hex, service_id).filter(|_| ephemeral) {
            Some((ckpt_seq, ckpt_hash)) => (ckpt_seq + 1, ckpt_hash, 0),
            None => (0, ZERO_HASH, 0),
        },
    };

    let entry = Entry {
        v: ENTRY_VERSION,
        entry_type: type_id,
        chain: ChainId {
            author,
            service: service_id,
        },
        seq,
        prev_hash,
        // The authoring clamp: our own chain's claimed time never goes backwards, so one write
        // from a fast clock can't out-LWW every later, correctly-stamped write - equal stamps
        // fall through to seq, which is true authoring order (PROJECT_PLAN, Displayed Time vs.
        // Claimed Time).
        timestamp_ms: crate::clock::now_ms().max(head_claim_ms),
        payload,
    };
    let signed = SignedEntry::create(&entry, key)
        .map_err(|e| AppError::Internal(anyhow!("signing entry: {e}")))?;

    // Write-ahead, one of two ways. Durable chains: the journal frame lands (fsynced) before
    // the row does, so journal ⊇ database survives a crash between the two (record::journal);
    // if the seq race below then loses, the loser's frame stays behind - a dead sibling
    // replay's validation gate has to arbitrate. Ephemeral chains: the CHECKPOINT lands first
    // instead - same order, different artifact - and the crash between it and the insert
    // leaves the file ahead by one, which is the phantom-gap shape suffix admission forgives
    // (record::heads has the full asymmetry argument). The cargo itself is deliberately not
    // journaled: notices are forgettable by charter, and journaling a flood's worth of them
    // forever was the one unbounded artifact a stranger could still grow.
    if ephemeral {
        db.checkpoint_ephemeral_head(&author_hex, service_id, seq, signed.hash())
            .context("checkpointing an ephemeral head")
            .map_err(AppError::Internal)?;
    } else {
        db.journal_append(signed.bytes())
            .context("journaling entry")
            .map_err(AppError::Internal)?;
    }

    // Two concurrent appends to one chain race to the same seq; the (author, service, seq)
    // primary key makes the loser fail loudly instead of forking the chain.
    db.execute(
        "INSERT INTO entries
           (author_pubkey, service, seq, entry_hash, prev_hash, entry_type, timestamp_ms,
            received_at_ms, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        (
            author_hex.as_str(),
            i64::from(service_id),
            seq as i64,
            signed.hash().as_slice(),
            signed.entry().prev_hash.as_slice(),
            i64::from(type_id),
            signed.entry().timestamp_ms,
            crate::clock::now_ms(),
            signed.bytes(),
        ),
    )
    .await
    .context("storing entry")
    .map_err(AppError::Internal)?;

    // The chain-heads memo, fed at the source: this signer just became the tip of its chain,
    // and the fact is in hand - re-deriving it later means reopening this encrypted file.
    if let (Some(memo), Some(root)) = (db.memo(), db.root()) {
        if let Err(e) = crate::net::frontier::note_head(
            memo,
            root,
            &author_hex,
            service_id,
            seq,
            signed.hash(),
        )
        .await
        {
            tracing::debug!(error = ?e, "noting a chain head failed (sweep reconciles)");
        }
    }

    // Every locally-signed write rings the eager-sync bell (this function is the one funnel:
    // only local writes sign; sync-received entries take the gate path and deliberately ride
    // the lazy tick instead - the relay damping, see net::resync).
    db.nudge_sync();

    Ok(signed)
}

/// Set one field of the identity's public profile: append a `profile-set` entry, then fold it
/// into the materialized view.
pub async fn set_profile_field(
    db: &Db,
    key: &SigningKey,
    field: &str,
    value: &str,
) -> Result<SignedEntry, AppError> {
    let payload = ProfileSet {
        field: field.to_string(),
        value: value.to_string(),
    }
    .encode()
    .map_err(|e| AppError::BadRequest(crate::msg!("record.imaol.invalid-profile-field-e", "invalid profile field: {e}", e = e)))?;

    let signed = append(
        db,
        key,
        service::PROFILE_PUBLIC,
        entry_type::PROFILE_SET,
        Payload::Inline(payload),
    )
    .await?;
    apply_profile_set(db, &signed).await?;
    Ok(signed)
}

/// Publish one relationship's consented bands about a subject: append a `public-edge` entry to
/// this key's follows-public chain. LWW per subject makes the newest statement the published
/// relationship; a statement with no bands is the retraction. WHEN to publish or retract is
/// publish.rs's judgment - this is only the pen.
pub async fn publish_public_edge(
    db: &Db,
    key: &SigningKey,
    subject: &[u8; 32],
    trust: Option<String>,
    interest: Option<String>,
) -> Result<SignedEntry, AppError> {
    let payload = PublicEdge {
        subject: *subject,
        trust,
        interest,
    }
    .encode()
    .map_err(|e| AppError::Internal(anyhow!("encoding public-edge: {e}")))?;
    append(
        db,
        key,
        service::FOLLOWS_PUBLIC,
        entry_type::PUBLIC_EDGE,
        Payload::Inline(payload),
    )
    .await
}

/// Share (or withdraw) one document of someone else's: a signed pointer on this persona's own
/// rebroadcast chain (PROJECT_PLAN, Rebroadcast: Pointer Plus Pinned Replica).
///
/// `version` is the head the sharer saw; `None` withdraws. Nothing about the document's content
/// is copied - and there is nowhere here to put it if a caller wanted to, which is deliberate.
pub async fn publish_rebroadcast(
    db: &Db,
    key: &SigningKey,
    author: &[u8; 32],
    doc_id: &[u8; 16],
    version: Option<[u8; 32]>,
) -> Result<SignedEntry, AppError> {
    let payload = ringtome_proto::Rebroadcast {
        author: *author,
        doc_id: *doc_id,
        version,
    }
    .encode();
    append(
        db,
        key,
        service::REBROADCASTS,
        entry_type::REBROADCAST,
        Payload::Inline(payload),
    )
    .await
}

/// One subject's published relationship, as folded from the chains. Empty (both bands absent)
/// means the newest statement was a retraction - readers treat it as "nothing published".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PublishedEdge {
    pub trust: Option<String>,
    pub interest: Option<String>,
}

impl PublishedEdge {
    pub fn is_empty(&self) -> bool {
        self.trust.is_none() && self.interest.is_none()
    }
}

/// The LWW stamp every fold in this codebase orders by: claimed timestamp, then seq, then
/// entry hash - the total order The Ordering Contract specifies, spelled once here because
/// `imaol` is where that contract lives (`record::private` and the folds below all use it).
pub(crate) type Stamp = (i64, u64, [u8; 32]);

/// A folded statement with this replica's arrival stamp for the winning entry - local, unsigned,
/// never synced (Displayed Time vs. Claimed Time's receipt bound). The notifications memo orders
/// by it because arrival here is what "new" honestly means on this node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedRow {
    pub edge: PublishedEdge,
    pub received_at_ms: i64,
}

/// The published relationships: the latest `public-edge` per subject across every key's
/// follows-public chain in this database, LWW on the standard stamp.
///
/// Memo-backed (2026-08-09, replacing a full-chain replay per call): the fold below advances
/// by watermark and writes the `published_edges` view, and this read never folds more than
/// what arrived since it last looked. The replay version was fine while "these chains are
/// tiny" was true, and public-by-default repealed that premise the same day it was written -
/// every dial turn while visible appends a statement, the fold's cost was O(publication
/// history) forever, and it sat on two hot paths (publish::reconcile per ledger refresh,
/// notifications::refresh_from per frontier move). The Data Layer's own rule, applied at
/// last: the fold writes a memo, and reads never fold.
pub async fn published_edges(db: &Db) -> Result<BTreeMap<String, PublishedRow>, AppError> {
    catch_up_published_edges(db).await?;
    type Row = (String, Option<String>, Option<String>, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT subject_root, trust, interest, received_at_ms FROM published_edges",
            (),
        )
        .await
        .context("reading the published-edges view")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(|(subject, trust, interest, received_at_ms)| {
            (
                subject,
                PublishedRow {
                    edge: PublishedEdge { trust, interest },
                    received_at_ms,
                },
            )
        })
        .collect())
}

/// Fold new `public-edge` entries into the view. Keyless (the chain is public), so garbage is
/// skipped and nothing ever stalls a watermark - the fold enforces nothing, because chain
/// admission is signatures and hashes only, and a future band word must not wedge anything.
/// Retractions fold to a row with both bands NULL rather than a delete: the row is the LWW
/// tombstone that keeps a resurrected older statement from winning, and readers already treat
/// an empty edge as "nothing published".
async fn catch_up_published_edges(db: &Db) -> Result<(), AppError> {
    type Row = (String, Vec<u8>, i64, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT e.author_pubkey, e.bytes, e.received_at_ms, e.seq
             FROM entries e
             LEFT JOIN view_watermarks w
               ON w.author_pubkey = e.author_pubkey AND w.service = e.service
             WHERE e.service = ?1 AND e.entry_type = ?2
               AND e.seq > COALESCE(w.folded_seq, -1)
             ORDER BY e.author_pubkey, e.seq",
            (
                i64::from(service::FOLLOWS_PUBLIC),
                i64::from(entry_type::PUBLIC_EDGE),
            ),
        )
        .await
        .context("reading public-edge entries past the watermark")
        .map_err(AppError::Internal)?;
    if rows.is_empty() {
        return Ok(());
    }

    let mut advance: BTreeMap<String, u64> = BTreeMap::new();
    for (author_hex, bytes, received_at_ms, seq) in rows {
        advance.insert(author_hex, seq as u64);
        let Ok(signed) = SignedEntry::decode(&bytes) else {
            continue;
        };
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(edge) = PublicEdge::decode(payload) else {
            continue;
        };
        // The apply_profile_set discipline: compare-and-write is one atomic statement, so
        // concurrent catch-ups and rebuild replays interleave benignly.
        db.execute(
            "INSERT INTO published_edges
               (subject_root, trust, interest, timestamp_ms, seq, entry_hash, received_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(subject_root) DO UPDATE SET
               trust = excluded.trust,
               interest = excluded.interest,
               timestamp_ms = excluded.timestamp_ms,
               seq = excluded.seq,
               entry_hash = excluded.entry_hash,
               received_at_ms = excluded.received_at_ms
             WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
                 > (published_edges.timestamp_ms, published_edges.seq, published_edges.entry_hash)",
            (
                hex::encode(edge.subject),
                edge.trust.as_deref(),
                edge.interest.as_deref(),
                signed.entry().timestamp_ms,
                signed.entry().seq as i64,
                signed.hash().as_slice(),
                received_at_ms,
            ),
        )
        .await
        .context("folding a published edge")
        .map_err(AppError::Internal)?;
    }
    for (author_hex, seq) in advance {
        advance_watermark(db, &author_hex, service::FOLLOWS_PUBLIC, seq).await?;
    }
    Ok(())
}

/// One rebroadcast as a reader sees it: a pointer, plus what it endorsed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RebroadcastRow {
    /// The ORIGINAL author's root, hex. Never the rebroadcaster - that is the chain's author.
    pub author_root: String,
    pub doc_id: [u8; 16],
    /// The version endorsed at share time. `None` is a folded retraction: the pointer was
    /// withdrawn, and the row survives only as the LWW tombstone.
    pub version_seen: Option<[u8; 32]>,
    pub received_at_ms: i64,
}

impl RebroadcastRow {
    /// A withdrawn share. Readers show nothing for these; the row exists so a resurrected older
    /// pointer cannot win the LWW comparison.
    pub fn is_retracted(&self) -> bool {
        self.version_seen.is_none()
    }
}

/// Everything this persona has rebroadcast: the latest pointer per `(author, doc_id)` across
/// every key's rebroadcast chain, LWW on the standard stamp.
///
/// Memo-backed from birth rather than after the fact - the full-chain audit's rule applied
/// before it could be broken, since a prolific rebroadcaster's chain grows without bound and
/// this read sits behind the feed.
pub async fn rebroadcasts(db: &Db) -> Result<Vec<RebroadcastRow>, AppError> {
    catch_up_rebroadcasts(db).await?;
    type Row = (String, Vec<u8>, Option<Vec<u8>>, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT author_root, doc_id, version_seen, received_at_ms FROM rebroadcasts
             ORDER BY received_at_ms DESC",
            (),
        )
        .await
        .context("reading the rebroadcasts view")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|(author_root, doc_id, version_seen, received_at_ms)| {
            Some(RebroadcastRow {
                author_root,
                doc_id: doc_id.try_into().ok()?,
                version_seen: match version_seen {
                    None => None,
                    Some(v) => Some(v.try_into().ok()?),
                },
                received_at_ms,
            })
        })
        .collect())
}

/// Fold new `rebroadcast` entries into the view. Keyless (the chain is public), so garbage is
/// skipped and nothing ever stalls a watermark - the `catch_up_published_edges` discipline, for
/// the same reason: chain admission is signatures and hashes only, and a payload this fold
/// cannot read must never wedge it.
///
/// A retraction folds to a row with `version_seen` NULL rather than a delete, so a resurrected
/// older pointer cannot win by arriving late.
async fn catch_up_rebroadcasts(db: &Db) -> Result<(), AppError> {
    type Row = (String, Vec<u8>, i64, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT e.author_pubkey, e.bytes, e.received_at_ms, e.seq
             FROM entries e
             LEFT JOIN view_watermarks w
               ON w.author_pubkey = e.author_pubkey AND w.service = e.service
             WHERE e.service = ?1 AND e.entry_type = ?2
               AND e.seq > COALESCE(w.folded_seq, -1)
             ORDER BY e.author_pubkey, e.seq",
            (
                i64::from(service::REBROADCASTS),
                i64::from(entry_type::REBROADCAST),
            ),
        )
        .await
        .context("reading rebroadcast entries past the watermark")
        .map_err(AppError::Internal)?;
    if rows.is_empty() {
        return Ok(());
    }

    let mut advance: BTreeMap<String, u64> = BTreeMap::new();
    for (author_hex, bytes, received_at_ms, seq) in rows {
        advance.insert(author_hex, seq as u64);
        let Ok(signed) = SignedEntry::decode(&bytes) else {
            continue;
        };
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(pointer) = ringtome_proto::Rebroadcast::decode(payload) else {
            continue;
        };
        db.execute(
            "INSERT INTO rebroadcasts
               (author_root, doc_id, version_seen, timestamp_ms, seq, entry_hash, received_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(author_root, doc_id) DO UPDATE SET
               version_seen = excluded.version_seen,
               timestamp_ms = excluded.timestamp_ms,
               seq = excluded.seq,
               entry_hash = excluded.entry_hash,
               received_at_ms = excluded.received_at_ms
             WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
                 > (rebroadcasts.timestamp_ms, rebroadcasts.seq, rebroadcasts.entry_hash)",
            (
                hex::encode(pointer.author),
                pointer.doc_id.as_slice(),
                pointer.version.as_ref().map(|v| v.as_slice()),
                signed.entry().timestamp_ms,
                signed.entry().seq as i64,
                signed.hash().as_slice(),
                received_at_ms,
            ),
        )
        .await
        .context("folding a rebroadcast")
        .map_err(AppError::Internal)?;
    }
    for (author_hex, seq) in advance {
        advance_watermark(db, &author_hex, service::REBROADCASTS, seq).await?;
    }
    Ok(())
}

/// State one public annotation (ANNOTATIONS.md slice 1): `target` carries `key = value`,
/// or with `present` false no longer does. LWW per (target, key, value) - restating
/// overwrites, never stacks.
pub async fn publish_annotation(
    db: &Db,
    key: &SigningKey,
    annotation: &ringtome_proto::PublicAnnotation,
) -> Result<SignedEntry, AppError> {
    let payload = annotation.encode().map_err(|_| {
        AppError::BadRequest(crate::msg!(
            "record.imaol.annotation-too-long",
            "that label is too long to state - a tag is 32 characters at most, anything else 1024"
        ))
    })?;
    append(
        db,
        key,
        service::ANNOTATIONS_PUBLIC,
        entry_type::PUBLIC_ANNOTATION,
        Payload::Inline(payload),
    )
    .await
}

/// One folded annotation statement, as a reader sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnnotationRow {
    pub target_author: String,
    pub target_doc: [u8; 16],
    pub key: String,
    pub value: String,
    pub present: bool,
    pub received_at_ms: i64,
}

/// Every statement this speaker has folded, retractions as tombstones - the annotations
/// memo's source (ANNOTATIONS.md slice 2), filtered by stamp at the caller.
pub async fn public_annotations(db: &Db) -> Result<Vec<AnnotationRow>, AppError> {
    catch_up_annotations(db).await?;
    type Row = (String, Vec<u8>, String, String, i64, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT target_author, target_doc, key, value, present, received_at_ms
             FROM public_annotations ORDER BY received_at_ms, seq",
            (),
        )
        .await
        .context("reading the public annotations view")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|(target_author, doc, key, value, present, received_at_ms)| {
            Some(AnnotationRow {
                target_author,
                target_doc: doc.try_into().ok()?,
                key,
                value,
                present: present != 0,
                received_at_ms,
            })
        })
        .collect())
}

/// The signed entry behind one PRESENT statement, for serving as a proof (ANNOTATIONS.md
/// slice 3): the stored hash resolves through the entries log, so the bytes are the
/// annotator's own, byte for byte.
pub async fn annotation_entry(
    db: &Db,
    target_author: &str,
    target_doc: &[u8; 16],
    key: &str,
    value: &str,
) -> Result<Option<SignedEntry>, AppError> {
    let row: Option<(Vec<u8>, i64)> = db
        .fetch_optional(
            "SELECT entry_hash, present FROM public_annotations
             WHERE target_author = ?1 AND target_doc = ?2 AND key = ?3 AND value = ?4",
            (target_author, target_doc.as_slice(), key, value),
        )
        .await
        .context("reading an annotation's entry hash")
        .map_err(AppError::Internal)?;
    let Some((hash, present)) = row else {
        return Ok(None);
    };
    if present == 0 {
        return Ok(None);
    }
    let Ok(hash) = <[u8; 32]>::try_from(hash.as_slice()) else {
        return Ok(None);
    };
    entry_by_hash(db, &hash).await
}

/// The speaker's PRESENT statements about one post, insertion order.
pub async fn annotations_of(
    db: &Db,
    target_author_hex: &str,
    target_doc: &[u8; 16],
) -> Result<Vec<AnnotationRow>, AppError> {
    catch_up_annotations(db).await?;
    Ok(annotation_rows(db, (target_author_hex, target_doc))
        .await?
        .into_iter()
        .filter(|r| r.present)
        .collect())
}

/// The author's PINS (PEEK.md ruling 11): their own present `pin` statements about their
/// own posts, most recently pinned first, capped at the strip's twenty. Only the author's
/// chain is read - anyone else's `pin` is a label, never a placement.
pub async fn pinned_docs(db: &Db, author_hex: &str) -> Result<Vec<[u8; 16]>, AppError> {
    catch_up_annotations(db).await?;
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT target_doc FROM public_annotations
             WHERE target_author = ?1 AND key = 'pin' AND present = 1
             ORDER BY timestamp_ms DESC, seq DESC LIMIT 20",
            (author_hex,),
        )
        .await
        .context("reading the author's pins")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|(d,)| <[u8; 16]>::try_from(d.as_slice()).ok())
        .collect())
}

async fn annotation_rows(
    db: &Db,
    (author, doc): (&str, &[u8; 16]),
) -> Result<Vec<AnnotationRow>, AppError> {
    type Row = (String, Vec<u8>, String, String, i64, i64);
    // One post's statements only, today; the whole-view read arrives with slice 2's memo
    // fold, which is its one consumer.
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT target_author, target_doc, key, value, present, received_at_ms
             FROM public_annotations WHERE target_author = ?1 AND target_doc = ?2
             ORDER BY timestamp_ms, seq",
            (author, doc.as_slice()),
        )
        .await
        .context("reading the public annotations view")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .filter_map(|(target_author, doc, key, value, present, received_at_ms)| {
            Some(AnnotationRow {
                target_author,
                target_doc: doc.try_into().ok()?,
                key,
                value,
                present: present != 0,
                received_at_ms,
            })
        })
        .collect())
}

/// Fold annotation statements past the watermark - `catch_up_rebroadcasts`' twin, keyed
/// four ways instead of two.
async fn catch_up_annotations(db: &Db) -> Result<(), AppError> {
    type Row = (String, Vec<u8>, i64, i64);
    let rows: Vec<Row> = db
        .fetch_all(
            "SELECT e.author_pubkey, e.bytes, e.received_at_ms, e.seq
             FROM entries e
             LEFT JOIN view_watermarks w
               ON w.author_pubkey = e.author_pubkey AND w.service = e.service
             WHERE e.service = ?1 AND e.entry_type = ?2
               AND e.seq > COALESCE(w.folded_seq, -1)
             ORDER BY e.author_pubkey, e.seq",
            (
                i64::from(service::ANNOTATIONS_PUBLIC),
                i64::from(entry_type::PUBLIC_ANNOTATION),
            ),
        )
        .await
        .context("reading annotation entries past the watermark")
        .map_err(AppError::Internal)?;
    if rows.is_empty() {
        return Ok(());
    }
    let mut advance: BTreeMap<String, u64> = BTreeMap::new();
    for (author_hex, bytes, received_at_ms, seq) in rows {
        advance.insert(author_hex, seq as u64);
        let Ok(signed) = SignedEntry::decode(&bytes) else {
            continue;
        };
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(a) = ringtome_proto::PublicAnnotation::decode(payload) else {
            continue;
        };
        db.execute(
            "INSERT INTO public_annotations
               (target_author, target_doc, key, value, present, timestamp_ms, seq, entry_hash, received_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(target_author, target_doc, key, value) DO UPDATE SET
               present = excluded.present,
               timestamp_ms = excluded.timestamp_ms,
               seq = excluded.seq,
               entry_hash = excluded.entry_hash,
               received_at_ms = excluded.received_at_ms
             WHERE (excluded.timestamp_ms, excluded.seq, excluded.entry_hash)
                 > (public_annotations.timestamp_ms, public_annotations.seq, public_annotations.entry_hash)",
            (
                hex::encode(a.target_author),
                a.target_doc.as_slice(),
                a.key.as_str(),
                a.value.as_str(),
                i64::from(a.present),
                signed.entry().timestamp_ms,
                signed.entry().seq as i64,
                signed.hash().as_slice(),
                received_at_ms,
            ),
        )
        .await
        .context("folding an annotation")
        .map_err(AppError::Internal)?;
    }
    for (author_hex, seq) in advance {
        advance_watermark(db, &author_hex, service::ANNOTATIONS_PUBLIC, seq).await?;
    }
    Ok(())
}

/// Drop one chain's rows below `floor_seq` - the retention primitive (PROJECT_PLAN, Tiered
/// inbox chains: "most eviction is aging off the floor"). Returns how many rows left.
///
/// **The head must survive, structurally.** If a chain's newest entry were ever pruned, the
/// next `append` would find no head and mint a genesis at seq 0 - a fork with this chain's own
/// history, which every peer still holding it would (correctly) condemn as equivocation. So
/// the floor is clamped to the stored head: a caller asking to prune everything keeps exactly
/// the head, and a chain with no rows is untouchable. The journal deliberately keeps its dead
/// frames (`journal ⊇ database` is the recovery invariant); replay may resurrect pruned rows,
/// and the retention pass simply prunes them again - policy is idempotent where history is not.
pub async fn prune_chain_below(
    db: &Db,
    author_hex: &str,
    service_id: u32,
    floor_seq: u64,
) -> Result<u64, AppError> {
    let Some((head_seq, _, _)) = chain_head(db, author_hex, service_id).await? else {
        return Ok(0); // no rows, nothing to prune - and nothing to protect
    };
    let floor = floor_seq.min(head_seq);
    let pruned = db
        .execute(
            "DELETE FROM entries
             WHERE author_pubkey = ?1 AND service = ?2 AND seq < ?3",
            (author_hex, i64::from(service_id), floor as i64),
        )
        .await
        .context("pruning a chain prefix")
        .map_err(AppError::Internal)?;
    Ok(pruned)
}

/// How many rows one chain holds. A test instrument (production retention reads
/// [`chain_spans`], one query for the whole service).
#[cfg(test)]
pub(crate) async fn chain_len(
    db: &Db,
    author_hex: &str,
    service_id: u32,
) -> Result<u64, AppError> {
    let row: Option<(i64,)> = db
        .fetch_optional(
            "SELECT COUNT(*) FROM entries WHERE author_pubkey = ?1 AND service = ?2",
            (author_hex, i64::from(service_id)),
        )
        .await
        .context("measuring a chain")
        .map_err(AppError::Internal)?;
    Ok(row.map(|(n,)| n as u64).unwrap_or(0))
}

/// Every chain on one service: author, head seq, and held row count - the retention pass's
/// worklist, one indexed GROUP BY instead of a query per author.
pub async fn chain_spans(
    db: &Db,
    service_id: u32,
) -> Result<Vec<(String, u64, u64)>, AppError> {
    let rows: Vec<(String, i64, i64)> = db
        .fetch_all(
            "SELECT author_pubkey, MAX(seq), COUNT(*) FROM entries
             WHERE service = ?1 GROUP BY author_pubkey",
            (i64::from(service_id),),
        )
        .await
        .context("surveying a service's chains")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(|(author, head, len)| (author, head as u64, len as u64))
        .collect())
}

/// Fold one `profile-set` entry into the view. Last-writer-wins on the tuple
/// `(timestamp_ms, seq, entry_hash)`: claimed timestamps order cross-key writes (cosmetic stakes,
/// convergence is what matters), seq breaks same-chain timestamp ties in true authoring order,
/// and the hash makes the comparison a total order so every replica lands on the same value
/// regardless of replay order.
///
/// The comparison lives *inside* the upsert's WHERE clause, so compare-and-write is one atomic
/// statement. A check-then-act version of this (SELECT the tuple, compare in Rust, then write)
/// has a lost-update window when a rebuild replaying old entries races a live write: both read,
/// both "win," and the old value can land last. Statement-level atomicity closes it - the row is
/// monotone in the tuple no matter how appliers interleave.
pub(crate) async fn apply_profile_set(db: &Db, signed: &SignedEntry) -> Result<(), AppError> {
    let Payload::Inline(bytes) = &signed.entry().payload else {
        return Err(AppError::Internal(anyhow!(
            "profile-set payload must be inline"
        )));
    };
    let ps = ProfileSet::decode(bytes)
        .map_err(|e| AppError::Internal(anyhow!("undecodable profile-set payload: {e}")))?;

    db.execute(
        "INSERT INTO profile_view (field, value, updated_at_ms, seq, entry_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(field) DO UPDATE SET
           value = excluded.value,
           updated_at_ms = excluded.updated_at_ms,
           seq = excluded.seq,
           entry_hash = excluded.entry_hash
         WHERE (excluded.updated_at_ms, excluded.seq, excluded.entry_hash)
             > (profile_view.updated_at_ms, profile_view.seq, profile_view.entry_hash)",
        (
            ps.field.as_str(),
            ps.value.as_str(),
            signed.entry().timestamp_ms,
            signed.entry().seq as i64,
            signed.hash().as_slice(),
        ),
    )
    .await
    .context("updating profile view")
    .map_err(AppError::Internal)?;
    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct ProfileField {
    pub field: String,
    pub value: String,
    pub updated_at_ms: i64,
}

/// The identity's current public profile, as materialized.
pub async fn get_profile(db: &Db) -> Result<Vec<ProfileField>, AppError> {
    let rows: Vec<(String, String, i64)> = db
        .fetch_all(
            "SELECT field, value, updated_at_ms FROM profile_view ORDER BY field",
            (),
        )
        .await
        .context("reading profile view")
        .map_err(AppError::Internal)?;
    Ok(rows
        .into_iter()
        .map(|(field, value, updated_at_ms)| ProfileField {
            field,
            value,
            updated_at_ms,
        })
        .collect())
}

/// Wipe every materialized view and rebuild it by replaying the entries log, re-validating the
/// full chain as it goes: strict decode, signature, dense seqs, hash links. Returns the number of
/// entries replayed. This is the M1 exit demo and the standing proof that the views are caches,
/// not truth.
///
/// The encrypted views (doc versions, private registers/sets) cannot be refolded here - replay
/// has no epoch keys - so for them rebuild is the *drop* half: clearing the tables and their
/// watermarks makes the next keyed read (`documents::materialize`, `private::materialize_service`)
/// refold the whole log. Drop + replay still holds everywhere; the replay is just deferred to
/// the first reader that can decrypt.
/// Every service that can feed a view - the argument that means "drop everything".
fn every_service() -> std::collections::BTreeSet<u32> {
    [
        service::PROFILE_PUBLIC,
        service::POSTS,
        service::FOLLOWS_PUBLIC,
        service::GENERAL_PRIVATE,
        service::DOCUMENTS_PRIVATE,
        service::DOC_META_PRIVATE,
        service::INBOX_TRUSTED,
        service::INBOX_STRANGER,
        service::REBROADCASTS,
    ]
    .into_iter()
    .collect()
}

/// Drop the materialized views that the given services feed, and the watermarks that would
/// otherwise stop them refolding.
///
/// **Which service feeds which view** is the mapping that rots if it lives in anyone's head,
/// so it lives here, once. A service absent from this match feeds no view table (the identity
/// chains: the key tree is computed on demand, never stored).
///
/// Dropping is the whole job. Every view in this codebase refolds itself from a watermark on
/// the next read that wants it (`documents::catch_up`, `private::catch_up`,
/// `catch_up_published_edges`, `inbox::catch_up`) - the one exception is `profile_view`, whose
/// fold happens inline at ingest and therefore has to be replayed by whoever cleared it.
async fn drop_views_fed_by(
    db: &Db,
    services: &std::collections::BTreeSet<u32>,
) -> Result<(), AppError> {
    let touches = |s: u32| services.contains(&s);
    // **A view and its watermarks are dropped together, over every service that feeds it.**
    // Several views are fed by more than one lane - `doc_versions` by the public POSTS lane
    // AND the private one, the private registers by general-private AND doc-meta - and their
    // clears are whole-table. Clearing one of those while resetting only the evicted lane's
    // watermark destroys the OTHER lane's rows and then never refolds them: its watermark
    // still says "already folded", so the content is simply gone until a full rebuild.
    //
    // That is not hypothetical. It shipped in the first cut of this function on 2026-08-10,
    // survived two green CI runs, and was caught by the repudiation-reaches-feeds test, where
    // evicting a device's private chains wiped the public lane's `doc_heads` and the feed
    // retraction then swept an honest post out of its author's own feed as collateral.
    let mut dropped: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();

    if touches(service::PROFILE_PUBLIC) {
        db.execute("DELETE FROM profile_view", ())
            .await
            .context("clearing profile view")
            .map_err(AppError::Internal)?;
        dropped.insert(service::PROFILE_PUBLIC);
    }
    if touches(service::FOLLOWS_PUBLIC) {
        db.execute("DELETE FROM published_edges", ())
            .await
            .context("clearing the published-edges view")
            .map_err(AppError::Internal)?;
        dropped.insert(service::FOLLOWS_PUBLIC);
    }
    if touches(service::POSTS) || touches(service::DOCUMENTS_PRIVATE) {
        crate::record::documents::clear_view(db).await?;
        // Folded from the POSTS chain by the same pass that folds headers, so it drops with
        // them - the invariant this function exists to keep (a view and its watermarks go
        // together over every service that feeds them).
        db.execute("DELETE FROM public_retractions", ())
            .await
            .context("clearing the public-retractions view")
            .map_err(AppError::Internal)?;
        dropped.insert(service::POSTS);
        dropped.insert(service::DOCUMENTS_PRIVATE);
    }
    if touches(service::GENERAL_PRIVATE) || touches(service::DOC_META_PRIVATE) {
        crate::record::private::clear_view(db).await?;
        dropped.insert(service::GENERAL_PRIVATE);
        dropped.insert(service::DOC_META_PRIVATE);
    }
    if touches(service::INBOX_TRUSTED) || touches(service::INBOX_STRANGER) {
        crate::inbox::clear_view(db).await?;
        dropped.insert(service::INBOX_TRUSTED);
        dropped.insert(service::INBOX_STRANGER);
    }
    if touches(service::REBROADCASTS) {
        db.execute("DELETE FROM rebroadcasts", ())
            .await
            .context("clearing the rebroadcasts view")
            .map_err(AppError::Internal)?;
        dropped.insert(service::REBROADCASTS);
    }

    // Exactly the lanes whose rows were just destroyed - so each refolds, and lanes nobody
    // touched keep their progress instead of replaying from genesis.
    for service_id in &dropped {
        db.execute(
            "DELETE FROM view_watermarks WHERE service = ?1",
            (i64::from(*service_id),),
        )
        .await
        .context("clearing view watermarks")
        .map_err(AppError::Internal)?;
    }
    Ok(())
}

/// Views are stale because entries were EVICTED under them (a proven forgery, a revocation's
/// anchored cut) - drop exactly the ones those chains fed, and restore the one view that
/// cannot refold itself.
///
/// This is the ingest path's version of `rebuild_views`, and the difference is the point.
/// `rebuild_views` re-decodes and re-VALIDATES every entry in the log - an ed25519 verification
/// each - which is the right ritual for an operator asking "prove the views are caches", and
/// exactly the wrong thing to hang off a peer-triggered edge: a stranger's revocation would
/// buy a whole-log signature replay (found in the 2026-08-10 full-chain audit). The entries
/// that survive were validated when they were admitted; nothing here needs to re-litigate them.
///
/// The profile replay is bounded by the persona's OWN profile history - a handful of entries,
/// and nothing an attacker can inflate - which is why it is safe to do eagerly.
pub(crate) async fn refold_after_eviction(
    db: &Db,
    services: &std::collections::BTreeSet<u32>,
) -> Result<(), AppError> {
    drop_views_fed_by(db, services).await?;
    if !services.contains(&service::PROFILE_PUBLIC) {
        return Ok(());
    }
    for signed in entries_of_type(db, service::PROFILE_PUBLIC, entry_type::PROFILE_SET).await? {
        apply_profile_set(db, &signed).await?;
    }
    Ok(())
}

pub async fn rebuild_views(db: &Db) -> Result<u64, AppError> {
    drop_views_fed_by(db, &every_service()).await?;

    let rows: Vec<(String, i64, Vec<u8>)> = db
        .fetch_all(
            "SELECT author_pubkey, service, bytes FROM entries ORDER BY author_pubkey, service, seq",
            (),
        )
        .await
        .context("reading entries log")
        .map_err(AppError::Internal)?;

    let mut prev: Option<SignedEntry> = None;
    let mut prev_chain: Option<(String, i64)> = None;
    let mut count = 0u64;

    for (author, svc, bytes) in rows {
        let signed = SignedEntry::decode(&bytes)
            .map_err(|e| AppError::Internal(anyhow!("stored entry fails strict decode: {e}")))?;

        let chain_key = (author, svc);
        let prev_link = if prev_chain.as_ref() == Some(&chain_key) {
            prev.as_ref()
        } else {
            None
        };
        // A chain STARTING above zero is legal exactly where holders prune by policy: the
        // suffix's first entry is validated standalone (signature; its prev_hash is the
        // commitment to the destroyed prefix), and the walk chains forward from it as normal.
        // Everywhere else, a missing genesis is the corruption this replay exists to catch.
        let suffix_start = prev_link.is_none()
            && signed.entry().seq > 0
            && crate::net::sync::service_allows_suffix(signed.entry().chain.service);
        if suffix_start {
            signed
                .verify()
                .map_err(|e| AppError::Internal(anyhow!("stored suffix head fails: {e}")))?;
        } else {
            ringtome_proto::validate_next(prev_link, &signed)
                .map_err(|e| AppError::Internal(anyhow!("stored chain fails validation: {e}")))?;
        }

        if signed.entry().chain.service == service::PROFILE_PUBLIC
            && signed.entry().entry_type == entry_type::PROFILE_SET
        {
            apply_profile_set(db, &signed).await?;
        }

        prev = Some(signed);
        prev_chain = Some(chain_key);
        count += 1;
    }
    Ok(count)
}

#[derive(Debug, serde::Serialize)]
pub struct StoredEntry {
    /// Which device chain wrote it. Free attribution the old whole-log dump never carried,
    /// and the paging cursor needs it anyway - chains are per key, keys are per device.
    pub author: String,
    pub service: u32,
    pub seq: u64,
    pub entry_type: u32,
    pub timestamp_ms: i64,
    /// When this replica first stored the entry - the local upper bound on when it was authored.
    pub received_at_ms: i64,
    pub hash_hex: String,
    pub bytes_hex: String,
}

/// Load and resolve the identity's key tree from its stored identity-public chains. The tree is
/// tiny (design center: 2-5 keys), so recomputing on demand beats maintaining a view.
pub async fn load_key_tree(db: &Db, root_hex: &str) -> Result<ringtome_proto::Crown, AppError> {
    let root = pubkey::require(root_hex, "root pubkey")?;

    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT bytes FROM entries WHERE service = ?1 ORDER BY author_pubkey, seq",
            (i64::from(service::IDENTITY_PUBLIC),),
        )
        .await
        .context("reading identity chains")
        .map_err(AppError::Internal)?;

    let entries = rows
        .into_iter()
        .map(|(bytes,)| SignedEntry::decode(&bytes))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Internal(anyhow!("stored identity entry fails decode: {e}")))?;

    ringtome_proto::Crown::build(root, &entries)
        .map_err(|e| AppError::Internal(anyhow!("key tree resolution failed: {e}")))
}

/// Every stored entry of one `(service, entry_type)`, decoded, in `(author, seq)` order - the
/// read path for chain-scanning consumers (the private-chain machinery reads `key-epoch`,
/// `authorize`, and `private-record` entries through this).
/// Services whose whole chain may be read at once, because ceremony bounds them.
///
/// This is a gate, not a hint: `entries_of_type` has no watermark and no limit, so calling it
/// on a content chain is a full replay with no tell. Every caller today is one of these two,
/// and the list is the reason that stays true - a service earns a whole-chain read by being
/// named here, never by default (the `record::private::aad_for_service` discipline).
///
/// - **identity-public**: tiny and security-critical by design, and the authority context has
///   to be read whole to be trusted at all (`Crown::build` linearizes from genesis).
/// - **profile-public**: a handful of `profile-set` entries - name, bio, avatar. Bounded by
///   the persona's OWN ceremony rather than by anything a peer can inflate, which is what
///   makes the eviction refold safe to do eagerly.
fn service_reads_whole(service_id: u32) -> bool {
    service_id == service::IDENTITY_PUBLIC || service_id == service::PROFILE_PUBLIC
}

pub async fn entries_of_type(
    db: &Db,
    service_id: u32,
    type_id: u32,
) -> Result<Vec<SignedEntry>, AppError> {
    if !service_reads_whole(service_id) {
        return Err(AppError::Internal(anyhow!(
            "service {service_id} is not read whole - it has no bound, and a content chain \
             read this way is a silent full replay (record::imaol::service_reads_whole)"
        )));
    }
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT bytes FROM entries WHERE service = ?1 AND entry_type = ?2
         ORDER BY author_pubkey, seq",
            (i64::from(service_id), i64::from(type_id)),
        )
        .await
        .context("reading entries by type")
        .map_err(AppError::Internal)?;

    rows.into_iter()
        .map(|(bytes,)| {
            SignedEntry::decode(&bytes)
                .map_err(|e| AppError::Internal(anyhow!("stored entry fails decode: {e}")))
        })
        .collect()
}

/// Every stored entry of one `(service, entry_type)` that each author's view watermark has not
/// yet folded, decoded, in `(author, seq)` order - the catch-up-on-read fetch for the persisted
/// views (`documents::materialize`, `private::materialize_service`). A chain with no watermark row is
/// unfolded from seq 0.
pub(crate) async fn entries_past_watermarks(
    db: &Db,
    service_id: u32,
    type_id: u32,
) -> Result<Vec<SignedEntry>, AppError> {
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT bytes FROM entries e
         WHERE service = ?1 AND entry_type = ?2
           AND seq > COALESCE((SELECT folded_seq FROM view_watermarks w
                               WHERE w.author_pubkey = e.author_pubkey
                                 AND w.service = e.service), -1)
         ORDER BY author_pubkey, seq",
            (i64::from(service_id), i64::from(type_id)),
        )
        .await
        .context("reading entries past view watermarks")
        .map_err(AppError::Internal)?;

    rows.into_iter()
        .map(|(bytes,)| {
            SignedEntry::decode(&bytes)
                .map_err(|e| AppError::Internal(anyhow!("stored entry fails decode: {e}")))
        })
        .collect()
}

/// Advance one chain's view watermark, monotonically. The comparison lives inside the upsert's
/// WHERE clause (the `apply_profile_set` discipline): concurrent catch-ups may interleave
/// freely, and the row only ever moves forward - a racing fold that finished earlier can never
/// drag the watermark back.
/// Pull a view watermark DOWN so entries that arrived beneath it get folded (PEEK.md slice
/// 5: a backfill under the follow ceiling lands older seqs than the lane has folded, and
/// "past the watermark" would never see them). The next catch-up re-folds from `below_seq`
/// up - idempotent for what was folded already, and bounded by what is held.
pub(crate) async fn lower_watermark(
    db: &Db,
    author_hex: &str,
    service_id: u32,
    below_seq: i64,
) -> Result<(), AppError> {
    db.execute(
        "UPDATE view_watermarks SET folded_seq = ?3
         WHERE author_pubkey = ?1 AND service = ?2 AND folded_seq > ?3",
        (author_hex, i64::from(service_id), below_seq),
    )
    .await
    .context("lowering view watermark")
    .map_err(AppError::Internal)?;
    Ok(())
}

pub(crate) async fn advance_watermark(
    db: &Db,
    author_hex: &str,
    service_id: u32,
    folded_seq: u64,
) -> Result<(), AppError> {
    db.execute(
        "INSERT INTO view_watermarks (author_pubkey, service, folded_seq)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(author_pubkey, service) DO UPDATE SET
           folded_seq = excluded.folded_seq
         WHERE excluded.folded_seq > view_watermarks.folded_seq",
        (author_hex, i64::from(service_id), folded_seq as i64),
    )
    .await
    .context("advancing view watermark")
    .map_err(AppError::Internal)?;
    Ok(())
}

/// Test-only: one chain's stored view watermark - how tests observe that a fold advanced (or
/// deliberately stalled).
#[cfg(test)]
pub(crate) async fn view_watermark(db: &Db, author_hex: &str, service_id: u32) -> Option<i64> {
    db.fetch_optional::<(i64,)>(
        "SELECT folded_seq FROM view_watermarks WHERE author_pubkey = ?1 AND service = ?2",
        (author_hex, i64::from(service_id)),
    )
    .await
    .unwrap()
    .map(|(seq,)| seq)
}

/// Test-only: forget every fold watermark while keeping the folded rows - which forces the next
/// materialize to refold entries over an already-populated view, the exact shape two concurrent
/// catch-ups produce. The idempotence tests pin that this changes nothing.
#[cfg(test)]
pub(crate) async fn reset_watermarks_for_test(db: &Db) {
    db.execute("DELETE FROM view_watermarks", ()).await.unwrap();
}

/// Test-only: copy every entry row of one database into another - a second replica that holds
/// the same chains, without standing up the sync path (which is exercised in `net::sync`'s own
/// tests). Raw `entries` SQL is legal here and only here: imaol owns the table.
#[cfg(test)]
pub(crate) async fn clone_entries_for_test(src: &Db, dst: &Db) {
    type Row = (String, i64, i64, Vec<u8>, Vec<u8>, i64, i64, i64, Vec<u8>);
    let rows: Vec<Row> = src
        .fetch_all(
            "SELECT author_pubkey, service, seq, entry_hash, prev_hash, entry_type,
                    timestamp_ms, received_at_ms, bytes
             FROM entries",
            (),
        )
        .await
        .unwrap();
    for row in rows {
        dst.execute(
            "INSERT INTO entries
               (author_pubkey, service, seq, entry_hash, prev_hash, entry_type, timestamp_ms,
                received_at_ms, bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            row,
        )
        .await
        .unwrap();
    }
}

/// One page of a service's entries across all authors, newest first by
/// `(timestamp_ms, seq, entry_hash)` - the same total order the LWW views merge by, so paging
/// is stable within one device's same-millisecond bursts and across devices. `before` excludes
/// the cursor and everything after it. Each envelope comes with its local receipt time.
///
/// Deliberately tolerant of incomplete history: nothing here assumes seq 0 is present, which is
/// the read-path posture suffix sync needs (PROJECT_PLAN, Shallow Sync).
#[allow(dead_code)] // consumer: the store's AppendLog, routed in Tier 4S (plan-in-hand)
pub async fn entries_page(
    db: &Db,
    service_id: u32,
    limit: u32,
    before: Option<(i64, u64, [u8; 32])>,
) -> Result<Vec<(SignedEntry, i64)>, AppError> {
    let rows: Vec<(Vec<u8>, i64)> = match before {
        Some((timestamp_ms, seq, hash)) => {
            db.fetch_all(
                "SELECT bytes, received_at_ms FROM entries
             WHERE service = ?1 AND (timestamp_ms, seq, entry_hash) < (?2, ?3, ?4)
             ORDER BY timestamp_ms DESC, seq DESC, entry_hash DESC LIMIT ?5",
                (
                    i64::from(service_id),
                    timestamp_ms,
                    seq as i64,
                    hash.to_vec(),
                    i64::from(limit),
                ),
            )
            .await
        }
        None => {
            db.fetch_all(
                "SELECT bytes, received_at_ms FROM entries
             WHERE service = ?1
             ORDER BY timestamp_ms DESC, seq DESC, entry_hash DESC LIMIT ?2",
                (i64::from(service_id), i64::from(limit)),
            )
            .await
        }
    }
    .context("paging entries")
    .map_err(AppError::Internal)?;

    rows.into_iter()
        .map(|(bytes, received_at_ms)| {
            let signed = SignedEntry::decode(&bytes)
                .map_err(|e| AppError::Internal(anyhow!("stored entry fails decode: {e}")))?;
            Ok((signed, received_at_ms))
        })
        .collect()
}

/// The stored head of every chain a key has written: `(service, seq, head_hash)` triples -
/// exactly the shape revocation anchors want.
pub async fn chain_heads_for_author(
    db: &Db,
    author_hex: &str,
) -> Result<Vec<(u32, u64, [u8; 32])>, AppError> {
    let rows: Vec<(i64, i64, Vec<u8>)> = db
        .fetch_all(
            "SELECT service, seq, entry_hash FROM entries e
         WHERE author_pubkey = ?1
           AND seq = (SELECT MAX(seq) FROM entries
                      WHERE author_pubkey = e.author_pubkey AND service = e.service)",
            (author_hex,),
        )
        .await
        .context("reading chain heads")
        .map_err(AppError::Internal)?;

    rows.into_iter()
        .map(|(svc, seq, hash)| {
            let head_hash: [u8; 32] = hash
                .try_into()
                .map_err(|_| AppError::Internal(anyhow!("corrupt entry hash")))?;
            Ok((svc as u32, seq as u64, head_hash))
        })
        .collect()
}


/// Does this database hold any entry at all? The cheap half of what the journal-invariant
/// check used to ask `all_entry_bytes` - which read every entry's BLOB off disk on EVERY
/// database open (so every handle-cache miss) to compute one boolean, on a table that grows
/// with the whole of an identity's history. Measured 2026-08-08 while chasing the test-data
/// generator's latency curve: 150 databases through a 128-slot cache, each miss re-reading
/// the log.
pub async fn entries_are_empty(db: &Db) -> Result<bool, AppError> {
    let row: Option<(i64,)> = db
        .fetch_optional("SELECT 1 FROM entries LIMIT 1", ())
        .await
        .context("probing for stored entries")
        .map_err(AppError::Internal)?;
    Ok(row.is_none())
}

/// How many entries the journal backfill carries in memory at once.
pub const BACKFILL_BATCH: u32 = 256;

/// One page of stored envelope bytes in `(author, service, seq)` order - the primary key, so
/// the walk is an index seek - plus the cursor to continue from, or `None` at the end.
///
/// Paged since 2026-08-10 (the full-chain audit). Its caller is journal backfill, which runs
/// when a database is opened beside an empty journal; the whole-log version held every entry
/// an identity had ever written in memory at once, which is a strange amount of RAM to spend
/// on a recovery path that only ever streams its input straight back out to a file.
///
/// Ephemeral chains are excluded: "the journal never holds inbox cargo" has to be true on
/// every path, and the backfill is the one that would otherwise quietly re-import it.
/// One stored entry by its hash - the identity every entry has, globally unique because the hash
/// covers the chain id and seq (`entries_by_hash`).
///
/// Lives here because `entries` is this module's table (tests/conventions.rs). The fragment door
/// needs it to hand over a document's header exactly as its author signed it.
pub async fn entry_by_hash(db: &Db, hash: &[u8; 32]) -> Result<Option<SignedEntry>, AppError> {
    let row: Option<(Vec<u8>,)> = db
        .fetch_optional("SELECT bytes FROM entries WHERE entry_hash = ?1", (hash.to_vec(),))
        .await
        .context("reading an entry by hash")
        .map_err(AppError::Internal)?;
    row.map(|(bytes,)| {
        SignedEntry::decode(&bytes)
            .map_err(|e| AppError::Internal(anyhow!("stored entry fails decode: {e}")))
    })
    .transpose()
}

pub async fn entry_bytes_page(
    db: &Db,
    limit: u32,
    after: Option<&EntryCursor>,
) -> Result<(Vec<Vec<u8>>, Option<EntryCursor>), AppError> {
    type Row = (String, i64, i64, Vec<u8>);
    let rows: Vec<Row> = match after {
        Some(cursor) => {
            db.fetch_all(
                "SELECT author_pubkey, service, seq, bytes FROM entries
                 WHERE (author_pubkey, service, seq) > (?1, ?2, ?3)
                 ORDER BY author_pubkey, service, seq LIMIT ?4",
                (
                    cursor.author.as_str(),
                    i64::from(cursor.service),
                    cursor.seq as i64,
                    i64::from(limit),
                ),
            )
            .await
        }
        None => {
            db.fetch_all(
                "SELECT author_pubkey, service, seq, bytes FROM entries
                 ORDER BY author_pubkey, service, seq LIMIT ?1",
                (i64::from(limit),),
            )
            .await
        }
    }
    .context("reading a page of entry bytes")
    .map_err(AppError::Internal)?;

    // The cursor advances by the last row READ, not the last row kept - filtering ephemeral
    // chains out of the payload must not make the walk step over them and loop forever.
    let next = (rows.len() as u32 == limit)
        .then(|| rows.last().map(|(author, svc, seq, _)| EntryCursor {
            author: author.clone(),
            service: *svc as u32,
            seq: *seq as u64,
        }))
        .flatten();
    Ok((
        rows.into_iter()
            .filter(|(_, svc, _, _)| !crate::net::sync::service_allows_suffix(*svc as u32))
            .map(|(_, _, _, bytes)| bytes)
            .collect(),
        next,
    ))
}

/// Row shape of the raw-log query:
/// (author_pubkey, service, seq, entry_type, timestamp_ms, received_at_ms, entry_hash, bytes).
type EntryRow = (String, i64, i64, i64, i64, i64, Vec<u8>, Vec<u8>);

/// The raw log, hex-encoded - the debug/inspect surface (pipe an entry into `ringtome inspect`).
/// Where a page of the raw log stopped: the `entries` primary key, which is also the order
/// this pages in - so the walk is an index seek with no sort, and the cursor is unique by
/// construction (two devices can share a `(service, seq)`; they cannot share this).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EntryCursor {
    pub author: String,
    pub service: u32,
    pub seq: u64,
}

/// Default and ceiling for one page of raw entries. Small, because each row carries the
/// entry's whole envelope as hex - the point of this surface is to read bytes, and a hundred
/// of them is already a big response.
pub const ENTRIES_PAGE: u32 = 100;
pub const ENTRIES_PAGE_MAX: u32 = 500;

/// One page of the raw log, in primary-key order, plus one lookahead row so the caller can
/// say whether more exists.
///
/// Paged since 2026-08-10 (the full-chain audit): this used to return the ENTIRE log, hex
/// envelopes and all, out of an HTTP handler - fine at demo scale, ruinous at the tens of
/// thousands of entries this system is built for. It is deliberately explicit about
/// truncation rather than silently capped: an inspection surface that shows the first hundred
/// of fifty thousand and says nothing is worse than one that refuses.
pub async fn list_entries(
    db: &Db,
    limit: u32,
    after: Option<&EntryCursor>,
) -> Result<(Vec<StoredEntry>, bool), AppError> {
    let want = limit.clamp(1, ENTRIES_PAGE_MAX);
    let fetch = i64::from(want) + 1; // the lookahead
    let rows: Vec<EntryRow> = match after {
        Some(cursor) => {
            db.fetch_all(
                "SELECT author_pubkey, service, seq, entry_type, timestamp_ms, received_at_ms,
                        entry_hash, bytes
                 FROM entries
                 WHERE (author_pubkey, service, seq) > (?1, ?2, ?3)
                 ORDER BY author_pubkey, service, seq LIMIT ?4",
                (
                    cursor.author.as_str(),
                    i64::from(cursor.service),
                    cursor.seq as i64,
                    fetch,
                ),
            )
            .await
        }
        None => {
            db.fetch_all(
                "SELECT author_pubkey, service, seq, entry_type, timestamp_ms, received_at_ms,
                        entry_hash, bytes
                 FROM entries ORDER BY author_pubkey, service, seq LIMIT ?1",
                (fetch,),
            )
            .await
        }
    }
    .context("listing entries")
    .map_err(AppError::Internal)?;

    let more = rows.len() as u32 > want;
    Ok((
        rows.into_iter()
            .take(want as usize)
            .map(
                |(author, svc, seq, ty, ts, received, hash, bytes)| StoredEntry {
                    author,
                    service: svc as u32,
                    seq: seq as u64,
                    entry_type: ty as u32,
                    timestamp_ms: ts,
                    received_at_ms: received,
                    hash_hex: hex::encode(hash),
                    bytes_hex: hex::encode(bytes),
                },
            )
            .collect(),
        more,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> Db {
        crate::db::test_user_db().await
    }

    fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[3u8; 32])
    }

    #[tokio::test]
    async fn profile_set_and_get_round_trip() {
        let db = test_db().await;
        let key = test_key();

        set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();
        set_profile_field(&db, &key, "bio", "purveyor of hats")
            .await
            .unwrap();

        let profile = get_profile(&db).await.unwrap();
        assert_eq!(profile.len(), 2);
        assert_eq!(profile[1].field, "name");
        assert_eq!(profile[1].value, "Hats Ahoy");
    }

    #[tokio::test]
    async fn later_write_wins_even_within_one_millisecond() {
        let db = test_db().await;
        let key = test_key();

        set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();
        set_profile_field(&db, &key, "name", "Hat Fan")
            .await
            .unwrap();

        let profile = get_profile(&db).await.unwrap();
        assert_eq!(profile.len(), 1);
        // Same-chain writes tie-break on seq, so the rename wins even if both landed in the same
        // clock millisecond (which, at test speed, they usually do).
        assert_eq!(profile[0].value, "Hat Fan");
    }

    #[tokio::test]
    async fn pruning_drops_the_prefix_and_appends_continue_unbroken() {
        let db = test_db().await;
        let key = test_key();
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        for i in 0..6 {
            append(
                &db,
                &key,
                service::INBOX_STRANGER,
                entry_type::INBOX_NOTICE,
                Payload::Inline(vec![i as u8]),
            )
            .await
            .unwrap();
        }

        let pruned = prune_chain_below(&db, &author_hex, service::INBOX_STRANGER, 4)
            .await
            .unwrap();
        assert_eq!(pruned, 4);
        assert_eq!(chain_len(&db, &author_hex, service::INBOX_STRANGER).await.unwrap(), 2);

        // The chain keeps working: the head survived, so the next append links to it rather
        // than minting a fork at genesis.
        let next = append(
            &db,
            &key,
            service::INBOX_STRANGER,
            entry_type::INBOX_NOTICE,
            Payload::Inline(vec![9]),
        )
        .await
        .unwrap();
        assert_eq!(next.entry().seq, 6, "seq continues from the surviving head");
    }

    #[tokio::test]
    async fn the_published_edges_memo_folds_incrementally_and_idempotently() {
        let db = test_db().await;
        let key = test_key();
        let alice = [5u8; 32];

        publish_public_edge(&db, &key, &alice, Some("high".into()), None).await.unwrap();
        let first = published_edges(&db).await.unwrap();
        assert_eq!(first[&hex::encode(alice)].edge.trust.as_deref(), Some("high"));

        // A second read folds nothing (the watermark holds) and answers the same.
        let second = published_edges(&db).await.unwrap();
        assert_eq!(first, second, "a read past the watermark is a no-op");

        // New statements past the watermark fold in; old rows stand.
        let bob = [6u8; 32];
        publish_public_edge(&db, &key, &bob, None, Some("low".into())).await.unwrap();
        publish_public_edge(&db, &key, &alice, Some("max".into()), Some("max".into())).await.unwrap();
        let third = published_edges(&db).await.unwrap();
        assert_eq!(third.len(), 2);
        assert_eq!(third[&hex::encode(alice)].edge.trust.as_deref(), Some("max"));
        assert_eq!(third[&hex::encode(bob)].edge.interest.as_deref(), Some("low"));
    }

    #[tokio::test]
    async fn a_whole_chain_read_is_refused_on_unbounded_services() {
        // The cop, planted and watched go red (STYLE: a cop that cannot fail is decoration).
        // `entries_of_type` has no watermark and no limit; on a content chain that is a full
        // replay with no tell, so the services it may be used on are named rather than assumed.
        let db = test_db().await;
        for allowed in [service::IDENTITY_PUBLIC, service::PROFILE_PUBLIC] {
            assert!(
                entries_of_type(&db, allowed, entry_type::PROFILE_SET).await.is_ok(),
                "ceremony-bounded chains still read whole"
            );
        }
        for refused in [
            service::POSTS,
            service::DOCUMENTS_PRIVATE,
            service::GENERAL_PRIVATE,
            service::INBOX_STRANGER,
        ] {
            assert!(
                entries_of_type(&db, refused, entry_type::DOC_HEADER).await.is_err(),
                "service {refused} grows without bound and must not be read whole"
            );
        }
    }

    #[tokio::test]
    async fn the_journal_backfill_streams_the_whole_log_in_pages() {
        // Bounded memory on the recovery path: the walk must still visit every durable entry
        // exactly once, and must NOT step over the ephemeral rows it filters out (a cursor
        // advanced by rows kept rather than rows read would loop on an inbox-heavy log).
        let db = test_db().await;
        let key = test_key();
        for i in 0..5 {
            set_profile_field(&db, &key, "name", &format!("n{i}")).await.unwrap();
            append(
                &db,
                &key,
                service::INBOX_STRANGER,
                entry_type::INBOX_NOTICE,
                Payload::Inline(vec![i as u8]),
            )
            .await
            .unwrap();
        }

        let mut streamed: Vec<Vec<u8>> = Vec::new();
        let mut cursor: Option<EntryCursor> = None;
        for _ in 0..20 {
            let (batch, next) = entry_bytes_page(&db, 2, cursor.as_ref()).await.unwrap();
            streamed.extend(batch);
            match next {
                Some(at) => cursor = Some(at),
                None => break,
            }
        }
        assert_eq!(
            streamed.len(),
            5,
            "every durable entry, exactly once - and no inbox cargo, which the journal never holds"
        );
    }

    #[tokio::test]
    async fn the_raw_log_pages_completely_and_says_when_it_stops() {
        // Two devices so the cursor's uniqueness is actually exercised: `(service, seq)` alone
        // collides across authors, and a cursor that collides either skips rows or loops.
        let db = test_db().await;
        let phone = SigningKey::from_bytes(&[3u8; 32]);
        let laptop = SigningKey::from_bytes(&[4u8; 32]);
        for i in 0..4 {
            set_profile_field(&db, &phone, "name", &format!("phone {i}")).await.unwrap();
            set_profile_field(&db, &laptop, "bio", &format!("laptop {i}")).await.unwrap();
        }

        let (whole, more) = list_entries(&db, ENTRIES_PAGE_MAX, None).await.unwrap();
        assert_eq!(whole.len(), 8);
        assert!(!more, "a page that holds everything says so");

        // Walk it three at a time and reassemble.
        let mut walked: Vec<StoredEntry> = Vec::new();
        let mut cursor: Option<EntryCursor> = None;
        for _ in 0..10 {
            let (page, more) = list_entries(&db, 3, cursor.as_ref()).await.unwrap();
            assert!(page.len() <= 3, "the limit is a limit");
            let step = page.last().map(|last| EntryCursor {
                author: last.author.clone(),
                service: last.service,
                seq: last.seq,
            });
            walked.extend(page);
            match (more, step) {
                (true, Some(next)) => cursor = Some(next),
                _ => break,
            }
        }
        assert_eq!(
            walked.iter().map(|e| &e.hash_hex).collect::<Vec<_>>(),
            whole.iter().map(|e| &e.hash_hex).collect::<Vec<_>>(),
            "paging visits every entry exactly once, in the same order"
        );
        assert_eq!(
            walked.iter().map(|e| &e.author).collect::<std::collections::BTreeSet<_>>().len(),
            2,
            "and both devices' chains are in there"
        );
    }

    #[tokio::test]
    async fn a_cleared_view_resets_every_lane_that_feeds_it() {
        // The invariant a real bug taught us (see `drop_views_fed_by`): `doc_versions` is fed
        // by BOTH document lanes and cleared whole, so dropping it for one lane must reset the
        // other's watermark too - or that lane's rows are destroyed and never refold, and the
        // feed retraction that follows sweeps honest posts out as collateral.
        let db = test_db().await;
        for svc in [
            service::POSTS,
            service::DOCUMENTS_PRIVATE,
            service::GENERAL_PRIVATE,
            service::DOC_META_PRIVATE,
            service::INBOX_TRUSTED,
            service::INBOX_STRANGER,
            service::PROFILE_PUBLIC,
        ] {
            advance_watermark(&db, "aa", svc, 7).await.unwrap();
        }

        // Evict the PUBLIC document lane only.
        drop_views_fed_by(&db, &[service::POSTS].into_iter().collect())
            .await
            .unwrap();

        let left: Vec<(i64,)> = db
            .fetch_all("SELECT service FROM view_watermarks ORDER BY service", ())
            .await
            .unwrap();
        let left: Vec<u32> = left.into_iter().map(|(s,)| s as u32).collect();
        assert!(
            !left.contains(&service::POSTS) && !left.contains(&service::DOCUMENTS_PRIVATE),
            "both lanes feeding doc_versions reset together, because the clear took both"
        );
        assert!(
            left.contains(&service::GENERAL_PRIVATE)
                && left.contains(&service::DOC_META_PRIVATE)
                && left.contains(&service::INBOX_TRUSTED)
                && left.contains(&service::INBOX_STRANGER)
                && left.contains(&service::PROFILE_PUBLIC),
            "and every view the eviction never touched keeps its progress: {left:?}"
        );
    }

    #[tokio::test]
    async fn an_eviction_drops_only_the_lanes_it_invalidated() {
        // The ingest path's refold, pinned on both halves: the one view that cannot refold
        // itself (profile) is replayed, and a lane the eviction never touched keeps its view
        // instead of being made to rebuild from genesis.
        let db = test_db().await;
        let key = test_key();
        let alice = [5u8; 32];

        set_profile_field(&db, &key, "name", "Hats Ahoy").await.unwrap();
        set_profile_field(&db, &key, "bio", "purveyor of hats").await.unwrap();
        publish_public_edge(&db, &key, &alice, Some("high".into()), None).await.unwrap();
        // Fold the edge into its view so there is something to preserve.
        assert_eq!(published_edges(&db).await.unwrap().len(), 1);

        // A profile-lane eviction: the profile view is rebuilt from the surviving entries...
        refold_after_eviction(&db, &[service::PROFILE_PUBLIC].into_iter().collect())
            .await
            .unwrap();
        let profile = get_profile(&db).await.unwrap();
        assert_eq!(profile.len(), 2, "the profile view came back");
        assert_eq!(profile[1].value, "Hats Ahoy");

        // ...and the follows lane, which lost nothing, still holds its row WITHOUT refolding.
        let held: Option<(i64,)> = db
            .fetch_optional("SELECT COUNT(*) FROM published_edges", ())
            .await
            .unwrap();
        assert_eq!(
            held.unwrap().0,
            1,
            "an unrelated lane's view is not collateral damage"
        );

        // And when the follows lane IS the evicted one, its view drops and refolds on read.
        refold_after_eviction(&db, &[service::FOLLOWS_PUBLIC].into_iter().collect())
            .await
            .unwrap();
        let after: Option<(i64,)> = db
            .fetch_optional("SELECT COUNT(*) FROM published_edges", ())
            .await
            .unwrap();
        assert_eq!(after.unwrap().0, 0, "dropped");
        assert_eq!(
            published_edges(&db).await.unwrap().len(),
            1,
            "and the watermark reset means the next read refolds it"
        );
    }

    #[tokio::test]
    async fn the_memo_survives_a_rebuild() {
        // rebuild_views drops the memo; the next read refolds it whole from the log.
        let db = test_db().await;
        let key = test_key();
        let alice = [5u8; 32];
        publish_public_edge(&db, &key, &alice, Some("medium".into()), None).await.unwrap();
        let before = published_edges(&db).await.unwrap();

        rebuild_views(&db).await.unwrap();
        let after = published_edges(&db).await.unwrap();
        assert_eq!(before, after, "the memo is a cache, and the log is the truth");
    }

    #[tokio::test]
    async fn rebuild_tolerates_a_pruned_inbox_chain() {
        // The latent trap retention left behind: replay validates every chain from genesis,
        // and a pruned inbox chain legitimately starts above zero. Found while memoizing;
        // without the suffix arm in rebuild_views, this test dies with "genesis entry must
        // have seq 0" on the first eviction that triggers a rebuild against a pruned db.
        let db = test_db().await;
        let key = test_key();
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        for i in 0..5 {
            append(
                &db,
                &key,
                service::INBOX_STRANGER,
                entry_type::INBOX_NOTICE,
                Payload::Inline(vec![i as u8]),
            )
            .await
            .unwrap();
        }
        prune_chain_below(&db, &author_hex, service::INBOX_STRANGER, 3).await.unwrap();

        let replayed = rebuild_views(&db).await.unwrap();
        assert!(replayed >= 2, "the pruned chain's suffix replays instead of erroring");
    }

    #[tokio::test]
    async fn a_rebuilt_database_continues_an_ephemeral_chain_instead_of_forking_it() {
        // The defused bomb. Inbox cargo is never journaled, so a database rebuild loses those
        // chains - and a device that then minted a genesis would equivocate against its own
        // siblings. The checkpoint file is what remembers; this test is the whole reason it
        // exists.
        let heads_path = std::env::temp_dir().join(format!(
            "ringtome-imaol-heads-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&heads_path);
        let heads = crate::record::heads::EphemeralHeads::open(&heads_path).unwrap();

        let db = test_db().await.with_ephemeral_heads(heads.clone());
        let key = test_key();
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        let mut last_hash = [0u8; 32];
        for i in 0..3 {
            let signed = append(
                &db,
                &key,
                service::INBOX_STRANGER,
                entry_type::INBOX_NOTICE,
                Payload::Inline(vec![i as u8]),
            )
            .await
            .unwrap();
            last_hash = *signed.hash();
        }

        // The catastrophe: a fresh database (the rebuild), same checkpoint file.
        let rebuilt = test_db().await.with_ephemeral_heads(heads);
        let continued = append(
            &rebuilt,
            &key,
            service::INBOX_STRANGER,
            entry_type::INBOX_NOTICE,
            Payload::Inline(vec![9]),
        )
        .await
        .unwrap();
        assert_eq!(continued.entry().seq, 3, "continues, never re-genesises");
        assert_eq!(
            continued.entry().prev_hash, last_hash,
            "and links onto the exact head the old database held"
        );
        assert_eq!(
            hex::encode(continued.entry().chain.author),
            author_hex,
            "same key, one chain, no fork anywhere"
        );
        let _ = std::fs::remove_file(&heads_path);
    }

    #[tokio::test]
    async fn ephemeral_cargo_never_touches_the_journal() {
        let dir = std::env::temp_dir().join(format!(
            "ringtome-imaol-journal-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let journal_path = dir.join("test.jnl");
        let journal = crate::record::journal::Journal::open(&journal_path).unwrap();
        let db = crate::db::test_user_db_with_journal(journal).await;
        let key = test_key();

        let baseline = std::fs::metadata(&journal_path).unwrap().len();
        append(
            &db,
            &key,
            service::INBOX_TRUSTED,
            entry_type::INBOX_NOTICE,
            Payload::Inline(vec![1]),
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::metadata(&journal_path).unwrap().len(),
            baseline,
            "an inbox transcription writes no journal frame"
        );

        // And a durable chain still does - the exemption is the exception, not a regression.
        set_profile_field(&db, &key, "name", "Journaled").await.unwrap();
        assert!(
            std::fs::metadata(&journal_path).unwrap().len() > baseline,
            "durable writes keep their write-ahead frame"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn pruning_can_never_take_the_head() {
        // The invariant the whole feature hangs on: an emptied chain would re-genesis at seq 0
        // and equivocate with its own history on every peer still holding it.
        let db = test_db().await;
        let key = test_key();
        let author_hex = hex::encode(key.verifying_key().to_bytes());
        for i in 0..3 {
            append(
                &db,
                &key,
                service::INBOX_TRUSTED,
                entry_type::INBOX_NOTICE,
                Payload::Inline(vec![i as u8]),
            )
            .await
            .unwrap();
        }
        // Ask for far more than exists: the floor clamps to the head.
        prune_chain_below(&db, &author_hex, service::INBOX_TRUSTED, 9_999).await.unwrap();
        assert_eq!(chain_len(&db, &author_hex, service::INBOX_TRUSTED).await.unwrap(), 1);
        let next = append(
            &db,
            &key,
            service::INBOX_TRUSTED,
            entry_type::INBOX_NOTICE,
            Payload::Inline(vec![7]),
        )
        .await
        .unwrap();
        assert_eq!(next.entry().seq, 3, "no re-genesis, ever");
    }

    #[tokio::test]
    async fn rebroadcasts_fold_latest_per_document_and_keep_the_tombstone() {
        let db = test_db().await;
        let key = test_key();
        let alice = [5u8; 32];
        let doc = [1u8; 16];
        let other = [2u8; 16];

        publish_rebroadcast(&db, &key, &alice, &doc, Some([9u8; 32]))
            .await
            .unwrap();
        publish_rebroadcast(&db, &key, &alice, &other, Some([8u8; 32]))
            .await
            .unwrap();
        // The same document again, endorsing a newer version: an update, never a second row.
        publish_rebroadcast(&db, &key, &alice, &doc, Some([7u8; 32]))
            .await
            .unwrap();

        let rows = rebroadcasts(&db).await.unwrap();
        assert_eq!(rows.len(), 2, "LWW per (author, doc_id) - shares do not stack");
        let doc_row = rows.iter().find(|r| r.doc_id == doc).unwrap();
        assert_eq!(
            doc_row.version_seen,
            Some([7u8; 32]),
            "the newest pointer is the share"
        );
        assert_eq!(doc_row.author_root, hex::encode(alice));
        assert!(!doc_row.is_retracted());

        // Withdrawing keeps the row as a tombstone: a delete would let a resurrected older
        // pointer win the next time the fold saw it.
        publish_rebroadcast(&db, &key, &alice, &doc, None)
            .await
            .unwrap();
        let rows = rebroadcasts(&db).await.unwrap();
        let doc_row = rows.iter().find(|r| r.doc_id == doc).unwrap();
        assert!(doc_row.is_retracted(), "a withdrawn share renders as nothing");
        assert!(
            rows.iter().any(|r| r.doc_id == other && !r.is_retracted()),
            "withdrawing one share does not touch another"
        );
    }

    /// The property the whole design rests on: a rebroadcast entry carries no content. If a
    /// pointer could ever grow a body, author control would end at the first share.
    #[tokio::test]
    async fn a_rebroadcast_entry_carries_no_content() {
        let db = test_db().await;
        let key = test_key();
        let entry = publish_rebroadcast(&db, &key, &[5u8; 32], &[1u8; 16], Some([9u8; 32]))
            .await
            .unwrap();
        assert!(
            entry.bytes().len() < 400,
            "a pointer entry is small by construction; {} bytes suggests something got copied \
             into it",
            entry.bytes().len()
        );
    }

    #[tokio::test]
    async fn published_edges_fold_latest_per_subject_and_honor_retraction() {
        let db = test_db().await;
        let key = test_key();
        let alice = [5u8; 32];
        let bob = [6u8; 32];

        publish_public_edge(&db, &key, &alice, Some("high".into()), Some("medium".into()))
            .await
            .unwrap();
        publish_public_edge(&db, &key, &bob, None, Some("low".into()))
            .await
            .unwrap();
        // Alice again: the newer statement IS the published relationship.
        publish_public_edge(&db, &key, &alice, Some("max".into()), Some("max".into()))
            .await
            .unwrap();
        // Bob retracted: folds to an empty edge, which readers treat as nothing published.
        publish_public_edge(&db, &key, &bob, None, None).await.unwrap();

        let published = published_edges(&db).await.unwrap();
        assert_eq!(published.len(), 2);
        let a = &published[&hex::encode(alice)];
        assert_eq!(a.edge.trust.as_deref(), Some("max"));
        assert_eq!(a.edge.interest.as_deref(), Some("max"));
        assert!(a.received_at_ms > 0, "the fold carries this replica's arrival stamp");
        assert!(published[&hex::encode(bob)].edge.is_empty(), "a retraction folds to empty");
    }

    #[tokio::test]
    async fn a_fast_clock_cannot_wedge_the_lww_register() {
        // The footgun the authoring clamp exists for: an entry stamped by a fast clock (here,
        // a year ahead) would out-LWW every later, correctly-stamped write until reality caught
        // up. The clamp stamps successors at max(now, chain head's claim), so the tie falls
        // through to seq - true authoring order - and the rename wins immediately.
        let db = test_db().await;
        let key = test_key();

        set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();
        let year_ahead = crate::clock::now_ms() + 365 * 24 * 60 * 60 * 1000;
        db.execute("UPDATE entries SET timestamp_ms = ?1", (year_ahead,))
            .await
            .unwrap();
        db.execute("UPDATE profile_view SET updated_at_ms = ?1", (year_ahead,))
            .await
            .unwrap();

        let renamed = set_profile_field(&db, &key, "name", "Hat Fan")
            .await
            .unwrap();
        assert_eq!(
            renamed.entry().timestamp_ms,
            year_ahead,
            "the successor is clamped up to the head's claim, never below it"
        );
        let profile = get_profile(&db).await.unwrap();
        assert_eq!(
            profile[0].value, "Hat Fan",
            "the later write wins despite the fast clock"
        );
    }

    #[tokio::test]
    async fn entries_carry_a_local_receipt_time() {
        let db = test_db().await;
        let key = test_key();

        let before = crate::clock::now_ms();
        set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();
        let after = crate::clock::now_ms();

        let (entries, _) = list_entries(&db, ENTRIES_PAGE, None).await.unwrap();
        assert!(
            (before..=after).contains(&entries[0].received_at_ms),
            "received_at_ms is this replica's own storage moment"
        );
    }

    #[tokio::test]
    async fn chains_are_dense_and_linked() {
        let db = test_db().await;
        let key = test_key();

        let e0 = set_profile_field(&db, &key, "name", "a").await.unwrap();
        let e1 = set_profile_field(&db, &key, "name", "b").await.unwrap();

        assert_eq!(e0.entry().seq, 0);
        assert_eq!(e0.entry().prev_hash, ZERO_HASH);
        assert_eq!(e1.entry().seq, 1);
        assert_eq!(e1.entry().prev_hash, *e0.hash());
    }

    #[tokio::test]
    async fn entries_page_tolerates_a_missing_history_prefix() {
        // The suffix-sync posture at the read path: a replica holding only the tail of a chain
        // (a suffix-holding node simply never receives the early entries) pages what it holds.
        let db = test_db().await;
        let key = test_key();
        for n in 0..4u8 {
            append(
                &db,
                &key,
                service::POSTS,
                entry_type::POST,
                Payload::Inline(vec![0xa0, n]),
            )
            .await
            .unwrap();
        }
        db.execute(
            "DELETE FROM entries WHERE service = ?1 AND seq < 2",
            (i64::from(service::POSTS),),
        )
        .await
        .unwrap();

        let page = entries_page(&db, service::POSTS, 10, None).await.unwrap();
        let seqs: Vec<u64> = page.iter().map(|(signed, _)| signed.entry().seq).collect();
        assert_eq!(
            seqs,
            vec![3, 2],
            "newest first, no complaint about the absent prefix"
        );
    }

    #[tokio::test]
    async fn rebuild_reproduces_the_same_view() {
        let db = test_db().await;
        let key = test_key();

        set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();
        set_profile_field(&db, &key, "bio", "purveyor of hats")
            .await
            .unwrap();
        set_profile_field(&db, &key, "name", "Hat Fan")
            .await
            .unwrap();

        let before = get_profile(&db).await.unwrap();

        // Sabotage the view, then rebuild from the log.
        db.execute("UPDATE profile_view SET value = 'CLOBBERED'", ())
            .await
            .unwrap();
        let replayed = rebuild_views(&db).await.unwrap();
        assert_eq!(replayed, 3);

        let after = get_profile(&db).await.unwrap();
        assert_eq!(before.len(), after.len());
        for (b, a) in before.iter().zip(after.iter()) {
            assert_eq!((&b.field, &b.value), (&a.field, &a.value));
        }
    }

    #[tokio::test]
    async fn rebuild_detects_a_tampered_log() {
        let db = test_db().await;
        let key = test_key();

        set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();

        // Corrupt one byte of the stored envelope: rebuild must refuse, not shrug.
        let (bytes,): (Vec<u8>,) = db
            .fetch_one("SELECT bytes FROM entries LIMIT 1", ())
            .await
            .unwrap();
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        db.execute("UPDATE entries SET bytes = ?1", (tampered,))
            .await
            .unwrap();

        assert!(rebuild_views(&db).await.is_err());
    }

    /// The fold path's two reads SEEK, never scan. Both ask "(service, entry_type), in
    /// (author, seq) order" - `entries_of_type` on every store open (epoch keys) and
    /// `entries_past_watermarks` on every private or document read - against a table that
    /// grows with everything the identity ever writes. Before `entries_by_service_type`
    /// (2026-08-08) the plan was a raw `SCAN entries`, blobs and all, plus a sorter; a
    /// dropped index would put it back, and nothing else in the suite would notice, because
    /// a scan over test-sized data is fast. Hence a plan assertion rather than a timing one:
    /// it fails on the shape, not on how slow the machine felt today.
    #[tokio::test]
    async fn the_fold_path_reads_seek_and_never_scan() {
        let db = crate::db::test_user_db().await;
        for sql in [
            "SELECT bytes FROM entries WHERE service = ?1 AND entry_type = ?2
             ORDER BY author_pubkey, seq",
            "SELECT bytes FROM entries e
             WHERE service = ?1 AND entry_type = ?2
               AND seq > COALESCE((SELECT folded_seq FROM view_watermarks w
                                   WHERE w.author_pubkey = e.author_pubkey
                                     AND w.service = e.service), -1)
             ORDER BY author_pubkey, seq",
        ] {
            let rows: Vec<(i64, i64, i64, String)> = db
                .fetch_all(&format!("EXPLAIN QUERY PLAN {sql}"), (5i64, 6i64))
                .await
                .unwrap();
            let plan: String = rows
                .iter()
                .map(|(_, _, _, d)| d.as_str())
                .collect::<Vec<_>>()
                .join(" | ");
            assert!(
                plan.contains("entries_by_service_type"),
                "the fold read must use its index, got: {plan}"
            );
            assert!(
                !plan.contains("SCAN entries"),
                "and must not fall back to a table scan, got: {plan}"
            );
            assert!(
                !plan.contains("USE TEMP B-TREE FOR ORDER BY") && !plan.contains("USE SORTER"),
                "the index supplies (author, seq) order, so no sorter should appear: {plan}"
            );
        }
    }
}
