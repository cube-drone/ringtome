//! Custom domains (plans/CUSTOM_DOMAINS.md), slice 1: the claim and its proof. Serving the
//! domain is domainsite.rs.
//!
//! A persona claims a domain in its signed profile (the `domain` field), and the claim counts
//! only once the domain agrees: a TXT record at `_ringtome.<domain>` naming the persona's root,
//! or - for the ✓ alone, never for serving (ruling 4) - a `/.well-known/ringtome` file naming it.
//! Anyone can type any domain into a profile; nothing shows one until DNS says it back.
//!
//! Every node that shows a claim checks it itself (section 2), and keeps what it found in
//! `domain_proofs`: a memo, never a wire fact, because the answer depends on when it was asked.
//! A claim is noted when the profile moves (`profiles::refresh`, the byline cache's edge, calls
//! [`claimed`]), checked at once, and checked again about daily by [`pass`]. A lookup that fails
//! outright (DNS down, as opposed to "no such record") keeps a verified claim verified for a grace
//! period, so one bad answer doesn't take the ✓ away.
//!
//! Each check also notes whether the domain is **served** - its well-known file, written by the
//! node serving it, says `"served": true` - because a verified domain becomes the canonical address
//! only once something at it answers for the persona (ruling 7): until then it's still Hugo.
use anyhow::{Context, Result};
use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::auth::Session;
use crate::clock::now_ms;
use crate::error::AppError;
use crate::AppState;

/// The profile field a claim lives in.
pub const FIELD: &str = "domain";
/// What a TXT record's value starts with, before the root.
const RECORD_PREFIX: &str = "ringtome-root=";
/// How often a claim is asked about again.
const RECHECK_MS: i64 = 24 * 60 * 60 * 1000;
/// How soon a claim whose lookups are failing is asked about again.
const RETRY_MS: i64 = 60 * 60 * 1000;
/// How long a verified claim stays verified while its lookups fail outright.
const GRACE_MS: i64 = 3 * 24 * 60 * 60 * 1000;
const LOOKUP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const WELL_KNOWN_MAX_BYTES: usize = 4096;

/// A claimed domain as a profile may hold it - a bare hostname, lowercase, punycode for an
/// international name: `cube-drone.com`, `art.lassam.net` - or None for anything else: a scheme,
/// a path, a port, an IP address, a single label. Exactly the name given (ruling 1): `www.` means
/// nothing of its own.
pub fn normalise(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let raw = raw.strip_suffix('.').unwrap_or(raw);
    if raw.is_empty()
        || raw.contains(['/', ':', '@', '?', '#'])
        || raw.contains(char::is_whitespace)
    {
        return None;
    }
    let url::Host::Domain(domain) = url::Host::parse(raw).ok()? else {
        return None;
    };
    let labels: Vec<&str> = domain.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    };
    let top = labels.last()?;
    (domain.len() <= 253
        && labels.len() >= 2
        && labels.iter().all(label_ok)
        && !top.chars().all(|c| c.is_ascii_digit()))
    .then_some(domain)
}

/// Where the TXT record goes.
pub fn record_name(domain: &str) -> String {
    format!("_ringtome.{domain}")
}

/// What the TXT record says: the root in its short form.
pub fn record_value(root: &[u8; 32]) -> String {
    format!("{RECORD_PREFIX}{}", crate::webpath::short_of(root))
}

/// Does one TXT record's text name `root`? Any spelling the address bar takes - the short form,
/// the worded one (its words checked), hex.
fn names(text: &str, root: &[u8; 32]) -> bool {
    text.trim().strip_prefix(RECORD_PREFIX).is_some_and(|v| {
        matches!(crate::speakable::parse(v), Some(crate::speakable::Parsed::Ok(r)) if r == *root)
    })
}

/// Does a well-known file's body (`{"root": "..."}`) name `root`?
fn well_known_names(body: &[u8], root: &[u8; 32]) -> bool {
    serde_json::from_slice::<serde_json::Value>(body).ok().is_some_and(|v| {
        v.get("root").and_then(|r| r.as_str()).is_some_and(|r| {
            matches!(crate::speakable::parse(r), Some(crate::speakable::Parsed::Ok(k)) if k == *root)
        })
    })
}

/// What one way of asking found.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Said {
    /// The domain names this root.
    Yes,
    /// The domain answered, and doesn't name it.
    No,
    /// No answer at all: DNS or the site was down, or too slow.
    Unknown,
}

/// The TXT records the integration rig pretends DNS holds (`/test/dns-txt`): name -> values.
/// Consulted instead of DNS for a pretend domain ([`pretend`]), so a suite never asks the real one.
static TEST_TXT: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<String>>>,
> = std::sync::LazyLock::new(Default::default);

/// Set (or, with no values, clear) a pretend TXT record. Test rigs only.
pub fn set_test_txt(name: &str, values: Vec<String>) {
    let mut held = TEST_TXT.lock().unwrap();
    if values.is_empty() {
        held.remove(name);
    } else {
        held.insert(name.to_string(), values);
    }
}

/// A domain the rig's records answer for: a `.test` one (a name DNS never holds, RFC 6761) under
/// `RINGTOME_LOCAL_TEST`. Any other domain is asked about for real, even by a dev node
/// (2026-10-18: a real record on a real domain, and a dev node's "check now" never looked).
fn pretend(state: &AppState, domain: &str) -> bool {
    state.config.local_test && domain.ends_with(".test")
}

/// Ask DNS for `_ringtome.<domain>`.
async fn txt_says(state: &AppState, domain: &str, root: &[u8; 32]) -> Said {
    let name = record_name(domain);
    if pretend(state, domain) {
        let held = TEST_TXT.lock().unwrap();
        let said = held.get(&name).is_some_and(|vs| vs.iter().any(|v| names(v, root)));
        return if said { Said::Yes } else { Said::No };
    }
    static RESOLVER: std::sync::OnceLock<Option<hickory_resolver::TokioResolver>> =
        std::sync::OnceLock::new();
    let Some(resolver) = RESOLVER.get_or_init(|| {
        hickory_resolver::TokioResolver::builder_tokio()
            .and_then(|b| b.build())
            .map_err(|e| tracing::warn!(error = %e, "no DNS resolver for custom domains"))
            .ok()
    }) else {
        return Said::Unknown;
    };
    match tokio::time::timeout(LOOKUP_TIMEOUT, resolver.txt_lookup(format!("{name}."))).await {
        Ok(Ok(found)) => {
            let said = found.answers().iter().any(|record| match &record.data {
                // A long record arrives as several strings, read as one.
                hickory_resolver::proto::rr::RData::TXT(txt) => names(
                    &txt.txt_data.iter().map(|s| String::from_utf8_lossy(s)).collect::<String>(),
                    root,
                ),
                _ => false,
            });
            if said {
                Said::Yes
            } else {
                Said::No
            }
        }
        Ok(Err(e)) if e.is_no_records_found() => Said::No,
        _ => Said::Unknown,
    }
}

/// What the domain's `/.well-known/ringtome` said: whether it names the root, and whether a node
/// serving the domain wrote it (`"served": true`, ruling 7) - None for no answer at all.
#[derive(Debug, Clone, Copy, PartialEq)]
struct WellKnown {
    said: Said,
    served: Option<bool>,
}

/// The well-known files the integration rig pretends domains serve (`/test/well-known`):
/// domain -> body. Consulted instead of the web for a pretend domain ([`pretend`]).
static TEST_WELL_KNOWN: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
> = std::sync::LazyLock::new(Default::default);

/// Set (or, with no body, clear) a pretend well-known file. Test rigs only.
pub fn set_test_well_known(domain: &str, body: Option<Vec<u8>>) {
    let mut held = TEST_WELL_KNOWN.lock().unwrap();
    match body {
        Some(body) => held.insert(domain.to_string(), body),
        None => held.remove(domain),
    };
}

/// What a well-known body says about `root`.
fn well_known_of(body: &[u8], root: &[u8; 32]) -> WellKnown {
    let named = well_known_names(body, root);
    let served = named
        && serde_json::from_slice::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("served").and_then(|s| s.as_bool()))
            .unwrap_or(false);
    WellKnown { said: if named { Said::Yes } else { Said::No }, served: Some(served) }
}

/// Ask the domain's website for `/.well-known/ringtome`, through the unfurler's guarded fetch.
async fn well_known_says(state: &AppState, domain: &str, root: &[u8; 32]) -> WellKnown {
    if pretend(state, domain) {
        let held = TEST_WELL_KNOWN.lock().unwrap();
        return match held.get(domain) {
            Some(body) => well_known_of(body, root),
            None => WellKnown { said: Said::No, served: Some(false) },
        };
    }
    let url = format!("https://{domain}/.well-known/ringtome");
    match crate::net::unfurl::fetch_media_bytes(&url, WELL_KNOWN_MAX_BYTES, false).await {
        Ok(body) => well_known_of(&body, root),
        // The site answered, with something that isn't the file: a 404, or a page too big to be
        // it - another site is answering the domain, which is "no", not "no answer".
        Err(e) if e.starts_with("the server answered") || e.starts_with("file ") => {
            WellKnown { said: Said::No, served: Some(false) }
        }
        Err(_) => WellKnown { said: Said::Unknown, served: None },
    }
}

/// What a node serving `root`'s domain answers at its `/.well-known/ringtome`.
pub fn well_known_body(root: &[u8; 32]) -> serde_json::Value {
    serde_json::json!({ "root": crate::webpath::short_of(root), "served": true })
}

/// What this node last found about one persona's claim.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Proof {
    pub domain: String,
    /// `verified`, `unverified` or `lapsed`.
    pub state: String,
    /// `txt` or `well-known`, while verified.
    pub proof: Option<String>,
    /// When it was last asked; 0 before the first ask.
    pub checked_ms: i64,
    pub verified_ms: Option<i64>,
    /// When the domain last said a Ringtome node serves it (ruling 7); None while it doesn't.
    pub served_ms: Option<i64>,
    #[serde(skip)]
    failing_since_ms: Option<i64>,
}

impl Proof {
    pub fn verified(&self) -> bool {
        self.state == "verified"
    }

    /// May the domain be the persona's canonical address: proved theirs, and served (ruling 7)?
    pub fn canonical(&self) -> bool {
        self.verified() && self.served_ms.is_some()
    }
}

type ProofRow = (String, String, Option<String>, i64, Option<i64>, Option<i64>, Option<i64>);

/// The memo's row for `root_hex`, if its profile claims a domain.
pub async fn proof_of(node_db: &crate::db::Db, root_hex: &str) -> Result<Option<Proof>> {
    let row: Option<ProofRow> = node_db
        .fetch_optional(
            "SELECT domain, state, proof, checked_ms, verified_ms, served_ms, failing_since_ms
             FROM domain_proofs WHERE root = ?1",
            (root_hex,),
        )
        .await
        .context("reading a domain proof")?;
    Ok(row.map(|(domain, state, proof, checked_ms, verified_ms, served_ms, failing_since_ms)| {
        Proof { domain, state, proof, checked_ms, verified_ms, served_ms, failing_since_ms }
    }))
}

/// The domain `root_hex` may be shown with: its claim, when the claim is verified.
pub async fn verified(node_db: &crate::db::Db, root_hex: &str) -> Option<String> {
    proof_of(node_db, root_hex).await.ok().flatten().filter(Proof::verified).map(|p| p.domain)
}

/// The domain that is `root_hex`'s canonical address, if it has one: verified, and served.
pub async fn canonical(node_db: &crate::db::Db, root_hex: &str) -> Option<String> {
    proof_of(node_db, root_hex).await.ok().flatten().filter(Proof::canonical).map(|p| p.domain)
}

/// Note what `root_hex`'s profile claims now (`raw`, the field as signed, or None). A new claim
/// starts unverified and is checked at once, in the background; a claim withdrawn leaves the
/// memo. An unchanged one costs a read.
pub async fn claimed(state: &AppState, root_hex: &str, raw: Option<&str>) -> Result<()> {
    let claim = raw.and_then(normalise);
    let held = proof_of(&state.node_db, root_hex).await?;
    if held.as_ref().map(|p| &p.domain) == claim.as_ref() {
        return Ok(());
    }
    let was_shown = held.as_ref().is_some_and(Proof::verified);
    match &claim {
        None => {
            state
                .node_db
                .execute("DELETE FROM domain_proofs WHERE root = ?1", (root_hex,))
                .await
                .context("forgetting a withdrawn domain claim")?;
        }
        Some(domain) => {
            state
                .node_db
                .execute(
                    "INSERT INTO domain_proofs (root, domain, state, proof, checked_ms, verified_ms, failing_since_ms)
                     VALUES (?1, ?2, 'unverified', NULL, 0, NULL, NULL)
                     ON CONFLICT (root) DO UPDATE SET
                         domain = excluded.domain, state = 'unverified', proof = NULL,
                         checked_ms = 0, verified_ms = NULL, served_ms = NULL, failing_since_ms = NULL",
                    (root_hex, domain.as_str()),
                )
                .await
                .context("noting a domain claim")?;
            let (state, root) = (state.clone(), root_hex.to_string());
            tokio::spawn(async move {
                if let Err(e) = check(&state, &root).await {
                    tracing::debug!(root = %root, error = ?e, "domain check failed");
                }
            });
        }
    }
    if was_shown {
        crate::profiles::touch(&state.node_db, root_hex).await?;
    }
    Ok(())
}

/// What a check found, given what was held: the next state, its proof, and when lookups started
/// failing. Pure, so the grace period is testable without a clock.
fn next(
    held: &Proof,
    txt: Said,
    well_known: Said,
    now: i64,
) -> (String, Option<String>, Option<i64>) {
    let found = if txt == Said::Yes {
        Some("txt")
    } else if well_known == Said::Yes {
        Some("well-known")
    } else {
        None
    };
    if let Some(proof) = found {
        return ("verified".into(), Some(proof.into()), None);
    }
    // Failing means no answer from the way it was proved: a TXT record that has gone is gone,
    // whatever the website is doing.
    let failing = match held.proof.as_deref() {
        Some("well-known") => well_known == Said::Unknown,
        _ => txt == Said::Unknown,
    };
    match held.state.as_str() {
        "verified" if failing => {
            let since = held.failing_since_ms.unwrap_or(now);
            if now - since > GRACE_MS {
                ("lapsed".into(), None, None)
            } else {
                ("verified".into(), held.proof.clone(), Some(since))
            }
        }
        "verified" | "lapsed" => ("lapsed".into(), None, None),
        _ => ("unverified".into(), None, None),
    }
}

/// Ask about `root_hex`'s claim now, and keep what was found. None when it claims nothing.
pub async fn check(state: &AppState, root_hex: &str) -> Result<Option<Proof>> {
    let Some(held) = proof_of(&state.node_db, root_hex).await? else {
        return Ok(None);
    };
    let root = crate::pubkey::decode(root_hex).context("a domain proof's root")?;
    let txt = txt_says(state, &held.domain, &root).await;
    // Asked whatever the TXT record said: it's also where the domain says it's served.
    let well_known = well_known_says(state, &held.domain, &root).await;
    let now = now_ms();
    let (verdict, proof, failing_since) = next(&held, txt, well_known.said, now);
    let served_ms = match well_known.served {
        Some(true) => Some(now),
        Some(false) => None,
        None => held.served_ms,
    };
    let verified_ms =
        if verdict == "verified" && failing_since.is_none() { Some(now) } else { held.verified_ms };
    // Only over the claim that was asked about: one changed meanwhile is the new claim's to ask.
    state
        .node_db
        .execute(
            "UPDATE domain_proofs SET state = ?3, proof = ?4, checked_ms = ?5, verified_ms = ?6,
                 failing_since_ms = ?7, served_ms = ?8
             WHERE root = ?1 AND domain = ?2",
            (
                root_hex,
                held.domain.as_str(),
                verdict.as_str(),
                proof,
                now,
                verified_ms,
                failing_since,
                served_ms,
            ),
        )
        .await
        .context("keeping a domain proof")?;
    let canonical = verdict == "verified" && served_ms.is_some();
    if held.verified() != (verdict == "verified") || held.canonical() != canonical {
        tracing::info!(root = %root_hex, domain = %held.domain, state = %verdict, "domain claim checked");
        crate::profiles::touch(&state.node_db, root_hex).await?;
    }
    proof_of(&state.node_db, root_hex).await
}

/// The recheck: every claim due to be asked about again - daily, or hourly while its lookups fail.
pub async fn pass(state: AppState) -> Result<()> {
    let now = now_ms();
    let due: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT root FROM domain_proofs
             WHERE checked_ms < ?1 OR (failing_since_ms IS NOT NULL AND checked_ms < ?2)",
            (now - RECHECK_MS, now - RETRY_MS),
        )
        .await
        .context("listing domain claims due a check")?;
    for (root,) in due {
        if let Err(e) = check(&state, &root).await {
            tracing::debug!(root = %root, error = ?e, "domain check failed");
        }
    }
    Ok(())
}

/// Forget an evicted persona's claim, as its byline is forgotten.
pub async fn forget(node_db: &crate::db::Db, root_hex: &str) -> Result<()> {
    node_db
        .execute("DELETE FROM domain_proofs WHERE root = ?1", (root_hex,))
        .await
        .context("forgetting an evicted domain claim")?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The owner's doors: the settings page's view of their own claim.

#[derive(Deserialize)]
pub struct DomainPut {
    pub domain: String,
}

/// The owner's view: what they claim, what this node found, and the record that would prove it.
async fn owner_answer(state: &AppState, root_hex: &str) -> Result<serde_json::Value, AppError> {
    let root = crate::pubkey::decode(root_hex)
        .ok_or_else(|| AppError::BadRequest(crate::msg!("domains.bad-root", "bad root pubkey")))?;
    let proof = proof_of(&state.node_db, root_hex).await.map_err(AppError::Internal)?;
    Ok(serde_json::json!({
        "domain": proof.as_ref().map(|p| p.domain.clone()),
        "state": proof.as_ref().map(|p| p.state.clone()),
        "proof": proof.as_ref().and_then(|p| p.proof.clone()),
        "checked_ms": proof.as_ref().map(|p| p.checked_ms),
        "verified_ms": proof.as_ref().and_then(|p| p.verified_ms),
        "served_ms": proof.as_ref().and_then(|p| p.served_ms),
        "record_name": proof.as_ref().map(|p| record_name(&p.domain)),
        "record_value": record_value(&root),
        // Serving (slice 3): whether this node answers the domain now, and where to point it.
        "serving": crate::domainsite::site_of_root(state, root_hex).await.is_some(),
        "custom_domains": state.config.custom_domains,
        "target": state.config.domains_target,
    }))
}

/// The memo brought up to the profile as signed now, before the owner is told about it: the
/// byline edge notes a claim too, but not necessarily before this door answers.
async fn caught_up(
    state: &AppState,
    data: &crate::record::store::Store,
    root_hex: &str,
) -> Result<(), AppError> {
    let fields = data.profile().all().await?;
    let raw = crate::idface::profile_value(&fields, FIELD).filter(|v| !v.is_empty());
    claimed(state, root_hex, raw).await.map_err(AppError::Internal)
}

/// `GET /api/identity/{root}/domain`: the owner's claim and what this node found.
pub async fn domain_get(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    caught_up(&state, &data, &root).await?;
    Ok(Json(owner_answer(&state, &root).await?))
}

/// `PUT /api/identity/{root}/domain`: claim a domain (`""` withdraws the claim), and check it.
pub async fn domain_put(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<DomainPut>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    let value = if req.domain.trim().is_empty() {
        String::new()
    } else {
        normalise(&req.domain).ok_or_else(|| {
            AppError::BadRequest(crate::msg!(
                "domains.not-a-domain",
                "that isn't a domain - give just the name, like example.com"
            ))
        })?
    };
    data.profile().set(FIELD, &value).await?;
    caught_up(&state, &data, &root).await?;
    if !value.is_empty() {
        check(&state, &root).await.map_err(AppError::Internal)?;
    }
    Ok(Json(owner_answer(&state, &root).await?))
}

/// `POST /api/identity/{root}/domain/check`: ask DNS again, now.
pub async fn domain_check(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let data = crate::record::store::open(&state, &session.account.id, &root).await?;
    caught_up(&state, &data, &root).await?;
    check(&state, &root).await.map_err(AppError::Internal)?;
    Ok(Json(owner_answer(&state, &root).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claim_is_a_bare_hostname_and_nothing_else() {
        assert_eq!(normalise("cube-drone.com").as_deref(), Some("cube-drone.com"));
        assert_eq!(normalise("  Cube-Drone.COM. ").as_deref(), Some("cube-drone.com"));
        assert_eq!(normalise("www.cube-drone.com").as_deref(), Some("www.cube-drone.com"));
        assert_eq!(normalise("bücher.example").as_deref(), Some("xn--bcher-kva.example"));
        for bad in [
            "",
            "localhost",
            "https://cube-drone.com",
            "cube-drone.com/blog",
            "cube-drone.com:8080",
            "1.2.3.4",
            "[::1]",
            "-bad.com",
            "under_score.com",
            "two words.com",
            "a..b",
        ] {
            assert_eq!(normalise(bad), None, "{bad:?} should not be a claim");
        }
    }

    #[test]
    fn a_record_names_the_root_in_any_spelling() {
        let root = [7u8; 32];
        let value = record_value(&root);
        assert!(names(&value, &root));
        assert!(names(&format!(" {RECORD_PREFIX}{} ", crate::speakable::speakable(&root)), &root));
        assert!(names(&format!("{RECORD_PREFIX}{}", hex::encode(root)), &root));
        assert!(!names(&value, &[8u8; 32]));
        assert!(!names(&crate::webpath::short_of(&root), &root), "the prefix is part of it");
        assert!(well_known_names(
            format!(r#"{{"root":"{}"}}"#, crate::webpath::short_of(&root)).as_bytes(),
            &root
        ));
        assert!(!well_known_names(b"<html>not here</html>", &root));
    }

    #[test]
    fn only_a_serving_node_s_file_says_the_domain_is_served() {
        let root = [7u8; 32];
        let ours = well_known_body(&root).to_string();
        assert_eq!(well_known_of(ours.as_bytes(), &root).served, Some(true));
        let hugo = format!(r#"{{"root":"{}"}}"#, crate::webpath::short_of(&root));
        let said = well_known_of(hugo.as_bytes(), &root);
        assert_eq!((said.said, said.served), (Said::Yes, Some(false)), "the ✓, not the address");
        let someone = well_known_body(&[8u8; 32]).to_string();
        assert_eq!(well_known_of(someone.as_bytes(), &root).served, Some(false), "not for them");
    }

    fn held(state: &str, failing_since_ms: Option<i64>) -> Proof {
        Proof {
            domain: "cube-drone.com".into(),
            state: state.into(),
            proof: (state == "verified").then(|| "txt".into()),
            checked_ms: 0,
            verified_ms: None,
            served_ms: None,
            failing_since_ms,
        }
    }

    #[test]
    fn a_verified_claim_rides_out_an_outage_and_lapses_when_the_domain_says_otherwise() {
        let now = 10 * GRACE_MS;
        // Proved either way.
        assert_eq!(next(&held("unverified", None), Said::Yes, Said::No, now).0, "verified");
        let (s, p, _) = next(&held("unverified", None), Said::No, Said::Yes, now);
        assert_eq!((s.as_str(), p.as_deref()), ("verified", Some("well-known")));
        // DNS down: kept, and the outage's start noted - until the grace runs out.
        let (s, _, since) = next(&held("verified", None), Said::Unknown, Said::Unknown, now);
        assert_eq!((s.as_str(), since), ("verified", Some(now)));
        let late = now + GRACE_MS + 1;
        assert_eq!(next(&held("verified", Some(now)), Said::Unknown, Said::No, late).0, "lapsed");
        // The domain answered and doesn't name them: lapsed at once, and stays so.
        assert_eq!(next(&held("verified", None), Said::No, Said::No, now).0, "lapsed");
        assert_eq!(next(&held("verified", None), Said::No, Said::Unknown, now).0, "lapsed");
        assert_eq!(next(&held("lapsed", None), Said::No, Said::Unknown, now).0, "lapsed");
        // Never proved: an outage changes nothing.
        assert_eq!(next(&held("unverified", None), Said::Unknown, Said::No, now).0, "unverified");
    }
}
