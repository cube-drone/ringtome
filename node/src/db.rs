//! SQLite connection management.
//!
//! The node database (`node.db`) holds node-level state: configuration, known peers, replication
//! bookkeeping. (Per-user/per-chain databases come later and will reuse `open_sqlite`.)
//!
//! The connection recipe - WAL journal, `synchronous = normal`, create-if-missing - is carried
//! over from the old codebase; it is the sensible default for a local, single-writer-ish SQLite
//! file that values durability without paying full-synchronous cost on every write.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;

/// Open (creating if absent) a SQLite database at `path` and return a connection pool.
///
/// Applies the standard PRAGMAs and verifies the connection with a trivial query, so a caller that
/// gets an `Ok` back knows the database is actually usable, not merely opened.
pub async fn open_sqlite(path: &Path) -> Result<SqlitePool> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating db directory {}", parent.display()))?;
    }

    let options = SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
        .synchronous(sqlx::sqlite::SqliteSynchronous::Normal);

    let pool = SqlitePool::connect_with(options)
        .await
        .with_context(|| format!("opening sqlite database {}", path.display()))?;

    // Prove the connection is live rather than just constructed.
    sqlx::query("SELECT 1")
        .execute(&pool)
        .await
        .context("verifying sqlite connection")?;

    Ok(pool)
}

/// Record a boot in the `boot_timestamps` table, creating it if needed.
///
/// Beyond leaving a useful boot history (and a per-boot record of which app version ran), this
/// exercises the full read/write/DDL path on startup - a stronger liveness proof than a bare
/// `SELECT 1`, which only shows the connection opened.
pub async fn record_boot(pool: &SqlitePool, app_version: &str) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS boot_timestamps (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            booted_at_ms INTEGER NOT NULL,
            app_version  TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await
    .context("creating boot_timestamps table")?;

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    sqlx::query("INSERT INTO boot_timestamps (booted_at_ms, app_version) VALUES (?1, ?2)")
        .bind(now_ms)
        .bind(app_version)
        .execute(pool)
        .await
        .context("recording boot timestamp")?;

    Ok(())
}
