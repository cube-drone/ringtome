//! The edge-publication mint: `public-edge` statements from the consented ledger.
//!
//! Doctrine (PROJECT_PLAN: The Vouch Dissolved into the Ledger; Edge-Endpoint Visibility, the
//! Publish tier): the ledger's `edges_public` dial is CONSENT, never publication - Copy, Don't
//! Flip. This module is the publication: it compares the desired public view (every contact
//! whose ledger consents, carrying the bands as set) against what the chains already say
//! (`imaol::published_edges`), and appends statements only for the difference. Consent granted
//! mints a statement; a dial turned while consented mints the update; consent withdrawn mints
//! the retraction (a statement with no bands - LWW needs a write to override the old one, so
//! silence cannot un-publish).
//!
//! Reconciliation is idempotent and multi-device safe: each device compares against the merged
//! fold of ALL the persona's follows-public chains, so a statement another device already made
//! is not repeated; two devices racing the same delta write agreeing statements, which LWW
//! collapses harmlessly. It rides `subscriptions::refresh` - the one place already reading the
//! whole ledger with the store open - so publication reacts to dial turns at the same speed the
//! routing memo does.

use std::collections::BTreeMap;

use anyhow::Result;

use crate::record::imaol::PublishedEdge;
use crate::record::store::Store;
use ringtome_proto::PublicEdge;

/// The ledger keys this module reads (mirroring `js/pure/contact.js`).
const TRUST: &str = "trust";
const INTEREST: &str = "interest";
const EDGES_PUBLIC: &str = "edges_public";

/// A stored dial value as a validated band, or None: silence, garbage, and the retired numeric
/// scale all read as "no opinion", never as a publishable word. Proto's band list is the source
/// of truth - the mint must never sign a word the wire format rejects.
fn band(facts: &BTreeMap<String, String>, key: &str) -> Option<String> {
    facts
        .get(key)
        .filter(|v| PublicEdge::BANDS.contains(&v.as_str()))
        .cloned()
}

/// What one contact's ledger wants published: the bands, if consented and any are set. A
/// consented ledger with no dials set desires nothing - same as no consent - so flipping
/// consent before ever touching a dial publishes no empty statement.
fn desired_of(facts: &BTreeMap<String, String>) -> Option<PublishedEdge> {
    if facts.get(EDGES_PUBLIC).map(String::as_str) != Some("yes") {
        return None;
    }
    let edge = PublishedEdge {
        trust: band(facts, TRUST),
        interest: band(facts, INTEREST),
    };
    (!edge.is_empty()).then_some(edge)
}

/// Reconcile the chains with the ledger: append statements for every difference between what
/// consent wants published and what the fold says is published. Returns the roots whose
/// statements changed (the notification fold's worklist for locally-hosted subjects).
pub async fn reconcile(
    store: &Store,
    contacts: &[(String, BTreeMap<String, String>)],
) -> Result<Vec<String>> {
    let edges = store.public_edges();
    let published = edges
        .published()
        .await
        .map_err(|e| anyhow::anyhow!("folding published edges: {e}"))?;

    let mut changed = Vec::new();
    let mut desired_subjects: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
    for (subject_hex, facts) in contacts {
        let Some(subject) = crate::pubkey::decode(subject_hex) else {
            continue; // a malformed ledger collection name publishes nothing
        };
        let Some(desired) = desired_of(facts) else {
            continue; // unconsented (or nothing to say): handled by the retraction pass below
        };
        desired_subjects.insert(subject_hex.as_str());
        if published.get(subject_hex).map(|r| &r.edge) == Some(&desired) {
            continue;
        }
        edges
            .publish(&subject, desired.trust.clone(), desired.interest.clone())
            .await
            .map_err(|e| anyhow::anyhow!("publishing edge for {subject_hex}: {e}"))?;
        changed.push(subject_hex.clone());
    }

    // The retraction pass: every subject the chains publish that the ledger no longer wants
    // published. `published` already folds retractions to empty, so only live statements
    // retract - un-consenting twice writes once.
    for (subject_hex, row) in &published {
        if row.edge.is_empty() || desired_subjects.contains(subject_hex.as_str()) {
            continue;
        }
        let Some(subject) = crate::pubkey::decode(subject_hex) else {
            continue;
        };
        edges
            .publish(&subject, None, None)
            .await
            .map_err(|e| anyhow::anyhow!("retracting edge for {subject_hex}: {e}"))?;
        changed.push(subject_hex.clone());
    }
    Ok(changed)
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
    fn consent_gates_desire() {
        assert_eq!(
            desired_of(&facts(&[("trust", "max"), ("interest", "high")])),
            None,
            "no consent, nothing desired"
        );
        assert_eq!(
            desired_of(&facts(&[("trust", "max"), ("edges_public", "no")])),
            None,
            "an explicit refusal is still a refusal"
        );
        let d = desired_of(&facts(&[
            ("trust", "max"),
            ("interest", "high"),
            ("edges_public", "yes"),
        ]))
        .unwrap();
        assert_eq!(d.trust.as_deref(), Some("max"));
        assert_eq!(d.interest.as_deref(), Some("high"));
    }

    #[test]
    fn consent_with_nothing_to_say_desires_nothing() {
        assert_eq!(desired_of(&facts(&[("edges_public", "yes")])), None);
        // The retired numeric scale is not a band and must never be signed onto a chain.
        assert_eq!(
            desired_of(&facts(&[("trust", "95"), ("edges_public", "yes")])),
            None
        );
    }

    #[test]
    fn one_band_is_enough_to_publish() {
        let d = desired_of(&facts(&[("interest", "low"), ("edges_public", "yes")])).unwrap();
        assert_eq!(d.trust, None);
        assert_eq!(d.interest.as_deref(), Some("low"));
    }
}
