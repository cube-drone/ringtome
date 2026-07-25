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
        ("identity_peers", vec!["net/sync.rs"]),
        ("boot_timestamps", vec!["db.rs"]),
        ("ingest_job", vec!["ingest.rs"]),
        ("_sqlx_migrations", vec!["db.rs"]),
        // per-user DBs. `entries` is protocol law: local authorship (imaol) + the sync gate.
        ("entries", vec!["record/imaol.rs", "net/sync.rs"]),
        ("profile_view", vec!["record/imaol.rs"]),
        // persisted materialized views: each fold's SQL lives with the code
        // that owns the decrypted domain; the shared watermark bookkeeping lives in imaol.
        ("doc_versions", vec!["record/documents.rs"]),
        ("doc_heads", vec!["record/documents.rs"]),
        ("doc_search", vec!["record/documents.rs"]),
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
