//! A group server (Curtis, 2026-10-02): "I set up a group server for my friends."
//!
//! While sign-ups take a password and the operator has named a group (registration.rs), whoever
//! signs up with that password was invited - they have met the operator, and they are in the group.
//! So the first persona their account makes joins it: it and every other member, and every node
//! administrator's first persona (who set the whole thing up), begin knowing each other - low trust
//! and low interest, both ways, each tagged with the group's name in the other's People list.
//! Published like any dial (Curtis): it is a relationship like the others, only made at the door.
//!
//! What it never does:
//!
//!   * touch accounts that were here before - only joiners and administrators are in a group;
//!   * write anything except when somebody joins - turning the group on or renaming it changes
//!     no one's ledger;
//!   * lower a dial somebody already set, or add their tag twice. A person who later changes or
//!     drops the relationship keeps it changed: the group is where they began, not a leash.
//!
//! The writes are the persona's own private chain entries, signed by the node's leaf key for each
//! persona it hosts (the starters' road, starters.rs). A join pairs with every member, so the work
//! runs detached after the persona is made - a sign-up never waits on a big group.

use uuid::Uuid;

use crate::db::Db;
use crate::error::AppError;
use crate::AppState;

/// The dials a group's members begin on, about each other.
const GROUP_TRUST: &str = "low";
const GROUP_INTEREST: &str = "low";

/// An account signed up into `group`: remembered until its first persona is made.
pub async fn note_joiner(db: &Db, account: &Uuid, group: &str) -> Result<(), AppError> {
    db.execute(
        "INSERT OR IGNORE INTO group_members (account_id, group_name, root_pubkey, joined_ms) VALUES (?1, ?2, NULL, ?3)",
        (account.to_string(), group, crate::clock::now_ms()),
    )
    .await
    .map_err(AppError::Internal)?;
    Ok(())
}

/// A persona was made: if it is the first of an account that signed up into a group, it joins -
/// paired with every member and every administrator, detached. Best-effort: a failure is logged,
/// never a failed persona.
pub async fn enroll(state: &AppState, account: &Uuid, root: &str) {
    if let Err(e) = enroll_inner(state, account, root).await {
        tracing::warn!(error = ?e, root = %root, "could not enroll a new persona in its group");
    }
}

async fn enroll_inner(state: &AppState, account: &Uuid, root: &str) -> Result<(), AppError> {
    let row: Option<(String, Option<String>)> = state
        .node_db
        .fetch_optional(
            "SELECT group_name, root_pubkey FROM group_members WHERE account_id = ?1",
            (account.to_string(),),
        )
        .await
        .map_err(AppError::Internal)?;
    let Some((group, None)) = row else { return Ok(()) }; // no group, or its first persona is made
    let mine = crate::identity::list_for_account(&state.node_db, account).await?;
    if mine.first().map(|i| i.root_pubkey.as_str()) != Some(root) {
        return Ok(()); // only the account's first persona is the member
    }
    state
        .node_db
        .execute(
            "UPDATE group_members SET root_pubkey = ?1 WHERE account_id = ?2",
            (root, account.to_string()),
        )
        .await
        .map_err(AppError::Internal)?;
    let peers = peers_of(state, &group, root).await?;
    tracing::info!(root = %root, group = %group, peers = peers.len(), "a new persona joins its group");
    let state = state.clone();
    let root = root.to_string();
    tokio::spawn(async move {
        for peer in &peers {
            for (me, them) in [(root.as_str(), peer.as_str()), (peer.as_str(), root.as_str())] {
                if let Err(e) = befriend(&state, me, them, &group).await {
                    tracing::warn!(error = ?e, me = %me, them = %them, "a group relationship did not take");
                }
            }
            crate::fold::nudge_ledger(&state, peer);
        }
        crate::fold::nudge_ledger(&state, &root);
    });
    Ok(())
}

/// Whom a joiner of `group` is paired with: its other members' first personas, and every node
/// administrator's first persona - each once, never the joiner itself.
async fn peers_of(state: &AppState, group: &str, joiner: &str) -> Result<Vec<String>, AppError> {
    let members: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT root_pubkey FROM group_members WHERE group_name = ?1 AND root_pubkey IS NOT NULL",
            (group,),
        )
        .await
        .map_err(AppError::Internal)?;
    let mut peers: Vec<String> = members.into_iter().map(|(r,)| r).collect();
    for admin in crate::auth::accounts_tagged(&state.node_db, crate::auth::TAG_NODE_ADMIN).await? {
        if let Some(first) =
            crate::identity::list_for_account(&state.node_db, &admin).await?.into_iter().next()
        {
            peers.push(first.root_pubkey);
        }
    }
    peers.retain(|p| p != joiner);
    peers.sort();
    peers.dedup();
    Ok(peers)
}

/// `me` begins knowing `them` as a group member: the dials only where unset, the group's tag added.
async fn befriend(state: &AppState, me: &str, them: &str, group: &str) -> Result<(), AppError> {
    let data = crate::record::store::open_agented(state, me).await?;
    let collection = format!("contact:{them}");
    let register = data.private_registers(&collection);
    let (held, _) = register.all().await?;
    let has = |key: &str| held.iter().any(|r| r.key == key && !r.value.trim().is_empty());
    if !has("trust") {
        register.set("trust", GROUP_TRUST).await?;
    }
    if !has("interest") {
        register.set("interest", GROUP_INTEREST).await?;
    }
    let tag = normalise_tag(group);
    let mut tags: Vec<String> = held
        .iter()
        .find(|r| r.key == "tags")
        .and_then(|r| serde_json::from_str(&r.value).ok())
        .unwrap_or_default();
    if !tag.is_empty() && !tags.contains(&tag) && tags.len() < TAGS_CAP {
        tags.push(tag);
        register
            .set("tags", &serde_json::to_string(&tags).map_err(|e| AppError::Internal(e.into()))?)
            .await?;
    }
    Ok(())
}

/// The People list's tag rules (js/pure/contacttags.js): lowercased, whitespace collapsed, at most
/// `TAG_MAX` letters - so the group's tag is the one a person would have typed.
pub const TAG_MAX: usize = 32;
const TAGS_CAP: usize = 24;

pub fn normalise_tag(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    collapsed.chars().take(TAG_MAX).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_group_name_becomes_the_tag_a_person_would_type() {
        assert_eq!(normalise_tag("  Beans   Group "), "beans group");
        assert_eq!(normalise_tag(&"x".repeat(40)).len(), TAG_MAX);
        assert_eq!(normalise_tag("   "), "");
    }
}
