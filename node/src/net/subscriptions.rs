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

/// One persona's edge to another, as this table records it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Edge {
    /// Interest: how eagerly to sync them (the dial is already a cadence dial by design).
    pub eagerness: Option<i64>,
    /// Interest in what they rebroadcast.
    pub rebroadcast: Option<i64>,
    /// Their trust value - ONLY when the author consented to it being known.
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
const TRUST_PUBLIC: &str = "trust_public";

/// One contact's facts, read as an edge. The consent check lives HERE and nowhere else: an
/// unconsented trust value is not copied out of the persona's database at all, rather than
/// copied and then filtered by whoever reads.
fn edge_of(facts: &BTreeMap<String, String>) -> Edge {
    let num = |k: &str| facts.get(k).and_then(|v| v.parse::<i64>().ok());
    let consented = matches!(facts.get(TRUST_PUBLIC).map(String::as_str), Some("true" | "1"));
    Edge {
        eagerness: num(INTEREST),
        rebroadcast: num(REBROADCAST),
        trust: if consented { num(TRUST) } else { None },
    }
}

/// Rebuild one persona's rows from their own ledger.
///
/// A whole-persona rewrite rather than a delta - the alternative is tracking which ledger
/// key changed, which is exactly the bookkeeping the memo idiom exists to avoid - but a
/// rewrite that SCALES: upserts land as chunked multi-row statements (the `fanout` batching
/// pattern), and the removal half is the stamp sweep below, never a list. Rows for contacts
/// whose last dial went back to nothing are deleted, because a subscription nobody holds
/// must not keep routing.
pub async fn refresh(state: &AppState, root_hex: &str, account_id: &uuid::Uuid) -> Result<()> {
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
    for (foreign_root, facts) in contacts {
        let edge = edge_of(&facts);
        if edge.is_empty() {
            continue;
        }
        if edge.eagerness.is_some_and(|e| e > 0) {
            eager_now.insert(foreign_root.clone());
        }
        edges.push((foreign_root, edge));
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

/// Every followed foreign persona, with who follows it and how eagerly - the follow-refresh
/// sweep's worklist (idface::refresh_followed_pass). Eagerness > 0 is the feed criterion,
/// same as followers_of: the dial's bottom stop means "don't show", and it also means
/// "don't spend wake-up syncs on them".
pub async fn followed_foreign(node_db: &crate::db::Db) -> Result<Vec<(String, String, i64)>> {
    let rows: Vec<(String, String, i64)> = node_db
        .fetch_all(
            "SELECT foreign_root, local_root, eagerness FROM subscriptions
             WHERE eagerness IS NOT NULL AND eagerness > 0",
            (),
        )
        .await
        .context("listing followed foreign personas")?;
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
        if let Err(e) = refresh(&state, &root, &account).await {
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
        if let Err(e) = refresh(state, &root, &account).await {
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
        let e = edge_of(&facts(&[("interest", "75"), ("interest_rebroadcasts", "25")]));
        assert_eq!(e.eagerness, Some(75));
        assert_eq!(e.rebroadcast, Some(25));
        assert_eq!(e.trust, None);
    }

    #[test]
    fn withholds_trust_without_consent() {
        // The whole justification for trust being in a node-level table at all.
        let e = edge_of(&facts(&[("trust", "95")]));
        assert_eq!(e.trust, None, "a quiet assessment never leaves its own database");
        let still = edge_of(&facts(&[("trust", "95"), ("trust_public", "false")]));
        assert_eq!(still.trust, None, "and an explicit refusal is still a refusal");
    }

    #[test]
    fn carries_trust_the_author_published() {
        let e = edge_of(&facts(&[("trust", "95"), ("trust_public", "true")]));
        assert_eq!(e.trust, Some(95), "consent is what makes it the node's business");
        // The raw 0-100 travels, not a bucket: nothing consumes it yet, and a number can be
        // bucketed later where a bucket can never be un-bucketed.
        let mid = edge_of(&facts(&[("trust", "37"), ("trust_public", "true")]));
        assert_eq!(mid.trust, Some(37));
    }

    #[test]
    fn an_edge_with_nothing_on_it_is_not_a_row() {
        assert!(edge_of(&facts(&[])).is_empty());
        assert!(edge_of(&facts(&[("nickname", "Bee")])).is_empty(), "a name is not an edge");
        assert!(edge_of(&facts(&[("blocked", "true")])).is_empty(), "a block stays home");
        assert!(!edge_of(&facts(&[("interest", "0")])).is_empty(), "zero is a choice, not absence");
    }

    #[test]
    fn shrugs_at_values_it_cannot_read() {
        let e = edge_of(&facts(&[("interest", "quite a lot"), ("trust_public", "true")]));
        assert_eq!(e.eagerness, None, "an unparseable dial is no dial, never a zero");
    }
}
