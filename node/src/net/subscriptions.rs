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
/// A whole-persona rewrite rather than a delta: the ledger is small (one row per person you
/// have an opinion about), and the alternative is tracking which key changed, which is exactly
/// the bookkeeping the memo idiom exists to avoid. Rows for contacts whose last dial went back
/// to nothing are deleted, because a subscription nobody holds must not keep routing.
pub async fn refresh(state: &AppState, root_hex: &str, account_id: &uuid::Uuid) -> Result<()> {
    let store = crate::record::store::open(state, account_id, root_hex)
        .await
        .map_err(|e| anyhow::anyhow!("opening {root_hex} to read its ledger: {e}"))?;
    let contacts = store
        .contacts()
        .await
        .map_err(|e| anyhow::anyhow!("reading the contact ledger: {e}"))?;

    let now = now_ms();
    let mut keep: Vec<String> = Vec::new();
    for (foreign_root, facts) in contacts {
        let edge = edge_of(&facts);
        if edge.is_empty() {
            continue;
        }
        keep.push(foreign_root.clone());
        state
            .node_db
            .execute(
                "INSERT INTO subscriptions
                   (local_root, foreign_root, eagerness, rebroadcast, trust, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (local_root, foreign_root) DO UPDATE SET
                     eagerness = excluded.eagerness,
                     rebroadcast = excluded.rebroadcast,
                     trust = excluded.trust,
                     updated_at_ms = excluded.updated_at_ms",
                (
                    root_hex,
                    foreign_root.as_str(),
                    edge.eagerness,
                    edge.rebroadcast,
                    edge.trust,
                    now,
                ),
            )
            .await
            .context("storing a subscription")?;
    }

    // Everything this persona no longer has any edge to. Quoting is safe here because these
    // are hex roots that came out of the ledger's own collection names, but the filter is
    // belt-and-braces: anything that isn't hex cannot name a row we wrote.
    let quoted: Vec<String> = keep
        .iter()
        .filter(|r| r.len() == 64 && r.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|r| format!("'{r}'"))
        .collect();
    state
        .node_db
        .execute(
            &format!(
                "DELETE FROM subscriptions WHERE local_root = ?1 AND foreign_root NOT IN ({})",
                if quoted.is_empty() { "''".into() } else { quoted.join(",") }
            ),
            (root_hex,),
        )
        .await
        .context("clearing withdrawn subscriptions")?;
    Ok(())
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
        if let Err(e) = refresh(&state, &root, &account).await {
            tracing::warn!(root = %root, error = ?e, "subscription refresh failed");
        }
    }
    Ok(())
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
