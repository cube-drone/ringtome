//! Database connection management (Turso, encrypted at rest).
//!
//! Two kinds of database:
//!
//! - **`node.db`** - node-level state (config, known peers, replication bookkeeping). One per node.
//! - **per-user DBs** (`data/users/<root-pubkey>.db`) - the materialized view of a single
//!   identity's IM-AOL chains. Many per node. Identity is the system's natural partition, so each
//!   identity gets its own file: one identity's queries physically cannot touch another's, and
//!   sync-in / drop / front / back-up are per-file operations that match the chain model.
//!
//! Both kinds share the open recipe (`open_database`) and each has its own embedded schema,
//! applied on open via a `user_version`-gated runner. The per-user DBs are held in a bounded
//! cache of open handles, since a busy node cannot keep every user's file open at once.
//!
//! **At-rest encryption.** Every database gets its own random 32-byte key, sealed in the node
//! keystore (`data/keys/db-<name>.key`, AAD = the database's logical name) and handed to Turso's
//! page-level AEGIS-256 encryption. There is no unencrypted mode: a database file with no key
//! file is a database this build cannot attribute (a lost keystore, or a foreign file dropped in
//! place) and refuses to open - minting a fresh key over it would either fail confusingly or
//! destroy the tell that the keystore is gone.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use turso::{Builder, EncryptionOpts, IntoParams, Value};

use crate::keystore::Keystore;

/// Schema for `node.db`, embedded into the binary at compile time.
const NODE_SCHEMA: &str = include_str!("../migrations/node/0001_schema.sql");
/// Schema for the per-user databases, embedded at compile time: the entries log and its
/// materialized views (see `imaol`).
const USER_SCHEMA: &str = include_str!("../migrations/user/0001_chains_and_profile.sql");

/// Current schema version, stamped into `PRAGMA user_version`. Bump when a migration is added
/// (and teach `migrate` the version-to-version steps; today there is only "0 -> schema").
const SCHEMA_VERSION: i64 = 1;

/// How long a write waits on a busy connection before failing.
const BUSY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Length of a database encryption key (AEGIS-256).
const DB_KEY_LEN: usize = 32;

// ---------------------------------------------------------------------------------------------
// Row extraction

/// One column value out of a [`turso::Value`]. The mirror of what call sites bind: i64, String,
/// Vec<u8>, and Option of each.
pub trait FromColumn: Sized {
    fn from_column(value: Value) -> Result<Self>;
}

impl FromColumn for i64 {
    fn from_column(value: Value) -> Result<Self> {
        match value {
            Value::Integer(i) => Ok(i),
            other => Err(anyhow!("expected integer column, got {other:?}")),
        }
    }
}

impl FromColumn for String {
    fn from_column(value: Value) -> Result<Self> {
        match value {
            Value::Text(s) => Ok(s),
            other => Err(anyhow!("expected text column, got {other:?}")),
        }
    }
}

impl FromColumn for Vec<u8> {
    fn from_column(value: Value) -> Result<Self> {
        match value {
            Value::Blob(b) => Ok(b),
            other => Err(anyhow!("expected blob column, got {other:?}")),
        }
    }
}

impl<T: FromColumn> FromColumn for Option<T> {
    fn from_column(value: Value) -> Result<Self> {
        match value {
            Value::Null => Ok(None),
            other => Ok(Some(T::from_column(other)?)),
        }
    }
}

/// A whole row as a tuple, in SELECT order - the shape `fetch_*` extracts into.
pub trait FromRow: Sized {
    fn from_row(row: &turso::Row) -> Result<Self>;
}

macro_rules! impl_from_row {
    ($($idx:tt $t:ident),+) => {
        impl<$($t: FromColumn),+> FromRow for ($($t,)+) {
            fn from_row(row: &turso::Row) -> Result<Self> {
                Ok(($($t::from_column(row.get_value($idx)?)?,)+))
            }
        }
    };
}

impl_from_row!(0 A);
impl_from_row!(0 A, 1 B);
impl_from_row!(0 A, 1 B, 2 C);
impl_from_row!(0 A, 1 B, 2 C, 3 D);
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E);
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E, 5 F);
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E, 5 F, 6 G);

// ---------------------------------------------------------------------------------------------
// The handle

/// One open database: the Turso handle plus a shared connection. Cheap to clone. All statements
/// on one `Db` share one connection; the `fetch_*` helpers always run their statement to
/// completion before returning, because an open statement (a half-read RETURNING above all)
/// blocks further writes on the connection.
#[derive(Clone)]
pub struct Db {
    /// Kept so the database outlives any moment where no query is in flight.
    _database: turso::Database,
    conn: turso::Connection,
}

impl Db {
    /// Execute one statement to completion; returns rows affected.
    pub async fn execute(&self, sql: &str, params: impl IntoParams) -> Result<u64> {
        Ok(self.conn.execute(sql, params).await?)
    }

    /// Run a script of semicolon-separated statements.
    pub async fn execute_batch(&self, sql: &str) -> Result<()> {
        Ok(self.conn.execute_batch(sql).await?)
    }

    /// Raw row stream, for the callers that must inspect columns dynamically (the local-test SQL
    /// passthrough). Everyone else goes through the typed `fetch_*` helpers.
    pub async fn query(&self, sql: &str, params: impl IntoParams) -> Result<turso::Rows> {
        Ok(self.conn.query(sql, params).await?)
    }

    /// Every row, extracted into `T`.
    pub async fn fetch_all<T: FromRow>(
        &self,
        sql: &str,
        params: impl IntoParams,
    ) -> Result<Vec<T>> {
        let mut rows = self.conn.query(sql, params).await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(T::from_row(&row)?);
        }
        Ok(out)
    }

    /// The first row (if any), extracted into `T`. Drains the statement either way - see the
    /// open-statement rule on [`Db`].
    pub async fn fetch_optional<T: FromRow>(
        &self,
        sql: &str,
        params: impl IntoParams,
    ) -> Result<Option<T>> {
        let mut rows = self.conn.query(sql, params).await?;
        let first = match rows.next().await? {
            Some(row) => Some(T::from_row(&row)?),
            None => None,
        };
        while rows.next().await?.is_some() {}
        Ok(first)
    }

    /// Exactly one row, extracted into `T`; errors if the query returns none.
    pub async fn fetch_one<T: FromRow>(&self, sql: &str, params: impl IntoParams) -> Result<T> {
        self.fetch_optional(sql, params)
            .await?
            .ok_or_else(|| anyhow!("query returned no rows"))
    }
}

// ---------------------------------------------------------------------------------------------
// Opening and migrating

/// Key-file name for a database's encryption key, from its logical name (`node`, or a root
/// pubkey). Prefixed so database keys can never collide with identity key files, which are named
/// by bare hex pubkeys.
fn db_key_name(logical_name: &str) -> String {
    format!("db-{logical_name}")
}

/// Load (or first-open-generate) the sealed encryption key for one database, hex-encoded for
/// Turso. The logical name rides in as AAD, so a key file can't be silently swapped between
/// databases.
fn load_or_create_db_key(keystore: &Keystore, logical_name: &str) -> Result<String> {
    let key_name = db_key_name(logical_name);
    let key = if keystore.contains(&key_name) {
        keystore
            .load_key(&key_name, logical_name.as_bytes())
            .with_context(|| format!("opening database key for {logical_name}"))?
    } else {
        use rand::RngCore;
        let mut key = [0u8; DB_KEY_LEN];
        rand::rngs::OsRng.fill_bytes(&mut key);
        keystore
            .store(&key_name, &key, logical_name.as_bytes())
            .with_context(|| format!("sealing database key for {logical_name}"))?;
        tracing::info!(db = %logical_name, "generated new database encryption key");
        key.to_vec()
    };
    if key.len() != DB_KEY_LEN {
        bail!("database key for {logical_name} has wrong length");
    }
    Ok(hex::encode(key))
}

/// Open (creating if absent) a database at `path` and return a handle.
///
/// Always encrypted: a fresh database is created under a key minted into the keystore, an
/// existing one opens under its existing key. An existing file with *no* key file refuses to
/// open rather than getting a fresh key minted over it - the key can't decrypt the file, and
/// the missing key file is the diagnostic (lost keystore vs. foreign file) that a mint would
/// destroy. Applies the standard connection recipe (WAL is Turso's default journal mode,
/// `synchronous = normal`, busy timeout; `foreign_keys` stays at its default, off, as before).
/// Does not migrate - callers pair this with `migrate`.
pub async fn open_database(path: &Path, keystore: &Keystore) -> Result<Db> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating db directory {}", parent.display()))?;
    }
    let logical_name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("database path {} has no usable name", path.display()))?
        .to_string();
    let path_str = path
        .to_str()
        .ok_or_else(|| anyhow!("database path {} is not valid UTF-8", path.display()))?;

    if path.exists() && !keystore.contains(&db_key_name(&logical_name)) {
        bail!(
            "database {} exists but its key file ({}.key) does not - lost keystore, or a file \
             this node never authored; refusing to open or mint a key over it",
            path.display(),
            db_key_name(&logical_name),
        );
    }
    let hexkey = load_or_create_db_key(keystore, &logical_name)?;
    let database = Builder::new_local(path_str)
        .experimental_encryption(true)
        .with_encryption(EncryptionOpts {
            cipher: "aegis256".to_string(),
            hexkey,
        })
        .build()
        .await
        .with_context(|| format!("opening database {}", path.display()))?;

    let db = connect(database)?;
    db.execute("PRAGMA synchronous = NORMAL", ())
        .await
        .context("setting synchronous pragma")?;
    Ok(db)
}

/// Wrap a built database in a [`Db`]: connect and set the busy timeout.
fn connect(database: turso::Database) -> Result<Db> {
    let conn = database.connect().context("connecting to database")?;
    conn.busy_timeout(BUSY_TIMEOUT)
        .context("setting busy timeout")?;
    Ok(Db {
        _database: database,
        conn,
    })
}

/// Apply `schema` if the database is fresh, stamping `PRAGMA user_version`.
///
/// Apply-and-stamp rides one transaction: a half-applied schema with the version unstamped
/// would fail every later boot on the already-created tables, so either both land or neither
/// does.
async fn migrate(db: &Db, schema: &str, what: &str) -> Result<()> {
    let (version,): (i64,) = db
        .fetch_one("PRAGMA user_version", ())
        .await
        .context("reading schema version")?;
    if version >= SCHEMA_VERSION {
        return Ok(());
    }
    db.execute("BEGIN", ())
        .await
        .context("starting migration transaction")?;
    let applied: Result<()> = async {
        db.execute_batch(schema)
            .await
            .with_context(|| format!("applying {what} schema"))?;
        db.execute("PRAGMA user_version = 1", ())
            .await
            .context("stamping schema version")?;
        Ok(())
    }
    .await;
    match applied {
        Ok(()) => db
            .execute("COMMIT", ())
            .await
            .context("committing migration")
            .map(|_| ()),
        Err(e) => {
            let _ = db.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}

/// Open and migrate the node database at `<data_dir>/node.db`.
pub async fn open_node_db(data_directory: &Path, keystore: &Keystore) -> Result<Db> {
    let path = data_directory.join("node.db");
    let db = open_database(&path, keystore).await?;
    migrate(&db, NODE_SCHEMA, "node")
        .await
        .context("running node migrations")?;
    Ok(db)
}

/// A fresh in-memory node database, migrated. For tests that don't want a file (or a keystore).
#[cfg(test)]
pub async fn test_node_db() -> Db {
    let db = test_memory_db().await;
    migrate(&db, NODE_SCHEMA, "node").await.unwrap();
    db
}

/// A fresh in-memory per-user database, migrated. For tests that don't go through
/// [`UserDbManager`].
#[cfg(test)]
pub async fn test_user_db() -> Db {
    let db = test_memory_db().await;
    migrate(&db, USER_SCHEMA, "user").await.unwrap();
    db
}

#[cfg(test)]
async fn test_memory_db() -> Db {
    let database = Builder::new_local(":memory:").build().await.unwrap();
    connect(database).unwrap()
}

/// Record a boot in `boot_timestamps` (a local-only diagnostic; never exposed over the network).
/// The table itself comes from the schema; this is just the insert.
pub async fn record_boot(db: &Db, app_version: &str) -> Result<()> {
    db.execute(
        "INSERT INTO boot_timestamps (booted_at_ms, app_version) VALUES (?1, ?2)",
        (crate::clock::now_ms(), app_version),
    )
    .await
    .context("recording boot timestamp")?;

    Ok(())
}

/// Manages the per-user (per-identity) databases: opens them on demand, migrates them, and keeps a
/// bounded number of open handles at once.
///
/// Keyed by the identity's root public key (as a string). A busy node may agent or front many
/// identities but cannot hold every file open, so the cache evicts least-recently-used handles; an
/// evicted handle closes when the last reference drops, and re-access simply reopens the file
/// (cheap - the data is on disk, migrations are already applied, the key is in the keystore).
#[derive(Clone)]
pub struct UserDbManager {
    users_directory: PathBuf,
    keystore: Keystore,
    handles: moka::future::Cache<String, Db>,
}

impl UserDbManager {
    /// `data_directory` is the node's data dir; per-user DBs live in `<data_dir>/users/`.
    /// `max_open` bounds how many per-user handles stay open simultaneously.
    pub fn new(data_directory: &Path, keystore: Keystore, max_open: u64) -> Self {
        Self {
            users_directory: data_directory.join("users"),
            keystore,
            handles: moka::future::Cache::new(max_open),
        }
    }

    fn path_for(&self, root_pubkey: &str) -> PathBuf {
        self.users_directory.join(format!("{root_pubkey}.db"))
    }

    /// Get (opening and migrating if necessary) the database for one identity.
    pub async fn get(&self, root_pubkey: &str) -> Result<Db> {
        if let Some(db) = self.handles.get(root_pubkey).await {
            return Ok(db);
        }

        let path = self.path_for(root_pubkey);
        let db = open_database(&path, &self.keystore).await?;
        migrate(&db, USER_SCHEMA, "user")
            .await
            .with_context(|| format!("running user migrations for {root_pubkey}"))?;

        self.handles
            .insert(root_pubkey.to_string(), db.clone())
            .await;
        Ok(db)
    }

    /// Number of per-user handles currently held open (best-effort; the cache is eventually
    /// consistent about its size).
    pub async fn open_count(&self) -> u64 {
        self.handles.run_pending_tasks().await;
        self.handles.entry_count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    async fn temp_dir() -> PathBuf {
        // A unique-ish scratch dir under the OS temp location, avoiding Date/rand (unavailable in
        // some harnesses) by leaning on the process id + a nanosecond counter.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("ringtome-test-{}-{}", std::process::id(), nanos));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    fn temp_keystore(dir: &Path) -> Keystore {
        // Ensure we don't pick up an ambient RINGTOME_ENVELOPE_KEY from the environment.
        std::env::remove_var("RINGTOME_ENVELOPE_KEY");
        Keystore::load(dir).unwrap()
    }

    #[tokio::test]
    async fn node_db_migrates_encrypted_and_records_boot() {
        let dir = temp_dir().await;
        let ks = temp_keystore(&dir);
        let db = open_node_db(&dir, &ks).await.unwrap();
        record_boot(&db, "0.0.0-test").await.unwrap();

        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM boot_timestamps", ())
            .await
            .unwrap();
        assert_eq!(count, 1);

        // The schema version is stamped, and a key file was minted for the database.
        let (version,): (i64,) = db.fetch_one("PRAGMA user_version", ()).await.unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(ks.contains("db-node"));

        // At-rest encryption is real: the file must not start with the plaintext SQLite magic.
        drop(db);
        let bytes = std::fs::read(dir.join("node.db")).unwrap();
        assert!(
            !bytes.starts_with(b"SQLite format 3"),
            "node.db is plaintext on disk"
        );

        // Reopening with the same keystore finds the same key and reads the data back.
        let db = open_node_db(&dir, &ks).await.unwrap();
        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM boot_timestamps", ())
            .await
            .unwrap();
        assert_eq!(count, 1);

        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn db_without_key_file_refuses_to_open() {
        // A database file this keystore can't attribute (lost keystore, or a foreign file
        // dropped in place): refuse loudly, and never mint a key over it.
        let dir = temp_dir().await;
        {
            let ks = temp_keystore(&dir);
            let db = open_node_db(&dir, &ks).await.unwrap();
            record_boot(&db, "0.0.0-test").await.unwrap();
        }
        // Same file, fresh keystore: the key file is gone from this node's perspective.
        let other = dir.join("other-keystore");
        std::fs::create_dir_all(&other).unwrap();
        let ks = temp_keystore(&other);
        let err = match open_node_db(&dir, &ks).await {
            Ok(_) => panic!("opened a database whose key file is missing"),
            Err(e) => e,
        };
        assert!(
            err.to_string().contains("key file"),
            "refusal names the missing key file: {err}"
        );
        assert!(
            !ks.contains("db-node"),
            "no key is minted over an unattributable database"
        );

        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn user_db_manager_isolates_and_caches() {
        let dir = temp_dir().await;
        let ks = temp_keystore(&dir);
        let mgr = UserDbManager::new(&dir, ks, 8);

        // Two distinct identities get two distinct, independent databases.
        let a = mgr.get("alice_pubkey").await.unwrap();
        let b = mgr.get("bob_pubkey").await.unwrap();

        // Prove isolation: a table created in alice's DB is not visible in bob's.
        a.execute("CREATE TABLE probe (v INTEGER)", ())
            .await
            .unwrap();
        a.execute("INSERT INTO probe (v) VALUES (1)", ())
            .await
            .unwrap();

        let bob_sees_probe = b
            .fetch_all::<(i64,)>("SELECT v FROM probe", ())
            .await
            .is_err();
        assert!(bob_sees_probe, "bob's db must not see alice's table");

        // Re-getting alice returns the cached handle and the data persists.
        let a2 = mgr.get("alice_pubkey").await.unwrap();
        let (v,): (i64,) = a2.fetch_one("SELECT v FROM probe", ()).await.unwrap();
        assert_eq!(v, 1);

        assert_eq!(mgr.open_count().await, 2);

        // Two files on disk, one per identity, each with its own key file.
        assert!(dir.join("users").join("alice_pubkey.db").exists());
        assert!(dir.join("users").join("bob_pubkey.db").exists());

        tokio::fs::remove_dir_all(&dir).await.ok();
    }
}
