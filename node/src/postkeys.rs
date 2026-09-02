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
