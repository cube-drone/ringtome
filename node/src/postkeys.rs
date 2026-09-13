//! Per-post keys for trusted-only bodies (PROJECT_PLAN's Post visibility slice 2b).
//!
//! The design argument, settled 2026-09-01: a secret hash is capability-URL security and
//! this hash already has public jobs, so the body is CIPHERTEXT wherever it travels and
//! the 32-byte key is the only gated thing. Untrusted nodes do not refuse to share the
//! content - they cannot, because they never had it. This memo is the node's key ring:
//! the author's node remembers at mint, a trusted reader's node remembers what the key
//! lane taught it (net::fragment::fetch_key), and release goes through the trust check.

use crate::db::Db;
use anyhow::{Context, Result};

pub async fn remember(node_db: &Db, author_root: &str, doc_hex: &str, key: &[u8; 32]) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO post_keys (author_root, doc_id, key, noted_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (author_root, doc_id) DO UPDATE SET key = excluded.key",
            (author_root, doc_hex, key.as_slice(), crate::clock::now_ms()),
        )
        .await
        .context("remembering a post key")?;
    Ok(())
}

pub async fn lookup(node_db: &Db, author_root: &str, doc_hex: &str) -> Result<Option<[u8; 32]>> {
    let row: Option<(Vec<u8>,)> = node_db
        .fetch_optional(
            "SELECT key FROM post_keys WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_hex),
        )
        .await
        .context("reading a post key")?;
    Ok(row.and_then(|(k,)| <[u8; 32]>::try_from(k.as_slice()).ok()))
}

/// The audience a post is sealed to, on the author's own node (PROJECT_PLAN's Contact tags,
/// ruling 4): a contact tag, or None for everyone the author trusts.
pub async fn set_audience(node_db: &Db, author_root: &str, doc_hex: &str, audience: Option<&str>) -> Result<()> {
    node_db
        .execute(
            "UPDATE post_keys SET audience = ?3 WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_hex, audience),
        )
        .await
        .context("noting a post's audience")?;
    Ok(())
}

pub async fn audience(node_db: &Db, author_root: &str, doc_hex: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = node_db
        .fetch_optional(
            "SELECT audience FROM post_keys WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_hex),
        )
        .await
        .context("reading a post's audience")?;
    Ok(row.and_then(|(a,)| a).filter(|a| !a.trim().is_empty()))
}

/// How long a refusal is believed before the key is asked for again.
pub const REFUSAL_TTL_MS: i64 = 10 * 60 * 1000;

/// The author's node would not give this node the key: remember it, so the feed and the
/// shelf hide what the door would refuse (Contact tags, ruling 4).
pub async fn refuse(node_db: &Db, author_root: &str, doc_hex: &str) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO post_key_refusals (author_root, doc_id, noted_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (author_root, doc_id) DO UPDATE SET noted_ms = excluded.noted_ms",
            (author_root, doc_hex, crate::clock::now_ms()),
        )
        .await
        .context("remembering a key refusal")?;
    Ok(())
}

pub async fn unrefuse(node_db: &Db, author_root: &str, doc_hex: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM post_key_refusals WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_hex),
        )
        .await
        .context("forgetting a key refusal")?;
    Ok(())
}

/// Whether a fresh refusal stands for this post.
pub async fn refused(node_db: &Db, author_root: &str, doc_hex: &str) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT noted_ms FROM post_key_refusals WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_hex),
        )
        .await
        .context("reading a key refusal")?;
    Ok(row.is_some_and(|(at,)| crate::clock::now_ms() - at < REFUSAL_TTL_MS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_key_is_remembered_and_read_back() {
        let db = crate::db::test_node_db().await;
        let key = [7u8; 32];
        remember(&db, "aa", "11", &key).await.unwrap();
        assert_eq!(lookup(&db, "aa", "11").await.unwrap(), Some(key));
        assert_eq!(lookup(&db, "aa", "22").await.unwrap(), None);
    }
}
