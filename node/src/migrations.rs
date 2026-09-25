//! The migration ladders: how a database written by one release becomes the database the next
//! release expects, in place, without losing anything.
//!
//! **Why this exists (2026-09-23).** Until the first release, schema changes were squashed into
//! one file per database and a mismatched stamp was refused with "delete it and rebuild" - the
//! User-1 rule (STYLE.md), correct while no database mattered. Releases 0.1.0-0.1.2 put a real
//! node on Curtis's machine, and from here every schema change ships as a new rung on a ladder
//! rather than an edit to the old file. There is one ladder per database kind (`NODE`, `USER`),
//! and a rung is one SQL file under `migrations/<kind>/`, numbered densely.
//!
//! **The baseline continues the old count.** The first rung of each ladder is the squashed
//! schema exactly as 0.1.x shipped it, numbered at the generation that schema was stamped with
//! (node 53, user 26). So every database a release ever wrote is ALREADY on its ladder with no
//! special case, and a pre-ladder dev database (a smaller stamp) is refused with the old
//! rebuild guidance, which is still the truth about it.
//!
//! **What a climb promises.**
//! - Each rung applies in its own transaction together with its stamp (`PRAGMA user_version`)
//!   and its row in `schema_ladder`. A failing rung leaves the database on the rung before it,
//!   never halfway through.
//! - A database stamped ABOVE this build's top rung was written by a newer build, and is
//!   refused. Nothing here migrates down: a rung has no inverse, and guessing one is how data is
//!   lost.
//! - **A rung is frozen once any database has climbed it.** `schema_ladder` records the
//!   BLAKE3 of every rung a database applied, and a rung whose text has changed since then is
//!   refused. For a released rung this can't happen - `migrations/released.txt` pins them, and
//!   `tests/conventions.rs` holds the pin - so in practice it catches the dev case: a rung
//!   edited after this machine's dev node already ran it, whose database would otherwise
//!   silently disagree with the file.
//!
//! **Chains are not migrated; their views are.** Chain entries are signed bytes that never
//! change (PROJECT_PLAN, Canonical Encoding: never re-serialize), so the wire format evolves by
//! adding fields and types, never by rewriting. What a release CAN change is how entries fold
//! into the user database's views - and a view is disposable, so a rung that changes one names
//! the services that feed it in `refold`. The climb drops those views and their watermarks in
//! the rung's transaction, and each view refolds itself from the entries on its next read (the
//! machinery forgery eviction already uses, `imaol::refold_after_eviction`). A rung that adds a
//! view column derived from an entry header is `ALTER TABLE ... ADD COLUMN` plus a refold of
//! its services: the column fills itself from the chains.
//!
//! **What the node ladder cannot do yet.** Node rungs are SQL only. `node.db` holds memos
//! written at fold time from many personas' chains (the feed journal, the room lane), and a
//! rung that needed to re-derive one would have to open every user database - a code rung. The
//! first node change that needs one should grow it here, shaped against that change.

use anyhow::{anyhow, bail, Context, Result};

use crate::db::Db;

/// One step on a ladder: the SQL that takes a database from the rung before to this one.
#[derive(Clone, Copy, Debug)]
pub struct Rung {
    /// The stamp a database carries once this rung has applied. Dense: each rung is one more
    /// than the last, and the file name starts with it (`0054_...`).
    pub version: i64,
    /// The rung's file name under `migrations/<kind>/` - what an error names, and what
    /// `schema_ladder` records.
    pub name: &'static str,
    /// The file's text, embedded at compile time.
    pub sql: &'static str,
    /// Services whose views this rung invalidates (user ladder only): their views and
    /// watermarks are dropped in the rung's transaction, and refold from the chains on the next
    /// read. Empty for a rung that changes no view's derivation.
    pub refold: &'static [u32],
}

/// The ladder for `node.db`.
pub const NODE: &[Rung] = &[
    Rung {
        version: 53,
        name: "0053_baseline.sql",
        sql: include_str!("../migrations/node/0053_baseline.sql"),
        refold: &[],
    },
    Rung {
        version: 54,
        name: "0054_push_subscriptions.sql",
        sql: include_str!("../migrations/node/0054_push_subscriptions.sql"),
        refold: &[],
    },
];

/// The ladder for the per-user databases (`data/users/<root>.db`).
pub const USER: &[Rung] = &[Rung {
    version: 26,
    name: "0026_baseline.sql",
    sql: include_str!("../migrations/user/0026_baseline.sql"),
    refold: &[],
}];

/// The ladder's own record, created by the climb rather than by any rung so that it exists
/// the same way in every database, baseline included.
const LADDER_TABLE: &str = "CREATE TABLE IF NOT EXISTS schema_ladder (
    version       INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    checksum      TEXT    NOT NULL,  -- BLAKE3 hex of the rung's SQL as it was applied
    applied_at_ms INTEGER NOT NULL,
    applied_by    TEXT    NOT NULL   -- the build's version; 'adopted' for a rung a database
                                     -- carried before the ladder existed
)";

/// A rung's fingerprint: BLAKE3 of its text, hex - the system's one hash (PROJECT_PLAN,
/// Canonical Encoding).
fn checksum(rung: &Rung) -> String {
    blake3::hash(rung.sql.as_bytes()).to_hex().to_string()
}

/// Bring `db` to the top of `ladder`: a fresh database climbs every rung, an existing one
/// climbs the rungs above its stamp, and one at the top only has its record checked. `what`
/// names the database kind in errors ("node", "user").
pub async fn climb(db: &Db, ladder: &[Rung], what: &str) -> Result<()> {
    let (Some(baseline), Some(top)) = (ladder.first(), ladder.last()) else {
        bail!("the {what} ladder has no rungs");
    };
    let (stamp,): (i64,) = db
        .fetch_one("PRAGMA user_version", ())
        .await
        .context("reading the schema stamp")?;

    if stamp > top.version {
        bail!(
            "{what} database is at migration {stamp}, and this build only knows up to {}; it \
             was written by a newer Ringtome - run that build (nothing here migrates down)",
            top.version
        );
    }
    if stamp != 0 && stamp < baseline.version {
        bail!(
            "{what} database is schema generation {stamp}, from before the migration ladder \
             began at {}; delete the database and rebuild (per-user data replays from its \
             journal or re-syncs from a peer)",
            baseline.version
        );
    }

    db.execute(LADDER_TABLE, ())
        .await
        .context("creating the schema_ladder table")?;
    if stamp != 0 {
        check_climbed(db, ladder, stamp, what).await?;
    }
    for rung in ladder.iter().filter(|r| r.version > stamp) {
        apply(db, rung)
            .await
            .with_context(|| format!("applying {what} migration {}", rung.name))?;
        if stamp != 0 {
            tracing::info!(db = what, rung = rung.name, "migrated");
        }
    }
    Ok(())
}

/// Hold an existing database's record against the ladder: every rung it has climbed must be
/// the rung this build carries, byte for byte. A rung with no record is one the database
/// carried from before the ladder existed (the baseline, on a database 0.1.x wrote) - it is
/// adopted as it stands, because there is no other truth about it to compare.
async fn check_climbed(db: &Db, ladder: &[Rung], stamp: i64, what: &str) -> Result<()> {
    let recorded: Vec<(i64, String)> = db
        .fetch_all("SELECT version, checksum FROM schema_ladder", ())
        .await
        .context("reading the schema_ladder record")?;
    for rung in ladder.iter().filter(|r| r.version <= stamp) {
        match recorded.iter().find(|(version, _)| *version == rung.version) {
            Some((_, was)) if *was == checksum(rung) => {}
            Some(_) => bail!(
                "{what} migration {} has changed since this database applied it. A released rung \
                 never changes (migrations/released.txt); if this is an unreleased rung edited \
                 during development, delete this dev database and rebuild",
                rung.name
            ),
            None => {
                db.execute(
                    "INSERT INTO schema_ladder (version, name, checksum, applied_at_ms, applied_by)
                     VALUES (?1, ?2, ?3, ?4, 'adopted')",
                    (rung.version, rung.name, checksum(rung), crate::clock::now_ms()),
                )
                .await
                .context("adopting a pre-ladder rung")?;
            }
        }
    }
    Ok(())
}

/// One rung, whole or not at all: its SQL, its refold, its record and its stamp share a
/// transaction.
async fn apply(db: &Db, rung: &Rung) -> Result<()> {
    db.execute("BEGIN", ())
        .await
        .context("starting the migration transaction")?;
    let applied: Result<()> = async {
        db.execute_batch(rung.sql).await.context("running the rung's SQL")?;
        if !rung.refold.is_empty() {
            let services: std::collections::BTreeSet<u32> = rung.refold.iter().copied().collect();
            crate::record::imaol::refold_after_eviction(db, &services)
                .await
                .map_err(|e| anyhow!("dropping the views this rung invalidates: {e}"))?;
        }
        db.execute(
            "INSERT INTO schema_ladder (version, name, checksum, applied_at_ms, applied_by)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            (
                rung.version,
                rung.name,
                checksum(rung),
                crate::clock::now_ms(),
                env!("CARGO_PKG_VERSION"),
            ),
        )
        .await
        .context("recording the rung")?;
        // PRAGMA takes no bound parameters; the value is an i64 from a const table.
        db.execute(&format!("PRAGMA user_version = {}", rung.version), ())
            .await
            .context("stamping the rung")?;
        Ok(())
    }
    .await;
    match applied {
        Ok(()) => db
            .execute("COMMIT", ())
            .await
            .context("committing the rung")
            .map(|_| ()),
        Err(e) => {
            let _ = db.execute("ROLLBACK", ()).await;
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn stamp_of(db: &Db) -> i64 {
        db.fetch_one::<(i64,)>("PRAGMA user_version", ()).await.unwrap().0
    }

    /// A toy ladder over a toy table, so the climb's rules are tested apart from the real schema.
    const WIDGETS: &[Rung] = &[
        Rung {
            version: 7,
            name: "0007_widgets.sql",
            sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);",
            refold: &[],
        },
        Rung {
            version: 8,
            name: "0008_widget_colour.sql",
            sql: "ALTER TABLE widgets ADD COLUMN colour TEXT NOT NULL DEFAULT 'beige';",
            refold: &[],
        },
    ];

    #[tokio::test]
    async fn a_fresh_database_climbs_every_rung_and_records_each() {
        let db = crate::db::test_memory_db().await;
        climb(&db, WIDGETS, "toy").await.unwrap();
        assert_eq!(stamp_of(&db).await, 8);
        let recorded: Vec<(i64, String, String)> = db
            .fetch_all("SELECT version, name, applied_by FROM schema_ladder ORDER BY version", ())
            .await
            .unwrap();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[1].1, "0008_widget_colour.sql");
        assert_eq!(recorded[1].2, env!("CARGO_PKG_VERSION"));
        // And climbing again at the top is a no-op, not an error.
        climb(&db, WIDGETS, "toy").await.unwrap();
    }

    /// The point of the whole module: rows written under the old rung survive the new one.
    #[tokio::test]
    async fn an_existing_database_climbs_in_place_and_keeps_its_rows() {
        let db = crate::db::test_memory_db().await;
        climb(&db, &WIDGETS[..1], "toy").await.unwrap();
        db.execute("INSERT INTO widgets (label) VALUES ('sprocket')", ())
            .await
            .unwrap();
        climb(&db, WIDGETS, "toy").await.unwrap();
        let (label, colour): (String, String) = db
            .fetch_one("SELECT label, colour FROM widgets", ())
            .await
            .unwrap();
        assert_eq!((label.as_str(), colour.as_str()), ("sprocket", "beige"));
        assert_eq!(stamp_of(&db).await, 8);
    }

    #[tokio::test]
    async fn a_failing_rung_leaves_the_database_on_the_rung_before() {
        let db = crate::db::test_memory_db().await;
        climb(&db, &WIDGETS[..1], "toy").await.unwrap();
        let broken = [
            WIDGETS[0],
            Rung {
                version: 8,
                name: "0008_broken.sql",
                sql: "CREATE TABLE gears (id INTEGER PRIMARY KEY); ALTER TABLE nowhere ADD COLUMN x TEXT;",
                refold: &[],
            },
        ];
        let err = climb(&db, &broken, "toy").await.unwrap_err();
        assert!(format!("{err:#}").contains("0008_broken.sql"), "{err:#}");
        assert_eq!(stamp_of(&db).await, 7, "the stamp did not move");
        let gears: Option<(String,)> = db
            .fetch_optional("SELECT name FROM sqlite_master WHERE name = 'gears'", ())
            .await
            .unwrap();
        assert!(gears.is_none(), "the rung's first statement rolled back with the rest");
    }

    #[tokio::test]
    async fn a_database_from_a_newer_build_is_refused() {
        let db = crate::db::test_memory_db().await;
        climb(&db, WIDGETS, "toy").await.unwrap();
        let err = climb(&db, &WIDGETS[..1], "toy").await.unwrap_err();
        assert!(err.to_string().contains("newer Ringtome"), "{err}");
    }

    #[tokio::test]
    async fn a_pre_ladder_database_gets_the_rebuild_guidance() {
        let db = crate::db::test_memory_db().await;
        db.execute("PRAGMA user_version = 3", ()).await.unwrap();
        let err = climb(&db, WIDGETS, "toy").await.unwrap_err();
        assert!(err.to_string().contains("delete the database and rebuild"), "{err}");
    }

    #[tokio::test]
    async fn a_rung_edited_after_it_was_climbed_is_refused() {
        let db = crate::db::test_memory_db().await;
        climb(&db, WIDGETS, "toy").await.unwrap();
        let edited = [
            WIDGETS[0],
            Rung {
                sql: "ALTER TABLE widgets ADD COLUMN colour TEXT NOT NULL DEFAULT 'mauve';",
                ..WIDGETS[1]
            },
        ];
        let err = climb(&db, &edited, "toy").await.unwrap_err();
        assert!(err.to_string().contains("has changed since"), "{err}");
    }

    /// What every database 0.1.x wrote looks like: stamped at the baseline, no ladder record.
    /// It must climb as if it had been on the ladder all along.
    #[tokio::test]
    async fn a_database_from_before_the_ladder_is_adopted_at_its_stamp() {
        let db = crate::db::test_memory_db().await;
        db.execute_batch(WIDGETS[0].sql).await.unwrap();
        db.execute("PRAGMA user_version = 7", ()).await.unwrap();
        climb(&db, WIDGETS, "toy").await.unwrap();
        let recorded: Vec<(i64, String)> = db
            .fetch_all("SELECT version, applied_by FROM schema_ladder ORDER BY version", ())
            .await
            .unwrap();
        assert_eq!(recorded[0], (7, "adopted".to_string()));
        assert_eq!(recorded[1].0, 8);
    }

    /// The shape rules no compiler checks: dense versions, file names that start with them,
    /// every file on disk on its ladder (a rung written but never listed would never run), and
    /// refolds that name real services.
    #[test]
    fn each_ladder_matches_its_directory() {
        for (kind, ladder) in [("node", NODE), ("user", USER)] {
            for pair in ladder.windows(2) {
                assert_eq!(pair[1].version, pair[0].version + 1, "{kind} rungs are dense");
            }
            for rung in ladder {
                assert!(
                    rung.name.starts_with(&format!("{:04}_", rung.version)),
                    "{kind} rung {} is numbered {}",
                    rung.name,
                    rung.version
                );
                for s in rung.refold {
                    assert!(crate::record::imaol::every_service().contains(s), "{kind} rung {} refolds unknown service {s}", rung.name);
                }
                if kind == "node" {
                    assert!(rung.refold.is_empty(), "node rungs cannot refold (see the module doc)");
                }
            }
            let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations").join(kind);
            let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".sql"))
                .collect();
            on_disk.sort();
            let listed: Vec<String> = ladder.iter().map(|r| r.name.to_string()).collect();
            assert_eq!(on_disk, listed, "every .sql in migrations/{kind} is a rung on the {kind} ladder");
        }
    }
}
