//! Starter contacts (Curtis, 2026-09-28, the day something went to the real live internet): the
//! people every new persona begins its life knowing - the official Horse Drawing Tycoon 2 persona
//! and Cube Drone - each with the dials set as a person would set them, and published like any dial
//! (edges are public unless withheld, publish.rs; Curtis chose that they be).
//!
//! Seeded when a persona is CREATED here, never when one is joined or recovered: those already have
//! their contacts, and a starter somebody dropped on purpose must stay dropped. Each starter is then
//! fetched in the background through its via hint, so the first feed has them in it. Only on a node
//! meant for the real network - a prod build, which the packaged app and a server are - and never in
//! the test rig or on a dev node, which must not dial the internet or grow contacts nobody asked for.
//! `RINGTOME_STARTER_CONTACTS` replaces the list (`none` empties it); an operator's own list is a later
//! idea, not this one.

use anyhow::{anyhow, Result};

use crate::record::store::Store;
use crate::AppState;

/// One starter: whom, where to find them, and how the new persona begins about them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Starter {
    pub root: [u8; 32],
    /// The node keys (base58) a fetch tries first - the `?via=` of their address.
    pub via: Vec<String>,
    pub trust: String,
    pub interest: String,
    pub rebroadcasts: String,
}

/// The two, as their addresses give them: `root via trust interest rebroadcast-interest`.
const BUILT_IN: &str = "\
EBnZy7HqP8X9Vd1CL3XL128xfV32v4xEgXehivgAG97w:9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX:medium:medium:medium;\
HVnmWLq8YSnyiUCupmHM6wP91yrwC6PpcynabWGVHRkL:9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX:medium:low:low";

/// A list in the environment's spelling: `root:via[,via]:trust:interest:rebroadcasts`, `;` between
/// starters; `root` in any spelling an address takes, the bands the dials' own words.
pub fn parse(list: &str) -> Result<Vec<Starter>> {
    let mut out = Vec::new();
    for item in list.split(';').map(str::trim).filter(|s| !s.is_empty()) {
        let parts: Vec<&str> = item.split(':').collect();
        let [root, via, trust, interest, rebroadcasts] = parts.as_slice() else {
            return Err(anyhow!("a starter is root:via:trust:interest:rebroadcasts - {item:?}"));
        };
        let Some(crate::speakable::Parsed::Ok(root)) = crate::speakable::parse(root) else {
            return Err(anyhow!("not an address: {root:?}"));
        };
        for band in [trust, interest, rebroadcasts] {
            if !ringtome_proto::PublicEdge::BANDS.contains(band) && *band != "none" {
                return Err(anyhow!("not a dial's word: {band:?}"));
            }
        }
        out.push(Starter {
            root,
            via: via.split(',').map(str::trim).filter(|v| !v.is_empty()).map(str::to_string).collect(),
            trust: trust.to_string(),
            interest: interest.to_string(),
            rebroadcasts: rebroadcasts.to_string(),
        });
    }
    Ok(out)
}

/// The list this node seeds: the environment's when it says one, else the two - but only on a prod
/// node outside the test rig.
pub fn configured(env: Option<&str>, prod: bool, local_test: bool) -> Result<Vec<Starter>> {
    match env.map(str::trim) {
        Some("none") | Some("") => Ok(Vec::new()),
        Some(list) => parse(list),
        None if prod && !local_test => parse(BUILT_IN),
        None => Ok(Vec::new()),
    }
}

/// Give a newborn persona its starters: the three dials on each (never the persona itself), folded at
/// once so the follow and its public statement are in place before the first feed, then each fetched
/// through its hints, detached - a starter's node being slow or dark never delays a sign-up.
pub async fn seed(state: &AppState, data: &Store, root_hex: &str) {
    let starters = state.config.starter_contacts.clone();
    if starters.is_empty() {
        return;
    }
    let mut fetch: Vec<(String, Vec<String>)> = Vec::new();
    for s in &starters {
        let them = hex::encode(s.root);
        if them == root_hex {
            continue;
        }
        let collection = format!("contact:{them}");
        let register = data.private_registers(&collection);
        for (key, value) in [("trust", &s.trust), ("interest", &s.interest), ("interest_rebroadcasts", &s.rebroadcasts)] {
            if let Err(e) = register.set(key, value).await {
                tracing::warn!(error = ?e, starter = %them, key, "a starter's dial did not take");
            }
        }
        fetch.push((them, s.via.clone()));
    }
    crate::fold::fold_now(state, root_hex).await;
    tracing::info!(root = %root_hex, starters = fetch.len(), "seeded a new persona's starter contacts");
    for (them, via) in fetch {
        let state = state.clone();
        tokio::spawn(async move {
            let fetched = crate::idface::fetch_foreign(&state, &them, &via).await;
            tracing::info!(starter = %them, fetched, "fetched a starter contact");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The two built in read as themselves; a list says what the environment says; and only a prod
    /// node outside the rig seeds without being told (2026-09-28).
    #[test]
    fn the_starters_are_the_two_and_only_where_meant() {
        let two = parse(BUILT_IN).expect("the built-in list parses");
        assert_eq!(two.len(), 2);
        assert_eq!((two[0].trust.as_str(), two[0].interest.as_str(), two[0].rebroadcasts.as_str()), ("medium", "medium", "medium"));
        assert_eq!((two[1].trust.as_str(), two[1].interest.as_str(), two[1].rebroadcasts.as_str()), ("medium", "low", "low"));
        assert_eq!(two[0].via, vec!["9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX".to_string()]);
        assert_eq!(configured(None, true, false).unwrap().len(), 2, "a prod node");
        assert!(configured(None, false, false).unwrap().is_empty(), "a dev node");
        assert!(configured(None, true, true).unwrap().is_empty(), "the test rig");
        assert!(configured(Some("none"), true, false).unwrap().is_empty(), "turned off");
        assert!(parse("EBnZy7HqP8X9Vd1CL3XL128xfV32v4xEgXehivgAG97w:v:fond:low:low").is_err(), "not a dial's word");
        assert!(parse("nope:v:low:low:low").is_err(), "not an address");
    }
}
