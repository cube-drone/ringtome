//! The sign-up group (Curtis, 2026-10-20): "the server admin must create the public or private
//! group and then can set 'automatically enter new users' personas into this group'".
//!
//! An administrator chooses one group through one of their own personas that owns it and is hosted
//! here. From then on every persona made on this node - whatever the sign-up mode, and every one an
//! account makes, not only its first - joins it: that owner's key invites the newcomer and the
//! newcomer's takes the invite up (`roster::enter_newcomer`), the same two entries as any invite and
//! join, so every member's node counts them in. The sign-up form says so before anyone signs up
//! ("everyone who joins this server joins <group>"), and agreeing to that is agreeing to the
//! invite. A member who would rather not be in it leaves, as from any group.
//!
//! What it never does:
//!
//!   * touch personas that were here before the group was chosen, or that came here from another
//!     computer (joined or recovered) - only a persona made here is a newcomer;
//!   * keep going when its owner no longer owns the group: the invite would not count, so nobody
//!     is entered, and the Server page says why.
//!
//! It replaces the "group server" of 2026-10-02 (a group name on the sign-up limits, pairing every
//! joiner with every member and administrator by contact dials). Those pairings stay as they were
//! made; `paired_with` still answers for them, for the bank.

use uuid::Uuid;

use crate::error::AppError;
use crate::AppState;
use ringtome_proto::roster::GroupId;

/// The chosen group and the owner whose key invites, when there is one.
pub async fn chosen(state: &AppState) -> Result<Option<(GroupId, String)>, AppError> {
    let row: Option<(Vec<u8>, String)> = state
        .node_db
        .fetch_optional("SELECT group_id, owner FROM signup_group WHERE id = 1", ())
        .await
        .map_err(AppError::Internal)?;
    Ok(row.and_then(|(group, owner)| Some((group.try_into().ok()?, owner))))
}

/// One group an administrator may choose, or the one chosen, as the Server page shows it.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Choice {
    pub group: String,
    pub name: String,
    pub public: bool,
    /// The persona whose key invites: an owner of the group, hosted here.
    pub owner: String,
    pub owner_name: Option<String>,
    /// False when the owner no longer owns the group (or it is no longer held here): then nobody
    /// is entered until another owner is chosen.
    pub owner_owns: bool,
}

async fn choice(state: &AppState, group: GroupId, owner: String, name: String) -> Choice {
    let owner_name = crate::profiles::bylines(&state.node_db, std::slice::from_ref(&owner))
        .await
        .ok()
        .and_then(|b| b.get(&owner).and_then(|b| b.name.clone()));
    Choice {
        group: hex::encode(group),
        name,
        public: crate::roster::is_public(state, &group).await,
        owner_owns: crate::roster::is_owner(state, &group, &owner).await,
        owner,
        owner_name,
    }
}

/// The sign-up group as the Server page shows it.
pub async fn current(state: &AppState) -> Result<Option<Choice>, AppError> {
    let Some((group, owner)) = chosen(state).await? else { return Ok(None) };
    let ids = std::iter::once(hex::encode(group)).collect();
    let name = crate::roster::group_names(state, &ids)
        .await
        .map_err(AppError::Internal)?
        .remove(&hex::encode(group))
        .unwrap_or_default();
    Ok(Some(choice(state, group, owner, name).await))
}

/// The groups this administrator may choose: every group one of their personas here owns.
pub async fn choices(state: &AppState, account: &Uuid) -> Result<Vec<Choice>, AppError> {
    let mine: Vec<String> = crate::identity::list_for_account(&state.node_db, account)
        .await?
        .into_iter()
        .map(|i| i.root_pubkey)
        .collect();
    let owned = crate::roster::owned_by(state, &mine).await.map_err(AppError::Internal)?;
    let mut out = Vec::new();
    for (group, owner, name) in owned {
        out.push(choice(state, group, owner, name).await);
    }
    Ok(out)
}

/// Choose the sign-up group (`Some((group, owner))`) or none. The owner must be one of this
/// administrator's own personas and own the group now: it is their key that will invite.
pub async fn choose(
    state: &AppState,
    account: &Uuid,
    pick: Option<(&str, &str)>,
) -> Result<(), AppError> {
    let Some((group_hex, owner)) = pick else {
        state
            .node_db
            .execute("DELETE FROM signup_group WHERE id = 1", ())
            .await
            .map_err(AppError::Internal)?;
        tracing::info!("sign-up group cleared");
        return Ok(());
    };
    let group = crate::roster::group_of(group_hex)?;
    let mine = crate::identity::list_for_account(&state.node_db, account).await?;
    if !mine.iter().any(|i| i.root_pubkey == owner)
        || !crate::roster::is_owner(state, &group, owner).await
    {
        return Err(AppError::BadRequest(crate::msg!(
            "groups.choose-a-group-you-own",
            "choose a group one of your personas here owns"
        )));
    }
    state
        .node_db
        .execute(
            "INSERT INTO signup_group (id, group_id, owner, set_ms) VALUES (1, ?1, ?2, ?3)
             ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, owner = excluded.owner,
                 set_ms = excluded.set_ms",
            (group.to_vec(), owner, crate::clock::now_ms()),
        )
        .await
        .map_err(AppError::Internal)?;
    tracing::info!(group = %group_hex, owner = %owner, "sign-up group chosen");
    Ok(())
}

/// The sign-up group's name, for the sign-up form's notice - None when there is none, or when
/// its owner can no longer enter anybody into it.
pub async fn notice(state: &AppState) -> Option<String> {
    let current = current(state).await.ok()??;
    current.owner_owns.then_some(current.name)
}

/// A persona was made here: into the sign-up group with it, if there is one - detached, so making
/// a persona never waits on the group, and best-effort: a failure is logged, never a failed persona.
pub fn enroll(state: &AppState, root: &str) {
    let state = state.clone();
    let root = root.to_string();
    tokio::spawn(async move {
        let chosen = match chosen(&state).await {
            Ok(Some(chosen)) => chosen,
            Ok(None) => return,
            Err(e) => {
                tracing::warn!(error = ?e, "could not read the sign-up group");
                return;
            }
        };
        let (group, owner) = chosen;
        if owner == root {
            return;
        }
        match crate::roster::enter_newcomer(&state, &owner, &group, &root).await {
            Ok(()) => {
                tracing::info!(root = %root, group = %hex::encode(group), "a new persona joins the sign-up group")
            }
            Err(e) => {
                tracing::warn!(error = ?e, root = %root, "could not enter a new persona into the sign-up group")
            }
        }
    });
}

// ---------------------------------------------------------------------------------------------
// The old group server's pairings (2026-10-02 to 2026-10-20), kept for what they already made.

/// Whom this persona was paired with by the old group server - nobody, if it joined none. The
/// bank's "Follow a stranger" contract never counts them (for pairings made before the `auto`
/// mark).
pub async fn paired_with(state: &AppState, root: &str) -> Result<Vec<String>, AppError> {
    let row: Option<(String,)> = state
        .node_db
        .fetch_optional("SELECT group_name FROM group_members WHERE root_pubkey = ?1", (root,))
        .await
        .map_err(AppError::Internal)?;
    match row {
        Some((group,)) => peers_of(state, &group, root).await,
        None => Ok(Vec::new()),
    }
}

/// Whom a joiner of the old `group` was paired with: its other members' first personas, and every
/// node administrator's first persona - each once, never the joiner itself.
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
