//! The node's IM-AOL storage: appending signed entries to per-identity chains and materializing
//! views from them.
//!
//! The `entries` table in each per-user DB is the local copy of the signed log - the author's
//! exact bytes, one row per entry. Everything else in that DB is a *view*: rebuildable at any
//! time by replaying and re-validating the log (`rebuild_views`), which is the disposability
//! promise the per-user databases are built on. In M3 the entries table is also exactly what
//! replicates between nodes; nothing in this module may trust a row without re-validating it.

use anyhow::{anyhow, Context};
use ringtome_proto::registry::{entry_type, service};
use ringtome_proto::{
    ChainId, Entry, Payload, ProfileSet, SignedEntry, SigningKey, ENTRY_VERSION, ZERO_HASH,
};
use sqlx::SqlitePool;

use crate::error::AppError;

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The stored head of one chain: highest seq and that entry's hash.
async fn chain_head(
    db: &SqlitePool,
    author_hex: &str,
    service_id: u32,
) -> Result<Option<(u64, [u8; 32])>, AppError> {
    let row: Option<(i64, Vec<u8>)> = sqlx::query_as(
        "SELECT seq, entry_hash FROM entries
         WHERE author_pubkey = ?1 AND service = ?2
         ORDER BY seq DESC LIMIT 1",
    )
    .bind(author_hex)
    .bind(i64::from(service_id))
    .fetch_optional(db)
    .await
    .context("reading chain head")
    .map_err(AppError::Internal)?;

    match row {
        None => Ok(None),
        Some((seq, hash)) => {
            let hash: [u8; 32] = hash
                .try_into()
                .map_err(|_| AppError::Internal(anyhow!("corrupt entry_hash at chain head")))?;
            Ok(Some((seq as u64, hash)))
        }
    }
}

/// Append one entry to this key's (service) chain: derive seq and prev_hash from the stored
/// head, sign, store the exact envelope bytes.
pub async fn append(
    db: &SqlitePool,
    key: &SigningKey,
    service_id: u32,
    type_id: u32,
    payload: Payload,
) -> Result<SignedEntry, AppError> {
    let author = key.verifying_key().to_bytes();
    let author_hex = hex::encode(author);

    let (seq, prev_hash) = match chain_head(db, &author_hex, service_id).await? {
        Some((head_seq, head_hash)) => (head_seq + 1, head_hash),
        None => (0, ZERO_HASH),
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
        timestamp_ms: now_ms(),
        payload,
    };
    let signed = SignedEntry::create(&entry, key)
        .map_err(|e| AppError::Internal(anyhow!("signing entry: {e}")))?;

    // Two concurrent appends to one chain race to the same seq; the (author, service, seq)
    // primary key makes the loser fail loudly instead of forking the chain.
    sqlx::query(
        "INSERT INTO entries
           (author_pubkey, service, seq, entry_hash, prev_hash, entry_type, timestamp_ms, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&author_hex)
    .bind(i64::from(service_id))
    .bind(seq as i64)
    .bind(signed.hash().as_slice())
    .bind(signed.entry().prev_hash.as_slice())
    .bind(i64::from(type_id))
    .bind(signed.entry().timestamp_ms as i64)
    .bind(signed.bytes())
    .execute(db)
    .await
    .context("storing entry")
    .map_err(AppError::Internal)?;

    Ok(signed)
}

/// Set one field of the identity's public profile: append a `profile-set` entry, then fold it
/// into the materialized view.
pub async fn set_profile_field(
    db: &SqlitePool,
    key: &SigningKey,
    field: &str,
    value: &str,
) -> Result<SignedEntry, AppError> {
    let payload = ProfileSet {
        field: field.to_string(),
        value: value.to_string(),
    }
    .encode()
    .map_err(|e| AppError::BadRequest(format!("invalid profile field: {e}")))?;

    let signed = append(
        db,
        key,
        service::PROFILE,
        entry_type::PROFILE_SET,
        Payload::Inline(payload),
    )
    .await?;
    apply_profile_set(db, &signed).await?;
    Ok(signed)
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
async fn apply_profile_set(db: &SqlitePool, signed: &SignedEntry) -> Result<(), AppError> {
    let Payload::Inline(bytes) = &signed.entry().payload else {
        return Err(AppError::Internal(anyhow!(
            "profile-set payload must be inline"
        )));
    };
    let ps = ProfileSet::decode(bytes)
        .map_err(|e| AppError::Internal(anyhow!("undecodable profile-set payload: {e}")))?;

    sqlx::query(
        "INSERT INTO profile_view (field, value, updated_at_ms, seq, entry_hash)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(field) DO UPDATE SET
           value = excluded.value,
           updated_at_ms = excluded.updated_at_ms,
           seq = excluded.seq,
           entry_hash = excluded.entry_hash
         WHERE (excluded.updated_at_ms, excluded.seq, excluded.entry_hash)
             > (profile_view.updated_at_ms, profile_view.seq, profile_view.entry_hash)",
    )
    .bind(&ps.field)
    .bind(&ps.value)
    .bind(signed.entry().timestamp_ms as i64)
    .bind(signed.entry().seq as i64)
    .bind(signed.hash().as_slice())
    .execute(db)
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
pub async fn get_profile(db: &SqlitePool) -> Result<Vec<ProfileField>, AppError> {
    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT field, value, updated_at_ms FROM profile_view ORDER BY field")
            .fetch_all(db)
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
pub async fn rebuild_views(db: &SqlitePool) -> Result<u64, AppError> {
    sqlx::query("DELETE FROM profile_view")
        .execute(db)
        .await
        .context("clearing profile view")
        .map_err(AppError::Internal)?;

    let rows: Vec<(String, i64, Vec<u8>)> = sqlx::query_as(
        "SELECT author_pubkey, service, bytes FROM entries ORDER BY author_pubkey, service, seq",
    )
    .fetch_all(db)
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

        if signed.entry().chain.service == service::PROFILE
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
    pub hash_hex: String,
    pub bytes_hex: String,
}

/// Load and resolve the identity's key tree from its stored identity-public chains. The tree is
/// tiny (design center: 2-5 keys), so recomputing on demand beats maintaining a view.
pub async fn load_key_tree(
    db: &SqlitePool,
    root_hex: &str,
) -> Result<ringtome_proto::KeyTree, AppError> {
    let root: [u8; 32] = hex::decode(root_hex)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| AppError::BadRequest("root pubkey must be 64 hex chars".into()))?;

    let rows: Vec<(Vec<u8>,)> =
        sqlx::query_as("SELECT bytes FROM entries WHERE service = ?1 ORDER BY author_pubkey, seq")
            .bind(i64::from(service::IDENTITY_PUBLIC))
            .fetch_all(db)
            .await
            .context("reading identity chains")
            .map_err(AppError::Internal)?;

    let entries = rows
        .into_iter()
        .map(|(bytes,)| SignedEntry::decode(&bytes))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| AppError::Internal(anyhow!("stored identity entry fails decode: {e}")))?;

    ringtome_proto::KeyTree::build(root, &entries)
        .map_err(|e| AppError::Internal(anyhow!("key tree resolution failed: {e}")))
}

/// Row shape of the raw-log query: (service, seq, entry_type, timestamp_ms, entry_hash, bytes).
type EntryRow = (i64, i64, i64, i64, Vec<u8>, Vec<u8>);

/// The raw log, hex-encoded - the debug/inspect surface (pipe an entry into `ringtome inspect`).
pub async fn list_entries(db: &SqlitePool) -> Result<Vec<StoredEntry>, AppError> {
    let rows: Vec<EntryRow> = sqlx::query_as(
        "SELECT service, seq, entry_type, timestamp_ms, entry_hash, bytes
         FROM entries ORDER BY service, seq",
    )
    .fetch_all(db)
    .await
    .context("listing entries")
    .map_err(AppError::Internal)?;

    Ok(rows
        .into_iter()
        .map(|(svc, seq, ty, ts, hash, bytes)| StoredEntry {
            service: svc as u32,
            seq: seq as u64,
            entry_type: ty as u32,
            timestamp_ms: ts,
            hash_hex: hex::encode(hash),
            bytes_hex: hex::encode(bytes),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_db() -> SqlitePool {
        let pool = SqlitePool::connect("sqlite::memory:").await.unwrap();
        crate::db::user_migrator_for_test(&pool).await;
        pool
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
        sqlx::query("UPDATE profile_view SET value = 'CLOBBERED'")
            .execute(&db)
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
        let (bytes,): (Vec<u8>,) = sqlx::query_as("SELECT bytes FROM entries LIMIT 1")
            .fetch_one(&db)
            .await
            .unwrap();
        let mut tampered = bytes.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xff;
        sqlx::query("UPDATE entries SET bytes = ?1")
            .bind(&tampered)
            .execute(&db)
            .await
            .unwrap();

        assert!(rebuild_views(&db).await.is_err());
    }
}
