//! Starter contacts (Curtis, 2026-09-28, the day something went to the real live internet): the
//! people every new persona begins its life knowing - the official Horse Drawing Tycoon 2 persona,
//! Cube Drone, and Tom (2026-09-29: everybody's first friend, as he always was) - each with the dials set as a person would set them, and published like any dial
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

/// The three, as their addresses give them: `root via trust interest rebroadcast-interest`. Tom is
/// always there and never loud: low on every dial.
const BUILT_IN: &str = "\
EBnZy7HqP8X9Vd1CL3XL128xfV32v4xEgXehivgAG97w:9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX:medium:medium:medium;\
HVnmWLq8YSnyiUCupmHM6wP91yrwC6PpcynabWGVHRkL:9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX:medium:low:low;\
J4Rkao4TfvtmVnVyiRu3SgGaN3DcLnEts7xhffjk2q2F:9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX:low:low:low";

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
            via: via
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect(),
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
/// The contact-register key that marks a follow as the node's own doing - a starter's or a group's
/// (groups.rs) - rather than the person's: `starter` or `group`.
pub const AUTO_KEY: &str = "auto";

pub async fn seed(state: &AppState, data: &Store, root_hex: &str) {
    // The built-in (or environment's) starters, then the operator's own list - which wins for a
    // person on both, its dials being this node's word (2026-10-02).
    let mut starters = state.config.starter_contacts.clone();
    match auto_follow(&state.node_db).await {
        Ok(list) => {
            for a in list {
                let Some(root) = crate::pubkey::decode(&a.root) else { continue };
                starters.retain(|s| s.root != root);
                starters.push(Starter {
                    root,
                    via: a.via,
                    trust: a.trust,
                    interest: a.interest,
                    rebroadcasts: a.rebroadcasts,
                });
            }
        }
        Err(e) => tracing::warn!(error = ?e, "could not read the operator's auto-follow list"),
    }
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
        // `auto`: this follow was the node's, not the person's (2026-10-04) - the "Follow a
        // stranger" contract (bank.rs) never counts it. Private, never published.
        let auto = "starter".to_string();
        for (key, value) in [
            ("trust", &s.trust),
            ("interest", &s.interest),
            ("interest_rebroadcasts", &s.rebroadcasts),
            (AUTO_KEY, &auto),
        ] {
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

// ---------------------------------------------------------------------------------------------
// The operator's own list (Curtis, 2026-10-02: an admin who doesn't want the whole "everyone here
// is a friend" group should at least be able to choose who every newcomer starts out following).

/// One person on the operator's list, as the Server app shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AutoFollow {
    /// Their root, hex.
    pub root: String,
    pub via: Vec<String>,
    pub trust: String,
    pub interest: String,
    pub rebroadcasts: String,
    pub added_ms: i64,
    /// Their name, when this node's byline cache knows it (profiles.rs) - for the list's eye only.
    pub name: Option<String>,
}

pub async fn auto_follow(db: &crate::db::Db) -> Result<Vec<AutoFollow>, crate::error::AppError> {
    let rows: Vec<(String, String, String, String, String, i64)> = db
        .fetch_all("SELECT root_pubkey, via, trust, interest, rebroadcasts, added_ms FROM auto_follow ORDER BY added_ms", ())
        .await
        .map_err(crate::error::AppError::Internal)?;
    let roots: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let names = crate::profiles::bylines(db, &roots).await.unwrap_or_default();
    Ok(rows
        .into_iter()
        .map(|(root, via, trust, interest, rebroadcasts, added_ms)| AutoFollow {
            name: names.get(&root).and_then(|b| b.name.clone()),
            root,
            via: via
                .split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect(),
            trust,
            interest,
            rebroadcasts,
            added_ms,
        })
        .collect())
}

/// A person's address as somebody pastes it - a bare root in any spelling, or a page's link
/// (`…/ringtome/user/<root>…?via=a,b`) - as its root and its via hints.
pub fn parse_address(input: &str) -> Option<([u8; 32], Vec<String>)> {
    let input = input.trim();
    let (path, query) = input.split_once('?').unwrap_or((input, ""));
    let seg = match path.split_once("/user/") {
        Some((_, rest)) => rest.split('/').next().unwrap_or(""),
        None => path.trim_matches('/'),
    };
    let Some(crate::speakable::Parsed::Ok(root)) = crate::speakable::parse(seg) else {
        return None;
    };
    let via = query
        .split('&')
        .filter_map(|kv| kv.strip_prefix("via="))
        .flat_map(|v| v.split(','))
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .collect();
    Some((root, via))
}

/// Put somebody on the operator's list (or change their dials there).
pub async fn add_auto_follow(
    db: &crate::db::Db,
    address: &str,
    trust: &str,
    interest: &str,
    rebroadcasts: &str,
) -> Result<(), crate::error::AppError> {
    use crate::error::AppError;
    let (root, via) = parse_address(address).ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "starters.not-an-address",
            "that isn't a person's address"
        ))
    })?;
    for band in [trust, interest, rebroadcasts] {
        if !ringtome_proto::PublicEdge::BANDS.contains(&band) && band != "none" {
            return Err(AppError::BadRequest(crate::msg!(
                "starters.not-a-dial",
                "not a dial's word: {band}",
                band = band
            )));
        }
    }
    db.execute(
        "INSERT INTO auto_follow (root_pubkey, via, trust, interest, rebroadcasts, added_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (root_pubkey) DO UPDATE SET via = excluded.via, trust = excluded.trust, interest = excluded.interest,
             rebroadcasts = excluded.rebroadcasts",
        (hex::encode(root), via.join(","), trust, interest, rebroadcasts, crate::clock::now_ms()),
    )
    .await
    .map_err(AppError::Internal)?;
    Ok(())
}

pub async fn remove_auto_follow(
    db: &crate::db::Db,
    root_hex: &str,
) -> Result<(), crate::error::AppError> {
    db.execute("DELETE FROM auto_follow WHERE root_pubkey = ?1", (root_hex,))
        .await
        .map_err(crate::error::AppError::Internal)?;
    Ok(())
}

#[derive(serde::Deserialize)]
pub struct AddAutoFollow {
    address: String,
    #[serde(default = "low")]
    trust: String,
    #[serde(default = "medium")]
    interest: String,
    #[serde(default = "low")]
    rebroadcasts: String,
}
fn low() -> String {
    "low".into()
}
fn medium() -> String {
    "medium".into()
}

/// POST `/api/admin/auto-follow` - add somebody to the list (low trust, medium interest, low
/// rebroadcasts unless said otherwise: enough that their posts show).
pub async fn add_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    _admin: crate::auth::NodeAdminSession,
    axum::Json(req): axum::Json<AddAutoFollow>,
) -> Result<axum::Json<Vec<AutoFollow>>, crate::error::AppError> {
    add_auto_follow(&state.node_db, &req.address, &req.trust, &req.interest, &req.rebroadcasts)
        .await?;
    Ok(axum::Json(auto_follow(&state.node_db).await?))
}

/// DELETE `/api/admin/auto-follow/{root}` - take somebody off the list. Who already began with
/// them keeps them: the list is where a persona begins, not a leash.
pub async fn remove_handler(
    axum::extract::State(state): axum::extract::State<AppState>,
    _admin: crate::auth::NodeAdminSession,
    axum::extract::Path(root): axum::extract::Path<String>,
) -> Result<axum::Json<Vec<AutoFollow>>, crate::error::AppError> {
    remove_auto_follow(&state.node_db, &root).await?;
    Ok(axum::Json(auto_follow(&state.node_db).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three built in read as themselves; a list says what the environment says; and only a prod
    /// node outside the rig seeds without being told (2026-09-28).
    #[test]
    fn the_starters_are_the_two_and_only_where_meant() {
        let two = parse(BUILT_IN).expect("the built-in list parses");
        assert_eq!(two.len(), 3, "HDT2, Cube Drone, and Tom");
        assert_eq!(
            (two[2].trust.as_str(), two[2].interest.as_str(), two[2].rebroadcasts.as_str()),
            ("low", "low", "low"),
            "Tom: there, and quiet"
        );
        assert_eq!(
            (two[0].trust.as_str(), two[0].interest.as_str(), two[0].rebroadcasts.as_str()),
            ("medium", "medium", "medium")
        );
        assert_eq!(
            (two[1].trust.as_str(), two[1].interest.as_str(), two[1].rebroadcasts.as_str()),
            ("medium", "low", "low")
        );
        assert_eq!(two[0].via, vec!["9rZH3e1NMMVvnaM8BCtwXM4CMAaC2oYgwXD3ZCp1XVGX".to_string()]);
        assert_eq!(configured(None, true, false).unwrap().len(), 3, "a prod node");
        assert!(configured(None, false, false).unwrap().is_empty(), "a dev node");
        assert!(configured(None, true, true).unwrap().is_empty(), "the test rig");
        assert!(configured(Some("none"), true, false).unwrap().is_empty(), "turned off");
        assert!(
            parse("EBnZy7HqP8X9Vd1CL3XL128xfV32v4xEgXehivgAG97w:v:fond:low:low").is_err(),
            "not a dial's word"
        );
        assert!(parse("nope:v:low:low:low").is_err(), "not an address");
    }
}
