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
        ("schema_ladder", vec!["migrations.rs"]),
        ("push_subscriptions", vec!["webpush.rs"]),
        ("registration_policy", vec!["registration.rs"]),
        ("ingest_job", vec!["ingest.rs"]),
        ("foreign_fetches", vec!["idface.rs"]),
        ("post_replies", vec!["replies.rs"]),
        ("reply_evidence", vec!["replies.rs"]),
        ("comment_curation", vec!["replies.rs"]),
        ("reply_cursors", vec!["replies.rs"]),
        ("doc_annotations", vec!["annotations.rs"]),
        ("post_keys", vec!["postkeys.rs"]),
        ("annotation_proofs", vec!["annotations.rs"]),
        ("persona_frontiers", vec!["net/frontier.rs"]),
        ("chain_heads", vec!["net/frontier.rs"]),
        ("media_bakes", vec!["record/bake.rs"]),
        ("subscriptions", vec!["net/subscriptions.rs"]),
        ("identity_demand", vec!["net/demand.rs"]),
        ("feed_journal", vec!["fanout.rs"]),
        ("post_search", vec!["search.rs"]),
        ("room_messages", vec!["chat.rs"]),
        ("rooms_open", vec!["chat.rs"]),
        ("room_reactions", vec!["chat.rs"]),
        ("room_archives", vec!["chat.rs"]),
        ("node_shelf", vec!["nodeshelf.rs"]),
        ("node_listing", vec!["nodeshelf.rs"]),
        ("node_slugs", vec!["slugs.rs"]),
        ("feed_shares", vec!["fanout.rs"]),
        ("notifications", vec!["notifications.rs"]),
        ("outbound_notices", vec!["outbox.rs"]),
        ("missing_bodies", vec!["net/bodies.rs"]),
        ("persona_profiles", vec!["profiles.rs"]),
        // The rebroadcast family (registered 2026-08-11 - these existed unregistered, which is
        // why the cop said nothing while their SQL wandered). Pins are written by the
        // rebroadcast fold and READ by fanout's share journaling, deliberately: the worklist
        // and its consumer.
        ("rebroadcast_pins", vec!["rebroadcast.rs", "fanout.rs"]),
        ("fragments", vec!["fragments.rs"]),
        ("fragment_deliverers", vec!["fragments.rs"]),
        ("fragment_tombstones", vec!["fragments.rs"]),
        ("fragment_wants", vec!["fragments.rs"]),
        ("fragment_covers", vec!["fragments.rs"]),
        ("death_cursors", vec!["fragments.rs"]),
        // The second-order pair: the assembled published-edge graph (node.db) and the
        // per-persona implicit fold over it (user db). One module owns both because the
        // composition rule - my dial x their band, min of the two - must live in one place.
        ("edge_graph", vec!["edgegraph.rs"]),
        ("implicit_edges", vec!["edgegraph.rs"]),
        // The speculative pass (PROJECT_PLAN's Discovery, slice 1): demand rollup and the quiet-fetch
        // registry, one module - the doctrine (introducer-first, MAX-not-sum, quiet
        // mirrors) is enforced by these tables' shape, so their SQL stays in one place.
        ("speculative_demand", vec!["speculative.rs"]),
        ("speculative_fetches", vec!["speculative.rs"]),
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
        ("fanout.rs", 3),          // journal_page + retract_vanished: ONE author per public-move edge
                                  // + shelf_updated_since: the journal delta, one open per POSTS move (2026-08-28)
        ("identity.rs", 4),
        ("idface.rs", 18), // 18: `onward_sharer_admits` reads the sharer's mirrored chains for the onward hop (Contact tags, ruling 7, 2026-09-18) - once per (holder, key doc, sharer) per request, memoised by the loops; 17: `seal_admits` away from the holder's node reads the holder's edges as the fallback for a persona the lane has not judged - once per (holder, key doc) per request, memoised by the loops (2026-09-14); 16: `seal_admits` is the one gate - one open per (holder, key doc) per request, memoised by every caller that loops (2026-09-10 pm); 18: `seal_key_for` reads a sealed subject's header for whose seal it wears, once per label written (2026-09-10); 17: the body door's "held at all?" probe before a fetch (2026-09-08), once per request; 13: the whole-shelf read behind a search or the facets (2026-09-07); 14: the shares count for the kind row (2026-09-08); 15-16: the seal's holder (`sealed_here`, `trusted_viewer`) - once per request, and once per sealed REPLY on a shelf page (a page, never a persona loop)          // + stored_tree_leaves: ONE mirror per revalidation;
                                  // + id_post annotations: one shelf open per permalink read (2026-08-29)
                                   // + id_post: one open per permalink request (2026-08-25)
        ("ingest.rs", 1),
        ("profiles.rs", 2),        // refresh: ONE persona per claim-change edge
        ("nodeshelf.rs", 2),
        ("chat.rs", 5), // the room post's header (once per door), the memo fold (one persona per CHAT-move edge), the live lane's ingest of one frame into its speaker's database, the archive's answer (one open per speaker on the page) and the reader's attribution check of an archived entry (one per speaker on the page) - CHAT.md slices 2 to 4, 2026-09-18 // the fold's re-say of a hosted persona's shelf (once per move of their chain) and a shared original hosted here (once per distinct original per fold) - PROJECT_PLAN's The node's public face slice 1, 2026-09-15
        ("notifications.rs", 1),   // refresh_from: ONE author per frontier-move edge
        ("inbox.rs", 1),           // accept: ONE recipient per delivered envelope
        ("net/frontier.rs", 1),    // refresh: ONE persona per fingerprint recompute
        // refresh_from: ONE persona per FOLLOWS_PUBLIC frontier move, probe-gated so the
        // overwhelming majority of moves (posts, from people who publish no edges) never
        // reach the open. The notifications.rs shape, for the same reason.
        ("edgegraph.rs", 1),
        ("net/resync.rs", 1),
        // + derive_peers_for: ONE persona's crown per derive edge. The 4th (2026-08-15) is
        // sync_with_peer's exists-check before its create: the shelf is minted only when the
        // peer's Hello claims something to put on it, or the wake pass would mint an empty
        // database per unreachable followed stranger per beat.
        ("net/sync.rs", 4),
        ("record/bake.rs", 1),     // bake_one: ONE persona per external-media job, the ingest pattern
        // One open per SHARE - `fragments::current_version` resolves what head this node holds
        // so a share endorses what the reader actually saw. A human gesture, once, never a loop.
        // Plus one per public frontier MOVE - `mirror_retractions` opens the persona whose
        // chain just moved to mirror its retractions into the death log: per-edge, the
        // rebroadcast::refresh_from pattern, and the handle is hot from the sync that fired it.
        ("fragments.rs", 2),
        // One open per fragment REQUEST - a stranger asking for one document, and the open is
        // how we answer from our own copy of that author's chain. Per-request, not per-persona:
        // the loop this test guards against would be opening every author we hold to answer one
        // question, which is exactly what the (author, doc_id) key avoids.
        ("net/fragment.rs", 3),
        // One open per HELD PERSONA per reaper round (half-hourly; the harness shortens it) -
        // the one legitimate whole-corpus walk: mark-and-sweep is DEFINED as seeing every
        // reference, and any error aborts the run rather than reaping blind.
        ("reaper.rs", 1),
        // One open per HELD PERSONA per BACKUP (backup.rs, 2026-09-25) - the second legitimate
        // whole-corpus walk, and rarer than the reaper's: a person or a supervisor asked for it,
        // and a backup is DEFINED as every database, each copied under its own lock.
        ("backup.rs", 1),
        // One open per REBROADCAST frontier move, not per persona - and gated behind a
        // node.db chain-heads probe first, so the overwhelming majority of moves (from the
        // people who have never shared anything) never reach it. Same shape and same
        // justification as notifications.rs above.
        ("rebroadcast.rs", 1),
        // One EXISTS-probe per acquisition attempt, capped per pass (SPECULATIVE_FETCH_CAP)
        // and network-bound behind a dial - the mint-only-on-substance check ("did the
        // exchange actually leave a mirror?"), never a loop over held personas.
        ("speculative.rs", 1),
        ("record/documents.rs", 1),
        ("record/store.rs", 3), // + open_agented: the sweeps' session-free door, per agented persona once a minute - the journal-fill pass's own cadence
        ("identity/adoption.rs", 2),
        ("identity/routes.rs", 10), // 9: the feed asks the one gate (2026-09-10 pm); 10: the mention gate on a sealed publish reads the seal holder's edges once (2026-09-10); 10 again: a drawing's publish door opens its own persona once per request, as the avatar door does (DRAWING.md, 2026-09-26)
                                   // + resolve_reply_link: one parent-mirror open per reply publish (2026-08-26)
        ("replies.rs", 4),
        // search.rs (2026-09-07): one open when a body is INDEXED - inside the per-request
        // budget, never per candidate; currency is the listing's own stamp.
        ("search.rs", 1),
        ("annotations.rs", 2), // 2: `holder_admits` asks the one gate now (2026-09-10 pm); 3: `holder_admits` - once per DISTINCT seal holder among a page's sealed labels, memoised per request (2026-09-10),     // refresh_inner: ONE shelf open per fold-lane hook, for the annotator folded (2026-08-30)
                                  // + resolve_proof: one annotator-mirror open per served proof, budget-bounded (2026-08-30)         // refresh_inner: ONE shelf open per fold-lane hook, for the
                                  // root being folded - serialized per root, never a persona loop (2026-08-26)
                                  // + curation_refresh_inner: one ledger unseal per ledger-leg fold (2026-08-27)
                                  // + resolve_proof: one mirror open per served proof, page-bounded by the door (2026-08-27)
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

/// Every outbound connection goes through `net::p2p::dial`, which is the only thing that makes the
/// test transport gate (`/test/unplug`) *total* rather than approximate.
///
/// This cop exists because the failure it guards is silent and awful: a seventh dial site that
/// called `endpoint.connect` directly would leave a partition test passing while a whole protocol
/// kept talking through the "partition". The test would then be proving nothing, and saying so
/// confidently. Nothing at runtime can notice that; a grep can.
///
/// The rule is spelled as "`.connect(` appears nowhere but these files", which also catches a
/// future site that spells its receiver differently (`ep.connect`, `self.endpoint.connect`).
#[test]
fn every_outbound_dial_goes_through_the_gate() {
    let expected: BTreeMap<&str, usize> = BTreeMap::from([
        // The gate itself: the one place allowed to open an iroh connection.
        ("net/p2p.rs", 1),
        // A different `connect` entirely - turso opening a local database file, no network in it.
        ("db.rs", 1),
    ]);

    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut found: BTreeMap<String, usize> = BTreeMap::new();
    for path in files {
        let source = std::fs::read_to_string(&path).expect("readable source");
        // Flattened, because these calls are written across three lines as often as one.
        let flat: String = source.chars().filter(|c| !c.is_whitespace()).collect();
        let n = flat.matches(".connect(").count();
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
        "a new `.connect(` call site appeared. If it dials a peer, route it through \
         `net::p2p::dial(&state.unplugged, &state.endpoint, addr, ALPN)` so the transport gate \
         covers it - a dial that bypasses the gate makes every partition test quietly half-true."
    );
}

/// The tag cap, spelled twice: the wire refuses a tag past `MAX_TAG_CHARS`, and the client
/// stops the typing at the same place so a chip the door would refuse never forms. They
/// agree today; if they ever stop, the symptom is not a crash but the exact bug this pins
/// (Curtis, 2026-09-20: a room tagged with a film script, made and quietly untagged).
#[test]
fn the_client_and_the_wire_cap_a_tag_alike() {
    let js = Path::new(env!("CARGO_MANIFEST_DIR")).join("js/pure/annotations.js");
    let source = std::fs::read_to_string(&js).expect("readable js/pure/annotations.js");
    let line = source
        .lines()
        .find(|l| l.contains("export const MAX_TAG_CHARS"))
        .expect("js/pure/annotations.js exports MAX_TAG_CHARS for the tag inputs");
    let said: usize = line
        .split('=')
        .nth(1)
        .and_then(|v| v.trim().trim_end_matches(';').parse().ok())
        .expect("MAX_TAG_CHARS is a plain number");
    assert_eq!(
        said,
        ringtome_proto::PublicAnnotation::MAX_TAG_CHARS,
        "the client's tag cap and the wire's must be the same number, or an input lets \
         somebody type a label the door will refuse and nothing says so"
    );
}

/// The binary stays thin (DESKTOP.md, Stage 1). There is one node, assembled in one place: the
/// library's `run`. The moment `main.rs` grows its own `AppState { ... }` or its own
/// `Router::new()`, there are two nodes - the one `just ci` tests and the one the desktop shell
/// boots - and they drift silently, because nothing fails when a route is mounted in only one of
/// them. The binary's job is the command line: subcommands, the config's source, the subscriber.
#[test]
fn the_binary_assembles_no_node_of_its_own() {
    let main = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/main.rs");
    let source = std::fs::read_to_string(&main).expect("readable src/main.rs");
    for needle in ["AppState {", "Router::new(", ".route(", "TcpListener::bind"] {
        assert!(
            !source.contains(needle),
            "src/main.rs contains `{needle}` - the node is assembled in the library (`run`), \
             and a second assembly here is one the desktop shell would never run"
        );
    }
    assert!(
        source.lines().count() < 80,
        "src/main.rs is {} lines. It is the command line's entry point, not a composition \
         root - if it is growing, the thing it grew belongs in the library beside `run`",
        source.lines().count()
    );
}

/// The desktop workspace keeps the root's dev profile (2026-09-22).
///
/// `desktop/` is its own workspace so the gates never build Tauri - and a separate workspace
/// inherits no profile tables, which is not a nicety here: `[profile.dev.package."*"]` and the
/// rav1e/rav1d overrides are what keep a debug build's codecs from being ten to thirty times
/// slower. Without them the node inside the app took 4.2 SECONDS to encode an 11KB picture that
/// the `ringtome` binary encoded in 187ms, and it read as "Tauri is slow" until it was measured.
/// Drift between these two files is silent and expensive, so it is a test.
#[test]
fn the_desktop_workspace_keeps_the_dev_profile() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.toml");
    let desktop = Path::new(env!("CARGO_MANIFEST_DIR")).join("../desktop/Cargo.toml");
    let profiles = |path: &Path| -> BTreeMap<String, String> {
        let source = std::fs::read_to_string(path).expect("readable Cargo.toml");
        let mut out = BTreeMap::new();
        let mut table: Option<String> = None;
        for line in source.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                table = line.starts_with("[profile.dev").then(|| line.to_string());
                continue;
            }
            if let (Some(t), true) = (&table, !line.is_empty() && !line.starts_with('#')) {
                out.insert(format!("{t} {}", line.split('=').next().unwrap().trim()), line.to_string());
            }
        }
        out
    };
    assert_eq!(
        profiles(&root),
        profiles(&desktop),
        "the desktop workspace's dev profile no longer matches the root's. A separate workspace \
         inherits nothing, and what these tables buy is codecs that are not thirty times slower \
         inside the app than they are in the binary."
    );
}

/// One release, one number (Curtis, 2026-09-22). Six files spell the version and they must agree:
/// a desktop bundle whose Cargo version disagrees with its `tauri.conf.json` version gives two
/// answers to "what is running", and the updater believes the wrong one - it compares what the
/// bundle claims against what the manifest offers. `just release-*` writes all six together;
/// this is what catches the hand-edit that writes one. The supervisor is one of them because it
/// adopts the node it shipped beside AS ITS OWN VERSION (supervisor/src/install.rs, `adopt`).
#[test]
fn every_file_that_spells_the_version_agrees() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let spots: [(&str, &str); 6] = [
        ("node/Cargo.toml", "version = \""),
        ("proto/Cargo.toml", "version = \""),
        ("supervisor/Cargo.toml", "version = \""),
        ("desktop/Cargo.toml", "version = \""),
        ("desktop/tauri.conf.json", "\"version\": \""),
        ("node/js/package.json", "\"version\": \""),
    ];
    let mut said: BTreeMap<&str, String> = BTreeMap::new();
    for (file, needle) in spots {
        let source = std::fs::read_to_string(root.join(file)).expect("readable versioned file");
        // The FIRST occurrence: in a Cargo.toml that is `[package] version`, and in a package.json
        // the manifest's own version rather than a dependency's.
        let at = source.find(needle).unwrap_or_else(|| panic!("no version in {file}"));
        let rest = &source[at + needle.len()..];
        let end = rest.find('"').expect("a closing quote");
        said.insert(file, rest[..end].to_string());
    }
    let first = said.values().next().expect("six files").clone();
    assert!(
        said.values().all(|v| *v == first),
        "the version is spelled differently in different files: {said:?}. `just release-*` writes \
         them together; a hand-edit that writes one leaves the app disagreeing with itself."
    );
}

/// A released migration rung never changes (src/migrations.rs): every machine that ran the
/// release has climbed it, so an edit would make fresh databases and old ones two different
/// schemas under one stamp. `migrations/released.txt` is the pin `just release-*` writes, and
/// this is what holds it - including against a comment fix, because the node's own record of a
/// climbed rung is a hash of the whole file too.
#[test]
fn released_migrations_never_change() {
    use sha2::{Digest, Sha256};
    let migrations = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let pins = std::fs::read_to_string(migrations.join("released.txt")).expect("the pin file");
    let mut pinned = 0;
    for line in pins.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with('#')) {
        let (file, want) = line.split_once(' ').expect("`<kind>/<file> <sha256>`");
        let bytes = std::fs::read(migrations.join(file))
            .unwrap_or_else(|_| panic!("released rung {file} is gone; a shipped rung is never deleted"));
        let have = hex::encode(Sha256::digest(&bytes));
        assert_eq!(
            have,
            want.trim(),
            "released rung {file} has changed since it shipped. Put the file back and write the \
             change as a NEW rung (migrations/README.md)."
        );
        pinned += 1;
    }
    assert!(pinned >= 2, "both baselines are pinned");
}
