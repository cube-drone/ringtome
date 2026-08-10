//! The architecture cop: data-access barriers enforced as a test, not a registry.
//!
//! The convention (node/README.md): cross-module data access goes through the owning module's
//! public functions; raw SQL for a table lives only in that table's owner. This test greps the
//! source for SQL-shaped references to each known table outside its owner and fails with
//! directions. It is the deliberate anti-ServiceRegistry - architectural enforcement with zero
//! runtime existence (see API_OLD.md for the cautionary tale this replaces).
//!
//! The `entries` table is the iron case: rows appear only via `imaol::append` (local authorship)
//! or the sync gate (validated arrival). A stray `INSERT INTO entries` anywhere else is a forged
//! history waiting to happen.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// table name -> source files allowed to write SQL naming it (paths relative to `src/`).
fn owners() -> BTreeMap<&'static str, Vec<&'static str>> {
    BTreeMap::from([
        // node.db
        ("accounts", vec!["auth.rs"]),
        ("sessions", vec!["auth.rs"]),
        ("account_tags", vec!["auth.rs"]),
        ("identities", vec!["identity.rs"]),
        ("pending_adoptions", vec!["identity/adoption.rs"]),
        // The frontier columns on identity_peers are frontier concepts; the peer bookkeeping
        // around them stays sync's.
        ("identity_peers", vec!["net/sync.rs", "net/frontier.rs"]),
        ("boot_timestamps", vec!["db.rs"]),
        ("ingest_job", vec!["ingest.rs"]),
        ("foreign_fetches", vec!["idface.rs"]),
        ("persona_frontiers", vec!["net/frontier.rs"]),
        ("chain_heads", vec!["net/frontier.rs"]),
        ("media_bakes", vec!["record/bake.rs"]),
        ("subscriptions", vec!["net/subscriptions.rs"]),
        ("identity_demand", vec!["net/demand.rs"]),
        ("feed_journal", vec!["fanout.rs"]),
        ("notifications", vec!["notifications.rs"]),
        ("outbound_notices", vec!["outbox.rs"]),
        ("missing_bodies", vec!["net/bodies.rs"]),
        ("persona_profiles", vec!["profiles.rs"]),
        ("_sqlx_migrations", vec!["db.rs"]),
        // per-user DBs. `entries` is protocol law: local authorship (imaol) + the sync gate.
        ("entries", vec!["record/imaol.rs", "net/sync.rs"]),
        ("equivocations", vec!["net/sync.rs"]),
        ("profile_view", vec!["record/imaol.rs"]),
        ("published_edges", vec!["record/imaol.rs"]),
        // persisted materialized views: each fold's SQL lives with the code
        // that owns the decrypted domain; the shared watermark bookkeeping lives in imaol.
        ("doc_versions", vec!["record/documents.rs"]),
        ("doc_heads", vec!["record/documents.rs"]),
        ("doc_search", vec!["record/documents.rs"]),
        ("inbox_notices", vec!["inbox.rs"]),
        ("private_registers", vec!["record/private.rs"]),
        ("private_set_elements", vec!["record/private.rs"]),
        ("view_watermarks", vec!["record/imaol.rs"]),
    ])
}

/// SQL-shaped patterns that indicate a real query against a table (uppercase keywords keep
/// prose in comments from matching).
const PATTERNS: [&str; 5] = ["FROM {}", "INTO {}", "UPDATE {}", "JOIN {}", "TABLE {}"];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("readable source dir") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn sql_stays_in_its_owning_module() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    assert!(
        files.len() > 5,
        "sanity: expected to scan the actual source tree"
    );

    let mut violations = Vec::new();
    for path in &files {
        let content = std::fs::read_to_string(path).expect("readable source file");
        let rel = path
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for (table, allowed) in owners() {
            if allowed.iter().any(|a| rel == *a) {
                continue;
            }
            for pattern in PATTERNS {
                let needle = pattern.replace("{}", table);
                if content.contains(&needle) {
                    violations.push(format!(
                        "src/{rel}: `{needle}` - table `{table}` is owned by {allowed:?}; \
                         call the owning module's functions instead"
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "data-access convention violations (see node/README.md):\n  {}",
        violations.join("\n  ")
    );
}

/// Opening a user database is a PER-FILE act, and this test makes each place that does it a
/// deliberate one.
///
/// The hazard it guards (found live, 2026-08-05): per-user databases are separate encrypted
/// files behind a capped handle cache, so a loop that calls `user_dbs.get` per item - a roster
/// joining every contact's name, a feed joining every author's byline - thrashes the cache
/// opening files to answer a question a node-level memo answers in one query. The contacts
/// join shipped exactly that way and ran in production until a design conversation happened to
/// walk past it; the suite was green the whole time, because thrash is slow, not wrong.
///
/// A grep cannot see "inside a loop", so this pins the next best thing: the exact set of call
/// sites. Adding one fails this test until the count is bumped HERE, and the bump is the
/// moment to answer one question: is the new call inside anything iterating over personas?
/// If it is, you want a memo table (persona_frontiers, subscriptions, persona_profiles,
/// feed_journal are the four precedents) - the fold writes it once, and lists read the memo.
///
/// All THREE opening verbs count (`get`, `held`, `create` - 2026-08-08): thrash is about
/// opening a file per item, and it does not care which door you came through. The separate
/// MINTING hazard those verbs split apart is now the type system's job, not this test's -
/// `get` returns `Option`, so a read path can no longer create a database by forgetting to
/// check. `create_sites_stay_rare` below pins what is left of it.
#[test]
fn user_db_opens_are_deliberate() {
    let expected: BTreeMap<&str, usize> = BTreeMap::from([
        ("fanout.rs", 2),          // journal_page + retract_vanished: ONE author per public-move edge
        ("identity.rs", 4),
        ("idface.rs", 5),          // + stored_tree_leaves: ONE mirror per revalidation
        ("ingest.rs", 1),
        ("profiles.rs", 1),        // refresh: ONE persona per claim-change edge
        ("notifications.rs", 1),   // refresh_from: ONE author per frontier-move edge
        ("inbox.rs", 1),           // accept: ONE recipient per delivered envelope
        ("net/frontier.rs", 1),    // refresh: ONE persona per fingerprint recompute
        ("net/resync.rs", 1),
        ("net/sync.rs", 3),        // + derive_peers_for: ONE persona's crown per derive edge
        ("record/bake.rs", 1),     // bake_one: ONE persona per external-media job, the ingest pattern
        ("record/documents.rs", 1),
        ("record/store.rs", 2),
        ("identity/adoption.rs", 2),
        ("identity/routes.rs", 5),
    ]);

    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut found: BTreeMap<String, usize> = BTreeMap::new();
    for path in files {
        let source = std::fs::read_to_string(&path).expect("readable source");
        // Whitespace-stripped before counting: the newest call sites are line-wrapped
        // (`state\n.user_dbs\n.get`), and a line-based grep undercounts exactly the files
        // most recently added - which is how this test's own survey was wrong on its first
        // draft.
        let flat: String = source.chars().filter(|c| !c.is_whitespace()).collect();
        let n = flat.matches("user_dbs.get(").count()
            + flat.matches("user_dbs.held(").count()
            + flat.matches("user_dbs.create(").count();
        if n > 0 {
            let rel = path
                .strip_prefix(&src)
                .expect("path under src")
                .to_string_lossy()
                .replace('\\', "/");
            found.insert(rel, n);
        }
    }
    let found_ref: BTreeMap<&str, usize> =
        found.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    assert_eq!(
        found_ref, expected,
        "user-db call sites changed. If the new call runs once per request or per edge, bump \
         the count here and move on; if it runs once per PERSONA in a loop, stop - that is the \
         thrash this test exists to catch, and the answer is a node-level memo table."
    );
}

/// Minting a user database is rarer still, and this pins it.
///
/// `UserDbs::get` returns `Option` precisely so a READ path cannot create a database by
/// forgetting a precondition - which two of them did, silently, until the files turned up on
/// disk (2026-08-08: ~96 KB of empty database, WAL and journal per stranger a contact list
/// mentioned, a whole ledger's worth on a device adopting one). `create` is the deliberate
/// other half, and there should only ever be a handful: the paths that are the REASON a
/// persona's data is about to exist here.
///
/// If this count goes up, the question to answer is "am I the reason this persona's data is
/// arriving, or am I just reading?" - and if it is the second, `get` (or `held`) is the verb.
#[test]
fn create_sites_stay_rare() {
    let expected: BTreeMap<&str, usize> = BTreeMap::from([
        ("identity.rs", 1),  // create: a new persona's own database, minted at birth
        ("net/sync.rs", 2),  // both ends of an exchange: a first fetch, and the responder
    ]);

    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut found: BTreeMap<String, usize> = BTreeMap::new();
    for path in files {
        let source = std::fs::read_to_string(&path).expect("readable source");
        let flat: String = source.chars().filter(|c| !c.is_whitespace()).collect();
        let n = flat.matches("user_dbs.create(").count();
        if n > 0 {
            let rel = path
                .strip_prefix(&src)
                .expect("path under src")
                .to_string_lossy()
                .replace('\\', "/");
            found.insert(rel, n);
        }
    }
    let found_ref: BTreeMap<&str, usize> = found.iter().map(|(k, v)| (k.as_str(), *v)).collect();
    assert_eq!(
        found_ref, expected,
        "database-MINTING call sites changed. A read path must never be one: `get` returns \
         Option so absence is an answer, and `held` is for personas whose absence is a bug."
    );
}
