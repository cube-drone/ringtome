//! The speculative pass at posts depth (DISCOVERY.md slice 1, 2026-08-21): demand and quiet
//! acquisition for strangers a reader's trust admits but nobody here follows.
//!
//! Two halves, one doctrine:
//!
//!   - **`speculative_demand`** (node.db) - the rollup over each hosted reader's
//!     `implicit_edges`: top-K targets per reader by composed level, promiscuity-discounted,
//!     MAX across introducers and never sums (the Sybil doctrine - a thousand fake vouches
//!     are worth one best path), capped by the acquisition budget. Each row carries the BEST
//!     introducer, because the introducer is the dial target in acquisition and the byline
//!     in display. Written by the implicit fold's own pass and stamp-swept with it, so decay
//!     is free: a withdrawn vouch recedes here on the beat it recedes from `implicit_edges`.
//!
//!   - **the acquisition pass** - for each admitted target, pull their public chains through
//!     the INTRODUCER's endpoints first (their node provably fronts everyone they follow,
//!     and asking a friend discloses only to that friend), the target's own machinery as
//!     fallback - never first while an introducer path exists (DISCOVERY.md invariants).
//!     The mirror is QUIET: `speculative_fetches` is deliberately not `foreign_fetches`,
//!     because that registry opens the sync door and seats personas in the directory, and a
//!     speculative mirror serves nobody and announces nothing. Freshness is our own slow
//!     beat at lower priority than real follows - speculative content is allowed to be
//!     hours stale; that is part of what makes it cheap.
//!
//! Promotion is clean: the moment a reader turns a real dial on a surfaced persona, the
//! rollup excludes the pair (explicit beats implicit) and the ordinary follow machinery
//! takes over. Eviction of the mirror itself is DISCOVERY slice 4, deliberately not here.

use std::collections::{BTreeSet, HashMap, HashSet};

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// How many strangers' chains this node will hold per reader, no matter how bushy the
/// friends' vouching gets. A cap, not a pacing suggestion: it holds under adversarial
/// vouching because the rollup ranks by best-single-path, never by path count.
const SPECULATIVE_BUDGET: usize = 16;
/// Pulls started per pass - below `idface::FOLLOW_REFRESH_CAP`, because real follows are
/// chosen relationships and this pool is a hunch.
const SPECULATIVE_FETCH_CAP: usize = 4;
/// A speculative mirror this stale gets a refresh pull. Hours on purpose (the follow
/// staleness window is minutes): staleness tolerance is what makes speculation cheap.
const SPECULATIVE_STALE_MS: i64 = 6 * 60 * 60 * 1000;
/// How long an attempted target rests before the pass tries it again, success or failure -
/// the `FOLLOW_ATTEMPT_COOLDOWN_MS` rotation, for the same partition-starvation reason.
const SPECULATIVE_ATTEMPT_COOLDOWN_MS: i64 = 5 * 60 * 1000;
/// Per-candidate ceiling on a dial-and-sync, the `idface::FETCH_TIMEOUT` discipline.
const SPECULATIVE_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);
/// Rows per multi-row upsert (the fanout/subscriptions batching discipline).
const DEMAND_CHUNK_ROWS: usize = 150;

/// In-memory attempt stamps for the cooldown rotation. Boot-reset by design: the first pass
/// after boot may retry everything once, which is what a booting node wants.
static SPECULATIVE_ATTEMPTS: std::sync::Mutex<Option<HashMap<String, i64>>> =
    std::sync::Mutex::new(None);

/// Forget the attempt stamps, so the next `acquire_pass` retries every target - the test
/// beat's "acquire NOW" (test_endpoints); the boot-reset semantics, on demand.
pub fn reset_attempt_stamps() {
    *SPECULATIVE_ATTEMPTS.lock().expect("attempt marks poisoned") = None;
}

/// One composed implicit edge, as the implicit fold hands it to the rollup - the same five
/// facts `implicit_edges` stores, still in hand as values (STYLE: name the tuple).
pub struct ComposedEdge<'a> {
    pub target: &'a str,
    pub lane: &'static str,
    pub introducer: &'a str,
    /// Band ordinal, already min-composed (my dial x their published band).
    pub level: i64,
    /// The introducer's outbound vouch count on this lane - the discount's raw input.
    pub introducer_vouches: i64,
}

/// A band ordinal back to its word - proto's ladder is the one source of truth (the
/// `edgegraph::band_word` twin; three lines beats a cross-module export of a formatting rung).
fn band_word(ordinal: i64) -> &'static str {
    ringtome_proto::PublicEdge::BANDS[ordinal.clamp(0, 4) as usize]
}

/// The banded promiscuity discount: a vouch is meaningful in proportion to its scarcity
/// (PROJECT_PLAN, Implicit edges - "promiscuity is a discount, not a gate"). Bands rather
/// than a curve so the UI can say "who vouches for 400 people" and mean the same thing this
/// arithmetic does; the boundaries lean on the monkeysphere: a person's real inner circle
/// fits under ~50, a maintained social circle under ~150 (Dunbar), and past that each vouch
/// is closer to a mailing list than a judgment.
fn promiscuity_discount(vouches: i64) -> i64 {
    match vouches {
        v if v <= 50 => 0,
        v if v <= 150 => 1,
        _ => 2,
    }
}

/// One admitted target, as the rollup writes it.
#[derive(Debug, PartialEq, Eq)]
struct DemandRow {
    target: String,
    lane: String,
    introducer: String,
    /// Band ordinal after the discount - the score the budget ranks by.
    level: i64,
}

/// The rollup itself, pure: composed rows in, the budgeted demand set out.
///
/// Per target, the best single path wins - MAX across introducers and lanes, NEVER a sum
/// (per-introducer rows exist precisely so nothing here can accidentally add them) - with
/// the promiscuity discount applied per path before the comparison, so a 400-vouch
/// introducer's "high" competes as a "low". Explicitly-dialed targets are excluded whole:
/// a real dial means the pair left this pipeline (promotion is clean), and an explicit
/// "none" is an opinion speculation must not overrule. Ties break deterministically
/// (higher raw level, then introducer, then lane) so two folds over the same inputs write
/// the same memo.
fn rollup(composed: &[ComposedEdge<'_>], explicit: &HashSet<&str>, budget: usize) -> Vec<DemandRow> {
    let mut best: HashMap<&str, (i64, i64, &str, &str)> = HashMap::new(); // target -> (discounted, raw, introducer, lane)
    for edge in composed {
        if explicit.contains(edge.target) {
            continue;
        }
        let discounted = (edge.level - promiscuity_discount(edge.introducer_vouches)).max(0);
        if discounted == 0 {
            continue;
        }
        let candidate = (discounted, edge.level, edge.introducer, edge.lane);
        best.entry(edge.target)
            .and_modify(|held| {
                // Higher discounted wins; then higher raw; then the stable name order.
                let better = (candidate.0, candidate.1, std::cmp::Reverse(candidate.2), std::cmp::Reverse(candidate.3))
                    > (held.0, held.1, std::cmp::Reverse(held.2), std::cmp::Reverse(held.3));
                if better {
                    *held = candidate;
                }
            })
            .or_insert(candidate);
    }
    let mut rows: Vec<DemandRow> = best
        .into_iter()
        .map(|(target, (discounted, _, introducer, lane))| DemandRow {
            target: target.to_string(),
            lane: lane.to_string(),
            introducer: introducer.to_string(),
            level: discounted,
        })
        .collect();
    rows.sort_by(|a, b| b.level.cmp(&a.level).then(a.target.cmp(&b.target)));
    rows.truncate(budget);
    rows
}

/// Rebuild one reader's slice of the demand memo from their freshly-composed implicit set -
/// called by `edgegraph::refresh_implicit`, the one place those rows exist as values, so the
/// two memos ride one choreography and cannot drift. Whole-slice rewrite with the stamp
/// sweep, like everything it rides beside.
pub async fn refresh_demand(
    state: &AppState,
    reader_root: &str,
    composed: &[ComposedEdge<'_>],
    explicit: &HashSet<&str>,
) -> Result<()> {
    let now = now_ms();
    let rows = rollup(composed, explicit, SPECULATIVE_BUDGET);
    for chunk in rows.chunks(DEMAND_CHUNK_ROWS) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let b = i * 6;
                format!("(?{},?{},?{},?{},?{},?{})", b + 1, b + 2, b + 3, b + 4, b + 5, b + 6)
            })
            .collect();
        let sql = format!(
            "INSERT INTO speculative_demand
               (reader_root, target_root, lane, introducer_root, level, updated_at_ms)
             VALUES {}
             ON CONFLICT (reader_root, target_root) DO UPDATE SET
                 lane = excluded.lane,
                 introducer_root = excluded.introducer_root,
                 level = excluded.level,
                 updated_at_ms = excluded.updated_at_ms",
            placeholders.join(",")
        );
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|row| {
                [
                    turso::Value::Text(reader_root.to_string()),
                    turso::Value::Text(row.target.clone()),
                    turso::Value::Text(row.lane.clone()),
                    turso::Value::Text(row.introducer.clone()),
                    turso::Value::Text(band_word(row.level).to_string()),
                    turso::Value::Integer(now),
                ]
            })
            .collect();
        state
            .node_db
            .execute(&sql, turso::params_from_iter(params))
            .await
            .context("writing the speculative demand memo")?;
    }
    // The stamp sweep: rows this rewrite didn't touch lost the implicit inputs (or the
    // budget) that justified them, and the mirror behind them stops being refreshed.
    state
        .node_db
        .execute(
            "DELETE FROM speculative_demand WHERE reader_root = ?1 AND updated_at_ms < ?2",
            (reader_root, now),
        )
        .await
        .context("sweeping receded speculative demand")?;
    Ok(())
}

/// Is this persona held ONLY speculatively - a mirror with no freshness contract behind it?
///
/// The question every OUTWARD-facing shelf must ask before speaking with a held chain's
/// authority (found 2026-08-21, twice in one day: `idface::public_doc_bytes` served a
/// reader 404s for words their own share machinery held, then the fragment door answered
/// peers "Unknown" for the same reason and stale versions besides). A chain kept current
/// by a relationship - hosted here, member-fetched (visits revalidate), followed (the wake
/// pass) - may treat its shelf as the truth, silence included. A hunch-held mirror is
/// allowed to be hours stale BY DESIGN, so its silence is ignorance, never retraction; and
/// the DISCOVERY invariant is blunter still: speculative mirrors serve nobody, so a
/// serving surface that answered from one would let any peer probe out what this node
/// speculates about.
pub async fn speculative_only(state: &AppState, root_hex: &str) -> Result<bool> {
    // Deliberately NOT keyed on the `speculative_fetches` row (second pass at this
    // predicate, 2026-08-21): a pull that dies after minting the database leaves an ORPHAN
    // mirror with no row, and a row-keyed check classified exactly those as
    // relationship-held - reinstating the stale-chain shadow for good, since nothing would
    // ever refresh them either. The honest question is "does ANY freshness contract exist":
    // hosted here (its words are written here), member-fetched (visits revalidate), or
    // followed (the wake pass). A held chain with none of those is hunch-class, however it
    // got here. (A rebroadcast pin is deliberately NOT a contract: since 2026-08-11 a share
    // obliges a fragment COPY, never a chain subscription - `subscriptions::followed_foreign`
    // carries that correction - so a pinned author's CHAIN is exactly as unrefreshed as any
    // other hunch, while the fragment the pin actually obliges answers through its own shelf.)
    let hosted = crate::identity::is_hosted(&state.node_db, root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    if hosted || crate::idface::has_fetched(&state.node_db, root_hex).await? {
        return Ok(false);
    }
    Ok(crate::net::subscriptions::followers_of(&state.node_db, root_hex)
        .await?
        .is_empty())
}

/// When the pass last reached this target, if it ever has - the member surfaces' question
/// (idface serves a speculatively-held persona to the node's own members; reading was never
/// serving). The one sanctioned read of `speculative_fetches` outside the pass.
pub async fn fetched_at(node_db: &Db, target_root: &str) -> Result<Option<i64>> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT fetched_at_ms FROM speculative_fetches WHERE target_root = ?1",
            (target_root,),
        )
        .await
        .context("checking the speculative fetch registry")?;
    Ok(row.map(|(at,)| at))
}

async fn record_fetch(node_db: &Db, target_root: &str, via: &str) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO speculative_fetches (target_root, fetched_at_ms, last_via)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (target_root) DO UPDATE SET fetched_at_ms = ?2, last_via = ?3",
            (target_root, now_ms(), via),
        )
        .await
        .context("recording a speculative fetch")?;
    Ok(())
}

/// One target, as the acquisition pass weighs it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AcquireCandidate {
    target: String,
    /// The best demand level across readers (band ordinal).
    level: i64,
    /// Every introducer any reader's demand names - each one a door that fronts the target.
    introducers: BTreeSet<String>,
    /// COALESCE(fetched_at_ms, 0) - never-fetched sorts stalest.
    fetched_at: i64,
}

/// Priority for the pass's budget: strongest demand first, stalest first within a tie -
/// the `idface::order_refresh` shape without the presence rung (speculation has no human
/// waiting on it by definition).
fn order_acquisition(mut candidates: Vec<AcquireCandidate>) -> Vec<AcquireCandidate> {
    candidates.sort_by(|a, b| {
        b.level
            .cmp(&a.level)
            .then(a.fetched_at.cmp(&b.fetched_at))
            .then(a.target.cmp(&b.target))
    });
    candidates
}

/// The acquisition pass: pull stale admitted targets' public chains through their
/// introducers. One pass is one beat of DISCOVERY stage 2 - capped, cooldown-rotated,
/// sequential per target so the candidate ORDER is a guarantee (introducer paths exhaust
/// before the target's own machinery is ever dialed).
pub async fn acquire_pass(state: AppState) -> Result<()> {
    let stale_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_SPECULATIVE_STALE_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(SPECULATIVE_STALE_MS)
    } else {
        SPECULATIVE_STALE_MS
    };
    let cooldown_ms = if state.config.local_test {
        std::env::var("RINGTOME_TEST_SPECULATIVE_COOLDOWN_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(SPECULATIVE_ATTEMPT_COOLDOWN_MS)
    } else {
        SPECULATIVE_ATTEMPT_COOLDOWN_MS
    };
    let now = now_ms();

    let demand: Vec<(String, String, String)> = state
        .node_db
        .fetch_all(
            "SELECT target_root, introducer_root, level FROM speculative_demand",
            (),
        )
        .await
        .context("reading the speculative demand memo")?;
    if demand.is_empty() {
        return Ok(());
    }

    // Targets somebody here already holds a real relationship with are the ordinary
    // machinery's job, whatever any reader's rollup says: hosted personas write here,
    // followed personas ride the wake pass, member-fetched personas ride visits.
    let hosted: HashSet<String> = crate::identity::hosted_roots_with_accounts(&state.node_db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
        .into_iter()
        .map(|(root, _)| root)
        .collect();
    let followed: HashSet<String> = crate::net::subscriptions::followed_foreign(&state.node_db)
        .await?
        .into_iter()
        .map(|(foreign, _, _)| foreign)
        .collect();
    let member_fetched: HashSet<String> = crate::idface::fetched_roots(&state.node_db)
        .await?
        .into_iter()
        .collect();
    let stamps: HashMap<String, i64> = state
        .node_db
        .fetch_all("SELECT target_root, fetched_at_ms FROM speculative_fetches", ())
        .await?
        .into_iter()
        .map(|(target, at): (String, i64)| (target, at))
        .collect();

    let mut by_target: HashMap<String, AcquireCandidate> = HashMap::new();
    for (target, introducer, level) in demand {
        if hosted.contains(&target) || followed.contains(&target) || member_fetched.contains(&target)
        {
            continue;
        }
        let fetched_at = stamps.get(&target).copied().unwrap_or(0);
        if now - fetched_at < stale_ms {
            continue;
        }
        {
            let marks = SPECULATIVE_ATTEMPTS.lock().expect("attempt marks poisoned");
            if let Some(at) = marks.as_ref().and_then(|m| m.get(&target)) {
                if now - at < cooldown_ms {
                    continue; // recently attempted - let the rest of the list have the cap
                }
            }
        }
        let ordinal = crate::net::subscriptions::band_ordinal(&level).unwrap_or(0);
        let entry = by_target.entry(target.clone()).or_insert(AcquireCandidate {
            target,
            level: 0,
            introducers: BTreeSet::new(),
            fetched_at,
        });
        entry.level = entry.level.max(ordinal);
        entry.introducers.insert(introducer);
    }
    if by_target.is_empty() {
        return Ok(());
    }

    let started: Vec<AcquireCandidate> = order_acquisition(by_target.into_values().collect())
        .into_iter()
        .take(SPECULATIVE_FETCH_CAP)
        .collect();
    {
        let mut marks = SPECULATIVE_ATTEMPTS.lock().expect("attempt marks poisoned");
        let map = marks.get_or_insert_with(Default::default);
        for candidate in &started {
            map.insert(candidate.target.clone(), now);
        }
    }
    let mut pulled = 0usize;
    let total = started.len();
    for candidate in started {
        if acquire_one(&state, &candidate).await {
            pulled += 1;
        }
    }
    if total > 0 {
        tracing::info!(attempted = total, pulled, "speculative acquisition pass");
    }
    Ok(())
}

/// One quiet pull. Candidates in DISCLOSURE order - the endpoint that answered before (an
/// introducer path by construction), then every introducer's known machinery, then and only
/// then the target's own serving records - because "never dial the target first when an
/// introducer path exists" is an invariant, not a preference, and sequential tries are what
/// make an order a guarantee. Success is the MIRROR existing after the exchange, not the
/// exchange completing: a polite empty answer from a node that holds nothing must not stamp
/// freshness (mint-only-on-substance, the `sync_with_peer` rule, read back here).
async fn acquire_one(state: &AppState, candidate: &AcquireCandidate) -> bool {
    let target = &candidate.target;
    // A candidate earns a dial two ways and no other: it is an ENDPOINT id that once
    // actually answered (a via), or it is an identity key whose live serving record just
    // resolved to an endpoint. An UNRESOLVED identity key is never dialed - dialing one "as
    // an endpoint" is a guaranteed-dead dial that still walks the whole discovery stack,
    // and this pass runs on a loop: a beat's worth of them queues real dials behind
    // relay/DNS lookups for endpoints that do not exist (found 2026-08-21, first suite run
    // on a bad network - pushes sat minutes in dial limbo behind the junk). The visit-time
    // ladder (`idface::fetch_foreign`) tolerates unresolved hints because a human handed
    // them over once; a background loop gets no such indulgence.
    let resolved = |input: &str, output: String| (output != input).then_some(output);
    let mut vias: Vec<String> = Vec::new();
    if let Ok(Some((_, Some(last)))) = last_fetch(&state.node_db, target).await {
        vias.push(last);
    }
    for introducer in &candidate.introducers {
        if let Ok(Some(via)) = crate::idface::fetched_via(&state.node_db, introducer).await {
            vias.push(via);
        }
        for leaf in crate::idface::stored_tree_leaves(state, introducer).await {
            let endpoint = crate::idface::leaf_via_to_endpoint(state, introducer, &leaf).await;
            vias.extend(resolved(&leaf, endpoint));
        }
    }
    // The fallback rungs: the target's own machinery, strictly after every introducer path.
    // The zeroth-root rung (a founding node's serving record lives under the root key) and
    // whatever Active leaves a partial mirror already taught us. A never-served stranger
    // resolves nothing here and costs nothing - which is exactly the case the introducer
    // door exists for.
    let root_rung = crate::idface::leaf_via_to_endpoint(state, target, target).await;
    vias.extend(resolved(target, root_rung));
    for leaf in crate::idface::stored_tree_leaves(state, target).await {
        let endpoint = crate::idface::leaf_via_to_endpoint(state, target, &leaf).await;
        vias.extend(resolved(&leaf, endpoint));
    }

    let mut seen: HashSet<String> = HashSet::new();
    for via in vias.into_iter().filter(|v| seen.insert(v.clone())) {
        // The ceiling bounds the WAIT, never the exchange: the pull runs on its own task and
        // a slow one is DETACHED to finish, not cancelled. The first shape of this loop
        // aborted the in-flight future at the deadline, and the abort was a zombie mint
        // (2026-08-21, the day's third finding): a sync cancelled mid-exchange leaves QUIC
        // state its peer trips over later, and the fan-out pushes that queued behind those
        // zombies sat wedged for minutes - red cascade feeds, three runs in a row. A
        // detached pull that lands late just leaves a warm mirror; the next beat records it.
        // The dial rides inside the same task: address resolution is network work too.
        let task_state = state.clone();
        let task_target = target.clone();
        let task_via = via.clone();
        let mut pull = tokio::spawn(async move {
            let addr = crate::net::sync::dial_addr(&task_state, &task_via).await?;
            crate::net::sync::sync_with_peer(&task_state, &task_target, addr).await
        });
        match tokio::time::timeout(SPECULATIVE_FETCH_TIMEOUT, &mut pull).await {
            Ok(Ok(Ok(stats))) => {
                let held = matches!(state.user_dbs.get(target).await, Ok(Some(_)));
                if !held {
                    continue; // a polite empty exchange - they hold nothing of the target
                }
                if let Err(e) = record_fetch(&state.node_db, target, &via).await {
                    tracing::warn!(target = %target, "could not record a speculative fetch: {e:#}");
                }
                tracing::info!(target = %target, via = %via, received = stats.received,
                    "speculative pull landed");
                return true;
            }
            Ok(Ok(Err(e))) => {
                tracing::debug!(target = %target, via = %via, "speculative pull failed: {e:#}");
            }
            Ok(Err(join_error)) => {
                tracing::debug!(target = %target, via = %via, "speculative pull died: {join_error}");
            }
            Err(_) => {
                tracing::debug!(target = %target, via = %via,
                    "speculative pull still in flight at the deadline - detached, moving on");
            }
        }
    }
    false
}

/// The endpoint that last answered a speculative pull of this persona - the introducer-path
/// door, and the ONE candidate outward recovery machinery may use for a hunch-held mirror
/// (net::bodies::sweep): it already knows our interest, and every other candidate list is
/// built from relationship registries a hunch never enters.
pub async fn last_via(node_db: &Db, target_root: &str) -> Result<Option<String>> {
    Ok(last_fetch(node_db, target_root).await?.and_then(|(_, via)| via))
}

async fn last_fetch(node_db: &Db, target_root: &str) -> Result<Option<(i64, Option<String>)>> {
    let row: Option<(i64, Option<String>)> = node_db
        .fetch_optional(
            "SELECT fetched_at_ms, last_via FROM speculative_fetches WHERE target_root = ?1",
            (target_root,),
        )
        .await
        .context("reading the speculative fetch registry")?;
    Ok(row)
}

/// Every hosted reader whose rollup admits this author, with each pair's best introducer -
/// the feed journal's THIRD reader criterion (DISCOVERY slice 2, stage 3), asked per author
/// per public move exactly like `followers_of`, off the by-target index built for the
/// acquisition pass's identical question.
/// Does ANY reader's rollup still admit this target? The eviction sweep's demand-side
/// keeper - one probe on the by-target index.
pub async fn demand_exists(node_db: &Db, target_root: &str) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM speculative_demand WHERE target_root = ?1 LIMIT 1",
            (target_root,),
        )
        .await
        .context("probing the demand memo")?;
    Ok(row.is_some())
}

/// Forget an evicted mirror's fetch bookkeeping - the quiet registry's row goes with the
/// chains it recorded.
pub async fn forget_fetch(node_db: &Db, target_root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM speculative_fetches WHERE target_root = ?1",
            (target_root,),
        )
        .await
        .context("forgetting a speculative fetch record")?;
    Ok(())
}

pub async fn wanting_readers(node_db: &Db, target_root: &str) -> Result<Vec<(String, String)>> {
    let rows: Vec<(String, String)> = node_db
        .fetch_all(
            "SELECT reader_root, introducer_root FROM speculative_demand WHERE target_root = ?1",
            (target_root,),
        )
        .await
        .context("reading who wants this author speculatively")?;
    Ok(rows)
}

/// The reader's discounted path bands, keyed by target - the feed read's join for the
/// slider's `path` provenance (PROJECT_PLAN's effective-interest precedence: the derived
/// path score is third, behind the author and sharer dials). Budget-bounded by
/// construction, so the map is at most `SPECULATIVE_BUDGET` entries.
pub async fn levels_for(
    node_db: &Db,
    reader_root: &str,
) -> Result<std::collections::HashMap<String, String>> {
    let rows: Vec<(String, String)> = node_db
        .fetch_all(
            "SELECT target_root, level FROM speculative_demand WHERE reader_root = ?1",
            (reader_root,),
        )
        .await
        .context("reading the reader's path bands")?;
    Ok(rows.into_iter().collect())
}

/// One row of the People page's suggested shelf, byline attached.
#[derive(Debug, serde::Serialize)]
pub struct Suggested {
    pub root: String,
    /// The whole speakable spelling, server-derived like the directory's - the row is the
    /// profile the Person widget needs, and the client filter matches on these words.
    pub speakable: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    /// Which lane won the rollup ('trust' | 'taste').
    pub lane: String,
    /// Band word after the promiscuity discount - the score the shelf orders by.
    pub level: String,
    pub introducer_root: String,
    /// The introducer's claimed name, for the "via mara" byline. Absent renders as "via a
    /// friend" - the introduction is still the fact worth showing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub introducer_name: Option<String>,
}

/// The suggested shelf: one reader's demand rollup, FILTERED to targets the acquisition pass
/// has actually landed (the `speculative_fetches` join) - a suggestion the node cannot render
/// a face for is not yet a suggestion; it becomes one on the beat its pull completes. Bylines
/// ride the cache like every list surface (one query, no database per face), and the rows
/// come back best-first: band ordinal descending, root ascending, the rollup's own tiebreak.
///
/// Reading is not serving (the slice-1 doctrine): this surface hands a hunch-held persona to
/// the node's OWN reader, the one relationship a quiet mirror exists for.
pub async fn suggested_for(node_db: &Db, reader_root: &str) -> Result<Vec<Suggested>> {
    let rows: Vec<(String, String, String, String)> = node_db
        .fetch_all(
            "SELECT d.target_root, d.lane, d.level, d.introducer_root
             FROM speculative_demand d
             JOIN speculative_fetches f ON f.target_root = d.target_root
             WHERE d.reader_root = ?1",
            (reader_root,),
        )
        .await
        .context("reading the suggested shelf")?;
    let mut byline_roots: Vec<String> = Vec::new();
    for (target, _, _, introducer) in &rows {
        if !byline_roots.contains(target) {
            byline_roots.push(target.clone());
        }
        if !byline_roots.contains(introducer) {
            byline_roots.push(introducer.clone());
        }
    }
    let bylines = crate::profiles::bylines(node_db, &byline_roots).await?;
    let band_ordinal = |word: &str| {
        ringtome_proto::PublicEdge::BANDS
            .iter()
            .position(|b| *b == word)
            .unwrap_or(0)
    };
    let mut out: Vec<Suggested> = rows
        .into_iter()
        .filter_map(|(target, lane, level, introducer_root)| {
            let raw = crate::pubkey::decode(&target)?;
            let byline = bylines.get(&target).cloned().unwrap_or_default();
            let introducer_name =
                bylines.get(&introducer_root).and_then(|b| b.name.clone());
            Some(Suggested {
                speakable: crate::speakable::speakable(&raw),
                name: byline.name,
                avatar: byline.avatar,
                lane,
                level,
                introducer_root,
                introducer_name,
                root: target,
            })
        })
        .collect();
    out.sort_by(|a, b| {
        band_ordinal(&b.level)
            .cmp(&band_ordinal(&a.level))
            .then_with(|| a.root.cmp(&b.root))
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shelf's honesty gate: a demand row whose pull has not landed is not suggested.
    /// Planted red against a version without the `speculative_fetches` join before trusted.
    #[tokio::test]
    async fn suggestions_require_a_landed_mirror() {
        let db = crate::db::test_node_db().await;
        let reader = "aa".repeat(32);
        let landed = "bb".repeat(32);
        let pending = "cc".repeat(32);
        let introducer = "dd".repeat(32);
        for target in [&landed, &pending] {
            db.execute(
                "INSERT INTO speculative_demand
                   (reader_root, target_root, lane, introducer_root, level, updated_at_ms)
                 VALUES (?1, ?2, 'trust', ?3, 'high', 1)",
                (reader.as_str(), target.as_str(), introducer.as_str()),
            )
            .await
            .unwrap();
        }
        db.execute(
            "INSERT INTO speculative_fetches (target_root, fetched_at_ms) VALUES (?1, 2)",
            (landed.as_str(),),
        )
        .await
        .unwrap();
        let rows = suggested_for(&db, &reader).await.unwrap();
        assert_eq!(rows.len(), 1, "only the landed mirror is suggested");
        assert_eq!(rows[0].root, landed);
        assert_eq!(rows[0].introducer_root, introducer);
        assert!(!rows[0].speakable.is_empty(), "the row carries its spelling");
    }

    fn edge<'a>(
        target: &'a str,
        lane: &'static str,
        introducer: &'a str,
        level: i64,
        vouches: i64,
    ) -> ComposedEdge<'a> {
        ComposedEdge { target, lane, introducer, level, introducer_vouches: vouches }
    }

    #[test]
    fn max_across_introducers_never_sums() {
        // Two medium paths must come out medium - if this ever reads "high", somebody
        // summed, and a thousand Sybil vouches just became worth more than one best path.
        let rows = rollup(
            &[
                edge("stranger", "trust", "mara", 2, 5),
                edge("stranger", "trust", "otto", 2, 5),
            ],
            &HashSet::new(),
            16,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].level, 2, "MAX across introducers, never sums");
    }

    #[test]
    fn promiscuity_discounts_by_band() {
        // An inner-circle vouch keeps its level; a 400-vouch introducer's "high" competes
        // two bands down; a discount to the floor drops the row entirely.
        let rows = rollup(
            &[
                edge("close", "trust", "mara", 3, 50),
                edge("crowd", "trust", "collector", 3, 400),
                edge("gone", "trust", "collector", 2, 400),
            ],
            &HashSet::new(),
            16,
        );
        let level = |t: &str| rows.iter().find(|r| r.target == t).map(|r| r.level);
        assert_eq!(level("close"), Some(3), "scarce vouches keep their weight");
        assert_eq!(level("crowd"), Some(1), "a 400-vouch introducer is discounted two bands");
        assert_eq!(level("gone"), None, "discounted to the floor means not admitted");
    }

    #[test]
    fn the_best_single_path_carries_its_introducer() {
        let rows = rollup(
            &[
                edge("stranger", "trust", "promiscuous", 4, 400), // discounted to 2
                edge("stranger", "trust", "careful", 3, 10),      // stays 3 - the best path
            ],
            &HashSet::new(),
            16,
        );
        assert_eq!(rows[0].level, 3);
        assert_eq!(rows[0].introducer, "careful", "the memo names the winning path's introducer");
    }

    #[test]
    fn explicit_dials_leave_the_pipeline() {
        // Promotion is clean: any real dial on the target - including an explicit "none" -
        // excludes the pair from speculation entirely.
        let explicit: HashSet<&str> = ["dialed"].into();
        let rows = rollup(&[edge("dialed", "trust", "mara", 4, 5)], &explicit, 16);
        assert!(rows.is_empty(), "an explicit dial beats every implicit row");
    }

    #[test]
    fn the_budget_is_a_cap_and_the_order_is_stable() {
        let composed: Vec<ComposedEdge> = vec![
            edge("aa", "trust", "mara", 2, 5),
            edge("bb", "trust", "mara", 3, 5),
            edge("cc", "trust", "mara", 1, 5),
        ];
        let rows = rollup(&composed, &HashSet::new(), 2);
        assert_eq!(rows.len(), 2, "the acquisition budget bounds the memo");
        assert_eq!(rows[0].target, "bb", "strongest demand survives the cap first");
        assert_eq!(rows[1].target, "aa");
    }

    #[test]
    fn acquisition_orders_by_demand_then_staleness() {
        let cand = |target: &str, level: i64, fetched_at: i64| AcquireCandidate {
            target: target.into(),
            level,
            introducers: BTreeSet::new(),
            fetched_at,
        };
        let order: Vec<String> = order_acquisition(vec![
            cand("fresh-high", 3, 500),
            cand("stale-high", 3, 0),
            cand("stale-low", 1, 0),
        ])
        .into_iter()
        .map(|c| c.target)
        .collect();
        assert_eq!(order, vec!["stale-high", "fresh-high", "stale-low"]);
    }
}
