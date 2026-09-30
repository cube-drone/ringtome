//! The byline cache: every persona's most recent public name, avatar and banner, at node level.
//!
//! What a list of humans needs is one fact per face - who is this - and the truth lives in each
//! persona's own database, one encrypted file apiece. A People roster or a feed that opened a
//! database per row would thrash the handle cache to re-learn names that almost never change
//! (the fan-in warning in PROJECT_PLAN's Data Layer, and previously the live behavior of the
//! contacts join). This memo answers the whole list from one table.
//!
//! Cached facts are PUBLIC by construction - name and avatar are PROFILE_PUBLIC registers, the
//! same ones the anonymous /id face already serves to strangers - so the cache discloses
//! nothing. It refreshes on the frontier map's edge, which fires exactly when a persona's
//! public lane (profile included) moves; disposable and rebuildable like every memo.
use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;
use crate::AppState;

/// How many times any byline on this node has changed since it started (2026-09-29, Curtis: "in
/// order to see someone's updated name, banner or profile pic, I'd need to make some other arbitrary
/// change to my people page?"). The live stream re-sends a persona's contact rows when THEIR OWN
/// chains move; a contact renaming themselves moved nobody's chain here but their own, so the rows
/// kept the old name until the reader's ledger happened to change. The stream folds this into its
/// contacts stamp, so a changed byline re-gathers the roster, and only the rows that changed ship.
/// In memory on purpose: a restart resets it, and a returning page's cursor then misses and gets a
/// fresh snapshot, which is the honest answer after a restart anyway.
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The byline cache's change count (`EPOCH`).
pub fn epoch() -> u64 {
    EPOCH.load(std::sync::atomic::Ordering::Relaxed)
}

fn changed() {
    EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// One persona's byline, as the cache holds it.
#[derive(Debug, Clone, Default)]
pub struct Byline {
    pub name: Option<String>,
    pub avatar: Option<String>,
    /// Their banner's public doc_id (2026-09-28: the People app's rows wear it).
    pub banner: Option<String>,
    /// Their last heartbeat's UTC date (heartbeat.rs, 2026-09-29): the card's "active today".
    pub last_active: Option<String>,
}

/// Re-read one persona's public self-claims and store them - writing only on CHANGE, so
/// `updated_at_ms` means "when the claim moved" and an unchanged profile costs no write
/// (the frontiers lesson: a row rewritten to say "still the same" is worse than no row).
pub async fn refresh(state: &AppState, root_hex: &str) -> Result<()> {
    let db = state
        .user_dbs
        .held(root_hex)
        .await
        .with_context(|| format!("opening {root_hex} to read its profile"))?;
    let fields = crate::record::imaol::get_profile(&db)
        .await
        .map_err(|e| anyhow::anyhow!("reading profile: {e}"))?;
    let grab = |key: &str| {
        fields
            .iter()
            .find(|f| f.field == key)
            .map(|f| f.value.clone())
            .filter(|v| !v.is_empty())
    };
    let (name, avatar, banner) = (grab("name"), grab("avatar"), grab("banner"));
    let last_active = grab(crate::heartbeat::FIELD);

    type Cached = (Option<String>, Option<String>, Option<String>, Option<String>);
    let current: Option<Cached> = state
        .node_db
        .fetch_optional(
            "SELECT name, avatar, banner, last_active FROM persona_profiles WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("reading the byline cache")?;
    if current.as_ref().is_some_and(|(n, a, b, l)| *n == name && *a == avatar && *b == banner && *l == last_active) {
        return Ok(());
    }
    state
        .node_db
        .execute(
            "INSERT INTO persona_profiles (root_pubkey, name, avatar, banner, last_active, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (root_pubkey) DO UPDATE SET
                 name = excluded.name,
                 avatar = excluded.avatar,
                 banner = excluded.banner,
                 last_active = excluded.last_active,
                 updated_at_ms = excluded.updated_at_ms",
            (root_hex, name, avatar, banner, last_active, now_ms()),
        )
        .await
        .context("storing a byline")?;
    changed();
    Ok(())
}

/// The bylines for a whole list at once - the query a roster or a feed makes instead of
/// opening a database per face.
/// Forget an evicted persona's byline - a face the node no longer holds must not keep a
/// name in the cache (PROJECT_PLAN's Discovery, slice 4).
pub async fn forget(node_db: &crate::db::Db, root_hex: &str) -> anyhow::Result<()> {
    node_db
        .execute(
            "DELETE FROM persona_profiles WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("forgetting an evicted byline")?;
    changed();
    Ok(())
}

/// `bylines`, healing on the way: a root the cache has no row for but whose mirror this node
/// holds gets refreshed right now and read again. A thread or a bell must never show the
/// speakable words for a persona whose profile sits in a database one open away (Curtis,
/// 2026-09-05: "we have forgotten Lurk Stuck's name and profile picture").
pub async fn bylines_healed(state: &AppState, roots: &[String]) -> Result<std::collections::BTreeMap<String, Byline>> {
    let mut known = bylines(&state.node_db, roots).await?;
    let mut healed = false;
    for root in roots {
        if known.contains_key(root) {
            continue;
        }
        if matches!(state.user_dbs.get(root).await, Ok(Some(_))) && refresh(state, root).await.is_ok() {
            healed = true;
        }
    }
    if healed {
        known = bylines(&state.node_db, roots).await?;
    }
    Ok(known)
}

/// One cached row: root, name, avatar, banner, last heartbeat.
type BylineRow = (String, Option<String>, Option<String>, Option<String>, Option<String>);

pub async fn bylines(node_db: &Db, roots: &[String]) -> Result<std::collections::BTreeMap<String, Byline>> {
    let mut out = std::collections::BTreeMap::new();
    if roots.is_empty() {
        return Ok(out);
    }
    // Quoted IN-list, hex-filtered belt-and-braces: anything that isn't a hex root cannot
    // name a row this module wrote.
    let quoted: Vec<String> = roots
        .iter()
        .filter(|r| r.len() == 64 && r.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|r| format!("'{r}'"))
        .collect();
    if quoted.is_empty() {
        return Ok(out);
    }
    let rows: Vec<BylineRow> = node_db
        .fetch_all(
            &format!(
                "SELECT root_pubkey, name, avatar, banner, last_active FROM persona_profiles
                 WHERE root_pubkey IN ({})",
                quoted.join(",")
            ),
            (),
        )
        .await
        .context("reading bylines")?;
    for (root, name, avatar, banner, last_active) in rows {
        out.insert(root, Byline { name, avatar, banner, last_active });
    }
    Ok(out)
}
