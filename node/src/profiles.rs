//! The byline cache: every persona's most recent public name and avatar, at node level.
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

/// One persona's byline, as the cache holds it.
#[derive(Debug, Clone, Default)]
pub struct Byline {
    pub name: Option<String>,
    pub avatar: Option<String>,
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
    let (name, avatar) = (grab("name"), grab("avatar"));

    let current: Option<(Option<String>, Option<String>)> = state
        .node_db
        .fetch_optional(
            "SELECT name, avatar FROM persona_profiles WHERE root_pubkey = ?1",
            (root_hex,),
        )
        .await
        .context("reading the byline cache")?;
    if current.as_ref().is_some_and(|(n, a)| *n == name && *a == avatar) {
        return Ok(());
    }
    state
        .node_db
        .execute(
            "INSERT INTO persona_profiles (root_pubkey, name, avatar, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (root_pubkey) DO UPDATE SET
                 name = excluded.name,
                 avatar = excluded.avatar,
                 updated_at_ms = excluded.updated_at_ms",
            (root_hex, name, avatar, now_ms()),
        )
        .await
        .context("storing a byline")?;
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
    Ok(())
}

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
    let rows: Vec<(String, Option<String>, Option<String>)> = node_db
        .fetch_all(
            &format!(
                "SELECT root_pubkey, name, avatar FROM persona_profiles
                 WHERE root_pubkey IN ({})",
                quoted.join(",")
            ),
            (),
        )
        .await
        .context("reading bylines")?;
    for (root, name, avatar) in rows {
        out.insert(root, Byline { name, avatar });
    }
    Ok(out)
}
