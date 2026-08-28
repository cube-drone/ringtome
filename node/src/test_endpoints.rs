//! DANGEROUS test-only endpoints, mounted ONLY when `config.local_test` is set.
//!
//! These exist so the black-box integration suite can inspect and manipulate node state directly
//! (e.g. read the `boot_timestamps` table, reset state between tests) without us having to expose
//! that surface through the real API. The raw SQL passthrough here is a total security hole by
//! design - it must never be reachable on any node that is not a developer's local test target.
//! `/test/unplug` is the other dangerous one: it makes a node refuse its peers while looking
//! perfectly healthy over HTTP, which is a partition simulator in a test rig and a silent outage
//! anywhere else. It carries a second lock for that reason ([`crate::net::p2p::Unplugged`]).
//!
//! Safety posture: the route is not even registered unless local-test mode is on, so on a normal
//! node the path simply does not exist (404), rather than existing-but-forbidden. There is no code
//! path from the router to the SQL executor unless the node was deliberately armed.

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppError;
use crate::AppState;

#[derive(Deserialize)]
pub struct SqlRequest {
    pub sql: String,
}

#[derive(Serialize)]
pub struct SqlResponse {
    /// Rows returned, each a map of column name to JSON value. Empty for non-SELECT statements.
    pub rows: Vec<serde_json::Map<String, Value>>,
    /// Rows affected (for INSERT/UPDATE/DELETE); null for queries that return rows.
    pub rows_affected: Option<u64>,
}

#[derive(serde::Deserialize)]
pub struct BeatRequest {
    /// Which background pass to ring - see the match below for the vocabulary.
    #[serde(rename = "pass")]
    pub pass_name: String,
    /// The root the pass concerns, for the per-root passes. Ignored by the fleet sweeps.
    #[serde(default)]
    pub root: Option<String>,
}

/// Ring one background pass, NOW, and return when it has completed - the test suite's
/// deterministic-sequencing primitive (2026-08-25, ending the settle era). Every loop in
/// main's inventory is a plain one-pass function by design (loops.rs); this door lets a
/// test drive the pipeline hop by hop - act, ring, assert - instead of racing timers under
/// load, which is what three days of CI flakes were. `peerderive.cjs`'s `/test/derive`
/// pioneered the pattern; this generalizes it. LOCAL_TEST only, like every door here.
///
/// The `fold` pass rings the whole post-arrival hook chain UNCONDITIONALLY - no frontier
/// verdict gate - because a test that just made something arrive wants the folds run, not
/// an argument about whether the memo noticed. Every hook is idempotent by design.
pub async fn beat(
    State(state): State<AppState>,
    Json(req): Json<BeatRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let root = req.root.as_deref();
    let outcome: anyhow::Result<()> = match (req.pass_name.as_str(), root) {
        ("pull", Some(r)) => {
            // The reader-driven fetch ladder, synchronously - widened the way
            // `spawn_revalidate` widens it, so the beat walks the SAME candidate list a
            // background revalidation would: stored tree leaves first, then the cohort
            // rung (our own personas' sibling nodes - the only candidate left when the
            // followed persona's whole machinery is dark).
            let mut via = crate::idface::stored_tree_leaves(&state, r).await;
            for endpoint in crate::net::sync::cohort_endpoints(&state)
                .await
                .unwrap_or_default()
            {
                if !via.contains(&endpoint) {
                    via.push(endpoint);
                }
            }
            let fetched = crate::idface::fetch_foreign(&state, r, &via).await;
            tracing::info!(root = %r, fetched, "TEST BEAT: pull");
            Ok(())
        }
        ("fold", Some(r)) => {
            // The fold lane's drainable form: nudge (ledger leg included) and await the
            // run - the chain itself now lives in fold::run_chain, serialized per root,
            // so this beat can never race a concurrent arrival's fold.
            crate::fold::fold_now_forced(&state, r).await;
            Ok(())
        }
        ("eager-push", Some(r)) => {
            // FORCED, not the loop's pass: eager_root's debounce (resync.observe) reads
            // "nothing new since my last push" as quiet and declines - correct for a
            // free-running loop, and exactly the no-op race a rung beat cannot afford
            // (run 2 of the settle switchover: five tests failed on a beat that had
            // silently declined). A rung push means push NOW, decision be damned.
            if crate::identity::is_agented(&state.node_db, r)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?
            {
                let peers = crate::net::sync::peers_for(&state.node_db, r).await?;
                let results = crate::net::sync::sync_peers(&state, r, &peers).await?;
                let ok = results.iter().filter(|x| x.ok).count();
                tracing::info!(root = %r, peers = results.len(), ok, "TEST BEAT: eager-push");
            }
            Ok(())
        }
        ("eager-push", None) => crate::net::resync::eager_pass(state.clone(), None).await,
        ("demand-push", Some(r)) => {
            // The fold's OTHER push half, awaited: `after_public_move` spawns
            // `push_to_askers` detached, so a fold beat alone cannot sequence a
            // demand-record push (author's node -> a follower's node that once asked).
            crate::fanout::push_to_askers_now(&state, r).await;
            Ok(())
        }
        ("mint", r) => {
            // The authoring-side subscription sweep: memo refresh WITH minting allowed, so
            // a freshly-turned dial becomes its public-edge statement - then the knock,
            // AWAITED: the mint's own eager delivery is a detached spawn
            // (subscriptions::refresh), so without this second leg the beat returns while
            // the envelope is still in the air (run 2 of the settle switchover: two inbox
            // tests failed on exactly that). The whole sending half, run to completion.
            crate::net::subscriptions::sweep(state.clone(), r.map(String::from)).await?;
            crate::outbox::sweep(state.clone()).await
        }
        ("outbox", _) => {
            // Retry every queued knock NOW: the sweep's backoff ladder gates by
            // last_tried_ms, so zero the stamps first - a test ringing this means
            // "knock again", not "knock if due".
            crate::outbox::force_due(&state.node_db).await?;
            crate::outbox::sweep(state.clone()).await
        }
        ("fragment-sweep", scope) => {
            // Force due-ness first: the sweep's queries select by elapsed time
            // (`checked_ms`/`last_tried_ms` older than the revalidation interval), so ringing
            // it right after an act would revalidate nothing and the beat would be a shrug.
            // A test ringing this pass means "revalidate NOW" - zero the stamps, then sweep.
            // Scoped to the author when given, fleet-wide otherwise. The frozen-fragment
            // exclusion (edit window) is untouched: it is a property, not a schedule.
            crate::fragments::force_due(&state.node_db, scope).await?;
            crate::fragments::sweep(state.clone()).await
        }
        ("bodies-sweep", _) => {
            // Same posture as fragment-sweep: the healer backs off per-root
            // (`last_tried_ms` + exponential backoff), so a beat means "try again NOW".
            crate::net::bodies::force_due(&state.node_db).await?;
            crate::net::bodies::sweep(state.clone()).await
        }
        ("body-heal", Some(author)) => {
            // The eager body heal, awaited. Fragment intake spawns this DETACHED
            // (fragments::heal_soon), so no count of forced sweeps can deterministically
            // land a fragment's bytes - the noting is synchronous but the heal races. A
            // test that just made headers arrive rings this to walk the heal's whole
            // candidate ladder (deliverers first, then each origin's resolution) to
            // completion before asserting the served body.
            for origin in crate::fragments::origins_of_author(&state.node_db, author).await? {
                crate::net::bodies::heal_from(&state, author, &origin).await;
            }
            Ok(())
        }
        ("journal-fill", _) => crate::fanout::fill_pass(state.clone()).await,
        ("follow-refresh", _) => crate::idface::refresh_followed_pass(state.clone()).await,
        ("speculative-acquire", _) => {
            // Clear the pass's in-memory attempt stamps first: the cooldown rotation would
            // otherwise skip a target the background pass tried moments ago, and a rung
            // beat means "acquire NOW", not "acquire unless recently attempted".
            crate::speculative::reset_attempt_stamps();
            crate::speculative::acquire_pass(state.clone()).await
        }
        ("evict", _) => {
            // Grace ZERO: a rung eviction gates on claims (hosted, dials, fragments,
            // demand), never on clocks - the forced-due posture of every sweep beat.
            crate::eviction::evict_pass_with_grace(state.clone(), 0).await
        }
        (other, _) => {
            return Err(AppError::BadRequest(crate::msg!(
                "test.beat.unknown-pass",
                "unknown pass: {other}",
                other = other
            )))
        }
    };
    outcome.map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

#[derive(serde::Deserialize)]
pub struct MarkRequest {
    pub note: String,
}

/// Stamp a caller-supplied note into this node's log - the suite's clock, written into the
/// evidence (2026-08-24). The roothooks post every test's title here as it starts, so a rig
/// log reads as "TEST MARK: <which test> ... its traffic ..." instead of an undifferentiated
/// stream: the residual-tail dig spent its longest stretches mis-assigning log windows to
/// tests, because nothing in the logs said where one test's choreography ended and the
/// next's began. LOCAL_TEST only, like every door in this module.
pub async fn mark(Json(req): Json<MarkRequest>) -> Json<serde_json::Value> {
    tracing::info!(note = %req.note, "TEST MARK");
    Json(serde_json::json!({ "ok": true }))
}

/// Execute arbitrary SQL against the node database and return the results as JSON.
///
/// Tries the statement as a row-returning query first; if it returns no rows we cannot tell a
/// zero-row SELECT from a mutation, so we always report both `rows` and `rows_affected` and let the
/// caller use whichever is meaningful.
pub async fn raw_sql(
    State(state): State<AppState>,
    Json(req): Json<SqlRequest>,
) -> Result<Json<SqlResponse>, AppError> {
    tracing::warn!(sql = %req.sql, "LOCAL_TEST raw SQL passthrough");

    let (column_names, raw) = state
        .node_db
        .query_drained(&req.sql, ())
        .await
        .map_err(|e| AppError::BadRequest(crate::msg!("test_endpoints.sql-error-e", "sql error: {e}", e = e)))?;
    let rows: Vec<serde_json::Map<String, Value>> = raw
        .into_iter()
        .map(|values| row_to_json(&values, &column_names))
        .collect();

    Ok(Json(SqlResponse {
        rows,
        rows_affected: None,
    }))
}

#[derive(Serialize)]
pub struct ResolveServingResponse {
    pub found: bool,
    /// Fields of the resolved record, hex-encoded; absent when `found` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_key: Option<String>,
    /// The serving node's iroh endpoint id, in iroh's own string form (comparable with
    /// `/api/node`'s `endpoint_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<i64>,
}

/// Resolve a serving record through this node's directory (the same path a stranger node would
/// take). The mainline field test uses this to prove records published by one node come back
/// out of the real DHT through another node's client; `resolve_serving` has no production
/// caller yet, so without this route the resolve half of the directory is unreachable from
/// outside.
pub async fn resolve_serving(
    State(state): State<AppState>,
    Path(leaf_hex): Path<String>,
) -> Result<Json<ResolveServingResponse>, AppError> {
    let leaf = crate::pubkey::require(&leaf_hex, "leaf pubkey")?;
    let resolved = state
        .directory
        .resolve_serving(&leaf)
        .await
        .map_err(AppError::Internal)?;
    let Some(signed) = resolved else {
        return Ok(Json(ResolveServingResponse {
            found: false,
            root: None,
            node_key: None,
            endpoint_id: None,
            timestamp_ms: None,
        }));
    };
    let record = signed.record();
    let endpoint_id = iroh::PublicKey::from_bytes(&record.endpoint_id)
        .map(|k| k.to_string())
        .unwrap_or_else(|_| hex::encode(record.endpoint_id));
    Ok(Json(ResolveServingResponse {
        found: true,
        root: Some(hex::encode(record.root)),
        node_key: Some(hex::encode(record.node_key)),
        endpoint_id: Some(endpoint_id),
        timestamp_ms: Some(record.timestamp_ms),
    }))
}

// ---------------------------------------------------------------------------------------------
// The transport gate: /test/unplug.
//
// Simulating a partition without killing a process. The rig's four nodes are shared by the whole
// suite, so a spec that wants "these two are unreachable" cannot stop them. [`crate::net::p2p`]'s
// `Unplugged` carries the design argument and the safety posture; this is its door.

#[derive(Deserialize, Default)]
pub struct UnplugRequest {
    /// House ALPN names to refuse (`sync`, `blob`, `adopt`, `deliver`, `fragment`). Omitted or
    /// null means ALL of them, which is what "unplug this node" ordinarily means.
    #[serde(default)]
    pub alpns: Option<Vec<String>>,
    /// `both` (the default), `inbound`, or `outbound`. One-directional is an ASYMMETRIC partition -
    /// a real and interesting thing to test, and a confusing default, so it must be asked for.
    #[serde(default)]
    pub direction: Option<String>,
}

/// What the node is refusing now - the answer to every call here, so a test can assert the gate
/// rather than trust it, and a human can ask a rig some spec left unplugged what is wrong with it.
#[derive(Serialize)]
pub struct UnplugResponse {
    pub inbound: Vec<String>,
    pub outbound: Vec<String>,
}

impl From<crate::net::p2p::Refusals> for UnplugResponse {
    fn from(refusals: crate::net::p2p::Refusals) -> Self {
        Self {
            inbound: refusals.inbound.iter().map(|n| n.to_string()).collect(),
            outbound: refusals.outbound.iter().map(|n| n.to_string()).collect(),
        }
    }
}

/// Refuse connections on the named ALPNs (default: all of them) in the named direction (default:
/// both). **Replaces** the previous refusal set rather than adding to it.
///
/// An unknown ALPN name or direction is a 400 rather than a no-op: a typo that silently refused
/// nothing would produce a test that passes while proving nothing, which is worse than a red one.
pub async fn unplug(
    State(state): State<AppState>,
    body: Option<Json<UnplugRequest>>,
) -> Result<Json<UnplugResponse>, AppError> {
    let req = body.map(|Json(req)| req).unwrap_or_default();

    let names: Vec<&'static str> = match req.alpns {
        None => crate::net::p2p::ALPNS
            .iter()
            .map(|(name, _)| *name)
            .collect(),
        Some(asked) => {
            let mut resolved = Vec::with_capacity(asked.len());
            for name in &asked {
                let known = crate::net::p2p::alpn_named(name).ok_or_else(|| {
                    AppError::BadRequest(crate::msg!(
                        "test_endpoints.unplug-unknown-alpn",
                        "no such protocol {name}; this node speaks {known}",
                        name = name,
                        known = crate::net::p2p::ALPNS
                            .iter()
                            .map(|(house, _)| *house)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ))
                })?;
                resolved.push(known);
            }
            resolved
        }
    };

    let direction = req.direction.as_deref().unwrap_or("both");
    let (gate_inbound, gate_outbound) = match direction {
        "both" => (true, true),
        "inbound" => (true, false),
        "outbound" => (false, true),
        other => {
            return Err(AppError::BadRequest(crate::msg!(
                "test_endpoints.unplug-bad-direction",
                "no such direction {other}; use both, inbound or outbound",
                other = other
            )))
        }
    };

    let refusals = crate::net::p2p::Refusals {
        inbound: if gate_inbound {
            names.iter().copied().collect()
        } else {
            Default::default()
        },
        outbound: if gate_outbound {
            names.iter().copied().collect()
        } else {
            Default::default()
        },
    };
    tracing::warn!(
        inbound = ?refusals.inbound,
        outbound = ?refusals.outbound,
        "LOCAL_TEST transport gate armed"
    );
    state
        .unplugged
        .arm(&state.config, refusals)
        .map_err(AppError::Internal)?;
    Ok(Json(state.unplugged.refusals().into()))
}

/// Plug the node back in: refuse nothing. Idempotent, and safe to call on a node that was never
/// unplugged - which is what lets the suite's root hook fire it without asking first.
pub async fn plug_in(State(state): State<AppState>) -> Result<Json<UnplugResponse>, AppError> {
    state
        .unplugged
        .arm(&state.config, Default::default())
        .map_err(AppError::Internal)?;
    Ok(Json(state.unplugged.refusals().into()))
}

/// Read the gate without touching it.
pub async fn unplug_state(State(state): State<AppState>) -> Json<UnplugResponse> {
    Json(state.unplugged.refusals().into())
}

/// Run one peer-derive pass on demand (`net::sync::derive_peers`). The derive beat is
/// recovery-paced (minutes), and its lag behind a revocation is the strike's DELIVERY window,
/// not slack - so a probe that wants to watch revocation reach routing must ring this beat
/// itself: shortening the beat globally races every strike test's own choreography (the
/// prune lands mid-test and the struck peer vanishes before the strike is delivered).
pub async fn derive_pass(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    crate::net::sync::derive_peers(state)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "derived": true })))
}

/// Ring one reap on demand (`fragments::reap` - the death-cursor pass). The `derive_pass`
/// idiom, for the same reason: the reap rides the sweep beat, and a test proving "the batch
/// carried this, not the queue" needs to ring exactly one batch at a chosen moment rather than
/// race a cadence.
pub async fn reap_pass(State(state): State<AppState>) -> Result<Json<Value>, AppError> {
    crate::fragments::reap(&state)
        .await
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "reaped": true })))
}

#[derive(Deserialize)]
pub struct EditWindowRequest {
    /// Milliseconds; 0 restores the boot default.
    pub ms: i64,
}

/// Override the edit window at runtime - the `/test/revalidation` idiom, for the same reason:
/// a suite cannot wait a day to watch a post freeze, and a boot-wide tiny window would freeze
/// every OTHER test's posts mid-flight.
pub async fn edit_window(Json(req): Json<EditWindowRequest>) -> Result<Json<Value>, AppError> {
    crate::record::documents::EDIT_WINDOW_OVERRIDE
        .store(req.ms.max(0), std::sync::atomic::Ordering::Relaxed);
    tracing::warn!(ms = req.ms, "LOCAL_TEST edit window override");
    Ok(Json(serde_json::json!({ "ms": req.ms })))
}

/// Does the blob store hold these bytes right now? The reaper's observability: a takedown's
/// serving stops when the fragment dies, and THIS is how a test watches the bytes themselves
/// go on the next GC round.
pub async fn blob_present(
    State(state): State<AppState>,
    axum::extract::Path(hash_hex): axum::extract::Path<String>,
) -> Result<Json<Value>, AppError> {
    let bytes = hex::decode(&hash_hex)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok())
        .ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "test.endpoints.not-a-blob-hash",
                "not a blob hash: 64 hex characters expected"
            ))
        })?;
    let present = state.files.has(iroh_blobs::Hash::from_bytes(bytes)).await;
    Ok(Json(serde_json::json!({ "present": present })))
}

/// Convert a database row into a JSON object. The stored value's own type drives the JSON shape
/// (SQLite values are self-describing, so computed expressions like `COUNT(*)` come through as
/// what they are); blobs become arrays of byte values, since JSON has no bytes type.
fn row_to_json(values: &[turso::Value], column_names: &[String]) -> serde_json::Map<String, Value> {
    let mut obj = serde_json::Map::new();
    for (idx, name) in column_names.iter().enumerate() {
        let value = match values.get(idx) {
            Some(turso::Value::Integer(i)) => Value::from(*i),
            Some(turso::Value::Real(f)) => Value::from(*f),
            Some(turso::Value::Text(s)) => Value::from(s.clone()),
            Some(turso::Value::Blob(b)) => Value::from(b.clone()),
            Some(turso::Value::Null) | None => Value::Null,
        };
        obj.insert(name.clone(), value);
    }
    obj
}

#[derive(Deserialize)]
pub struct RevalidationModeRequest {
    /// "tree" | "fast" | "none" | "default"
    pub mode: String,
}

/// Override which lane fragment revalidation takes, for the duration of the process (or until
/// set back to "default"). Exists so ONE booted harness can prove the same cascade through both
/// lanes - the boot env can pin only one, and whichever it pins, the other rots unexercised.
pub async fn revalidation_mode(
    Json(req): Json<RevalidationModeRequest>,
) -> Result<Json<Value>, AppError> {
    let value = match req.mode.as_str() {
        "tree" => 1,
        "fast" => 2,
        // Per-document revalidation parked entirely; the reap alone moves anything. For the
        // test that proves a death arrived by the cursor and not the queue - which needs the
        // queue provably off, not merely slow.
        "none" => 3,
        "default" => 0,
        other => {
            return Err(AppError::BadRequest(crate::msg!(
                "test.endpoints.unknown-revalidation-mode",
                "unknown revalidation mode {other:?} (tree | fast | none | default)",
                other = other
            )))
        }
    };
    crate::net::fragment::REVALIDATION_MODE.store(value, std::sync::atomic::Ordering::Relaxed);
    tracing::warn!(mode = %req.mode, "LOCAL_TEST revalidation mode override");
    Ok(Json(serde_json::json!({ "mode": req.mode })))
}
