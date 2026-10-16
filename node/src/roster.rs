//! Groups on the node (plans/GROUPS.md, slice 1b): the memo of every group lane held here, the
//! group's door at the sync lane, the pull that keeps a group in step, and the routes a persona
//! acts through.
//!
//! A group is its members' lanes - one chain per `(device, GROUP, group id)`, each on its
//! member's own persona, single-writer like every chain - and its roster is a fold over them
//! (`ringtome_proto::roster`). This module copies the group entries out of each member's
//! database into `group_lanes` as their chains move (the fold leg, one persona per move), so a
//! roster folds from node.db alone, and keeps `group_people` - who the door opens to - as of
//! the last fold.
//!
//! Who to pull needs no directory: invites, appointments and removals name people, so a node
//! learns every persona a group involves by folding what it already holds, starting from the
//! founder and the inviter an invite names. Every member's node holds every lane (ruling 2),
//! so any of the group's nodes answers for anyone in it.
//!
//! Not here yet: group posts with bodies and the blob door's member check (slice 2), links and
//! the open settings in the app (slice 3), and a directory for joins nobody's entry names -
//! an open group's - which slice 3 owes.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Context, Result};
use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use ringtome_proto::registry::{entry_type, service, DocHeaderPlain, PostRetraction};
use ringtome_proto::roster::{
    self as fold, Founding, Grant, GroupEntry, GroupId, Hash, JoinMode, Lane, LaneAnchor,
    LaneEntry, Root, Roster,
};
use ringtome_proto::Payload;
use serde::Deserialize;

use crate::auth::Session;
use crate::clock::now_ms;
use crate::error::AppError;
use crate::record::store::{self, Store};
use crate::AppState;

/// What a group-scoped exchange carries: the member's key tree and profile, to check their
/// lanes by and name them with, and the lanes themselves.
pub const GROUP_SCOPE: &[u32] =
    &[service::IDENTITY_PUBLIC, service::PROFILE_PUBLIC, service::GROUP];

fn root_of(hex_root: &str) -> Option<Root> {
    hex::decode(hex_root).ok()?.try_into().ok()
}

fn group_of(hex_group: &str) -> Result<GroupId, AppError> {
    hex::decode(hex_group).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-group-id", "that isn't a group id"))
    })
}

fn hash_of(hex_hash: &str) -> Result<Hash, AppError> {
    hex::decode(hex_hash).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-an-entry-hash", "that isn't an entry hash"))
    })
}

// ---------------------------------------------------------------------------------------------
// The memo

/// The fold leg (fold.rs): a persona's GROUP chains moved, so copy their entries into the memo
/// and refold every group they touched.
pub async fn refresh_from(state: &AppState, root: &str, _force: bool) {
    if let Err(e) = refresh_inner(state, root).await {
        tracing::warn!(root = %root, error = ?e, "folding a persona's group lanes failed");
    }
}

async fn refresh_inner(state: &AppState, root: &str) -> Result<()> {
    // user-db open: the fold leg, one persona per move of its GROUP chains.
    let Ok(Some(db)) = state.user_dbs.get(root).await else { return Ok(()) };
    let entries = crate::record::imaol::group_entries(&db).await.map_err(|e| anyhow!("{e:?}"))?;
    drop(db);
    let mut touched: BTreeSet<GroupId> = BTreeSet::new();
    for signed in entries {
        let e = signed.entry();
        let Some(group) = e.chain.instance else { continue };
        let Payload::Inline(body) = &e.payload else { continue };
        let added = state
            .node_db
            .execute(
                "INSERT OR IGNORE INTO group_lanes
                   (group_id, persona, device, seq, hash, entry_type, body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                (
                    group.to_vec(),
                    root,
                    e.chain.author.to_vec(),
                    e.seq as i64,
                    signed.hash().to_vec(),
                    i64::from(e.entry_type),
                    body.clone(),
                ),
            )
            .await
            .context("remembering a group entry")?;
        if added > 0 {
            touched.insert(group);
        }
    }
    for group in touched {
        refold(state, &group).await?;
    }
    Ok(())
}

/// Every lane held for a group, decoded. An entry that doesn't decode is left out, as a chain
/// would leave out an entry that doesn't verify - its lane then ends there for the fold.
/// One memo row: `(persona, device, seq, hash, entry type, body)`.
type LaneRow = (String, Vec<u8>, i64, Vec<u8>, i64, Vec<u8>);

/// How the fold sees one entry on a group lane: a group entry as itself, a document's version
/// or takedown as content (proto `GroupEntry::Document`).
fn lane_body(entry_type: i64, body: &[u8]) -> Option<GroupEntry> {
    match u32::try_from(entry_type).ok()? {
        entry_type::GROUP_ENTRY => GroupEntry::decode(body).ok(),
        entry_type::DOC_HEADER => DocHeaderPlain::decode(body)
            .ok()
            .map(|h| GroupEntry::Document { doc: h.doc_id, retract: false }),
        entry_type::POST_RETRACT => PostRetraction::decode(body)
            .ok()
            .map(|r| GroupEntry::Document { doc: r.doc_id, retract: true }),
        _ => None,
    }
}

async fn lanes_of(state: &AppState, group: &GroupId) -> Result<Vec<Lane>> {
    let rows: Vec<LaneRow> = state
        .node_db
        .fetch_all(
            "SELECT persona, device, seq, hash, entry_type, body FROM group_lanes
             WHERE group_id = ?1 ORDER BY device, seq",
            (group.to_vec(),),
        )
        .await
        .context("reading a group's lanes")?;
    let mut lanes: BTreeMap<Vec<u8>, Lane> = BTreeMap::new();
    for (persona, device, seq, hash, kind, body) in rows {
        let (Some(persona), Ok(dev), Ok(hash)) = (
            root_of(&persona),
            <[u8; 32]>::try_from(device.as_slice()),
            <[u8; 32]>::try_from(hash),
        ) else {
            continue;
        };
        let lane =
            lanes.entry(device).or_insert(Lane { persona, device: dev, entries: Vec::new() });
        let next = lane.entries.last().map_or(0, |e| e.seq + 1);
        if seq as u64 != next {
            continue; // a gap: what lies past it waits for the lane to fill
        }
        match lane_body(kind, &body) {
            Some(body) => lane.entries.push(LaneEntry { seq: seq as u64, hash, body }),
            None => continue,
        }
    }
    Ok(lanes.into_values().collect())
}

/// Fold a group from the memo and keep what the door reads. `None` when no valid founding for
/// it is held.
async fn refold(state: &AppState, group: &GroupId) -> Result<Option<(Roster, Vec<Lane>)>> {
    let lanes = lanes_of(state, group).await?;
    let Some(roster) = fold::build(*group, &lanes) else { return Ok(None) };
    let db = &state.node_db;
    db.execute(
        "INSERT INTO group_rosters (group_id, name, founder, folded_ms) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (group_id) DO UPDATE SET name = excluded.name, folded_ms = excluded.folded_ms",
        (group.to_vec(), roster.name.as_str(), hex::encode(roster.founder), now_ms()),
    )
    .await
    .context("remembering a group")?;
    db.execute("DELETE FROM group_people WHERE group_id = ?1", (group.to_vec(),))
        .await
        .context("clearing a group's people")?;
    let mut people: Vec<(String, &str)> = Vec::new();
    for m in &roster.members {
        people
            .push((hex::encode(m), if roster.owners.contains_key(m) { "owner" } else { "member" }));
    }
    for i in &roster.invited {
        people.push((hex::encode(i), "invited"));
    }
    for (root, standing) in people {
        db.execute(
            "INSERT INTO group_people (group_id, root, standing) VALUES (?1, ?2, ?3)",
            (group.to_vec(), root, standing),
        )
        .await
        .context("remembering who's in a group")?;
    }
    Ok(Some((roster, lanes)))
}

// ---------------------------------------------------------------------------------------------
// The door

/// Is this instance a group this node holds?
pub async fn is_group(state: &AppState, instance: &[u8; 16]) -> bool {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM group_rosters WHERE group_id = ?1",
            (instance.to_vec(),),
        )
        .await
        .ok()
        .flatten()
        .is_some()
}

/// Does an exchange name a group this node holds? Then a persona nobody here follows still
/// has a lane here: the group's (net/sync.rs `serve_on`, the room lane's sibling).
pub async fn groups_here(state: &AppState, instances: &[[u8; 16]]) -> bool {
    for i in instances {
        if is_group(state, i).await {
            return true;
        }
    }
    false
}

/// The group's door at the lane (plans/GROUPS.md, section 6): of `groups`, those whose lanes
/// may go to this dialer - one that speaks for a persona the group's door opens to (a member,
/// an owner, or someone invited). Two ways to know who a dialer speaks for: `proven`, the
/// persona whose chains this very exchange carries when the dialer proved itself one of that
/// persona's nodes (a member pushing their own lane, or an invitee arriving); or what an
/// earlier proof told this door, kept per group in `group_peers` - the peer ledger only keeps
/// proofs for personas hosted here, and a group's members mostly aren't. The peer ledger's own
/// rows count too.
pub async fn dialer_may_hold(
    state: &AppState,
    groups: &[[u8; 16]],
    dialer: &str,
    proven: Option<&str>,
) -> Vec<[u8; 16]> {
    let mut out = Vec::new();
    let served =
        crate::net::sync::roots_served_by(&state.node_db, dialer).await.unwrap_or_default();
    for g in groups {
        let people: BTreeSet<String> = state
            .node_db
            .fetch_all::<(String,)>(
                "SELECT root FROM group_people WHERE group_id = ?1",
                (g.to_vec(),),
            )
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|(r,)| r)
            .collect();
        if let Some(p) = proven.filter(|p| people.contains(*p)) {
            remember_peer(state, g, dialer, p).await;
            out.push(*g);
            continue;
        }
        let told: Vec<(String,)> = state
            .node_db
            .fetch_all(
                "SELECT root FROM group_peers WHERE group_id = ?1 AND endpoint_id = ?2",
                (g.to_vec(), dialer),
            )
            .await
            .unwrap_or_default();
        if told.iter().any(|(r,)| people.contains(r)) || served.iter().any(|r| people.contains(r)) {
            out.push(*g);
        }
    }
    out
}

/// An endpoint that served this group, and the persona it proved it speaks for ('' when it
/// only answered).
async fn remember_peer(state: &AppState, group: &[u8; 16], endpoint: &str, root: &str) {
    if let Err(e) = state
        .node_db
        .execute(
            "INSERT INTO group_peers (group_id, endpoint_id, root, heard_ms) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (group_id, endpoint_id, root) DO UPDATE SET heard_ms = excluded.heard_ms",
            (group.to_vec(), endpoint, root, now_ms()),
        )
        .await
    {
        tracing::debug!(error = ?e, "remembering a group's peer failed");
    }
}

// ---------------------------------------------------------------------------------------------
// Keeping in step

/// Everyone a group's held lanes involve: the lanes' own personas and everyone an entry names.
fn named(lanes: &[Lane]) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for lane in lanes {
        out.insert(hex::encode(lane.persona));
        for e in &lane.entries {
            let who = match &e.body {
                GroupEntry::Found(f) => Some(f.founder),
                GroupEntry::Invite { invitee, .. } => Some(*invitee),
                GroupEntry::Appoint { appointee, .. } => Some(*appointee),
                GroupEntry::Remove { target, .. } | GroupEntry::Demote { target, .. } => {
                    Some(*target)
                }
                _ => None,
            };
            if let Some(who) = who {
                out.insert(hex::encode(who));
            }
        }
    }
    out
}

/// Where to reach a group: every node that has served it, newest first, then the known nodes of
/// everyone it names. Never this node.
async fn endpoints(state: &AppState, group: &GroupId, names: &BTreeSet<String>) -> Vec<String> {
    let ours = state.endpoint.id().to_string();
    let mut out: Vec<String> = Vec::new();
    let peers: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT endpoint_id FROM group_peers WHERE group_id = ?1
             GROUP BY endpoint_id ORDER BY MAX(heard_ms) DESC",
            (group.to_vec(),),
        )
        .await
        .unwrap_or_default();
    for (ep,) in peers {
        if ep != ours && !out.contains(&ep) {
            out.push(ep);
        }
    }
    for who in names {
        for ep in crate::net::sync::peers_for(&state.node_db, who).await.unwrap_or_default() {
            if ep != ours && !out.contains(&ep) {
                out.push(ep);
            }
        }
    }
    out
}

/// One group exchange: `persona`'s lanes for `group`, with the node at `endpoint`.
async fn exchange(state: &AppState, persona: &str, endpoint: &str, group: &GroupId) -> bool {
    let Ok(addr) = crate::net::sync::dial_addr(state, endpoint).await else { return false };
    let ok = crate::net::sync::sync_with_peer_asking(
        state,
        persona,
        addr,
        GROUP_SCOPE,
        &[*group],
        crate::net::sync::Ask::default(),
    )
    .await
    .map_err(|e| tracing::debug!(persona = %persona, endpoint = %endpoint, error = ?e, "a group exchange failed"))
    .is_ok();
    if ok {
        remember_peer(state, group, endpoint, "").await;
    }
    ok
}

/// Bring a group up to date for `me`: push `me`'s own lanes to every node the group is known at,
/// twice, then pull everyone the group names, folding as they arrive, until the names stop
/// growing. The pushes are also how those nodes learn this one speaks for `me`, and only the
/// second can tell them: a member proof is checked against `me`'s key tree, and a node meeting
/// `me` for the first time has it only once the first exchange has brought it. Until then its
/// door refuses this node's pulls - which in the full suite it did, whenever nothing else had
/// introduced the two nodes first (2026-10-15). `seed` adds people to pull before anything is
/// held (an invite's founder and inviter).
pub async fn sync_group(state: &AppState, me: &str, group: &GroupId, seed: &[String]) -> usize {
    let mut names: BTreeSet<String> = seed.iter().cloned().collect();
    names.extend(named(&lanes_of(state, group).await.unwrap_or_default()));
    let mut exchanged = 0;
    for ep in endpoints(state, group, &names).await {
        for _ in 0..2 {
            if exchange(state, me, &ep, group).await {
                exchanged += 1;
            }
        }
    }
    let mut pulled: BTreeSet<String> = BTreeSet::from([me.to_string()]);
    for _ in 0..4 {
        let fresh: Vec<String> = names.difference(&pulled).cloned().collect();
        if fresh.is_empty() {
            break;
        }
        let eps = endpoints(state, group, &names).await;
        for who in &fresh {
            for ep in &eps {
                if exchange(state, who, ep, group).await {
                    exchanged += 1;
                }
            }
            crate::fold::fold_now(state, who).await;
            pulled.insert(who.clone());
        }
        names.extend(named(&lanes_of(state, group).await.unwrap_or_default()));
    }
    fetch_bodies(state, group, &names).await;
    exchanged
}

/// The group-sync beat (lib.rs): every group each persona hosted here is in, owns or is
/// invited to, brought up to date - the floor under the sync a person asks for, as the room
/// beat is chat's.
pub async fn sync_pass(state: AppState) -> Result<()> {
    let rows: Vec<(Vec<u8>, String)> = state
        .node_db
        .fetch_all("SELECT group_id, root FROM group_people ORDER BY group_id, root", ())
        .await
        .context("listing the groups to keep in step")?;
    for (group, root) in rows {
        let Ok(group) = <[u8; 16]>::try_from(group.as_slice()) else { continue };
        if crate::identity::is_agented(&state.node_db, &root).await.unwrap_or(false) {
            sync_group(&state, &root, &group, &[]).await;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Acting

/// Append one entry to `me`'s lane for the group and fold it. It travels with the next sync -
/// the person's own, or the group-sync beat's ([`sync_pass`]) - never a push of its own racing
/// whatever comes next.
async fn write(
    state: &AppState,
    data: &Store,
    me: &str,
    group: GroupId,
    entry: GroupEntry,
) -> Result<Hash, AppError> {
    let payload = entry.encode().map_err(|e| {
        AppError::BadRequest(crate::msg!(
            "roster.not-a-group-entry",
            "that isn't a group entry: {why}",
            why = e
        ))
    })?;
    let signed = crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        service::GROUP,
        Some(group),
        entry_type::GROUP_ENTRY,
        Payload::Inline(payload),
    )
    .await?;
    crate::fold::fold_now(state, me).await;
    Ok(*signed.hash())
}

/// The roster as this node holds it, refolded now - for `me` only when the group's door opens
/// to them (ruling 3: members see the roster). A node holds a group for whichever of its
/// personas is in it; the others on it see nothing, as they would anywhere else.
async fn current(
    state: &AppState,
    group: &GroupId,
    me: &Root,
) -> Result<(Roster, Vec<Lane>), AppError> {
    let missing =
        || AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"));
    let (roster, lanes) =
        refold(state, group).await.map_err(AppError::Internal)?.ok_or_else(missing)?;
    let mine =
        roster.members.contains(me) || roster.invited.contains(me) || roster.banned.contains(me);
    if !mine {
        return Err(missing());
    }
    Ok((roster, lanes))
}

/// The appointment `me` acts under, or why they can't.
fn acting(roster: &Roster, me: &Root) -> Result<Hash, AppError> {
    roster.acting_as(me).ok_or_else(|| {
        AppError::Forbidden(crate::msg!(
            "roster.owners-only",
            "only the group's owners can do that"
        ))
    })
}

/// Every lane of these personas as held, anchored at its head - what this node has seen of
/// them, which is what an act ending their authority lets stand.
fn anchors_of(lanes: &[Lane], personas: &BTreeSet<Root>) -> Vec<LaneAnchor> {
    lanes
        .iter()
        .filter(|l| personas.contains(&l.persona))
        .filter_map(|l| {
            let e = l.entries.last()?;
            Some(LaneAnchor { device: l.device, seq: e.seq, head_hash: e.hash })
        })
        .collect()
}

/// The hostile end of `target`: their standing appointments, and the anchors over their lanes
/// and the lanes of every owner beneath them.
fn ending(roster: &Roster, lanes: &[Lane], target: &Root) -> (Vec<Hash>, Vec<LaneAnchor>) {
    let ends: Vec<Hash> = roster
        .appointments
        .iter()
        .filter(|(_, a)| a.persona == *target && a.standing)
        .map(|(h, _)| *h)
        .collect();
    let mut people = BTreeSet::from([*target]);
    for e in &ends {
        people.extend(roster.beneath(e));
    }
    (ends, anchors_of(lanes, &people))
}

fn roster_json(group: &GroupId, roster: &Roster, _lanes: &[Lane], me: &Root) -> serde_json::Value {
    let list = |s: &BTreeSet<Root>| s.iter().map(hex::encode).collect::<Vec<_>>();
    serde_json::json!({
        "group": hex::encode(group),
        "name": roster.name,
        "description": roster.description,
        "join_mode": match roster.join_mode { JoinMode::InviteOnly => "invite-only", JoinMode::Open => "open" },
        "founder": hex::encode(roster.founder),
        "members": roster.members.iter().map(|m| serde_json::json!({
            "root": hex::encode(m),
            "owner": roster.owners.contains_key(m),
        })).collect::<Vec<_>>(),
        "invited": list(&roster.invited),
        "banned": list(&roster.banned),
        "you": {
            "member": roster.members.contains(me),
            "owner": roster.owners.contains_key(me),
        },
    })
}

// ---------------------------------------------------------------------------------------------
// Routes

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/identity/{root}/groups", get(list_handler).post(found_handler))
        .route("/api/identity/{root}/groups/{group}", get(roster_handler))
        .route("/api/identity/{root}/groups/{group}/sync", post(sync_handler))
        .route("/api/identity/{root}/groups/{group}/invites", post(invite_handler))
        .route("/api/identity/{root}/groups/{group}/join", post(join_handler))
        .route("/api/identity/{root}/groups/{group}/leave", post(leave_handler))
        .route("/api/identity/{root}/groups/{group}/remove", post(remove_handler))
        .route("/api/identity/{root}/groups/{group}/demote", post(demote_handler))
        .route("/api/identity/{root}/groups/{group}/appoint", post(appoint_handler))
        .route("/api/identity/{root}/groups/{group}/posts", get(posts_handler))
        .route("/api/identity/{root}/groups/{group}/publish", post(publish_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/retract", post(retract_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/hide", post(hide_handler))
        // A group's pictures and bodies, at one address for every member - the embed in a
        // post's words can't name the reader - so the door is the session: any persona on it
        // the group counts.
        .route("/api/groups/{group}/docs/{doc}/body", get(group_body_route))
        .route("/api/groups/{group}/docs/{doc}/body/{name}", get(group_body_named_route))
        .route("/api/groups/{group}/docs/{doc}/thumb", get(group_thumb_route))
}

type Answer = Result<Json<serde_json::Value>, AppError>;

async fn me_of(state: &AppState, session: &Session, root: &str) -> Result<(Store, Root), AppError> {
    let data = store::open(state, &session.account.id, root).await?;
    let me = root_of(root).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })?;
    Ok((data, me))
}

#[derive(Deserialize)]
struct FoundRequest {
    name: String,
}

/// POST `/api/identity/{root}/groups` - found a group. Its key signs the founding and is then
/// dropped: everything after is said with the members' own keys (plans/GROUPS.md, section 1).
async fn found_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
    Json(req): Json<FoundRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let name = req.name.trim();
    if name.is_empty() || name.len() > GroupEntry::MAX_NAME_BYTES {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.a-group-needs-a-name",
            "a group needs a name of one short line"
        )));
    }
    let mut seed = [0u8; 32];
    {
        use rand::RngCore;
        rand::rngs::OsRng.fill_bytes(&mut seed);
    }
    let founding = Founding::sign(&ed25519_dalek::SigningKey::from_bytes(&seed), me, name);
    let group = founding.id();
    write(&state, &data, &root, group, GroupEntry::Found(founding)).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// GET `/api/identity/{root}/groups` - the groups this persona is in, or invited to.
async fn list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Answer {
    me_of(&state, &session, &root).await?;
    let rows: Vec<(Vec<u8>, String, String)> = state
        .node_db
        .fetch_all(
            "SELECT p.group_id, r.name, p.standing FROM group_people p
             JOIN group_rosters r ON r.group_id = p.group_id
             WHERE p.root = ?1 ORDER BY r.name",
            (root.as_str(),),
        )
        .await
        .context("listing a persona's groups")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!(rows
        .into_iter()
        .map(|(g, name, standing)| serde_json::json!({
            "group": hex::encode(g),
            "name": name,
            "standing": standing,
        }))
        .collect::<Vec<_>>())))
}

/// GET `/api/identity/{root}/groups/{group}` - the roster as this node holds it.
async fn roster_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (_, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// POST `.../groups/{group}/sync` - push this persona's lanes, pull everyone else's.
async fn sync_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (_, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    sync_group(&state, &root, &group, &[]).await;
    // A persona who has left still syncs - that's how the leave gets out - and is answered
    // without the roster, which is no longer theirs to read.
    match current(&state, &group, &me).await {
        Ok((roster, lanes)) => Ok(Json(roster_json(&group, &roster, &lanes, &me))),
        Err(AppError::NotFound(_)) => Ok(Json(serde_json::json!({ "group": hex::encode(group) }))),
        Err(e) => Err(e),
    }
}

#[derive(Deserialize)]
struct InviteRequest {
    invitee: String,
}

/// POST `.../groups/{group}/invites` - an owner invites a persona. The answer is what the
/// invitee's node needs to join: the group, the invite, who to pull first and where.
async fn invite_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<InviteRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let invitee = root_of(&req.invitee).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    let by = acting(&roster, &me)?;
    // Readmit every removal of theirs this node has seen: inviting someone back is meaning to.
    let readmits: Vec<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| {
            roster.counted.contains(&e.hash)
                && matches!(&e.body, GroupEntry::Remove { target, .. } if *target == invitee)
        })
        .map(|e| e.hash)
        .collect();
    let invite =
        write(&state, &data, &root, group, GroupEntry::Invite { by, invitee, readmits }).await?;
    // Where to find the group: here, and every node it has been heard at, so the newcomer
    // meets the members' nodes and not only this one.
    let mut via = vec![state.endpoint.id().to_string()];
    let heard: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT endpoint_id FROM group_peers WHERE group_id = ?1
             GROUP BY endpoint_id ORDER BY MAX(heard_ms) DESC LIMIT 7",
            (group.to_vec(),),
        )
        .await
        .unwrap_or_default();
    for (ep,) in heard {
        if !via.contains(&ep) {
            via.push(ep);
        }
    }
    Ok(Json(serde_json::json!({
        "group": hex::encode(group),
        "invite": hex::encode(invite),
        "founder": hex::encode(roster.founder),
        "inviter": root,
        "via": via,
    })))
}

#[derive(Deserialize)]
struct JoinRequest {
    invite: String,
    founder: String,
    inviter: String,
    via: Vec<String>,
}

/// POST `.../groups/{group}/join` - take up an invite: say so on this persona's own lane, then
/// fetch the group from where the invite said it is.
async fn join_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<JoinRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let invite = hash_of(&req.invite)?;
    for ep in req.via.iter().take(8) {
        remember_peer(&state, &group, ep, "").await;
    }
    let imaol_entry = GroupEntry::Join { grant: Grant::Invite(invite) };
    let payload = imaol_entry.encode().map_err(|e| AppError::Internal(anyhow!("{e}")))?;
    crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        service::GROUP,
        Some(group),
        entry_type::GROUP_ENTRY,
        Payload::Inline(payload),
    )
    .await?;
    crate::fold::fold_now(&state, &root).await;
    sync_group(&state, &root, &group, &[req.founder, req.inviter]).await;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// POST `.../groups/{group}/leave` - leave: retire from every appointment first (a leave ends
/// membership, not ownership - section 3, rule 8), then leave from every computer at once.
async fn leave_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    let ours = anchors_of(&lanes, &BTreeSet::from([me]));
    let others: Vec<LaneAnchor> = ours
        .iter()
        .filter(|a| a.device != data.signer().verifying_key().to_bytes())
        .copied()
        .collect();
    for (h, a) in &roster.appointments {
        if a.persona == me && a.standing {
            write(
                &state,
                &data,
                &root,
                group,
                GroupEntry::Retire { by: *h, anchors: others.clone() },
            )
            .await?;
        }
    }
    write(&state, &data, &root, group, GroupEntry::Leave { anchors: others }).await?;
    // Out, so the roster is no longer theirs to read (ruling 3).
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "left": true })))
}

#[derive(Deserialize)]
struct TargetRequest {
    target: String,
    #[serde(default)]
    ban: bool,
}

fn target_of(req: &TargetRequest) -> Result<Root, AppError> {
    root_of(&req.target).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })
}

/// POST `.../groups/{group}/remove` - an owner takes someone out, anchored at what this node
/// has seen of them and of every owner beneath them.
async fn remove_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<TargetRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let target = target_of(&req)?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    let by = acting(&roster, &me)?;
    let (ends, anchors) = ending(&roster, &lanes, &target);
    let entry = GroupEntry::Remove { by, target, ends, anchors, ban: req.ban };
    write(&state, &data, &root, group, entry).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// POST `.../groups/{group}/demote` - an owner takes someone's ownership, and the ownership of
/// everyone they appointed; they all stay in the group.
async fn demote_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<TargetRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let target = target_of(&req)?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    let by = acting(&roster, &me)?;
    let (ends, anchors) = ending(&roster, &lanes, &target);
    write(&state, &data, &root, group, GroupEntry::Demote { by, target, ends, anchors }).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// POST `.../groups/{group}/appoint` - an owner makes someone an owner, junior to themselves.
async fn appoint_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<TargetRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let appointee = target_of(&req)?;
    let (roster, _) = current(&state, &group, &me).await?;
    let by = acting(&roster, &me)?;
    write(&state, &data, &root, group, GroupEntry::Appoint { by, appointee }).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

// ---------------------------------------------------------------------------------------------
// Group posts: documents on the lane (plans/GROUPS.md, section 7)
//
// A group post is a document like any other post - a `DocHeader` with versions, a body blob, its
// pictures as media documents, edits as new versions, a takedown as a retraction - on the
// poster's lane for the group, not their public posts chain. Nothing here touches a persona's
// document views: those fold the public and private lanes, and every public surface reads them
// filtered to the public lane, so a group post can't reach one by construction. A group's
// documents are read from the memo, like its roster.

/// One counted version of a document posted to the group.
struct Version {
    persona: Root,
    hash: Hash,
    header: DocHeaderPlain,
}

/// A group's documents as members see them: each document's counted versions, by doc id, and
/// the documents their authors have taken down. Only what the roster counts - a version past
/// a removal's anchor is nobody's post.
async fn documents_of(
    state: &AppState,
    group: &GroupId,
    roster: &Roster,
) -> Result<(BTreeMap<[u8; 16], Vec<Version>>, BTreeSet<[u8; 16]>), AppError> {
    let rows: Vec<(String, Vec<u8>, i64, Vec<u8>)> = state
        .node_db
        .fetch_all(
            "SELECT persona, hash, entry_type, body FROM group_lanes
             WHERE group_id = ?1 AND entry_type IN (?2, ?3) ORDER BY device, seq",
            (
                group.to_vec(),
                i64::from(entry_type::DOC_HEADER),
                i64::from(entry_type::POST_RETRACT),
            ),
        )
        .await
        .context("reading a group's documents")
        .map_err(AppError::Internal)?;
    let mut versions: BTreeMap<[u8; 16], Vec<Version>> = BTreeMap::new();
    let mut takedowns: Vec<(Root, [u8; 16])> = Vec::new();
    for (persona, hash, kind, body) in rows {
        let (Some(persona), Ok(hash)) = (root_of(&persona), <[u8; 32]>::try_from(hash)) else {
            continue;
        };
        if !roster.counted.contains(&hash) {
            continue;
        }
        if kind == i64::from(entry_type::DOC_HEADER) {
            if let Ok(header) = DocHeaderPlain::decode(&body) {
                versions.entry(header.doc_id).or_default().push(Version { persona, hash, header });
            }
        } else if let Ok(r) = PostRetraction::decode(&body) {
            takedowns.push((persona, r.doc_id));
        }
    }
    // A document is its first author's: a version from anyone else is not an edit of it.
    for list in versions.values_mut() {
        let first = list.iter().find(|v| v.header.parents.is_empty()).map(|v| v.persona);
        if let Some(author) = first {
            list.retain(|v| v.persona == author);
        }
    }
    let gone: BTreeSet<[u8; 16]> = takedowns
        .into_iter()
        .filter(|(who, doc)| {
            versions.get(doc).and_then(|l| l.first()).is_some_and(|v| v.persona == *who)
        })
        .map(|(_, doc)| doc)
        .collect();
    Ok((versions, gone))
}

/// The version to show: a head no other counted version names as a parent - the newest edit.
/// Two concurrent heads (two of the author's computers) settle on the larger hash, the same on
/// every node.
fn display(list: &[Version]) -> Option<&Version> {
    let parents: BTreeSet<Hash> =
        list.iter().flat_map(|v| v.header.parents.iter().copied()).collect();
    list.iter().filter(|v| !parents.contains(&v.hash)).max_by_key(|v| v.hash)
}

/// The document's first version: what an owner's hide names, so a hide outlives the edits.
fn first_version(list: &[Version]) -> Option<&Version> {
    list.iter().find(|v| v.header.parents.is_empty())
}

/// Every blob a group lane held here names - bodies, pictures, their thumbnails - for the reaper
/// (reaper.rs): kept while any group lane names them, counted or not, since a refold can count
/// what doesn't count today.
pub async fn blob_refs(node_db: &crate::db::Db) -> Result<Vec<[u8; 32]>> {
    let rows: Vec<(Vec<u8>,)> = node_db
        .fetch_all(
            "SELECT body FROM group_lanes WHERE entry_type = ?1",
            (i64::from(entry_type::DOC_HEADER),),
        )
        .await
        .context("listing the blobs group lanes name")?;
    let mut out = Vec::new();
    for (body,) in rows {
        let header = DocHeaderPlain::decode(&body)
            .map_err(|e| anyhow!("a held group document fails decode: {e}"))?;
        out.push(header.file_hash);
        out.extend(header.thumb_hash);
        out.extend(header.preview_hash);
    }
    Ok(out)
}

/// Fetch the bodies and pictures of a group's documents this node doesn't hold yet, from the
/// group's nodes - any member's node holds them all. The hash is the boundary (section 6):
/// only members are served the lanes that name these hashes.
async fn fetch_bodies(state: &AppState, group: &GroupId, names: &BTreeSet<String>) {
    let Ok(Some((roster, _))) = refold(state, group).await else { return };
    let Ok((versions, gone)) = documents_of(state, group, &roster).await else { return };
    let mut missing: Vec<iroh_blobs::Hash> = Vec::new();
    for (doc, list) in &versions {
        if gone.contains(doc) {
            continue;
        }
        for v in list {
            for h in std::iter::once(v.header.file_hash).chain(v.header.thumb_hash) {
                let hash = iroh_blobs::Hash::from_bytes(h);
                if !state.files.has(hash).await && !missing.contains(&hash) {
                    missing.push(hash);
                }
            }
        }
    }
    if missing.is_empty() {
        return;
    }
    for ep in endpoints(state, group, names).await {
        let Ok(addr) = crate::net::sync::dial_addr(state, &ep).await else { continue };
        state.files.fetch_many(&state.endpoint, addr, &missing).await;
        let mut still = Vec::new();
        for h in missing {
            if !state.files.has(h).await {
                still.push(h);
            }
        }
        missing = still;
        if missing.is_empty() {
            break;
        }
    }
}

/// A group media document's address, the same for every member: the embed a group post's words
/// carry. The decorative name gives the renderer an extension to sniff, as a public twin's does.
fn media_target(
    group: &GroupId,
    doc: &[u8; 16],
    format: crate::record::documents::Format,
    animation: bool,
) -> String {
    let name = if animation { "media-loop" } else { "media" };
    format!(
        "/api/groups/{}/docs/{}/body/{name}.{}",
        hex::encode(group),
        hex::encode(doc),
        format.as_str()
    )
}

/// What `source` - a persona's own document - already became in this group.
async fn published_as(
    state: &AppState,
    root: &str,
    source: &[u8; 16],
    group: &GroupId,
) -> Option<[u8; 16]> {
    let row: Option<(Vec<u8>,)> = state
        .node_db
        .fetch_optional(
            "SELECT post FROM group_drafts WHERE root = ?1 AND source = ?2 AND group_id = ?3",
            (root, source.to_vec(), group.to_vec()),
        )
        .await
        .ok()
        .flatten();
    row.and_then(|(b,)| b.try_into().ok())
}

async fn remember_published(
    state: &AppState,
    root: &str,
    source: &[u8; 16],
    group: &GroupId,
    post: &[u8; 16],
) -> Result<(), AppError> {
    state
        .node_db
        .execute(
            "INSERT INTO group_drafts (root, source, group_id, post) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (root, source, group_id) DO UPDATE SET post = excluded.post",
            (root, source.to_vec(), group.to_vec(), post.to_vec()),
        )
        .await
        .context("remembering what a document became in a group")
        .map_err(AppError::Internal)?;
    Ok(())
}

/// Append a document entry (a version, or a takedown) to `me`'s lane for the group.
async fn append_document(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    kind: u32,
    payload: Vec<u8>,
) -> Result<Hash, AppError> {
    let signed = crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        service::GROUP,
        Some(*group),
        kind,
        Payload::Inline(payload),
    )
    .await?;
    crate::fold::fold_now(state, me).await;
    Ok(*signed.hash())
}

/// One of the persona's own pictures, as a media document on their lane for the group: its
/// plaintext bytes and thumbnail in the blob store, its header on the lane - the public twin's
/// shape, minus the public chain. Minted once per picture per group.
async fn group_media(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    source: &[u8; 16],
) -> Result<([u8; 16], crate::record::documents::Format, bool), AppError> {
    use crate::record::documents::Format;
    let docs = data.documents();
    let doc = docs.one(source).await?.ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "roster.a-picture-is-missing",
            "a picture this post embeds is missing"
        ))
    })?;
    let head = doc.display_head().ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "roster.a-picture-is-missing",
            "a picture this post embeds is missing"
        ))
    })?;
    let format = Format::from_wire(head.header.format);
    if !matches!(format, Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus) {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.not-a-picture",
            "something this post embeds isn't a picture, a film or a sound"
        )));
    }
    if let Some(minted) = published_as(state, me, source, group).await {
        return Ok((minted, format, head.header.animation));
    }
    let body = docs.body(head).await?.ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "roster.a-pictures-bytes-havent-arrived",
            "a picture's bytes haven't arrived on this computer yet"
        ))
    })?;
    let thumb = match head.header.thumb_hash {
        Some(h) => docs.blob(h).await?,
        None => None,
    };
    // HELD (`files::Put`) until the header naming them is on the lane.
    let held_body = state.files.put_public(&body).await.map_err(AppError::Internal)?;
    let held_thumb = match &thumb {
        Some(t) => Some(state.files.put_public(t).await.map_err(AppError::Internal)?),
        None => None,
    };
    let doc_id = crate::record::documents::new_doc_id();
    let header = DocHeaderPlain {
        doc_id,
        parents: Vec::new(),
        file_hash: *held_body.hash.as_bytes(),
        body_hash: *held_body.hash.as_bytes(),
        title: head.header.title.clone(),
        sealed_title: None,
        format: head.header.format,
        width: head.header.width,
        height: head.header.height,
        duration_ms: head.header.duration_ms,
        thumb_hash: held_thumb.as_ref().map(|t| *t.hash.as_bytes()),
        preview_hash: None,
        refs: Vec::new(),
        genesis_ms: Some(now_ms()),
        reply_to: None,
        thread_root: None,
        settled: false,
        trusted_only: false,
        dated_ms: None,
        animation: head.header.animation,
        im: false,
        part_of: None,
        seal_of: None,
        onward: false,
        prints: Default::default(),
    };
    let payload = header
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding a group media header: {e}")))?;
    append_document(state, data, me, group, entry_type::DOC_HEADER, payload).await?;
    drop((held_body, held_thumb));
    remember_published(state, me, source, group, &doc_id).await?;
    Ok((doc_id, format, head.header.animation))
}

/// Publish one of `me`'s drafts to a group: its pictures as group media documents, its words as a
/// body blob, the version on `me`'s lane. Publishing the same draft again is an edit: a new
/// version parented on the post's current one, its first stamp carried.
pub async fn publish(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    draft: &[u8; 16],
) -> Result<[u8; 16], AppError> {
    use crate::record::bake::MediaRef;
    use crate::record::documents::Format;
    let docs = data.documents();
    let doc = docs
        .one(draft)
        .await?
        .ok_or_else(|| AppError::NotFound(crate::msg!("roster.no-such-draft", "no such draft")))?;
    let head = doc.display_head().ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "roster.the-draft-is-unreadable",
            "that draft can't be read"
        ))
    })?;
    let format = Format::from_wire(head.header.format);
    if !matches!(format, Format::Marquee | Format::Plaintext) {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.words-only",
            "a group post is words, with pictures in them"
        )));
    }
    let title = head.header.title.clone();
    let words = docs.body(head).await?.ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "roster.the-drafts-words-havent-arrived",
            "this draft's words haven't arrived on this computer yet"
        ))
    })?;
    let mut words = String::from_utf8(words).map_err(|_| {
        AppError::BadRequest(crate::msg!(
            "roster.the-draft-is-unreadable",
            "that draft can't be read"
        ))
    })?;
    let mut refs: Vec<[u8; 16]> = Vec::new();
    if format == Format::Marquee {
        let mut swaps: Vec<(String, String)> = Vec::new();
        for found in crate::record::bake::media_refs(&words, me) {
            match found {
                MediaRef::PrivateDoc { target, doc_id } => {
                    let (media, fmt, animation) =
                        group_media(state, data, me, group, &doc_id).await?;
                    swaps.push((target, media_target(group, &media, fmt, animation)));
                    if !refs.contains(&media) {
                        refs.push(media);
                    }
                }
                // Pictures from elsewhere wait for a later slice: the public pipeline downloads
                // and copies them into public twins, and a group's need their own road.
                MediaRef::External { .. } | MediaRef::Foreign { .. } => {
                    return Err(AppError::BadRequest(crate::msg!(
                        "roster.own-pictures-only",
                        "a group post can carry your own pictures for now - this one is from elsewhere"
                    )));
                }
            }
        }
        words = crate::record::bake::rewrite(&words, &swaps);
    }
    if refs.len() > DocHeaderPlain::MAX_REFS {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.too-many-pictures",
            "that's more pictures than one post carries"
        )));
    }
    // An edit when this draft is already a post in the group, and the post still stands.
    let (roster, _) = refold(state, group).await.map_err(AppError::Internal)?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"))
    })?;
    let me_root = root_of(me).unwrap_or_default();
    let (versions, gone) = documents_of(state, group, &roster).await?;
    let onto = published_as(state, me, draft, group)
        .await
        .filter(|post| !gone.contains(post))
        .and_then(|post| versions.get(&post).map(|list| (post, list)))
        .filter(|(_, list)| list.first().is_some_and(|v| v.persona == me_root));
    let (doc_id, parents, genesis_ms) = match onto {
        Some((post, list)) => {
            let shown = display(list);
            (
                post,
                shown.map(|v| vec![v.hash]).unwrap_or_default(),
                first_version(list).and_then(|v| v.header.genesis_ms).unwrap_or_else(now_ms),
            )
        }
        None => (crate::record::documents::new_doc_id(), Vec::new(), now_ms()),
    };
    let held = state.files.put_public(words.as_bytes()).await.map_err(AppError::Internal)?;
    let header = DocHeaderPlain {
        doc_id,
        parents,
        file_hash: *held.hash.as_bytes(),
        body_hash: *held.hash.as_bytes(),
        title,
        sealed_title: None,
        format: format.to_wire(),
        width: None,
        height: None,
        duration_ms: None,
        thumb_hash: None,
        preview_hash: None,
        refs,
        genesis_ms: Some(genesis_ms),
        reply_to: None,
        thread_root: None,
        settled: false,
        trusted_only: false,
        dated_ms: None,
        animation: false,
        im: false,
        part_of: None,
        seal_of: None,
        onward: false,
        prints: Default::default(),
    };
    let payload = header
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding a group post's header: {e}")))?;
    append_document(state, data, me, group, entry_type::DOC_HEADER, payload).await?;
    drop(held);
    remember_published(state, me, draft, group, &doc_id).await?;
    Ok(doc_id)
}

#[derive(Deserialize)]
struct PublishRequest {
    doc: String,
}

fn doc_of(hex_doc: &str) -> Result<[u8; 16], AppError> {
    hex::decode(hex_doc).ok().and_then(|b| b.try_into().ok()).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-document-id", "that isn't a document id"))
    })
}

/// POST `.../groups/{group}/publish` - publish a draft to the group (or publish it again: an edit).
async fn publish_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<PublishRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, _) = current(&state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-only",
            "only the group's members can post to it"
        )));
    }
    let post = publish(&state, &data, &root, &group, &doc_of(&req.doc)?).await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "post": hex::encode(post) })))
}

/// POST `.../groups/{group}/docs/{doc}/retract` - take down your own post, as any post is taken
/// down: a retraction on the lane it was posted to.
async fn retract_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, doc)): Path<(String, String, String)>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let doc = doc_of(&doc)?;
    let (roster, _) = current(&state, &group, &me).await?;
    let (versions, _) = documents_of(&state, &group, &roster).await?;
    if !versions.get(&doc).and_then(|l| l.first()).is_some_and(|v| v.persona == me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.your-own-posts-only",
            "you can take down only your own posts"
        )));
    }
    append_document(
        &state,
        &data,
        &root,
        &group,
        entry_type::POST_RETRACT,
        PostRetraction { doc_id: doc }.encode(),
    )
    .await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "retracted": hex::encode(doc) })))
}

#[derive(Deserialize)]
struct HideRequest {
    hidden: bool,
}

/// POST `.../groups/{group}/docs/{doc}/hide` - an owner hides a post from the group's page, or
/// shows it again. The post stays its author's: a hide is the owner's own entry.
async fn hide_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, doc)): Path<(String, String, String)>,
    Json(req): Json<HideRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let doc = doc_of(&doc)?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    let by = acting(&roster, &me)?;
    let (versions, _) = documents_of(&state, &group, &roster).await?;
    let post =
        versions.get(&doc).and_then(|l| first_version(l)).map(|v| v.hash).ok_or_else(|| {
            AppError::NotFound(crate::msg!("roster.no-such-post", "no such post in this group"))
        })?;
    // Replace every hide of it this node has seen, so the newest word settles it.
    let replaces: Vec<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| roster.counted.contains(&e.hash))
        .filter(|e| matches!(&e.body, GroupEntry::Hide { post: p, .. } if *p == post))
        .map(|e| e.hash)
        .collect();
    write(&state, &data, &root, group, GroupEntry::Hide { by, post, hidden: req.hidden, replaces })
        .await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "hidden": req.hidden })))
}

/// GET `.../groups/{group}/posts` - the group's page: its posts, newest first, each at its
/// newest version, hidden ones marked (an owner sees them; the app decides how).
async fn posts_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (_, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, _) = current(&state, &group, &me).await?;
    let (versions, gone) = documents_of(&state, &group, &roster).await?;
    // A post is a document no other document names: a picture belongs to the post embedding it.
    let embedded: BTreeSet<[u8; 16]> = versions
        .values()
        .flat_map(|l| l.iter().flat_map(|v| v.header.refs.iter().copied()))
        .collect();
    let mut posts = Vec::new();
    for (doc, list) in &versions {
        if gone.contains(doc) || embedded.contains(doc) {
            continue;
        }
        let (Some(shown), Some(first)) = (display(list), first_version(list)) else { continue };
        let words = crate::idface::public_blob(&state, shown.header.file_hash)
            .await
            .ok()
            .flatten()
            .and_then(|b| String::from_utf8(b).ok());
        posts.push(serde_json::json!({
            "doc": hex::encode(doc),
            "author": hex::encode(shown.persona),
            "title": shown.header.title,
            "format": crate::record::documents::Format::from_wire(shown.header.format).as_str(),
            // None until the body has arrived from a member's node.
            "words": words,
            "media": shown.header.refs.iter().map(hex::encode).collect::<Vec<_>>(),
            "posted_ms": first.header.genesis_ms,
            "edited": list.len() > 1,
            "hidden": roster.hidden.contains(&first.hash),
        }));
    }
    posts.sort_by_key(|p| std::cmp::Reverse(p["posted_ms"].as_i64().unwrap_or(0)));
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "posts": posts })))
}

/// A group document's bytes, for a session one of whose personas the group counts.
async fn group_bytes(
    state: &AppState,
    session: &Session,
    group: &str,
    doc: &str,
    thumb: bool,
) -> Result<axum::response::Response, AppError> {
    use axum::http::header;
    use axum::response::IntoResponse;
    let missing =
        || AppError::NotFound(crate::msg!("roster.no-such-post", "no such post in this group"));
    let group = group_of(group)?;
    let doc = doc_of(doc)?;
    let mut roster = None;
    for persona in crate::identity::list_for_account(&state.node_db, &session.account.id).await? {
        let Some(root) = root_of(&persona.root_pubkey) else { continue };
        if let Ok((r, _)) = current(state, &group, &root).await {
            if r.members.contains(&root) {
                roster = Some(r);
                break;
            }
        }
    }
    let roster = roster.ok_or_else(missing)?;
    let (versions, gone) = documents_of(state, &group, &roster).await?;
    if gone.contains(&doc) {
        return Err(missing());
    }
    let shown = versions.get(&doc).and_then(|l| display(l)).ok_or_else(missing)?;
    let (hash, mime) = if thumb {
        (shown.header.thumb_hash.ok_or_else(missing)?, "image/avif")
    } else {
        (
            shown.header.file_hash,
            crate::record::documents::Format::from_wire(shown.header.format).mime(),
        )
    };
    let bytes = crate::idface::public_blob(state, hash)
        .await
        .map_err(AppError::Internal)?
        .ok_or_else(|| {
            AppError::NotFound(crate::msg!(
                "roster.still-on-its-way",
                "still on its way from the group's other computers"
            ))
        })?;
    // A media document has one version, so its bytes never change: kept. A post's words change
    // with an edit at the same address: asked after every time.
    use crate::record::documents::Format;
    let media = matches!(
        Format::from_wire(shown.header.format),
        Format::Avif | Format::Apng | Format::WebmAv1 | Format::OggOpus
    );
    let cache =
        if media || thumb { "private, max-age=31536000, immutable" } else { "private, no-cache" };
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, cache),
        ],
        bytes,
    )
        .into_response())
}

/// GET `/api/groups/{group}/docs/{doc}/body`.
async fn group_body_route(
    session: Session,
    State(state): State<AppState>,
    Path((group, doc)): Path<(String, String)>,
) -> Result<axum::response::Response, AppError> {
    group_bytes(&state, &session, &group, &doc, false).await
}

/// GET `/api/groups/{group}/docs/{doc}/body/{name}` - the embed's form; the name is decorative.
async fn group_body_named_route(
    session: Session,
    State(state): State<AppState>,
    Path((group, doc, _name)): Path<(String, String, String)>,
) -> Result<axum::response::Response, AppError> {
    group_bytes(&state, &session, &group, &doc, false).await
}

/// GET `/api/groups/{group}/docs/{doc}/thumb`.
async fn group_thumb_route(
    session: Session,
    State(state): State<AppState>,
    Path((group, doc)): Path<(String, String)>,
) -> Result<axum::response::Response, AppError> {
    group_bytes(&state, &session, &group, &doc, true).await
}
