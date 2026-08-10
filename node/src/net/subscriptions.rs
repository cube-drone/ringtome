//! The node's memo of who follows and trusts whom - derived from the personas' own ledgers.
//!
//! ## Why a node-level copy exists at all
//!
//! The truth lives where it was authored: each persona's `contact:<root>` registers on their
//! private chain, folded into their own encrypted database. But routing is a question asked
//! ACROSS personas - "who on this node wants this identity's updates?" - and per-user databases
//! are separate files, so answering it from the source means opening every one of them. Same
//! shape as `persona_frontiers`, same justification, same disposability: this is a memo, and
//! deleting it costs one rebuild.
//!
//! ## The line this table walks
//!
//! *The node routes; the user ranks* (PROJECT_PLAN, Data Layer) says the node keeps routing
//! facts and deliberately does NOT assemble trust weights, nicknames, blocks, or the graph's
//! shape - because ranking happens in the reader's own database where those facts already are,
//! and *already-possible* and *already-assembled* are different security postures.
//!
//! Routing (`eagerness`, `rebroadcast`) is squarely what that rule allows. `trust` is here on a
//! narrower warrant: only where its author set `trust_public`. That distinction is the whole
//! justification, so it is enforced in one place (`edge_of`) rather than trusted to callers:
//!
//!   - A private assessment must not have publicly measurable effects. Giving a peer a better
//!     rate limit because someone here quietly trusts them turns a private fact into something
//!     a stranger can DETECT BY MEASUREMENT - third-party enumeration arriving by side channel
//!     rather than by query (PROJECT_PLAN, Edge-Endpoint Visibility).
//!   - A consented edge is one its author has already agreed may be known, so the assembled
//!     version discloses nothing the published version wouldn't. The rule keeps its force
//!     exactly where it was aimed: the quiet graph.
//!
//! ## What is deliberately not here yet
//!
//! Nothing reads these rows, and there is deliberately no reader here to go with them - a
//! query written before its consumer guesses at the shape the consumer wants. When something
//! does read them, note that a COUNT of trust edges is the Sybil hole the trust doctrine exists
//! to avoid (joint flow, never per-person sums), so whatever consumes this should treat
//! standing as a bounded optimization, never a gate.
use anyhow::{Context, Result};
use std::collections::BTreeMap;

use crate::clock::now_ms;
use crate::AppState;

/// One persona's edge to another, as this table records it. Every value is a band ordinal
/// on the five-step ladder - none=0, low=1, medium=2, high=3, max=4 (PROJECT_PLAN, Bands
/// Not Numbers) - so `> 0` still reads "any rung above the bottom stop".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Edge {
    /// Interest: how eagerly to sync them (the dial is already a cadence dial by design).
    pub eagerness: Option<i64>,
    /// Interest in what they rebroadcast.
    pub rebroadcast: Option<i64>,
    /// Their trust band - ONLY when the author consented to it being known.
    pub trust: Option<i64>,
}

impl Edge {
    /// Nothing recorded: no row should exist, and an existing one should go.
    fn is_empty(&self) -> bool {
        self.eagerness.is_none() && self.rebroadcast.is_none() && self.trust.is_none()
    }
}

/// Rows per multi-row subscription upsert: 6 binds each, well under SQLite's classic
/// 999-variable floor (the `fanout::JOURNAL_CHUNK_ROWS` discipline).
const SUBSCRIPTION_CHUNK_ROWS: usize = 150;

/// The ledger's keys, spelled once (they mirror `js/pure/contact.js`'s collection).
const INTEREST: &str = "interest";
const REBROADCAST: &str = "interest_rebroadcasts";
const TRUST: &str = "trust";
const EDGES_PUBLIC: &str = "edges_public";

/// A stored band as its ladder rung, mirroring `js/pure/contact.js::bandOrdinal`: the five
/// words and nothing else. Silence and garbage are both `None`, never the bottom rung - the
/// distinction the JS side learned the hard way 2026-08-08 (an unset dial is no opinion;
/// "none" is one). Values from the retired numeric scale read as `None` too: pre-User-1, a
/// dropped dev-data dial beats a shim carried forever.
fn band_ordinal(value: &str) -> Option<i64> {
    match value {
        "none" => Some(0),
        "low" => Some(1),
        "medium" => Some(2),
        "high" => Some(3),
        "max" => Some(4),
        _ => None,
    }
}

/// One contact's facts, read as an edge. The consent check lives HERE and nowhere else: an
/// unconsented trust value is not copied out of the persona's database at all, rather than
/// copied and then filtered by whoever reads. `edges_public` is one consent for the
/// relationship whole (Edge-Endpoint Visibility, the Publish tier); the routing dials were
/// never gated on it, because the node routing by its own personas' interest is not a
/// disclosure - the gate matters for what leaves the persona's database as a TRUST fact.
fn edge_of(facts: &BTreeMap<String, String>) -> Edge {
    let band = |k: &str| facts.get(k).and_then(|v| band_ordinal(v));
    // PUBLIC is the resting state (2026-08-09): only an explicit "no" withholds. The gate is
    // still a gate - it just defaults open, because a trust graph nobody opts into never
    // grows (PROJECT_PLAN, Edge-Endpoint Visibility).
    let consented = facts.get(EDGES_PUBLIC).map(String::as_str) != Some("no");
    Edge {
        eagerness: band(INTEREST),
        rebroadcast: band(REBROADCAST),
        trust: if consented { band(TRUST) } else { None },
    }
}

/// Whether this refresh pass may mint public-edge statements (publish::reconcile).
///
/// The split exists because minting on the post-INGEST path is an amplifier, measured
/// 2026-08-09 (testdata, 3 nodes, seed 424242: 315 statements across 19 device keys for 9
/// personas, +40% wall time): a dial can sync to a persona's sibling nodes ahead of the
/// authoring node's statement, and each sibling's reconcile then honestly re-mints it - one
/// consent flip became up to three statements, each an fsync and an eager push through the
/// mesh. Publication needs no sibling-speed reaction: the authoring node mints on its own
/// write, the statement rides the same sync as the dial, and the backstop sweep still
/// converges the one real gap (an authoring device that died between the dial and the mint).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Minting {
    /// A local write or the backstop sweep: reconcile publications.
    Allowed,
    /// The post-ingest hook: memo only - the statement is the authoring node's to mint.
    MemoOnly,
}

/// Rebuild one persona's rows from their own ledger.
///
/// A whole-persona rewrite rather than a delta - the alternative is tracking which ledger
/// key changed, which is exactly the bookkeeping the memo idiom exists to avoid - but a
/// rewrite that SCALES: upserts land as chunked multi-row statements (the `fanout` batching
/// pattern), and the removal half is the stamp sweep below, never a list. Rows for contacts
/// whose last dial went back to nothing are deleted, because a subscription nobody holds
/// must not keep routing.
pub async fn refresh(
    state: &AppState,
    root_hex: &str,
    account_id: &uuid::Uuid,
    minting: Minting,
) -> Result<()> {
    let store = crate::record::store::open(state, account_id, root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("opening {root_hex} to read its ledger: {e}"))?;
    let contacts = store
        .contacts()
        .await
        .map_err(|e| anyhow::anyhow!("reading the contact ledger: {e}"))?;

    // The eager set BEFORE the rewrite, so the rewrite's delta is visible after: an edge
    // crossing from silent to eager is a new follow (backfill their page into this feed), and
    // one crossing out is an unfollow (excise them from it). Eagerness > 0 is the feed
    // criterion, deliberately narrower than `keep`: a trust-only or rebroadcast-only edge
    // keeps its subscription row but earns no feed rows, and dropping the interest dial to
    // its bottom stop is an unfollow even when trust remains.
    let eager_before: std::collections::HashSet<String> = state
        .node_db
        .fetch_all(
            "SELECT foreign_root FROM subscriptions
             WHERE local_root = ?1 AND eagerness IS NOT NULL AND eagerness > 0",
            (root_hex,),
        )
        .await
        .context("reading the eager set before the rewrite")?
        .into_iter()
        .map(|(r,): (String,)| r)
        .collect();

    let now = now_ms();
    let mut edges: Vec<(String, Edge)> = Vec::new();
    let mut eager_now: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (foreign_root, facts) in &contacts {
        let edge = edge_of(facts);
        if edge.is_empty() {
            continue;
        }
        if edge.eagerness.is_some_and(|e| e > 0) {
            eager_now.insert(foreign_root.clone());
        }
        edges.push((foreign_root.clone(), edge));
    }
    for chunk in edges.chunks(SUBSCRIPTION_CHUNK_ROWS) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let b = i * 6;
                format!("(?{},?{},?{},?{},?{},?{})", b + 1, b + 2, b + 3, b + 4, b + 5, b + 6)
            })
            .collect();
        let sql = format!(
            "INSERT INTO subscriptions
               (local_root, foreign_root, eagerness, rebroadcast, trust, updated_at_ms)
             VALUES {}
             ON CONFLICT (local_root, foreign_root) DO UPDATE SET
                 eagerness = excluded.eagerness,
                 rebroadcast = excluded.rebroadcast,
                 trust = excluded.trust,
                 updated_at_ms = excluded.updated_at_ms",
            placeholders.join(",")
        );
        let dial = |v: Option<i64>| v.map(turso::Value::Integer).unwrap_or(turso::Value::Null);
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|(foreign_root, edge)| {
                [
                    turso::Value::Text(root_hex.to_string()),
                    turso::Value::Text(foreign_root.clone()),
                    dial(edge.eagerness),
                    dial(edge.rebroadcast),
                    dial(edge.trust),
                    turso::Value::Integer(now),
                ]
            })
            .collect();
        state
            .node_db
            .execute(&sql, turso::params_from_iter(params))
            .await
            .context("storing subscriptions")?;
    }

    // The stamp sweep: every kept row was just stamped `updated_at_ms = now`, so "rows this
    // rewrite didn't touch" IS the withdrawn set - contacts whose last edge cleared. The old
    // form spelled that set out as a NOT IN literal of every followed root, megabytes of SQL
    // re-parsed per call, which would have hit the engine's statement-length ceiling around
    // fifteen thousand contacts. A timestamp already knows.
    state
        .node_db
        .execute(
            "DELETE FROM subscriptions WHERE local_root = ?1 AND updated_at_ms < ?2",
            (root_hex, now),
        )
        .await
        .context("clearing withdrawn subscriptions")?;

    // The feed consequences of the delta, in the same breath as the memo itself. Both live
    // in fanout (feed_journal is its table); both are idempotent, and both take the DELTA -
    // who crossed the eager line, either way - because this function is the one place that
    // knows it.
    let unfollowed: Vec<String> = eager_before
        .iter()
        .filter(|a| !eager_now.contains(*a))
        .cloned()
        .collect();
    crate::fanout::excise_unfollowed(state, root_hex, &unfollowed)
        .await
        .context("excising unfollowed feeds")?;
    for author in eager_now.iter().filter(|a| !eager_before.contains(*a)) {
        crate::fanout::backfill_follow(state, root_hex, author).await;
    }

    // Publication rides the same pass: this is the one place the whole ledger is read with the
    // store open, so consent flips and dial turns mint their public-edge statements here
    // (publish.rs). Locally-authored statements never take the sync gate, so the notification
    // fold is rung by hand for the same-node-subject case. Post-ingest passes are memo-only -
    // see `Minting` for the measured reason.
    if minting == Minting::Allowed {
        match crate::publish::reconcile(state, &store, root_hex, &contacts).await {
            Ok(changed) if !changed.is_empty() => {
                crate::notifications::refresh_from(state, root_hex).await;
                // Knock now rather than at the next backstop beat. Same shape as every other
                // push here (eager edge, periodic sweep behind it): the sweep exists for the
                // doors that were shut, not as the normal path to an open one.
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(e) = crate::outbox::sweep(state).await {
                        tracing::debug!(error = ?e, "eager notice delivery failed");
                    }
                });
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(root = %root_hex, error = ?e, "public-edge reconcile failed"),
        }
    }
    Ok(())
}

/// Every reader on this node following `foreign_root` for FEED purposes: eagerness set and
/// above zero, because the interest dial's bottom stop is labeled "don't show" and it means it.
/// A rebroadcast-only or trust-only edge is not a follow.
pub async fn followers_of(node_db: &crate::db::Db, foreign_root: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT local_root FROM subscriptions
             WHERE foreign_root = ?1 AND eagerness IS NOT NULL AND eagerness > 0",
            (foreign_root,),
        )
        .await
        .context("reading a persona's local followers")?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Does `local_root` follow `foreign_root` for feed purposes? The same criterion as
/// `followers_of`, asked pointwise - the notifications fold's routing check.
pub async fn follows(
    node_db: &crate::db::Db,
    local_root: &str,
    foreign_root: &str,
) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM subscriptions
             WHERE local_root = ?1 AND foreign_root = ?2
               AND eagerness IS NOT NULL AND eagerness > 0",
            (local_root, foreign_root),
        )
        .await
        .context("checking a follow edge")?;
    Ok(row.is_some())
}

/// Every foreign persona this node SYNCS, with who wants it and how eagerly - the
/// follow-refresh sweep's worklist (idface::refresh_followed_pass).
///
/// **Two dials open this door, not one** (2026-08-10). Interest means "I want your posts";
/// rebroadcast interest means "I want the things you share". Either is a reason to hold your
/// chains, and rebroadcast-only is a legitimate relationship - "I don't care what you think,
/// but you find good links" is a real way people follow people. A reader with only a
/// rebroadcast band still needs your chains synced, so the SYNC criterion is the union.
///
/// The eagerness returned is the stronger of the two, because it is a scheduling weight ("how
/// often do we wake for them") and the answer to that is however badly this node wants either
/// stream.
///
/// What the two dials do NOT share is the **feed** decision. `followers_of` stays keyed on
/// interest alone, and journaling shared documents will get its own worklist keyed on
/// rebroadcast alone - so a reader with only a rebroadcast band receives the shares and not the
/// posts. Deciding at journaling time rather than at render time is the same rule
/// `excise_unfollowed` enforces from the other end ("the feed is the reader's room", and "don't
/// show" applies retroactively): a row nobody will ever be shown is never written, and there is
/// no filter to forget at one of the read sites.
pub async fn followed_foreign(node_db: &crate::db::Db) -> Result<Vec<(String, String, i64)>> {
    let mut rows: Vec<(String, String, i64)> = node_db
        .fetch_all(
            "SELECT foreign_root, local_root, MAX(COALESCE(eagerness, 0), COALESCE(rebroadcast, 0))
             FROM subscriptions
             WHERE (eagerness IS NOT NULL AND eagerness > 0)
                OR (rebroadcast IS NOT NULL AND rebroadcast > 0)",
            (),
        )
        .await
        .context("listing synced foreign personas")?;

    // The third source, and the one that is not a dial at all: an author a local persona has
    // REBROADCAST must keep being refreshed even after every dial pointing at them goes back to
    // nothing (`rebroadcast::pinned_authors`). Otherwise a share outliving its follow becomes a
    // copy that can never learn it was retracted - permanence handed out by the back door,
    // which is the exact property pointer-plus-replica exists to deny.
    //
    // Weight 1 (the bottom rung, not zero): a pinned author is worth keeping current, but a
    // share is not a subscription and must not out-shout one. A pinned author who is ALSO
    // followed keeps their real eagerness, because the dedup below prefers the larger.
    let pinned = crate::rebroadcast::pinned_authors(node_db).await?;
    for (author, holder) in pinned {
        match rows
            .iter_mut()
            .find(|(f, l, _)| *f == author && *l == holder)
        {
            Some(_) => {} // already wanted, at a weight the dial chose
            None => rows.push((author, holder, 1)),
        }
    }
    Ok(rows)
}


/// One pass. `who` is the identity a write nudge named - a contact dial is a private-chain
/// write like any other, so turning one wakes this with that persona's name on it. `None` (a
/// tick, or a lag that can no longer say) rebuilds everyone's.
///
/// Hosted personas only: a foreign persona's database is their public lane as we fetched it,
/// and carries no ledger of ours to read.
pub async fn sweep(state: AppState, who: Option<String>) -> Result<()> {
    let hosted = crate::identity::hosted_roots_with_accounts(&state.node_db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    for (root, account) in hosted {
        if who.as_deref().is_some_and(|w| w != root) {
            continue;
        }
        // The backstop's stat-guard (see frontier::sweep): a full sweep is recovery, and this
        // pass pays a keystore unseal per persona it opens - the most expensive per-root cost
        // of any sweep on the node, which is exactly why an idle persona must cost a stat.
        if who.is_none() {
            match state.user_dbs.db_mtime_ms(&root) {
                Some(mt) if state.sweep_marks.is_stale("subscriptions", &root, mt) => {
                    state.sweep_marks.record("subscriptions", &root, mt);
                }
                _ => continue,
            }
        } else if let Some(mt) = state.user_dbs.db_mtime_ms(&root) {
            state.sweep_marks.record("subscriptions", &root, mt);
        }
        if let Err(e) = refresh(&state, &root, &account, Minting::Allowed).await {
            tracing::warn!(root = %root, error = ?e, "subscription refresh failed");
        }
    }
    Ok(())
}

/// Refresh one root's memo when its account is not in hand - the post-INGEST hook's shape.
///
/// A contact dial turned on one device reaches the others by sync, and ingest never rings the
/// nudge bus (relay damping). Without this, the memo only learned about cross-device dials
/// from the backstop tick - which made the tick load-bearing instead of recovery, and was the
/// missing event hook behind "why are we reopening every database every tick?".
pub async fn refresh_root(state: &AppState, root_hex: &str) {
    let Ok(hosted) = crate::identity::hosted_roots_with_accounts(&state.node_db).await else {
        return;
    };
    if let Some((root, account)) = hosted.into_iter().find(|(r, _)| r == root_hex) {
        if let Some(mt) = state.user_dbs.db_mtime_ms(&root) {
            state.sweep_marks.record("subscriptions", &root, mt);
        }
        if let Err(e) = refresh(state, &root, &account, Minting::MemoOnly).await {
            tracing::debug!(root = %root, error = ?e, "post-ingest subscription refresh failed");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn reads_the_routing_dials() {
        let e = edge_of(&facts(&[("interest", "high"), ("interest_rebroadcasts", "low")]));
        assert_eq!(e.eagerness, Some(3));
        assert_eq!(e.rebroadcast, Some(1));
        assert_eq!(e.trust, None);
    }

    #[test]
    fn withholds_trust_the_author_kept_quiet() {
        // The whole justification for trust being in a node-level table at all - now keyed on
        // the one word that withholds, since publication is the resting state (2026-08-09).
        let e = edge_of(&facts(&[("trust", "max"), ("edges_public", "no")]));
        assert_eq!(e.trust, None, "a withheld assessment never leaves its own database");
    }

    #[test]
    fn carries_trust_by_default() {
        // Silence publishes. ('yes' is the word the ledger UI writes when it writes one at
        // all - the pre-banding gate matched "true"/"1", which no writer ever produced, so
        // UI-granted consent silently never reached this table; found 2026-08-09.)
        let quiet = edge_of(&facts(&[("trust", "max")]));
        assert_eq!(quiet.trust, Some(4), "an unset visibility register publishes");
        let spoken = edge_of(&facts(&[("trust", "medium"), ("edges_public", "yes")]));
        assert_eq!(spoken.trust, Some(2));
    }

    #[test]
    fn an_edge_with_nothing_on_it_is_not_a_row() {
        assert!(edge_of(&facts(&[])).is_empty());
        assert!(edge_of(&facts(&[("nickname", "Bee")])).is_empty(), "a name is not an edge");
        assert!(edge_of(&facts(&[("blocked", "yes")])).is_empty(), "a block stays home");
        assert!(
            !edge_of(&facts(&[("interest", "none")])).is_empty(),
            "the bottom band is a choice, not absence"
        );
    }

    #[test]
    fn shrugs_at_values_it_cannot_read() {
        let e = edge_of(&facts(&[("interest", "quite a lot"), ("edges_public", "yes")]));
        assert_eq!(e.eagerness, None, "an unparseable dial is no dial, never a zero");
        let legacy = edge_of(&facts(&[("interest", "75"), ("trust", "95")]));
        assert_eq!(legacy.eagerness, None, "the retired numeric scale reads as silence");
        assert_eq!(legacy.trust, None);
    }
}
