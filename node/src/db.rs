//! SQLite connection management.
//!
//! Two kinds of database:
//!
//! - **`node.db`** - node-level state (config, known peers, replication bookkeeping). One per node.
//! - **per-user DBs** (`data/users/<root-pubkey>.db`) - the materialized view of a single
//!   identity's IM-AOL chains. Many per node. Identity is the system's natural partition, so each
//!   identity gets its own file: one identity's queries physically cannot touch another's, and
//!   sync-in / drop / front / back-up are per-file operations that match the chain model.
//!
//! Both kinds share the connection recipe (`open_sqlite`) and each has its own embedded migration
//! set, applied on open. The per-user DBs are held in a bounded cache of open handles, since a
//! busy node cannot keep every user's file open at once.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use sqlx::migrate::Migrator;
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::SqlitePool;

/// Migrations for `node.db`, embedded into the binary at compile time.
static NODE_MIGRATOR: Migrator = sqlx::migrate!("migrations/node");
/// Migrations for the per-user databases, embedded at compile time: the entries log and its
/// materialized views (see `imaol`).
static USER_MIGRATOR: Migrator = sqlx::migrate!("migrations/user");

/// Open (creating if absent) a SQLite database at `path` and return a connection pool.
///
/// Applies the standard PRAGMAs: WAL journal, `synchronous = normal`, create-if-missing. Does not
/// migrate - callers pair this with the appropriate migrator.
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

    Ok(pool)
}

/// Open and migrate the node database at `<data_dir>/node.db`.
pub async fn open_node_db(data_directory: &Path) -> Result<SqlitePool> {
    let path = data_directory.join("node.db");
    let pool = open_sqlite(&path).await?;
    NODE_MIGRATOR
        .run(&pool)
        .await
        .context("running node migrations")?;
    Ok(pool)
}

/// Run the node migrations against an already-open pool. For tests that use an in-memory DB rather
/// than a file opened via [`open_node_db`].
#[cfg(test)]
pub async fn node_migrator_for_test(pool: &SqlitePool) {
    NODE_MIGRATOR.run(pool).await.unwrap();
}

/// Run the per-user migrations against an already-open pool. For tests that use an in-memory DB
/// rather than going through [`UserDbManager`].
#[cfg(test)]
pub async fn user_migrator_for_test(pool: &SqlitePool) {
    USER_MIGRATOR.run(pool).await.unwrap();
}

/// Record a boot in `boot_timestamps` (a local-only diagnostic; never exposed over the network).
/// The table itself comes from migration `0001`; this is just the insert.
pub async fn record_boot(pool: &SqlitePool, app_version: &str) -> Result<()> {
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

/// Manages the per-user (per-identity) databases: opens them on demand, migrates them, and keeps a
/// bounded number of connection pools open at once.
///
/// Keyed by the identity's root public key (as a string). A busy node may agent or front many
/// identities but cannot hold every file open, so the cache evicts least-recently-used pools; an
/// evicted pool's connections close when the last reference drops, and re-access simply reopens the
/// file (cheap - the data is on disk, migrations are already applied).
#[derive(Clone)]
pub struct UserDbManager {
    users_directory: PathBuf,
    pools: moka::future::Cache<String, SqlitePool>,
}

impl UserDbManager {
    /// `data_directory` is the node's data dir; per-user DBs live in `<data_dir>/users/`.
    /// `max_open` bounds how many per-user pools stay open simultaneously.
    pub fn new(data_directory: &Path, max_open: u64) -> Self {
        Self {
            users_directory: data_directory.join("users"),
            pools: moka::future::Cache::new(max_open),
        }
    }

    fn path_for(&self, root_pubkey: &str) -> PathBuf {
        self.users_directory.join(format!("{root_pubkey}.db"))
    }

    /// Get (opening and migrating if necessary) the database pool for one identity.
    pub async fn get(&self, root_pubkey: &str) -> Result<SqlitePool> {
        if let Some(pool) = self.pools.get(root_pubkey).await {
            return Ok(pool);
        }

        let path = self.path_for(root_pubkey);
        let pool = open_sqlite(&path).await?;
        USER_MIGRATOR
            .run(&pool)
            .await
            .with_context(|| format!("running user migrations for {root_pubkey}"))?;

        self.pools
            .insert(root_pubkey.to_string(), pool.clone())
            .await;
        Ok(pool)
    }

    /// Number of per-user pools currently held open (best-effort; the cache is eventually
    /// consistent about its size).
    pub async fn open_count(&self) -> u64 {
        self.pools.run_pending_tasks().await;
        self.pools.entry_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn temp_dir() -> PathBuf {
        // A unique-ish scratch dir under the OS temp location, avoiding Date/rand (unavailable in
        // some harnesses) by leaning on the pool's process id + a nanosecond counter.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ringtome-test-{}-{}", std::process::id(), nanos));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    #[tokio::test]
    async fn node_db_migrates_and_records_boot() {
        let dir = temp_dir().await;
        let pool = open_node_db(&dir).await.unwrap();
        record_boot(&pool, "0.0.0-test").await.unwrap();

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM boot_timestamps")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);

        // The migration tracking table should exist and record our one node migration.
        let (migrations,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(migrations >= 1, "expected at least one applied migration");

        pool.close().await;
        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn user_db_manager_isolates_and_caches() {
        let dir = temp_dir().await;
        let mgr = UserDbManager::new(&dir, 8);

        // Two distinct identities get two distinct, independent databases.
        let a = mgr.get("alice_pubkey").await.unwrap();
        let b = mgr.get("bob_pubkey").await.unwrap();

        // Prove isolation: a table created in alice's DB is not visible in bob's.
        sqlx::query("CREATE TABLE probe (v INTEGER)")
            .execute(&a)
            .await
            .unwrap();
        sqlx::query("INSERT INTO probe (v) VALUES (1)")
            .execute(&a)
            .await
            .unwrap();

        let bob_sees_probe = sqlx::query("SELECT v FROM probe")
            .fetch_all(&b)
            .await
            .is_err();
        assert!(bob_sees_probe, "bob's db must not see alice's table");

        // Re-getting alice returns the cached pool and the data persists.
        let a2 = mgr.get("alice_pubkey").await.unwrap();
        let (v,): (i64,) = sqlx::query_as("SELECT v FROM probe")
            .fetch_one(&a2)
            .await
            .unwrap();
        assert_eq!(v, 1);

        assert_eq!(mgr.open_count().await, 2);

        // Two files on disk, one per identity.
        assert!(dir.join("users").join("alice_pubkey.db").exists());
        assert!(dir.join("users").join("bob_pubkey.db").exists());

        tokio::fs::remove_dir_all(&dir).await.ok();
    }
}
