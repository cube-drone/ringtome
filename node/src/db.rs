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
//! Both kinds share the open recipe (`open_database`) and each has one embedded schema, applied
//! to fresh databases and generation-checked on existing ones (pre-launch: rebuild, never
//! migrate in place - see the generation constants). The per-user DBs are held in a bounded
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
use crate::record::journal::Journal;

/// Schema for `node.db`, embedded into the binary at compile time.
const NODE_SCHEMA: &str = include_str!("../migrations/node/0001_schema.sql");
/// Schema for the per-user databases, embedded at compile time: the entries log and its
/// materialized views (see `imaol`, `record::documents`, `record::private`).
const USER_SCHEMA: &str = include_str!("../migrations/user/0001_chains_and_profile.sql");

/// Schema **generations**, stamped into `PRAGMA user_version`. Pre-launch policy: there is no
/// in-place migration - one schema file per database kind, edited freely, and a database whose
/// stamp doesn't match is refused with rebuild guidance (per-user data replays from the journal
/// or re-syncs; node accounts are dev accounts). Bump the generation whenever the schema file
/// changes. A real migration ladder is launch-gated work, built alongside the backup story,
/// when databases exist whose data must survive a schema change in place.
const NODE_SCHEMA_GENERATION: i64 = 11; // 11: the notifications memo (2026-08-09)
const USER_SCHEMA_GENERATION: i64 = 7; // 7: entries_by_service_type - the fold path's index (2026-08-08)

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
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E, 5 F, 6 G, 7 H);
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E, 5 F, 6 G, 7 H, 8 I);
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E, 5 F, 6 G, 7 H, 8 I, 9 J, 10 K, 11 L, 12 M, 13 N);
impl_from_row!(0 A, 1 B, 2 C, 3 D, 4 E, 5 F, 6 G, 7 H, 8 I, 9 J, 10 K, 11 L, 12 M, 13 N, 14 O);

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
    /// One statement at a time. Turso's `Connection` refuses overlapping statements
    /// ("concurrent use forbidden"), and every clone of a `Db` shares one connection - a race
    /// that stayed theoretical while all traffic was request-driven and became real the moment
    /// background sync started polling on a tick. Every statement path locks, runs to
    /// completion, and releases; safe to hold across the whole helper because the `fetch_*`
    /// helpers always drain before returning (the open-statement rule above).
    stmt_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// One sync-gate ingest at a time (see [`Db::lock_ingest`]). Distinct from `stmt_lock`,
    /// which serializes single statements: this serializes a whole validate-and-store batch.
    ingest_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// One locally-authored append at a time (see [`Db::lock_append`]). The third lock, and
    /// the same shape as the second for the same reason on the other side of the membrane:
    /// deriving a seq from the chain head and inserting under it is a read-then-write, and two
    /// of them overlapping means one loses on the `(author, service, seq)` primary key.
    append_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// The identity's raw-entry journal, attached when this is a per-user database opened
    /// through [`UserDbManager`]. `None` for `node.db` (whose insurance is a later, different
    /// mechanism - sealed dumps) and for in-memory test databases.
    journal: Option<Journal>,
    /// The node-level database, attached to per-user handles opened through [`UserDbManager`]
    /// so the entry writers (append, ingest, eviction) can co-write the chain-heads memo at
    /// the moment they know the tip - the fact is in hand in plaintext exactly once, and
    /// re-deriving it later means opening this encrypted file again. `None` for node.db
    /// itself and for bare test databases (the memo is then simply not fed; the reconciling
    /// sweep is the recovery path either way).
    memo: Option<std::sync::Arc<Db>>,
    /// Whose database this is: the identity's root pubkey, attached when opened through
    /// [`UserDbManager`]. `None` for `node.db` and in-memory test databases. Lets code holding
    /// only the handle answer identity-scoped questions (the signing gate in `imaol::append`
    /// resolves the key tree with it).
    root: Option<String>,
    /// The write-nudge broadcast, attached like the journal (per-user databases only). Fired by
    /// [`Db::nudge_sync`] on locally-*signed* writes so every waiter - the eager-sync loop AND
    /// each open live-cache stream - notices a fresh save in milliseconds instead of a poll
    /// tick. A broadcast, not a single `Notify`, precisely because there are many waiters: one
    /// bell for the whole node (each consumer re-checks its own frontier and acts only if it
    /// actually moved, so no per-root routing is needed).
    write_nudge: Option<WriteNudge>,
}

/// The write-nudge bus: a `()` broadcast fired on every locally-signed write. Consumers
/// (`loops::periodic_nudged`, the live-cache stream) subscribe and re-check their own state on
/// each ping. Capacity is tiny - a ping carries no data, and [`await_write_nudge`] folds a
/// lagged receiver into a single "something changed, re-check", so overflow is harmless.
/// The nudge names WHO changed - the identity's root, hex.
///
/// It used to carry nothing, and a dataless ping means every consumer must re-examine every
/// persona to find the one that moved: one person posting made a node with a thousand personas
/// run a thousand frontier scans to discover that nine hundred and ninety-nine of them were
/// exactly as before. The name is the whole fix; `imaol::append` knows it at the moment it
/// rings the bell.
pub type WriteNudge = tokio::sync::broadcast::Sender<String>;

/// Capacity of the nudge bus. Roomy on purpose: a lagged receiver can no longer say WHO wrote
/// and must fall back to sweeping everyone, so the channel should absorb any realistic burst -
/// pings are one String each, and the coalescing drain in `loops::periodic_nudged` empties it
/// between passes.
pub const NUDGE_CAPACITY: usize = 1024;

/// Await the next write nudge, answering WHICH identity wrote - or `None` for "something did,
/// and I no longer know what".
///
/// `None` is the lag case, and it is not a failure: a consumer that missed pings cannot know
/// what it missed, so the honest answer is to fall back to examining everything. Targeted when
/// we know, complete when we don't. Never busy-loops once the sender is gone (the receiver is
/// disabled and the future parks).
pub async fn await_write_nudge(
    rx: &mut Option<tokio::sync::broadcast::Receiver<String>>,
) -> Option<String> {
    use tokio::sync::broadcast::error::RecvError;
    if let Some(r) = rx.as_mut() {
        match r.recv().await {
            Ok(root) => return Some(root),
            Err(RecvError::Lagged(_)) => return None,
            Err(RecvError::Closed) => *rx = None,
        }
    }
    std::future::pending::<Option<String>>().await
}

impl Db {
    /// Execute one statement to completion; returns rows affected.
    pub async fn execute(&self, sql: &str, params: impl IntoParams) -> Result<u64> {
        let _guard = self.stmt_lock.lock().await;
        Ok(self.conn.execute(sql, params).await?)
    }

    /// Run a script of semicolon-separated statements.
    pub async fn execute_batch(&self, sql: &str) -> Result<()> {
        let _guard = self.stmt_lock.lock().await;
        Ok(self.conn.execute_batch(sql).await?)
    }

    /// Raw row stream, for the callers that must inspect columns dynamically (the local-test SQL
    /// passthrough). Everyone else goes through the typed `fetch_*` helpers. The lock only
    /// covers issuing the statement - the returned stream outlives it - so this stays a
    /// test-passthrough affordance, never a production path.
    pub async fn query(&self, sql: &str, params: impl IntoParams) -> Result<turso::Rows> {
        let _guard = self.stmt_lock.lock().await;
        Ok(self.conn.query(sql, params).await?)
    }

    /// Every row, extracted into `T`.
    pub async fn fetch_all<T: FromRow>(
        &self,
        sql: &str,
        params: impl IntoParams,
    ) -> Result<Vec<T>> {
        let _guard = self.stmt_lock.lock().await;
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
        let _guard = self.stmt_lock.lock().await;
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

    /// Truncate this database's WAL: backfill every frame into the main file, then cut the
    /// log to zero.
    ///
    /// Needed because turso's own maintenance bounds WORK, not the FILE: its auto-checkpoint
    /// (1000-frame threshold, on by default) runs in passive mode, which backfills pages but
    /// never shrinks the log - and on a node generating steady memo traffic the WAL grew
    /// without bound (568MB observed against a 12MB database after one fake-network run,
    /// 2026-08-05). A fat WAL is a tax on every read that follows, which made the whole node
    /// feel quadratically slower as it filled. TRUNCATE is the one mode that resets the file.
    ///
    /// `fetch_all`, not `execute`: the pragma answers with a row (busy / log / checkpointed),
    /// and the open-statement rule says drain it - an undrained statement wedges the shared
    /// connection.
    pub async fn checkpoint(&self) -> Result<()> {
        let _rows: Vec<(i64, i64, i64)> = self
            .fetch_all("PRAGMA wal_checkpoint(TRUNCATE)", ())
            .await
            .context("truncating the WAL")?;
        Ok(())
    }

    /// Hold this identity's ingest gate for the duration of one sync-gate batch. Under eager
    /// push, simultaneous bidirectional exchanges on one root are routine (A pushes to B while
    /// B pushes to A, both carrying the same re-offered entries); two concurrent ingests race
    /// between the head-read and the insert, and the loser dies on the `entry_hash` UNIQUE
    /// constraint instead of duplicate-skipping. One batch at a time per identity closes that
    /// window; local authorship (`imaol::append`) is unaffected - it writes only this node's
    /// own chains, which no ingest batch contests.
    pub async fn lock_ingest(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.ingest_lock.clone().lock_owned().await
    }

    /// Hold this identity's append gate for one locally-authored write (`imaol::append`).
    ///
    /// `lock_ingest`'s note used to end "local authorship is unaffected - it writes only this
    /// node's own chains, which no ingest batch contests", and that is still true of ingest.
    /// It was never true of local writes contesting EACH OTHER: one request can legitimately
    /// author two entries at once (Feed posts by publishing and minting the next draft in
    /// parallel), and two appends racing between the head read and the insert leaves the loser
    /// dead on the primary key - a 500 in the middle of an ordinary action, which the reader
    /// then repeats. Serialize them and the key goes back to being the backstop it was meant
    /// to be rather than the thing users meet.
    pub async fn lock_append(&self) -> tokio::sync::OwnedMutexGuard<()> {
        self.append_lock.clone().lock_owned().await
    }

    /// Frame `envelope` into this database's raw-entry journal, fsynced - the write-ahead half
    /// of the journal ⊇ database invariant. The two entry-insert sites (`imaol::append`, sync's
    /// store path) call this *before* the row lands. No-op for databases without a journal.
    pub fn journal_append(&self, envelope: &[u8]) -> Result<()> {
        match &self.journal {
            Some(journal) => journal.append(envelope),
            None => Ok(()),
        }
    }

    /// This handle (and every clone made from it) with the journal attached.
    fn with_journal(self, journal: Journal) -> Db {
        Db {
            journal: Some(journal),
            ..self
        }
    }

    /// Fire the write nudge: a locally-signed write just landed - wake the eager-sync loop and
    /// every open stream. `send` errors only when nobody is subscribed (ignored: the tick is
    /// the backstop). No-op for databases without the bus (node.db, tests) - and deliberately
    /// NEVER called from the sync-ingest path: entries arriving *by sync* relay onward on the
    /// lazy tick, the damping that keeps a peer triangle from ping-ponging (net::resync).
    pub fn nudge_sync(&self) {
        if let (Some(bus), Some(root)) = (&self.write_nudge, self.root()) {
            let _ = bus.send(root.to_string());
        }
    }

    /// This handle (and every clone made from it) with the write-nudge bus attached.
    fn with_write_nudge(self, bus: WriteNudge) -> Db {
        Db {
            write_nudge: Some(bus),
            ..self
        }
    }

    /// The identity's root pubkey, when this is a per-user database. See the field doc.
    pub fn root(&self) -> Option<&str> {
        self.root.as_deref()
    }

    /// The node.db handle riding along for memo co-writes, when this is a managed user db.
    pub fn memo(&self) -> Option<&Db> {
        self.memo.as_deref()
    }

    /// This handle with the node-level database attached (see the `memo` field).
    fn with_memo(self, node_db: std::sync::Arc<Db>) -> Db {
        Db {
            memo: Some(node_db),
            ..self
        }
    }

    /// This handle (and every clone made from it) knowing whose it is.
    fn with_root(self, root_hex: String) -> Db {
        Db {
            root: Some(root_hex),
            ..self
        }
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
        stmt_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        ingest_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        append_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
        memo: None,
        journal: None,
        root: None,
        write_nudge: None,
    })
}

/// Apply `schema` to a fresh database and stamp its generation; accept a matching stamp; refuse
/// everything else with rebuild guidance (the pre-launch no-in-place-migration policy - see the
/// generation constants).
///
/// Apply-and-stamp rides one transaction: a half-applied schema with the generation unstamped
/// would fail every later boot on the already-created tables, so either both land or neither
/// does.
async fn migrate(db: &Db, schema: &str, generation: i64, what: &str) -> Result<()> {
    let (version,): (i64,) = db
        .fetch_one("PRAGMA user_version", ())
        .await
        .context("reading schema generation")?;
    if version == generation {
        return Ok(());
    }
    if version != 0 {
        bail!(
            "{what} database is schema generation {version}, this build wants {generation}; \
             pre-launch there is no in-place migration - delete the database and rebuild \
             (per-user data replays from its journal or re-syncs from a peer)"
        );
    }
    db.execute("BEGIN", ())
        .await
        .context("starting schema transaction")?;
    let applied: Result<()> = async {
        db.execute_batch(schema)
            .await
            .with_context(|| format!("applying {what} schema"))?;
        db.execute(&format!("PRAGMA user_version = {generation}"), ())
            .await
            .context("stamping schema generation")?;
        Ok(())
    }
    .await;
    match applied {
        Ok(()) => db
            .execute("COMMIT", ())
            .await
            .context("committing schema")
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
    migrate(&db, NODE_SCHEMA, NODE_SCHEMA_GENERATION, "node")
        .await
        .context("running node migrations")?;
    Ok(db)
}

/// A fresh in-memory node database, migrated. For tests that don't want a file (or a keystore).
#[cfg(test)]
pub async fn test_node_db() -> Db {
    let db = test_memory_db().await;
    migrate(&db, NODE_SCHEMA, NODE_SCHEMA_GENERATION, "node")
        .await
        .unwrap();
    db
}

/// A fresh in-memory per-user database, migrated. For tests that don't go through
/// [`UserDbManager`].
#[cfg(test)]
pub async fn test_user_db() -> Db {
    let db = test_memory_db().await;
    migrate(&db, USER_SCHEMA, USER_SCHEMA_GENERATION, "user")
        .await
        .unwrap();
    db
}

/// A fresh in-memory per-user database with a raw-entry journal attached - for tests exercising
/// the write-ahead path without a [`UserDbManager`].
#[cfg(test)]
pub async fn test_user_db_with_journal(journal: Journal) -> Db {
    test_user_db().await.with_journal(journal)
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
    journals_directory: PathBuf,
    keystore: Keystore,
    handles: moka::future::Cache<String, Db>,
    /// node.db, attached to every per-user handle for chain-heads memo co-writes (see
    /// [`Db::memo`]). Set once by `attach_memo` in main after both databases exist; `None`
    /// in fixtures that never wire it, where the memo simply isn't fed.
    node_db: std::sync::Arc<std::sync::OnceLock<std::sync::Arc<Db>>>,
    /// The one write-nudge bus, attached to every per-user handle (see [`Db::nudge_sync`]).
    /// Owned here so wiring is automatic: whoever opens a user DB gets a nudging handle, and
    /// consumers subscribe via [`UserDbManager::subscribe_writes`].
    write_nudge: WriteNudge,
    /// Journals whose torn tail this PROCESS has already checked (see [`Journal::reopen`]).
    /// The check is crash recovery and costs a full read plus a frame walk; a handle cache
    /// smaller than the number of personas made it run on every miss, over files that grow
    /// with an identity's whole history. Boot-reset by being in memory, which is exactly
    /// right: a fresh process has not written any of these bytes and validates again.
    validated_journals: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

impl UserDbManager {
    /// `data_directory` is the node's data dir; per-user DBs live in `<data_dir>/users/`, their
    /// raw-entry journals in `<data_dir>/journals/`. `max_open` bounds how many per-user handles
    /// stay open simultaneously.
    pub fn new(data_directory: &Path, keystore: Keystore, max_open: u64) -> Self {
        Self {
            users_directory: data_directory.join("users"),
            journals_directory: data_directory.join("journals"),
            keystore,
            handles: moka::future::Cache::new(max_open),
            node_db: std::sync::Arc::new(std::sync::OnceLock::new()),
            validated_journals: Default::default(),
            // 16 is ample: pings carry no data and lag folds to one re-check.
            write_nudge: tokio::sync::broadcast::channel(NUDGE_CAPACITY).0,
        }
    }

    /// Subscribe to the write-nudge bus - a ping on every locally-signed write. Each consumer
    /// (the eager loop, a live-cache stream) gets its own receiver.
    /// Wire node.db in for memo co-writes. Once, at boot, after both databases exist; a
    /// second call is a no-op rather than an error, which keeps fixtures painless.
    pub fn attach_memo(&self, node_db: Db) {
        let _ = self.node_db.set(std::sync::Arc::new(node_db));
    }

    pub fn subscribe_writes(&self) -> tokio::sync::broadcast::Receiver<String> {
        self.write_nudge.subscribe()
    }

    /// The bus itself, for a consumer that subscribes on its own schedule (the eager loop).
    pub fn write_nudge(&self) -> WriteNudge {
        self.write_nudge.clone()
    }

    /// When this root's database files last changed, by stat alone - no open, no decrypt, no
    /// handle-cache pressure. The tick sweeps' cheap dirty check (`loops::FreshnessMarks`):
    /// the WAL's mtime moves on every write, the main file's on every checkpoint, so the max
    /// of the two moves whenever anything at all happened. `None` when the files don't exist.
    pub fn db_mtime_ms(&self, root_pubkey: &str) -> Option<i64> {
        let path = self.path_for(root_pubkey);
        let mtime = |p: std::path::PathBuf| {
            std::fs::metadata(p)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
        };
        let wal = path.with_extension("db-wal");
        match (mtime(path), mtime(wal)) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        }
    }

    /// Every user database currently OPEN, for maintenance that walks the warm set (the WAL
    /// checkpoint pass). Deliberately not "every user database on disk": reopening cold files
    /// to maintain them would recreate the thrash the handle cache exists to prevent. A cold
    /// file keeps whatever WAL it had - it only grows while written, writes only happen
    /// through an open handle, and the next open puts it back on this walk.
    pub fn open_handles(&self) -> Vec<(String, Db)> {
        self.handles
            .iter()
            .map(|(root, db)| (root.as_ref().clone(), db))
            .collect()
    }

    fn path_for(&self, root_pubkey: &str) -> PathBuf {
        self.users_directory.join(format!("{root_pubkey}.db"))
    }

    fn journal_path_for(&self, root_pubkey: &str) -> PathBuf {
        self.journals_directory.join(format!("{root_pubkey}.jnl"))
    }

    /// READ one persona's database - `None` when this node holds nothing of theirs.
    ///
    /// The `Option` is the whole point, and it is load-bearing rather than tidy. This used to
    /// create on open, so every read path was one forgotten precondition away from WRITING an
    /// empty database (plus WAL, plus journal - ~96 KB) for any stranger it was asked about:
    /// a contact list's worth of them on a device adopting a big ledger. Two call sites
    /// carried doc comments asserting "the caller checks first" and neither caller did
    /// (2026-08-08, found on disk and then in the node log). Absence is now a value the
    /// compiler makes you handle, not a rule you have to remember - and minting is its own
    /// verb (`create`), reached deliberately by the handful of paths that mean it.
    ///
    /// Still a PER-FILE act: decryption, migration check, journal validation - cheap once,
    /// ruinous per-item. If the call you are writing sits inside a loop over personas (a
    /// roster's names, a feed's bylines, "which of these changed?"), stop: that is the fan-in
    /// thrash the Data Layer warns about, and the answer is a node-level memo written at fold
    /// time (persona_frontiers, subscriptions, persona_profiles, feed_journal - four
    /// precedents). The conventions test pins every call site for exactly that reason - a
    /// separate hazard from minting, and one the type system cannot see.
    pub async fn get(&self, root_pubkey: &str) -> Result<Option<Db>> {
        if let Some(db) = self.handles.get(root_pubkey).await {
            return Ok(Some(db));
        }
        // Stat, then open. Not atomic - a concurrent `create` between the two just means the
        // next call finds it - but the window lives in ONE place now instead of at every
        // read site, which is the difference that matters. (turso's builder takes a path, not
        // open flags, so there is no open-if-exists to hand this to.)
        if !self.path_for(root_pubkey).exists() {
            return Ok(None);
        }
        self.open(root_pubkey).await.map(Some)
    }

    /// `get`, where absence is a BUG rather than an answer: the persona is one this node
    /// hosts (its database was minted at creation) or one we just observed entries from, so
    /// `None` means something is broken, not that someone is a stranger. Never mints, so the
    /// worst a misuse can do is fail loudly - which is the whole point of not having one verb
    /// that both reads and creates.
    pub async fn held(&self, root_pubkey: &str) -> Result<Db> {
        self.get(root_pubkey)
            .await?
            .ok_or_else(|| anyhow!("no database held for {root_pubkey}"))
    }

    /// Open one persona's database, MINTING it if this node holds nothing of theirs yet -
    /// first sync of a foreign persona, a newly created or adopted identity, a journal
    /// rebuild. The rare, deliberate half of `get`: if you are not the reason this persona's
    /// data is about to exist here, you want `get`.
    pub async fn create(&self, root_pubkey: &str) -> Result<Db> {
        if let Some(db) = self.handles.get(root_pubkey).await {
            return Ok(db);
        }
        self.open(root_pubkey).await
    }

    /// The shared body: open (creating if absent), migrate, attach the journal, cache the
    /// handle. Callers choose whether absence is allowed; this one just does the work.
    async fn open(&self, root_pubkey: &str) -> Result<Db> {
        let path = self.path_for(root_pubkey);
        let db = open_database(&path, &self.keystore).await?;
        migrate(&db, USER_SCHEMA, USER_SCHEMA_GENERATION, "user")
            .await
            .with_context(|| format!("running user migrations for {root_pubkey}"))?;

        // Open (torn-tail-validating) the journal, and initialize the journal ⊇ database
        // invariant: an empty journal over a non-empty entries table gets every stored entry
        // backfilled as frames, or rebuild-by-replay would silently lose the prefix.
        let journal_path = self.journal_path_for(root_pubkey);
        let first_look = self
            .validated_journals
            .lock()
            .unwrap()
            .insert(root_pubkey.to_string());
        let journal = if first_look {
            Journal::open(&journal_path)
                .with_context(|| format!("opening journal for {root_pubkey}"))?
        } else {
            Journal::reopen(&journal_path)
                .with_context(|| format!("reopening journal for {root_pubkey}"))?
        };
        let journal_empty = journal
            .is_empty()
            .with_context(|| format!("checking journal for {root_pubkey}"))?;
        // The entry BYTES are fetched only on the branch that writes them. The version that
        // read them unconditionally spent a whole-log read per open - so per handle-cache
        // miss - to answer `is_empty()` in the common case where the journal and the database
        // are both populated and there is nothing to do (measured 2026-08-08).
        if journal_empty {
            let existing = crate::record::imaol::all_entry_bytes(&db)
                .await
                .with_context(|| format!("reading entries for journal init of {root_pubkey}"))?;
            if !existing.is_empty() {
                journal
                    .append_all(&existing)
                    .with_context(|| format!("backfilling journal for {root_pubkey}"))?;
            }
        } else if crate::record::imaol::entries_are_empty(&db)
            .await
            .with_context(|| format!("probing entries for journal init of {root_pubkey}"))?
        {
            // The invariant's OTHER direction - the pre-launch migration promise ("per-user
            // data replays from its journal") actually kept: an EMPTY database under a
            // non-empty journal is a rebuilt file (the schema-generation bail told the
            // operator to delete it), and the journal is its insurance. Replay every frame
            // through the ordinary validated ingest - the gate re-checks every signature and
            // hash-link, so a tampered journal can inject nothing (field-found 2026-08-02:
            // the un-replayed rebuild left empty key trees, which the persona screen then
            // misread as a departed computer).
            if let Some(root) = crate::pubkey::decode(root_pubkey) {
                let (accepted, rejected) = crate::record::journal::rebuild_from_journal(
                    &db,
                    root,
                    &journal_path,
                )
                .await
                .with_context(|| format!("replaying journal for {root_pubkey}"))?;
                tracing::info!(
                    root = %root_pubkey,
                    accepted,
                    rejected,
                    "rebuilt empty database from its journal"
                );
            }
        }
        let mut db = db
            .with_journal(journal)
            .with_root(root_pubkey.to_string())
            .with_write_nudge(self.write_nudge.clone());
        if let Some(node_db) = self.node_db.get() {
            db = db.with_memo(node_db.clone());
        }

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
        // A unique scratch dir under the OS temp location. The uniqueness is an ATOMIC
        // COUNTER, not the clock: pid+nanos collided under parallel test load (SystemTime
        // granularity is coarser than a nanosecond), giving two tests the same directory -
        // one encrypted the db under its keystore, the other opened it with a different one,
        // and "Decryption failed for page=1" haunted full-suite runs for three days as the
        // once-in-many-runs phantom flake (REFACTOR.md's most-wanted, finally caught by the
        // test-unit tee).
        static UNIQUE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = UNIQUE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "ringtome-test-{}-{}-{}",
            std::process::id(),
            nanos,
            n
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        dir
    }

    fn temp_keystore(dir: &Path) -> Keystore {
        // Ensure we don't pick up an ambient RINGTOME_ENVELOPE_KEY from the environment.
        std::env::remove_var("RINGTOME_ENVELOPE_KEY");
        Keystore::load(dir).unwrap()
    }

    /// The migration promise, held: an EMPTY user database under a non-empty journal
    /// replays every frame on open (the journal invariant's second direction, wired
    /// 2026-08-02 after the schema-bump rebuild left empty key trees that the persona
    /// screen misread as departed computers). Write through the real append path, delete
    /// the database file out from under a fresh manager, and the reopened database must
    /// hold the same facts - by validated replay, not by luck.
    #[tokio::test]
    /// Also pins the cheap-probe branch (2026-08-08): the open path stopped reading every
    /// entry's bytes to decide this, and asks `imaol::entries_are_empty` instead - so the
    /// replay firing here is what proves the probe answers the same question the whole-log
    /// read used to.
    async fn empty_db_under_a_nonempty_journal_replays_on_open() {
        let dir = temp_dir().await;
        let key = ringtome_proto::SigningKey::generate(&mut rand::rngs::OsRng);
        let root_hex = hex::encode(key.verifying_key().to_bytes());

        {
            let ks = temp_keystore(&dir);
            let mgr = UserDbManager::new(&dir, ks, 4);
            let db = mgr.create(&root_hex).await.unwrap();
            crate::record::imaol::set_profile_field(&db, &key, "name", "Survivor Sue")
                .await
                .unwrap();
        } // handles drop; the journal holds the frame

        // The operator follows the bail guidance: the database dies, the journal survives.
        for suffix in [".db", ".db-wal", ".db-shm"] {
            let _ = std::fs::remove_file(dir.join("users").join(format!("{root_hex}{suffix}")));
        }

        let ks = temp_keystore(&dir); // same envelope key on disk: same keystore
        let mgr = UserDbManager::new(&dir, ks, 4);
        let db = mgr.create(&root_hex).await.unwrap();
        let profile = crate::record::imaol::get_profile(&db).await.unwrap();
        assert_eq!(
            profile.iter().find(|f| f.field == "name").map(|f| f.value.as_str()),
            Some("Survivor Sue"),
            "the journal replayed the profile through the validated ingest"
        );
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

        // The schema generation is stamped, and a key file was minted for the database.
        let (version,): (i64,) = db.fetch_one("PRAGMA user_version", ()).await.unwrap();
        assert_eq!(version, NODE_SCHEMA_GENERATION);
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
    async fn stale_schema_generation_refuses_with_rebuild_guidance() {
        // Pre-launch policy: an out-of-generation database is refused, never migrated in place.
        let db = test_memory_db().await;
        db.execute("PRAGMA user_version = 1", ()).await.unwrap();

        let err = migrate(&db, USER_SCHEMA, USER_SCHEMA_GENERATION, "user")
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("rebuild"),
            "refusal points at the rebuild path: {err}"
        );

        // A matching stamp is the idempotent-boot no-op; the fresh path stamps the generation.
        let fresh = test_user_db().await;
        migrate(&fresh, USER_SCHEMA, USER_SCHEMA_GENERATION, "user")
            .await
            .unwrap();
        let (version,): (i64,) = fresh.fetch_one("PRAGMA user_version", ()).await.unwrap();
        assert_eq!(version, USER_SCHEMA_GENERATION);
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
        let a = mgr.create("alice_pubkey").await.unwrap();
        let b = mgr.create("bob_pubkey").await.unwrap();

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
        let a2 = mgr.create("alice_pubkey").await.unwrap();
        let (v,): (i64,) = a2.fetch_one("SELECT v FROM probe", ()).await.unwrap();
        assert_eq!(v, 1);

        assert_eq!(mgr.open_count().await, 2);

        // Two files on disk, one per identity, each with its own key file.
        assert!(dir.join("users").join("alice_pubkey.db").exists());
        assert!(dir.join("users").join("bob_pubkey.db").exists());

        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn user_db_handles_ring_the_managers_write_nudge() {
        let dir = temp_dir().await;
        let ks = temp_keystore(&dir);
        let mgr = UserDbManager::new(&dir, ks, 8);
        // Two subscribers - every waiter (the eager loop AND each open stream) must hear one
        // write, which is exactly why the bus is a broadcast and not a single-waiter Notify.
        let mut a = mgr.subscribe_writes();
        let mut b = mgr.subscribe_writes();

        // A well-formed (if fictional) hex root: the manager stamps it onto the handle, and
        // imaol::append's signing gate resolves the key tree with it - a non-hex root would
        // now fail loudly, which is correct for real code and wrong for this fixture.
        let root = "aa".repeat(32);
        let db = mgr.create(&root).await.unwrap();
        db.nudge_sync();

        for (name, rx) in [("a", &mut a), ("b", &mut b)] {
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv())
                .await
                .unwrap_or_else(|_| panic!("subscriber {name} timed out"))
                .expect("subscriber received the nudge");
        }

        // And a bus-less database (tests, node.db) shrugs instead of panicking.
        test_user_db().await.nudge_sync();

        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[tokio::test]
    async fn user_db_journal_writes_ahead_and_backfills_when_missing() {
        let dir = temp_dir().await;
        let ks = temp_keystore(&dir);
        let mgr = UserDbManager::new(&dir, ks, 8);

        // A well-formed (if fictional) hex root: the manager stamps it onto the handle, and
        // imaol::append's signing gate resolves the key tree with it - a non-hex root would
        // now fail loudly, which is correct for real code and wrong for this fixture.
        let root = "aa".repeat(32);
        let db = mgr.create(&root).await.unwrap();
        let key = ringtome_proto::SigningKey::from_bytes(&[5u8; 32]);
        let signed = crate::record::imaol::set_profile_field(&db, &key, "name", "Hats Ahoy")
            .await
            .unwrap();

        // The manager attached the journal, and the append rode through it write-ahead.
        let journal_path = dir.join("journals").join(format!("{root}.jnl"));
        assert_eq!(
            crate::record::journal::read_journal(&journal_path).unwrap(),
            vec![signed.bytes().to_vec()]
        );

        // A vanished journal over a non-empty database: a fresh manager (same files, same
        // keystore) backfills the invariant on open.
        std::fs::remove_file(&journal_path).unwrap();
        let mgr2 = UserDbManager::new(&dir, temp_keystore(&dir), 8);
        mgr2.get(&root).await.unwrap();
        assert_eq!(
            crate::record::journal::read_journal(&journal_path).unwrap(),
            vec![signed.bytes().to_vec()],
            "backfill restored journal ⊇ database"
        );

        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    /// The WAL is a file, and files must stop growing: turso's auto-checkpoint bounds work
    /// (passive backfill) but only TRUNCATE shrinks the log - a fake-network run left a 568MB
    /// WAL over a 12MB database, and every read after it paid the difference. This pins the
    /// mechanism the wal-checkpoint loop rides: write enough to fatten the log, truncate,
    /// and the FILE is measurably near-empty while the data still answers.
    #[tokio::test]
    async fn a_checkpoint_actually_shrinks_the_wal_file() {
        let dir = temp_dir().await;
        let keystore = temp_keystore(&dir);
        let db = open_database(&dir.join("walcheck.db"), &keystore).await.unwrap();
        db.execute("CREATE TABLE fat (id INTEGER PRIMARY KEY, words TEXT)", ())
            .await
            .unwrap();
        for i in 0..300i64 {
            db.execute(
                "INSERT INTO fat (id, words) VALUES (?1, ?2)",
                (i, "x".repeat(2000)),
            )
            .await
            .unwrap();
        }
        let wal = dir.join("walcheck.db-wal");
        let before = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        assert!(before > 100_000, "sanity: the writes fattened the log ({before} bytes)");

        db.checkpoint().await.unwrap();
        let after = std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0);
        assert!(
            after < before / 10,
            "TRUNCATE must cut the file, not just backfill it ({before} -> {after} bytes)"
        );

        // And the data still answers from the main file.
        let (count,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM fat", ()).await.unwrap();
        assert_eq!(count, 300);
    }

    /// Reopening an evicted handle attaches to the journal without re-validating it - the
    /// whole-file read that used to run on every handle-cache miss. Proven by the appends
    /// still landing in order across an eviction, so the reattached handle is a real one.
    #[tokio::test]
    async fn an_evicted_handle_reopens_and_keeps_appending() {
        let dir = temp_dir().await;
        let dir = dir.as_path();
        let key = ringtome_proto::SigningKey::from_bytes(&[11u8; 32]);
        let root_hex = hex::encode(key.verifying_key().to_bytes());
        let mgr = UserDbManager::new(dir, temp_keystore(dir), 4);

        let db = mgr.create(&root_hex).await.unwrap();
        crate::record::imaol::set_profile_field(&db, &key, "name", "First").await.unwrap();
        drop(db);
        // Evict deterministically: capacity eviction is lazy, and a test that only USUALLY
        // reopens is a test that only usually tests anything (found by planting a broken
        // reopen and watching this pass anyway).
        mgr.handles.invalidate(&root_hex).await;
        mgr.handles.run_pending_tasks().await;
        assert_eq!(mgr.open_count().await, 0, "the handle really is gone");

        let db = mgr.create(&root_hex).await.unwrap();
        crate::record::imaol::set_profile_field(&db, &key, "name", "Second").await.unwrap();
        let journal_path = dir.join("journals").join(format!("{root_hex}.jnl"));
        let frames = crate::record::journal::read_journal(&journal_path).unwrap();
        assert_eq!(frames.len(), 2, "both appends are in the journal, across the eviction");
    }
}
