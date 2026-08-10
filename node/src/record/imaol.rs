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

    let (seq, prev_hash, head_claim_ms) = match chain_head(db, &author_hex, service_id).await? {
        Some((head_seq, head_hash, head_ts)) => (head_seq + 1, head_hash, head_ts),
        None => (0, ZERO_HASH, 0),
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

    // Write-ahead: the journal frame lands (fsynced) before the row does, so journal ⊇ database
    // survives a crash between the two (record::journal). If the seq race below then loses, the
    // loser's frame stays behind - a dead sibling replay's validation gate has to arbitrate.
    db.journal_append(signed.bytes())
        .context("journaling entry")
        .map_err(AppError::Internal)?;

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

/// A folded statement with this replica's arrival stamp for the winning entry - local, unsigned,
/// never synced (Displayed Time vs. Claimed Time's receipt bound). The notifications memo orders
/// by it because arrival here is what "new" honestly means on this node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedRow {
    pub edge: PublishedEdge,
    pub received_at_ms: i64,
}

/// The published relationships, folded: the latest `public-edge` per subject across every key's
/// follows-public chain in this database, LWW on `(timestamp_ms, seq, entry_hash)` (The Ordering
/// Contract's standard tuple). Computed at read rather than materialized: these chains are tiny
/// (one entry per published relationship change), and the query seeks via
/// `entries_by_service_type`. Undecodable payloads are skipped, never fatal - the fold enforces
/// nothing, because chain admission is signatures and hashes only, and a future band word must
/// not wedge anything.
pub async fn published_edges(db: &Db) -> Result<BTreeMap<String, PublishedRow>, AppError> {
    let rows: Vec<(Vec<u8>, i64)> = db
        .fetch_all(
            "SELECT bytes, received_at_ms FROM entries WHERE service = ?1 AND entry_type = ?2",
            (
                i64::from(service::FOLLOWS_PUBLIC),
                i64::from(entry_type::PUBLIC_EDGE),
            ),
        )
        .await
        .context("reading public-edge entries")
        .map_err(AppError::Internal)?;

    // winner per subject: (timestamp_ms, seq, hash) tuple beside the folded row.
    let mut latest: BTreeMap<String, ((i64, u64, [u8; 32]), PublishedRow)> = BTreeMap::new();
    for (bytes, received_at_ms) in rows {
        let Ok(signed) = SignedEntry::decode(&bytes) else {
            continue;
        };
        let Payload::Inline(payload) = &signed.entry().payload else {
            continue;
        };
        let Ok(edge) = PublicEdge::decode(payload) else {
            continue;
        };
        let stamp = (signed.entry().timestamp_ms, signed.entry().seq, *signed.hash());
        let folded = PublishedRow {
            edge: PublishedEdge {
                trust: edge.trust,
                interest: edge.interest,
            },
            received_at_ms,
        };
        let subject_hex = hex::encode(edge.subject);
        match latest.get(&subject_hex) {
            Some((held, _)) if *held >= stamp => {}
            _ => {
                latest.insert(subject_hex, (stamp, folded));
            }
        }
    }
    Ok(latest.into_iter().map(|(s, (_, r))| (s, r)).collect())
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
pub async fn rebuild_views(db: &Db) -> Result<u64, AppError> {
    db.execute("DELETE FROM profile_view", ())
        .await
        .context("clearing profile view")
        .map_err(AppError::Internal)?;
    db.execute("DELETE FROM view_watermarks", ())
        .await
        .context("clearing view watermarks")
        .map_err(AppError::Internal)?;
    crate::record::documents::clear_view(db).await?;
    crate::record::private::clear_view(db).await?;

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
        ringtome_proto::validate_next(prev_link, &signed)
            .map_err(|e| AppError::Internal(anyhow!("stored chain fails validation: {e}")))?;

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
pub async fn entries_of_type(
    db: &Db,
    service_id: u32,
    type_id: u32,
) -> Result<Vec<SignedEntry>, AppError> {
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

/// Every stored entry's exact envelope bytes, ordered by `(author, service, seq)` - the
/// deterministic order journal backfill writes frames in (replay revalidates regardless).
pub async fn all_entry_bytes(db: &Db) -> Result<Vec<Vec<u8>>, AppError> {
    let rows: Vec<(Vec<u8>,)> = db
        .fetch_all(
            "SELECT bytes FROM entries ORDER BY author_pubkey, service, seq",
            (),
        )
        .await
        .context("reading entry bytes")
        .map_err(AppError::Internal)?;
    Ok(rows.into_iter().map(|(bytes,)| bytes).collect())
}

/// Row shape of the raw-log query:
/// (service, seq, entry_type, timestamp_ms, received_at_ms, entry_hash, bytes).
type EntryRow = (i64, i64, i64, i64, i64, Vec<u8>, Vec<u8>);

/// The raw log, hex-encoded - the debug/inspect surface (pipe an entry into `ringtome inspect`).
pub async fn list_entries(db: &Db) -> Result<Vec<StoredEntry>, AppError> {
    let rows: Vec<EntryRow> = db
        .fetch_all(
            "SELECT service, seq, entry_type, timestamp_ms, received_at_ms, entry_hash, bytes
         FROM entries ORDER BY service, seq",
            (),
        )
        .await
        .context("listing entries")
        .map_err(AppError::Internal)?;

    Ok(rows
        .into_iter()
        .map(|(svc, seq, ty, ts, received, hash, bytes)| StoredEntry {
            service: svc as u32,
            seq: seq as u64,
            entry_type: ty as u32,
            timestamp_ms: ts,
            received_at_ms: received,
            hash_hex: hex::encode(hash),
            bytes_hex: hex::encode(bytes),
        })
        .collect())
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

        let entries = list_entries(&db).await.unwrap();
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
