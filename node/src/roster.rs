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
    LaneEntry, Root, Roster, Setting,
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
    &[service::IDENTITY_PUBLIC, service::PROFILE_PUBLIC, service::GROUP, service::GROUP_PUBLIC];

fn root_of(hex_root: &str) -> Option<Root> {
    hex::decode(hex_root).ok()?.try_into().ok()
}

pub fn group_of(hex_group: &str) -> Result<GroupId, AppError> {
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
    // What the memo already holds of this persona's lanes: each lane's next seq, when the lane is
    // held unbroken from its start. Only entries past that are read (ONE_FEED.md, slice 1: the
    // annotations' and edges' catch-up by watermark); a lane with a gap is read whole, so what
    // fills the gap is taken.
    let held: Vec<(Vec<u8>, Vec<u8>, i64, i64)> = state
        .node_db
        .fetch_all(
            "SELECT group_id, device, COUNT(*), MAX(seq) FROM group_lanes WHERE persona = ?1
             GROUP BY group_id, device",
            (root,),
        )
        .await
        .context("reading what a persona's group lanes hold")?;
    let marks: std::collections::HashMap<(Vec<u8>, Vec<u8>), i64> = held
        .into_iter()
        .filter(|(_, _, count, max)| *count == max + 1)
        .map(|(group, device, _, max)| ((group, device), max))
        .collect();
    // user-db open: the fold leg, one persona per move of its GROUP chains.
    let Ok(Some(db)) = state.user_dbs.get(root).await else { return Ok(()) };
    let entries = crate::record::imaol::group_entries_past(&db, &marks)
        .await
        .map_err(|e| anyhow!("{e:?}"))?;
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
                   (group_id, persona, device, seq, hash, entry_type, body, claimed_ms, arrived_ms,
                    service)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                (
                    group.to_vec(),
                    root,
                    lane_device(e.chain.service, &e.chain.author).to_vec(),
                    e.seq as i64,
                    signed.hash().to_vec(),
                    i64::from(e.entry_type),
                    body.clone(),
                    e.timestamp_ms,
                    crate::clock::now_ms(),
                    i64::from(e.chain.service),
                ),
            )
            .await
            .context("remembering a group entry")?;
        if added > 0 {
            touched.insert(group);
        }
    }
    for group in touched {
        // After the inserts: a reader that sees the new stamp sees the new entries.
        bump_lanes(state, &group).await?;
        refold(state, &group).await?;
    }
    Ok(())
}

/// The fold's name for a chain's lane (plans/PUBLIC_GROUPS.md): a device's public lane is
/// `public_lane(device)`, its members-only lane the device itself. The memo keys lanes so.
pub fn lane_device(service: u32, author: &[u8; 32]) -> [u8; 32] {
    if service == service::GROUP_PUBLIC {
        ringtome_proto::roster::public_lane(author)
    } else {
        *author
    }
}

/// The group's lanes moved: its stamp too, so a cached fold of it is stale.
async fn bump_lanes(state: &AppState, group: &GroupId) -> Result<()> {
    state
        .node_db
        .execute(
            "INSERT INTO group_stamps (group_id, lanes_seq) VALUES (?1, 1)
             ON CONFLICT (group_id) DO UPDATE SET lanes_seq = lanes_seq + 1",
            (group.to_vec(),),
        )
        .await
        .context("moving a group's stamp")?;
    Ok(())
}

/// The group's `(lanes_seq, derived_seq)`, or `(0, -1)` for one never stamped.
async fn stamps_of(state: &AppState, group: &GroupId) -> Result<(i64, i64)> {
    let row: Option<(i64, i64)> = state
        .node_db
        .fetch_optional(
            "SELECT lanes_seq, derived_seq FROM group_stamps WHERE group_id = ?1",
            (group.to_vec(),),
        )
        .await
        .context("reading a group's stamp")?;
    Ok(row.unwrap_or((0, -1)))
}

/// A stamp for the rows one derivation writes, above every earlier one's: its sweep then takes
/// exactly the rows it didn't write. Milliseconds when they move, one more when they don't.
fn next_noted() -> i64 {
    static LAST: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    let now = now_ms();
    let mut last = LAST.load(std::sync::atomic::Ordering::Relaxed);
    loop {
        let next = now.max(last + 1);
        match LAST.compare_exchange(
            last,
            next,
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
        ) {
            Ok(_) => return next,
            Err(seen) => last = seen,
        }
    }
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
        entry_type::PUBLIC_ANNOTATION => ringtome_proto::PublicAnnotation::decode(body)
            .ok()
            .map(|a| GroupEntry::Label { doc: a.target_doc }),
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

/// A group as its lanes fold: the roster, and the lanes it was folded from. Shared, since a
/// cached fold is handed to every read of it.
type Folded = (std::sync::Arc<Roster>, std::sync::Arc<Vec<Lane>>);

/// Fold a group from the memo and keep what the door and the feed read. `None` when no valid
/// founding for it is held. Writes nothing when the lanes haven't moved since the tables were
/// last written from them; when they have, rewrites them in place - upserted, then the rows not
/// written this time swept - so a reader never meets an emptied table (ONE_FEED.md, slice 1).
async fn refold(state: &AppState, group: &GroupId) -> Result<Option<Folded>> {
    // One derivation of a group at a time (2026-10-16): two at once would sweep each other's rows.
    let lock = refold_lock(group);
    let _held = lock.lock().await;
    let (lanes_seq, derived_seq) = stamps_of(state, group).await?;
    let Some((roster, lanes)) = folded(state, group).await? else { return Ok(None) };
    // Whose rows the journal holds turns on who is hosted here too, which the lanes don't say: a
    // persona adopted onto this node, already in the group, needs its rows. So the members hosted
    // here are remembered with the tables, in RAM - a boot forgets them, and writes each group's
    // tables once more.
    let mut readers: Vec<Root> = Vec::new();
    for m in &roster.members {
        if crate::identity::is_agented(&state.node_db, &hex::encode(m)).await.unwrap_or(false) {
            readers.push(*m);
        }
    }
    // And whom the group's public posts are carried to here (plans/PUBLIC_GROUPS.md): a reader
    // who turns a member's rebroadcasts on or off moves no lane, and must still be written for.
    let carry = carry_readers(state, &roster).await;
    type Hosted = std::collections::HashMap<GroupId, (Vec<Root>, Carry)>;
    static HOSTED: std::sync::LazyLock<std::sync::Mutex<Hosted>> =
        std::sync::LazyLock::new(Default::default);
    let same_readers = HOSTED.lock().expect("hosted readers poisoned").get(group)
        == Some(&(readers.clone(), carry.clone()));
    if derived_seq == lanes_seq && same_readers {
        return Ok(Some((roster, lanes)));
    }
    let db = &state.node_db;
    let noted = next_noted();
    db.execute(
        "INSERT INTO group_rosters (group_id, name, founder, folded_ms, public)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (group_id) DO UPDATE SET name = excluded.name, folded_ms = excluded.folded_ms,
           public = excluded.public",
        (
            group.to_vec(),
            roster.name.as_str(),
            hex::encode(roster.founder),
            now_ms(),
            i64::from(roster.public),
        ),
    )
    .await
    .context("remembering a group")?;
    // Who was in before this derivation: a line someone said in one of the group's rooms is kept
    // only while they're in it (plans/GROUP_ROOMS.md), so a line that arrived before their joining
    // did is folded again once it has (below).
    let before: BTreeSet<String> = members_of(state, group).await.into_iter().collect();
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
            "INSERT INTO group_people (group_id, root, standing, noted) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (group_id, root) DO UPDATE SET standing = excluded.standing,
               noted = excluded.noted",
            (group.to_vec(), root, standing, noted),
        )
        .await
        .context("remembering who's in a group")?;
    }
    db.execute(
        "DELETE FROM group_people WHERE group_id = ?1 AND noted < ?2",
        (group.to_vec(), noted),
    )
    .await
    .context("forgetting who's no longer in a group")?;
    keep_public_posts(state, group, &roster, noted).await?;
    recarry(state, group, &roster, &carry, noted).await?;
    rejournal(state, group, &roster, &readers, noted).await?;
    let newly: Vec<String> =
        roster.members.iter().map(hex::encode).filter(|m| !before.contains(m)).collect();
    if !newly.is_empty() && has_rooms(state, group).await {
        let state = state.clone();
        tokio::spawn(async move {
            for m in newly {
                crate::chat::refresh_from(&state, &m, false).await;
            }
        });
    }
    db.execute(
        "UPDATE group_stamps SET derived_seq = ?2 WHERE group_id = ?1",
        (group.to_vec(), lanes_seq),
    )
    .await
    .context("noting a group's tables written")?;
    HOSTED.lock().expect("hosted readers poisoned").insert(*group, (readers, carry));
    Ok(Some((roster, lanes)))
}

/// The group's public posts as the fold counts them (plans/PUBLIC_GROUPS.md, slice 2), each
/// stamped by when its claim was said; the rest swept.
async fn keep_public_posts(
    state: &AppState,
    group: &GroupId,
    roster: &Roster,
    noted: i64,
) -> Result<()> {
    let db = &state.node_db;
    for ((author, doc), claim) in &roster.public_posts {
        let claimed_ms: i64 = db
            .fetch_optional::<(Option<i64>,)>(
                "SELECT claimed_ms FROM group_lanes WHERE group_id = ?1 AND hash = ?2",
                (group.to_vec(), claim.to_vec()),
            )
            .await
            .context("reading when a claim was said")?
            .and_then(|(ms,)| ms)
            .unwrap_or_else(now_ms);
        db.execute(
            "INSERT INTO group_public_posts (group_id, author, doc, claim, claimed_ms, noted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (group_id, author, doc) DO UPDATE SET claim = excluded.claim,
               noted = excluded.noted",
            (
                group.to_vec(),
                hex::encode(author),
                hex::encode(doc),
                claim.to_vec(),
                claimed_ms,
                noted,
            ),
        )
        .await
        .context("remembering a group's public post")?;
    }
    db.execute(
        "DELETE FROM group_public_posts WHERE group_id = ?1 AND noted < ?2",
        (group.to_vec(), noted),
    )
    .await
    .context("forgetting a group's former public posts")?;
    // Its feed reads them here (plans/PUBLIC_GROUPS.md): each post this node doesn't hold is
    // fetched from its author as a share's fragment is, in the background - a derivation holds
    // the group's lock, and a fetch can take seconds.
    let wanted: Vec<(String, [u8; 16])> =
        roster.public_posts.keys().map(|(a, d)| (hex::encode(a), *d)).collect();
    if !wanted.is_empty() {
        let state = state.clone();
        tokio::spawn(async move {
            for (author, doc) in wanted {
                if crate::fragments::held(&state.node_db, &author, &hex::encode(doc))
                    .await
                    .ok()
                    .flatten()
                    .is_some()
                {
                    continue;
                }
                let _ = crate::fragments::journalable(&state, &author, &author, &doc).await;
            }
        });
    }
    Ok(())
}

/// Each member of a public group with readers here who follow them for their rebroadcasts, and
/// those readers - never the member themselves (plans/PUBLIC_GROUPS.md, ruling 5: "if you don't
/// want their rebroadcasts, you also don't want to hear from their groups"). Empty for a private
/// group, which has no public voice.
type Carry = Vec<(String, Vec<String>)>;

async fn carry_readers(state: &AppState, roster: &Roster) -> Carry {
    if !roster.public {
        return Vec::new();
    }
    let mut out = Vec::new();
    // The group's own followers (ruling 7), under no via: every member's public post as the
    // group's reaches them.
    let mut followers = followers_of_group(state, &roster.id).await;
    followers.sort();
    if !followers.is_empty() {
        out.push((String::new(), followers));
    }
    for m in &roster.members {
        let via = hex::encode(m);
        let mut readers = crate::net::subscriptions::rebroadcast_followers_of(&state.node_db, &via)
            .await
            .unwrap_or_default();
        readers.retain(|r| *r != via);
        readers.sort();
        if !readers.is_empty() {
            out.push((via, readers));
        }
    }
    out
}

/// Carry the group's public posts (plans/PUBLIC_GROUPS.md, slice 3): to each member's
/// rebroadcast-followers here, every public post as the group by its other members, journaled
/// with the member as their via - the share's road, so a post this node doesn't hold comes from
/// its author or its holders. A member's own post as the group is a post of theirs, under the
/// follow. A carry that ended - hidden, its author removed, taken down - withdraws its rows.
async fn recarry(
    state: &AppState,
    group: &GroupId,
    roster: &Roster,
    carry: &Carry,
    noted: i64,
) -> Result<()> {
    let db = &state.node_db;
    let stamps: std::collections::HashMap<(String, String), i64> = db
        .fetch_all::<(String, String, i64)>(
            "SELECT author, doc, claimed_ms FROM group_public_posts WHERE group_id = ?1",
            (group.to_vec(),),
        )
        .await
        .context("reading when a group's public posts were claimed")?
        .into_iter()
        .map(|(a, d, ms)| ((a, d), ms))
        .collect();
    for (via, readers) in carry {
        let mut pointers = Vec::new();
        for ((author, doc), claim) in &roster.public_posts {
            let author = hex::encode(author);
            if author == *via {
                continue; // a member's own post as the group is theirs, under the follow
            }
            let at =
                stamps.get(&(author.clone(), hex::encode(doc))).copied().unwrap_or_else(now_ms);
            db.execute(
                "INSERT INTO group_carries (group_id, via, author, doc, noted) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (group_id, via, author, doc) DO UPDATE SET noted = excluded.noted",
                (group.to_vec(), via.as_str(), author.as_str(), hex::encode(doc), noted),
            )
            .await
            .context("remembering a carried post")?;
            pointers.push(crate::record::imaol::RebroadcastRow {
                author_root: author,
                doc_id: *doc,
                version_seen: Some(*claim),
                timestamp_ms: at,
                received_at_ms: at,
            });
        }
        crate::fanout::journal_shares_to(state, via, readers, &pointers, true).await;
    }
    let ended: Vec<(String, String, String)> = db
        .fetch_all(
            "SELECT via, author, doc FROM group_carries WHERE group_id = ?1 AND noted < ?2",
            (group.to_vec(), noted),
        )
        .await
        .context("reading the carries that ended")?;
    for (via, author, doc) in ended {
        if via.is_empty() {
            let followers = followers_of_group(state, group).await;
            crate::fanout::withdraw_followed(state, &followers, &author, &doc).await?;
        } else {
            crate::fanout::withdraw_carried(db, &via, &author, &doc).await?;
        }
    }
    db.execute(
        "DELETE FROM group_carries WHERE group_id = ?1 AND noted < ?2",
        (group.to_vec(), noted),
    )
    .await
    .context("forgetting the carries that ended")?;
    Ok(())
}

/// Who on this node follows a group itself (ruling 7).
async fn followers_of_group(state: &AppState, group: &GroupId) -> Vec<String> {
    state
        .node_db
        .fetch_all::<(String,)>(
            "SELECT local_root FROM group_follows WHERE group_id = ?1",
            (group.to_vec(),),
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(r,)| r)
        .collect()
}

/// Does `root` follow this group?
pub async fn follows_group(state: &AppState, root: &str, group: &GroupId) -> bool {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM group_follows WHERE local_root = ?1 AND group_id = ?2",
            (root, group.to_vec()),
        )
        .await
        .ok()
        .flatten()
        .is_some()
}

#[derive(Deserialize, Default)]
struct FollowRequest {
    /// Where the group may be found, when this node holds nothing of it yet: endpoints its page
    /// came from, and who to ask for there - its founder and members, as the page names them.
    #[serde(default)]
    via: Vec<String>,
    #[serde(default)]
    members: Vec<String>,
}

/// POST `.../groups/{group}/follow` - follow a public group itself (plans/PUBLIC_GROUPS.md,
/// ruling 7): every member's public post as the group's, in your feed. Anyone may, member or not.
async fn follow_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    body: Option<Json<FollowRequest>>,
) -> Answer {
    me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let req = body.map(|Json(b)| b).unwrap_or_default();
    for ep in req.via.iter().take(8) {
        remember_peer(&state, &group, ep, "").await;
    }
    let seed: Vec<String> = req.members.into_iter().take(64).collect();
    if !matches!(folded(&state, &group).await, Ok(Some(_))) {
        public_sync(&state, &group, &seed).await;
    }
    let Some((roster, _)) = folded(&state, &group).await.map_err(AppError::Internal)? else {
        return Err(AppError::NotFound(crate::msg!(
            "roster.no-such-group-here",
            "no such group here"
        )));
    };
    if !roster.public {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.only-a-public-group-is-followed",
            "only a public group can be followed"
        )));
    }
    state
        .node_db
        .execute(
            "INSERT INTO group_follows (local_root, group_id, followed_ms) VALUES (?1, ?2, ?3)
             ON CONFLICT (local_root, group_id) DO NOTHING",
            (root.as_str(), group.to_vec(), now_ms()),
        )
        .await
        .context("following a group")
        .map_err(AppError::Internal)?;
    public_sync(&state, &group, &seed).await;
    if let Some((roster, _)) = refold(&state, &group).await.map_err(AppError::Internal)? {
        recarry(&state, &group, &roster, &carry_readers(&state, &roster).await, next_noted())
            .await
            .map_err(AppError::Internal)?;
    }
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "following": true })))
}

/// DELETE `.../groups/{group}/follow` - stop following it: its public posts leave your feed,
/// unless you follow their authors.
async fn unfollow_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    state
        .node_db
        .execute(
            "DELETE FROM group_follows WHERE local_root = ?1 AND group_id = ?2",
            (root.as_str(), group.to_vec()),
        )
        .await
        .context("unfollowing a group")
        .map_err(AppError::Internal)?;
    let posts: Vec<(String, String)> = state
        .node_db
        .fetch_all(
            "SELECT author, doc FROM group_public_posts WHERE group_id = ?1",
            (group.to_vec(),),
        )
        .await
        .context("reading a group's public posts")
        .map_err(AppError::Internal)?;
    for (author, doc) in posts {
        crate::fanout::withdraw_followed(&state, std::slice::from_ref(&root), &author, &doc)
            .await
            .map_err(AppError::Internal)?;
    }
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "following": false })))
}

/// The public groups that count each of these posts as theirs (the cards' "(Cheese Group)"):
/// `(author, doc)` to `(group, name)`, as this node holds them.
pub async fn public_groups_of(
    state: &AppState,
    posts: &[(String, String)],
) -> std::collections::HashMap<(String, String), (String, String)> {
    let mut out = std::collections::HashMap::new();
    for (author, doc) in posts {
        let row: Option<(Vec<u8>, String)> = state
            .node_db
            .fetch_optional(
                "SELECT p.group_id, r.name FROM group_public_posts p
                 JOIN group_rosters r ON r.group_id = p.group_id
                 WHERE p.author = ?1 AND p.doc = ?2 ORDER BY p.claimed_ms LIMIT 1",
                (author.as_str(), doc.as_str()),
            )
            .await
            .ok()
            .flatten();
        if let Some((g, name)) = row {
            out.insert((author.clone(), doc.clone()), (hex::encode(g), name));
        }
    }
    out
}

/// Before a public post as the group mints (plans/PUBLIC_GROUPS.md): the group is public and
/// `root` is in it.
pub async fn may_post_as(
    state: &AppState,
    root: &str,
    group_hex: &str,
) -> Result<GroupId, AppError> {
    let group = group_of(group_hex)?;
    let me = root_of(root).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })?;
    let (roster, _) = current(state, &group, &me).await?;
    if !roster.public {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.not-a-public-group",
            "only a public group's members post in public as the group"
        )));
    }
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-only",
            "only the group's members can post to it"
        )));
    }
    Ok(group)
}

/// After it mints: `root`'s public lane claims the post as the group's - once, so republishing an
/// edit says nothing more.
pub async fn claim_public(
    state: &AppState,
    data: &Store,
    root: &str,
    group: GroupId,
    doc: [u8; 16],
) -> Result<(), AppError> {
    let me = root_of(root).unwrap_or_default();
    if let Ok(Some((roster, _))) = folded(state, &group).await {
        if roster.public_posts.contains_key(&(me, doc)) {
            return Ok(());
        }
    }
    write(state, data, root, group, GroupEntry::Public { doc, retract: false }).await?;
    Ok(())
}

/// A post taken down: every group that counted it as theirs is told it no longer is.
pub async fn unclaim_public(
    state: &AppState,
    data: &Store,
    root: &str,
    doc: &[u8; 16],
) -> Result<(), AppError> {
    let groups: Vec<(Vec<u8>,)> = state
        .node_db
        .fetch_all(
            "SELECT group_id FROM group_public_posts WHERE author = ?1 AND doc = ?2",
            (root, hex::encode(doc)),
        )
        .await
        .context("finding the groups a post was claimed in")
        .map_err(AppError::Internal)?;
    for (g,) in groups {
        let Ok(group) = <[u8; 16]>::try_from(g.as_slice()) else { continue };
        write(state, data, root, group, GroupEntry::Public { doc: *doc, retract: true }).await?;
    }
    Ok(())
}

/// The group as its held lanes fold now, nothing written: kept while the group's stamp stands,
/// as the key tree is kept by its chain's entry count (CACHE.md: the stamp is read before the
/// fold, so a fold that raced an arrival is only ever kept under the older stamp). What a read
/// wants; the memo is kept by [`refold`].
async fn folded(state: &AppState, group: &GroupId) -> Result<Option<Folded>> {
    type Kept = std::collections::HashMap<GroupId, (i64, Folded)>;
    static KEPT: std::sync::LazyLock<std::sync::Mutex<Kept>> =
        std::sync::LazyLock::new(Default::default);
    /// Groups kept at once; past it the cache starts again (a node holds few groups).
    const KEPT_GROUPS: usize = 256;
    let (stamp, _) = stamps_of(state, group).await?;
    if let Some((at, kept)) = KEPT.lock().expect("kept folds poisoned").get(group) {
        if *at == stamp {
            return Ok(Some(kept.clone()));
        }
    }
    let lanes = lanes_of(state, group).await?;
    let Some(roster) = fold::build(*group, &lanes) else { return Ok(None) };
    let made: Folded = (std::sync::Arc::new(roster), std::sync::Arc::new(lanes));
    let mut kept = KEPT.lock().expect("kept folds poisoned");
    if kept.len() >= KEPT_GROUPS {
        kept.clear();
    }
    kept.insert(*group, (stamp, made.clone()));
    Ok(Some(made))
}

/// The lock [`refold`] holds for one group.
fn refold_lock(group: &GroupId) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    type Locks = std::collections::HashMap<GroupId, std::sync::Arc<tokio::sync::Mutex<()>>>;
    static LOCKS: std::sync::LazyLock<std::sync::Mutex<Locks>> =
        std::sync::LazyLock::new(Default::default);
    LOCKS.lock().expect("refold locks poisoned").entry(*group).or_default().clone()
}

// ---------------------------------------------------------------------------------------------
// The feed: each hosted member's view of the group's posts (slice 4b)

/// A group's posts as its page lists them: standing (not taken down) and not a picture another
/// post embeds - each with the version shown, the first (which a hide names), whether it was
/// edited, and whether an owner hid it.
struct Listed<'a> {
    doc: [u8; 16],
    shown: &'a Version,
    first: &'a Version,
    edited: bool,
    hidden: bool,
}

fn listed<'a>(
    versions: &'a BTreeMap<[u8; 16], Vec<Version>>,
    gone: &BTreeSet<[u8; 16]>,
    roster: &Roster,
) -> Vec<Listed<'a>> {
    // A post is a document no other document names: a picture belongs to the post embedding it.
    let embedded: BTreeSet<[u8; 16]> = versions
        .values()
        .flat_map(|l| l.iter().flat_map(|v| v.header.refs.iter().copied()))
        .collect();
    versions
        .iter()
        // Nor is the group's face: a picture or banner an owner set (Curtis, 2026-10-16), nor a
        // picture said in one of its rooms, which is part of the room (`room_media`).
        .filter(|(doc, list)| {
            !gone.contains(*doc)
                && !embedded.contains(*doc)
                && !roster.face_docs.contains(*doc)
                && list.iter().all(|v| v.header.part_of.is_none())
        })
        .filter_map(|(doc, list)| {
            let (shown, first) = (display(list)?, first_version(list)?);
            Some(Listed {
                doc: *doc,
                shown,
                first,
                edited: list.len() > 1,
                hidden: roster.hidden.contains(&first.hash),
            })
        })
        .collect()
}

/// May `viewer` see this post? A hidden one is out of sight (Curtis, 2026-10-15) but for the
/// owners, who may show it again, and its author, who should know it was hidden.
fn sees(roster: &Roster, viewer: &Root, post: &Listed) -> bool {
    !post.hidden || post.shown.persona == *viewer || roster.owners.contains_key(viewer)
}

/// Write each hosted member's rows of the group's posts into the one feed journal (ONE_FEED.md,
/// slice 3), as the group now stands: upserted with this derivation's `noted`, then the group's
/// rows it didn't write swept - a member who left or was removed keeps none, and a post they may
/// no longer see (taken down, or hidden from them) leaves. Its labels go to the one label memo,
/// and its words to the search index, which reads them through the group's door.
async fn rejournal(
    state: &AppState,
    group: &GroupId,
    roster: &Roster,
    readers: &[Root],
    noted: i64,
) -> Result<()> {
    let db = &state.node_db;
    let (versions, gone) =
        documents_of(state, group, roster).await.map_err(|e| anyhow!("{e:?}"))?;
    let posts = listed(&versions, &gone, roster);
    let labels = labels_of(state, group, roster).await.map_err(|e| anyhow!("{e:?}"))?;
    // The labels the fold counted, on the posts it lists, into the one label memo (ONE_FEED.md,
    // slice 4): scores, chips and the tag cloud read them there.
    let memo: Vec<crate::annotations::GroupLabelRow> = posts
        .iter()
        .flat_map(|p| {
            let author = hex::encode(p.shown.persona);
            let doc = hex::encode(p.doc);
            labels.get(&p.doc).into_iter().flatten().map(move |l| {
                (author.clone(), doc.clone(), l.annotator.clone(), l.key.clone(), l.value.clone())
            })
        })
        .collect();
    crate::annotations::keep_group_labels(state, group, &memo, noted).await?;
    keep_rooms(state, group, &posts, noted).await?;
    // The group's replies into the node's one replies memo, marked with the group: its threads,
    // counts and "in reply to" cards are the public ones'. A hidden reply is out of its thread.
    let replies: Vec<crate::replies::GroupReply> = posts
        .iter()
        .filter(|p| !p.hidden)
        .filter_map(|p| {
            let (pa, pd) = p.first.header.reply_to?;
            let (ra, rd) = p.first.header.thread_root.unwrap_or((pa, pd));
            Some(crate::replies::GroupReply {
                parent: (hex::encode(pa), hex::encode(pd)),
                root: (hex::encode(ra), hex::encode(rd)),
                reply: (hex::encode(p.first.persona), hex::encode(p.doc)),
                claimed_ms: p.shown.header.dated_ms.or(p.first.header.genesis_ms).unwrap_or(0),
            })
        })
        .collect();
    crate::replies::keep_group(db, group, &replies).await?;
    let news = bell_news(state, group, roster, readers, &posts, &labels).await?;
    crate::notifications::keep_group_rows(state, group, &news).await?;
    for post in &posts {
        let doc_hex = hex::encode(post.doc);
        let format = crate::record::documents::Format::from_wire(post.shown.header.format).as_str();
        // Its claimed date when it has one, as any post sorts by its (PUBLISH.md).
        let published = post.shown.header.dated_ms.or(post.first.header.genesis_ms).unwrap_or(0);
        let updated = post.shown.header.genesis_ms.unwrap_or(published);
        let minted = post.first.header.genesis_ms.unwrap_or(0);
        // Its pin (slice 4d): an owner's above a member's.
        let pin: i64 = if roster.owner_pins.contains(&post.first.hash) {
            2
        } else if roster.member_pins.contains(&post.first.hash) {
            1
        } else {
            0
        };
        for reader in readers.iter().filter(|r| sees(roster, r, post)) {
            let owns = roster.owners.contains_key(reader);
            db.execute(
                "INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format,
                   published_ms, updated_ms, arrived_ms, settled, dated_ms, minted_ms, group_id,
                   hidden, owns, noted, pin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT (reader_root, author_root, doc_id) DO UPDATE SET
                   title = excluded.title, format = excluded.format,
                   published_ms = excluded.published_ms, updated_ms = excluded.updated_ms,
                   settled = excluded.settled, dated_ms = excluded.dated_ms,
                   minted_ms = excluded.minted_ms, group_id = excluded.group_id,
                   hidden = excluded.hidden, owns = excluded.owns, noted = excluded.noted,
                   pin = excluded.pin",
                (
                    hex::encode(reader),
                    hex::encode(post.shown.persona),
                    doc_hex.as_str(),
                    post.shown.header.title.as_str(),
                    format,
                    published,
                    updated,
                    i64::from(post.shown.header.settled),
                    post.shown.header.dated_ms,
                    minted,
                    group.to_vec(),
                    i64::from(post.hidden),
                    i64::from(owns),
                    noted,
                    pin,
                ),
            )
            .await
            .context("journalling a group post")?;
        }
    }
    db.execute(
        "DELETE FROM feed_journal WHERE group_id = ?1 AND noted < ?2",
        (group.to_vec(), noted),
    )
    .await
    .context("sweeping a group's rows from the feed journal")?;
    crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
    Ok(())
}

/// One label entry of a group's lanes: `(persona, hash, body, claimed_ms, arrived_ms)`.
type StampedLabel = (String, Vec<u8>, Vec<u8>, Option<i64>, Option<i64>);
/// A post's version as this node took it: `(hash, claimed_ms, arrived_ms)`.
type StampedHeader = (Vec<u8>, Option<i64>, Option<i64>);
/// A statement as said: `(labeller, post, key, value)`.
type LabelAt = (String, [u8; 16], String, String);

/// The group's labels as bell news for its hosted members (section 7; 2026-10-17): a mention of
/// a member said by a post's author, and another member's labels on a member's post, one row per
/// (reader, labeller, post). Every member's node holds the group's lanes, so this is the follow's
/// fold and no envelope is sent. A label this node took before rung 94 carries no stamps: old news,
/// never rung. A reader is told only of a post they may see.
async fn bell_news(
    state: &AppState,
    group: &GroupId,
    roster: &Roster,
    readers: &[Root],
    posts: &[Listed<'_>],
    labels: &BTreeMap<[u8; 16], Vec<GroupLabel>>,
) -> Result<Vec<crate::notifications::GroupNews>> {
    use crate::notifications::{
        GroupNews, KIND_GROUP_COMMENT, KIND_GROUP_MENTIONED, KIND_GROUP_TAGGED,
    };
    let mention = ringtome_proto::PublicAnnotation::MENTION_KEY;
    let quiet = [mention, crate::chat::MUTE_KEY, crate::chat::DEPUTY_KEY];
    // When each statement was said and reached this node, the newest saying of it.
    let rows: Vec<StampedLabel> = state
        .node_db
        .fetch_all(
            "SELECT persona, hash, body, claimed_ms, arrived_ms FROM group_lanes
             WHERE group_id = ?1 AND entry_type = ?2 ORDER BY rowid",
            (group.to_vec(), i64::from(entry_type::PUBLIC_ANNOTATION)),
        )
        .await
        .context("reading when a group's labels were said")?;
    let mut said: BTreeMap<LabelAt, Option<(i64, i64)>> = BTreeMap::new();
    for (persona, hash, body, claimed, arrived) in rows {
        let Ok(hash) = <[u8; 32]>::try_from(hash) else { continue };
        if !roster.counted.contains(&hash) {
            continue;
        }
        let Ok(a) = ringtome_proto::PublicAnnotation::decode(&body) else { continue };
        said.insert((persona, a.target_doc, a.key, a.value), claimed.zip(arrived));
    }
    let readers: BTreeMap<String, &Root> = readers.iter().map(|r| (hex::encode(r), r)).collect();
    let mut out: Vec<GroupNews> = Vec::new();
    // A reply to a member's post (the comment row's group twin): stamped by the reply's first
    // version as this node took it, one row per (reader, replier, post) as a comment's is.
    let headers: Vec<StampedHeader> = state
        .node_db
        .fetch_all(
            "SELECT hash, claimed_ms, arrived_ms FROM group_lanes
             WHERE group_id = ?1 AND entry_type = ?2",
            (group.to_vec(), i64::from(entry_type::DOC_HEADER)),
        )
        .await
        .context("reading when a group's posts were said")?;
    let stamped: BTreeMap<Vec<u8>, (i64, i64)> = headers
        .into_iter()
        .filter_map(|(hash, claimed, arrived)| Some((hash, (claimed?, arrived?))))
        .collect();
    let by_doc: BTreeMap<[u8; 16], &Listed<'_>> = posts.iter().map(|p| (p.doc, p)).collect();
    let mut answered: BTreeMap<(String, String, String), (i64, i64)> = BTreeMap::new();
    for reply in posts.iter().filter(|p| !p.hidden) {
        let Some((parent_author, parent_doc)) = reply.first.header.reply_to else { continue };
        let Some(&(claimed, arrived)) = stamped.get(reply.first.hash.as_slice()) else {
            continue;
        };
        let (reader, replier) = (hex::encode(parent_author), hex::encode(reply.first.persona));
        let Some(parent) = by_doc.get(&parent_doc).filter(|p| p.first.persona == parent_author)
        else {
            continue;
        };
        if reader == replier || !readers.get(&reader).is_some_and(|r| sees(roster, r, parent)) {
            continue;
        }
        let e = answered.entry((reader, replier, hex::encode(parent_doc))).or_insert((0, 0));
        *e = (e.0.max(claimed), e.1.max(arrived));
    }
    for ((reader, author, doc), (claimed_ms, arrived_ms)) in answered {
        out.push(GroupNews {
            reader,
            author,
            kind: KIND_GROUP_COMMENT,
            doc,
            detail: None,
            arrived_ms,
            claimed_ms,
        });
    }
    for post in posts {
        let author = hex::encode(post.shown.persona);
        let doc = hex::encode(post.doc);
        // A labeller's labels on this post: their words, and the newest stamps among them.
        let mut tagged: BTreeMap<String, (Vec<String>, Vec<String>, i64, i64)> = BTreeMap::new();
        for l in labels.get(&post.doc).into_iter().flatten() {
            let Some(Some((claimed, arrived))) =
                said.get(&(l.annotator.clone(), post.doc, l.key.clone(), l.value.clone()))
            else {
                continue;
            };
            if l.key == mention {
                let Some(reader) = readers.get(&l.value) else { continue };
                if l.annotator != author || l.value == author || !sees(roster, reader, post) {
                    continue;
                }
                out.push(GroupNews {
                    reader: l.value.clone(),
                    author: author.clone(),
                    kind: KIND_GROUP_MENTIONED,
                    doc: doc.clone(),
                    detail: None,
                    arrived_ms: *arrived,
                    claimed_ms: *claimed,
                });
                continue;
            }
            if quiet.contains(&l.key.as_str())
                || l.annotator == author
                || !readers.contains_key(&author)
            {
                continue;
            }
            let e = tagged.entry(l.annotator.clone()).or_insert((Vec::new(), Vec::new(), 0, 0));
            if l.key == ringtome_proto::PublicAnnotation::TAG_KEY {
                e.0.push(l.value.clone());
            } else {
                e.1.push(format!("{}: {}", l.key, l.value));
            }
            e.2 = e.2.max(*arrived);
            e.3 = e.3.max(*claimed);
        }
        if !readers.get(&author).is_some_and(|r| sees(roster, r, post)) {
            continue;
        }
        for (annotator, (mut tags, rest, arrived, claimed)) in tagged {
            tags.sort_unstable();
            tags.dedup();
            tags.extend(rest);
            out.push(GroupNews {
                reader: author.clone(),
                author: annotator,
                kind: KIND_GROUP_TAGGED,
                doc: doc.clone(),
                detail: Some(tags.join(", ")),
                arrived_ms: arrived,
                claimed_ms: claimed,
            });
        }
    }
    Ok(out)
}

/// The group's rooms into `group_rooms` (plans/GROUP_ROOMS.md), as the group now stands: every
/// room post it lists and no owner hid, with its first version's hash - the topic is derived from
/// it - and when it was first seen closed. Then the group's rows not written swept: a room taken
/// down or hidden is no room any more.
async fn keep_rooms(
    state: &AppState,
    group: &GroupId,
    posts: &[Listed<'_>],
    noted: i64,
) -> Result<()> {
    let db = &state.node_db;
    for post in posts {
        let header = &post.shown.header;
        if header.format != Some(ringtome_proto::registry::doc_format::ROOM) || post.hidden {
            continue;
        }
        let bytes = header.encode().map_err(|e| anyhow!("encoding a room's header: {e}"))?;
        let closed = header.settled.then(now_ms);
        db.execute(
            "INSERT INTO group_rooms (room_author, room_doc, group_id, first_hash, header, closed_ms, noted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (room_author, room_doc) DO UPDATE SET header = excluded.header,
               closed_ms = CASE WHEN excluded.closed_ms IS NULL THEN NULL
                                ELSE COALESCE(closed_ms, excluded.closed_ms) END,
               noted = excluded.noted",
            (
                hex::encode(post.shown.persona),
                hex::encode(post.doc),
                group.to_vec(),
                post.first.hash.to_vec(),
                bytes,
                closed,
                noted,
            ),
        )
        .await
        .context("remembering a group's room")?;
    }
    db.execute(
        "DELETE FROM group_rooms WHERE group_id = ?1 AND noted < ?2",
        (group.to_vec(), noted),
    )
    .await
    .context("sweeping a group's rooms")?;
    Ok(())
}

/// Does this node hold any room of the group?
async fn has_rooms(state: &AppState, group: &GroupId) -> bool {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM group_rooms WHERE group_id = ?1 LIMIT 1",
            (group.to_vec(),),
        )
        .await
        .ok()
        .flatten()
        .is_some()
}

/// A room posted to a group, as this node holds it (plans/GROUP_ROOMS.md).
pub struct GroupRoom {
    pub group: GroupId,
    pub header: DocHeaderPlain,
    /// The hash of the room post's first version: only a node served the group's lanes learns it,
    /// so the room's live topic is derived from it.
    pub first_hash: Hash,
    /// When this node first saw the room closed.
    pub closed_ms: Option<i64>,
}

/// One `group_rooms` row: `(group, first hash, header, closed_ms)`.
type RoomRow = (Vec<u8>, Vec<u8>, Vec<u8>, Option<i64>);

/// The group room `(author, doc)`, if it is one this node holds.
pub async fn room_of(state: &AppState, author: &str, doc_hex: &str) -> Option<GroupRoom> {
    let row: Option<RoomRow> = state
        .node_db
        .fetch_optional(
            "SELECT group_id, first_hash, header, closed_ms FROM group_rooms
             WHERE room_author = ?1 AND room_doc = ?2",
            (author, doc_hex),
        )
        .await
        .ok()
        .flatten();
    let (group, first, header, closed_ms) = row?;
    Some(GroupRoom {
        group: group.try_into().ok()?,
        header: DocHeaderPlain::decode(&header).ok()?,
        first_hash: first.try_into().ok()?,
        closed_ms,
    })
}

/// The author of the group room a chain instance names, if this node holds one.
pub async fn room_author_by_doc(node_db: &crate::db::Db, doc_hex: &str) -> Option<String> {
    node_db
        .fetch_optional::<(String,)>(
            "SELECT room_author FROM group_rooms WHERE room_doc = ?1 LIMIT 1",
            (doc_hex,),
        )
        .await
        .ok()
        .flatten()
        .map(|(a,)| a)
}

/// One group room as the chats column lists it.
pub struct ListedRoom {
    pub group: String,
    pub group_name: String,
    pub author: String,
    pub doc: String,
    pub header: DocHeaderPlain,
    /// The group's standing room, its #general.
    pub standing: bool,
}

/// Every room of every group `root` is in, as this node holds them.
pub async fn rooms_for(state: &AppState, root: &str) -> Result<Vec<ListedRoom>> {
    type Row = (Vec<u8>, String, String, Vec<u8>, String);
    let rows: Vec<Row> = state
        .node_db
        .fetch_all(
            "SELECT r.group_id, r.room_author, r.room_doc, r.header, g.name FROM group_rooms r
             JOIN group_people p ON p.group_id = r.group_id
             JOIN group_rosters g ON g.group_id = r.group_id
             WHERE p.root = ?1 AND p.standing IN ('member', 'owner')",
            (root,),
        )
        .await
        .context("listing a persona's group rooms")?;
    let mut standing: BTreeMap<GroupId, Option<(Root, [u8; 16])>> = BTreeMap::new();
    let mut out = Vec::with_capacity(rows.len());
    for (group, author, doc, header, name) in rows {
        let (Ok(group), Ok(header)) = (GroupId::try_from(group), DocHeaderPlain::decode(&header))
        else {
            continue;
        };
        let room = match standing.get(&group) {
            Some(room) => *room,
            None => {
                let room = folded(state, &group).await.ok().flatten().and_then(|(r, _)| r.room);
                standing.insert(group, room);
                room
            }
        };
        let is_standing =
            room.is_some_and(|(a, d)| hex::encode(a) == author && hex::encode(d) == doc);
        out.push(ListedRoom {
            group: hex::encode(group),
            group_name: name,
            author,
            doc,
            header,
            standing: is_standing,
        });
    }
    Ok(out)
}

/// Is `root` an owner of the group now, as the door last folded it?
pub async fn is_owner(state: &AppState, group: &GroupId, root: &str) -> bool {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM group_people WHERE group_id = ?1 AND root = ?2 AND standing = 'owner'",
            (group.to_vec(), root),
        )
        .await
        .ok()
        .flatten()
        .is_some()
}

/// When `root` stopped being in the group, if they once were and aren't now: the stamp of the
/// newest counted entry that ended it - an owner's removal of them, or their own leave. A group
/// room keeps what they said before it (plans/GROUP_ROOMS.md; Curtis, 2026-10-16: "Removed
/// member's lines stay"), whenever a node first sees those lines. The stamps are the owners' and
/// the leaver's own; a removed member who dates a line before their removal is the owners' to mute.
pub async fn out_since(state: &AppState, group: &GroupId, root: &str) -> Option<i64> {
    let target = root_of(root)?;
    let (roster, lanes) = folded(state, group).await.ok().flatten()?;
    if roster.members.contains(&target) {
        return None;
    }
    let ends: Vec<(Root, Hash)> = lanes
        .iter()
        .flat_map(|l| l.entries.iter().map(move |e| (l.persona, e)))
        .filter(|(_, e)| roster.counted.contains(&e.hash))
        .filter(|(persona, e)| match &e.body {
            GroupEntry::Remove { target: t, .. } => *t == target,
            GroupEntry::Leave { .. } => *persona == target,
            _ => false,
        })
        .map(|(persona, e)| (persona, e.hash))
        .collect();
    let mut newest: Option<i64> = None;
    for (persona, hash) in ends {
        // user-db open: the entry's own stamp, off the lane's persona as held here.
        let Ok(Some(db)) = state.user_dbs.get(&hex::encode(persona)).await else { continue };
        if let Ok(Some(entry)) = crate::record::imaol::entry_by_hash(&db, &hash).await {
            let at = entry.entry().timestamp_ms;
            newest = Some(newest.map_or(at, |n: i64| n.max(at)));
        }
    }
    newest
}

/// Is `(author, doc)` the group's standing room, its #general?
pub async fn is_standing(state: &AppState, group: &GroupId, author: &str, doc: &[u8; 16]) -> bool {
    let Ok(Some((roster, _))) = folded(state, group).await else { return false };
    roster.room.is_some_and(|(a, d)| hex::encode(a) == author && d == *doc)
}

/// The group's owners now, as the door last folded it.
pub async fn owners_of(state: &AppState, group: &GroupId) -> Vec<String> {
    state
        .node_db
        .fetch_all::<(String,)>(
            "SELECT root FROM group_people WHERE group_id = ?1 AND standing = 'owner'",
            (group.to_vec(),),
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(r,)| r)
        .collect()
}

/// The group's members and owners now, as the door last folded it.
pub async fn members_of(state: &AppState, group: &GroupId) -> Vec<String> {
    state
        .node_db
        .fetch_all::<(String,)>(
            "SELECT root FROM group_people WHERE group_id = ?1 AND standing IN ('member', 'owner')",
            (group.to_vec(),),
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(r,)| r)
        .collect()
}

/// The member a dialer speaks for, if any (plans/GROUP_ROOMS.md: a group room's door at the
/// lane): `proven` when this exchange proved it, else what the group's peer ledger and the peer
/// ledger say - the group door's two ways of knowing ([`dialer_may_hold`]), asked of members and
/// owners only, since an invitee is not yet in the room.
pub async fn dialer_member(
    state: &AppState,
    group: &GroupId,
    dialer: &str,
    proven: Option<&str>,
) -> Option<String> {
    let members: BTreeSet<String> = members_of(state, group).await.into_iter().collect();
    if let Some(p) = proven.filter(|p| members.contains(*p)) {
        return Some(p.to_string());
    }
    let told: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT root FROM group_peers WHERE group_id = ?1 AND endpoint_id = ?2",
            (group.to_vec(), dialer),
        )
        .await
        .unwrap_or_default();
    let served =
        crate::net::sync::roots_served_by(&state.node_db, dialer).await.unwrap_or_default();
    told.into_iter().map(|(r,)| r).chain(served).find(|r| members.contains(r))
}

/// Does the dialer speak for `root`, a member - proven by an earlier exchange (the group's peer
/// ledger) or by the peer ledger? A group room's door on the fragment lane: the asker names the
/// persona it asks for, and the door checks both halves.
pub async fn dialer_speaks_for_member(
    state: &AppState,
    group: &GroupId,
    dialer: &str,
    root: &str,
) -> bool {
    if !is_member(state, group, root).await {
        return false;
    }
    let told: Option<(i64,)> = state
        .node_db
        .fetch_optional(
            "SELECT 1 FROM group_peers WHERE group_id = ?1 AND endpoint_id = ?2 AND root = ?3",
            (group.to_vec(), dialer, root),
        )
        .await
        .ok()
        .flatten();
    told.is_some()
        || crate::net::sync::roots_served_by(&state.node_db, dialer)
            .await
            .unwrap_or_default()
            .iter()
            .any(|r| r == root)
}

/// The mutes standing in a group room (plans/GROUP_ROOMS.md; Curtis, 2026-10-16: "Group owners
/// should be mods in every room"): `mute` labels on the room post, on the group's lanes, said by
/// the room's creator or by an owner of the group now. Never the creator or an owner themself.
pub async fn room_mutes(
    state: &AppState,
    group: &GroupId,
    author: &str,
    doc: &[u8; 16],
) -> std::collections::HashSet<String> {
    let Ok(Some((roster, _))) = folded(state, group).await else { return Default::default() };
    let owners: BTreeSet<String> = roster.owners.keys().map(hex::encode).collect();
    let Ok(mut labels) = labels_of(state, group, &roster).await else { return Default::default() };
    labels
        .remove(doc)
        .unwrap_or_default()
        .into_iter()
        .filter(|l| l.key == crate::chat::MUTE_KEY)
        .filter(|l| l.annotator == author || owners.contains(&l.annotator))
        .map(|l| l.value)
        .filter(|v| v != author && !owners.contains(v))
        .collect()
}

/// Say a moderation label on a group room's post, on `me`'s lane for the group, or take it back.
#[allow(clippy::too_many_arguments)]
pub async fn say_room_label(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    author: &str,
    doc: &[u8; 16],
    key: &str,
    value: &str,
    present: bool,
) -> Result<(), AppError> {
    let author = root_of(author).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })?;
    say_label(state, me, data, group, &author, doc, key, value, present).await?;
    crate::fold::fold_now(state, me).await;
    push_soon(state, me, *group);
    Ok(())
}

/// The machines each of `root`'s groups has been heard at, with the group's name: the Network
/// page's "in {group}" links (plans/NETWORK.md). Only groups `root` is in.
pub async fn machines_of_groups(state: &AppState, root: &str) -> Vec<(String, String, String)> {
    state
        .node_db
        .fetch_all::<(Vec<u8>, String, String)>(
            "SELECT DISTINCT p.group_id, r.name, g.endpoint_id FROM group_people p
             JOIN group_rosters r ON r.group_id = p.group_id
             JOIN group_peers g ON g.group_id = p.group_id
             WHERE p.root = ?1 AND p.standing IN ('member', 'owner')",
            (root,),
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|(g, name, ep)| (hex::encode(g), name, ep))
        .collect()
}

/// Where to reach the group's nodes - every member's holds its lanes and its rooms' chains.
pub async fn group_endpoints(state: &AppState, group: &GroupId) -> Vec<String> {
    let names: BTreeSet<String> = members_of(state, group).await.into_iter().collect();
    endpoints(state, group, &names).await
}

/// Bring the group's lanes in soon, for a hosted member: a room line named a picture whose
/// media document rides the speaker's lane, and its bytes come with the group (`fetch_bodies`).
/// At most once every few seconds a group, however many pictures arrive.
pub fn catch_up_soon(state: &AppState, group: GroupId) {
    type Last = std::collections::HashMap<GroupId, i64>;
    static LAST: std::sync::LazyLock<std::sync::Mutex<Last>> =
        std::sync::LazyLock::new(Default::default);
    const EVERY_MS: i64 = 3_000;
    {
        let mut last = LAST.lock().expect("catch-up stamps poisoned");
        let now = now_ms();
        if last.get(&group).is_some_and(|at| now - at < EVERY_MS) {
            return;
        }
        last.insert(group, now);
    }
    let state = state.clone();
    tokio::spawn(async move {
        for root in members_of(&state, &group).await {
            if crate::identity::is_agented(&state.node_db, &root).await.unwrap_or(false) {
                sync_group(&state, &root, &group, &[]).await;
                return;
            }
        }
    });
}

/// A group post's title and date as `reader`'s journal row of it holds them - there for every
/// group post the reader may see (the bell's group rows).
pub async fn journalled_post(
    state: &AppState,
    reader: &str,
    author: &str,
    doc_hex: &str,
    group: &GroupId,
) -> Option<(String, i64)> {
    state
        .node_db
        .fetch_optional(
            "SELECT title, published_ms FROM feed_journal
             WHERE reader_root = ?1 AND author_root = ?2 AND doc_id = ?3 AND group_id = ?4",
            (reader, author, doc_hex, group.to_vec()),
        )
        .await
        .ok()
        .flatten()
}

/// The names of these groups, by hex id, as this node last folded them: a group post's card says
/// which group (the journal keeps the id, so a rename rewrites no rows).
pub async fn group_names(
    state: &AppState,
    ids: &BTreeSet<String>,
) -> Result<std::collections::HashMap<String, String>> {
    let mut out = std::collections::HashMap::new();
    for id in ids {
        let Ok(raw) = hex::decode(id) else { continue };
        let row: Option<(String,)> = state
            .node_db
            .fetch_optional("SELECT name FROM group_rosters WHERE group_id = ?1", (raw,))
            .await
            .context("reading a group's name")?;
        if let Some((name,)) = row {
            out.insert(id.clone(), name);
        }
    }
    Ok(out)
}

/// The words of a group post, as the search index reads a post (search.rs `body_facts`): its
/// newest version's file hash and format, off its author's lane - or None when it's no group post
/// held here.
pub async fn group_post_body(
    state: &AppState,
    author: &str,
    doc: &[u8; 16],
) -> Option<([u8; 32], Option<u64>)> {
    let rows: Vec<(Vec<u8>,)> = state
        .node_db
        .fetch_all(
            "SELECT body FROM group_lanes WHERE persona = ?1 AND entry_type = ?2 ORDER BY seq DESC",
            (author, i64::from(entry_type::DOC_HEADER)),
        )
        .await
        .ok()?;
    rows.into_iter()
        .filter_map(|(body,)| DocHeaderPlain::decode(&body).ok())
        .find(|h| h.doc_id == *doc)
        .map(|h| (h.file_hash, h.format))
}

/// Is `(author, doc)` a group post this node holds - in a hosted member's journal, or posted by
/// one of this node's own personas? A public road refuses one (plans/GROUPS.md, section 7): a
/// public tag on it, or a tag taken back, names the post on the tagger's public chain.
pub async fn holds_group_post(state: &AppState, author: &str, doc: &[u8; 16]) -> Result<bool> {
    let journalled: Vec<(i64,)> = state
        .node_db
        .fetch_all(
            "SELECT 1 FROM feed_journal
             WHERE author_root = ?1 AND doc_id = ?2 AND group_id <> x'' LIMIT 1",
            (author, hex::encode(doc)),
        )
        .await
        .context("looking for a group post")?;
    if !journalled.is_empty() {
        return Ok(true);
    }
    let drafted: Vec<(i64,)> = state
        .node_db
        .fetch_all(
            "SELECT 1 FROM group_drafts WHERE root = ?1 AND post = ?2 LIMIT 1",
            (author, doc.to_vec()),
        )
        .await
        .context("looking for a group post")?;
    Ok(!drafted.is_empty())
}

/// GET `/api/identity/{root}/group-posts/{author}/{doc}` - the group this persona sees a post in,
/// `{group, name}`, or 404 when it sees it in none: how a caller holding only a post's address
/// finds its group's door (the agent's `label` tool, mcp/write.rs).
async fn post_group_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, author, doc)): Path<(String, String, String)>,
) -> Answer {
    me_of(&state, &session, &root).await?;
    let rows: Vec<(Vec<u8>, String)> = state
        .node_db
        .fetch_all(
            "SELECT j.group_id, r.name FROM feed_journal j
             JOIN group_rosters r ON r.group_id = j.group_id
             WHERE j.reader_root = ?1 AND j.author_root = ?2 AND j.doc_id = ?3
               AND j.group_id <> x'' LIMIT 1",
            (root.as_str(), author.as_str(), doc.as_str()),
        )
        .await
        .context("finding a post's group")
        .map_err(AppError::Internal)?;
    let (group, name) = rows.into_iter().next().ok_or_else(|| {
        AppError::NotFound(crate::msg!("roster.no-such-post", "no such post in this group"))
    })?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "name": name })))
}

// ---------------------------------------------------------------------------------------------
// The door

/// Is `root` in the group now, as the door last folded it: a member or an owner, not merely
/// invited. What the label memo asks before showing a group post's labels (annotations.rs).
pub async fn is_member(state: &AppState, group: &GroupId, root: &str) -> bool {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM group_people
             WHERE group_id = ?1 AND root = ?2 AND standing IN ('member', 'owner')",
            (group.to_vec(), root),
        )
        .await
        .ok()
        .flatten()
        .is_some()
}

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
pub(crate) async fn remember_peer(state: &AppState, group: &[u8; 16], endpoint: &str, root: &str) {
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
                GroupEntry::Invite { invitee, founding, .. } => {
                    out.insert(hex::encode(founding.founder));
                    Some(*invitee)
                }
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

// ---------------------------------------------------------------------------------------------
// Gossip (plans/NETWORK.md, "Group gossip")

/// Partners a gossip pass picks by reliability.
const RELIABLE_PARTNERS: usize = 2;
/// And the check-in slot: the machine least lately tried, so none is left out for good.
const CHECK_INS: usize = 1;

/// One machine a gossip pass might ask, as the machine table knows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub endpoint: String,
    pub reliability: f64,
    pub last_ok_ms: Option<i64>,
    pub last_tried_ms: Option<i64>,
    /// Not answering lately, and not to be asked again yet (the dark book).
    pub dark: bool,
}

/// This pass's partners (ruling 4): the `best` most reliable that aren't dark, ties to the most
/// lately answered; then `check_ins` more from everyone else, the least lately tried first - the
/// never tried before all - so a shut laptop or a new member is asked in its turn. A dark machine
/// is a check-in only when nothing else is left, since the dial refuses it unasked. With no more
/// candidates than slots, every one.
pub fn pick_partners(mut candidates: Vec<Candidate>, best: usize, check_ins: usize) -> Vec<String> {
    if candidates.len() <= best + check_ins {
        return candidates.into_iter().map(|c| c.endpoint).collect();
    }
    candidates.sort_by(|a, b| {
        a.dark
            .cmp(&b.dark)
            .then(b.reliability.total_cmp(&a.reliability))
            .then(b.last_ok_ms.cmp(&a.last_ok_ms))
            .then(a.endpoint.cmp(&b.endpoint))
    });
    let mut picked: Vec<String> = Vec::new();
    let mut rest: Vec<Candidate> = Vec::new();
    for c in candidates {
        if picked.len() < best && !c.dark {
            picked.push(c.endpoint);
        } else {
            rest.push(c);
        }
    }
    let want = best + check_ins - picked.len();
    rest.sort_by(|a, b| {
        a.dark
            .cmp(&b.dark)
            .then(a.last_tried_ms.cmp(&b.last_tried_ms))
            .then(a.endpoint.cmp(&b.endpoint))
    });
    picked.extend(rest.into_iter().take(want).map(|c| c.endpoint));
    picked
}

/// The machines a gossip pass may ask (ruling 4's candidates): current members' machines. A
/// machine qualifies when the group's peer ledger proved a current member there, or when it is
/// where a current member is served and the ledger names nobody else there. A removed member's
/// node is the one this leaves out: the ledger names only them at it, and every member's node
/// holds every member's lanes, so "serves a member" alone would let it back in. Never this node.
async fn gossip_candidates(state: &AppState, group: &GroupId) -> Vec<Candidate> {
    let members: BTreeSet<String> = members_of(state, group).await.into_iter().collect();
    let told: Vec<(String, String)> = state
        .node_db
        .fetch_all(
            "SELECT endpoint_id, root FROM group_peers WHERE group_id = ?1 AND root != ''",
            (group.to_vec(),),
        )
        .await
        .unwrap_or_default();
    let mut out = Vec::new();
    for ep in endpoints(state, group, &members).await {
        let named: Vec<&String> = told.iter().filter(|(e, _)| *e == ep).map(|(_, r)| r).collect();
        let a_member_here = named.iter().any(|r| members.contains(*r));
        let only_others = !named.is_empty() && !a_member_here;
        if only_others {
            continue;
        }
        if !a_member_here {
            let mut served = false;
            for m in &members {
                if crate::net::sync::peers_for(&state.node_db, m)
                    .await
                    .unwrap_or_default()
                    .contains(&ep)
                {
                    served = true;
                    break;
                }
            }
            if !served {
                continue;
            }
        }
        let m = crate::machines::machine(&ep);
        out.push(Candidate {
            reliability: m.as_ref().map_or(0.5, |m| m.reliability()),
            last_ok_ms: m.as_ref().and_then(|m| m.last_ok_ms),
            last_tried_ms: m.as_ref().and_then(|m| m.last_tried_ms()),
            dark: crate::net::p2p::dark_left(&ep).is_some(),
            endpoint: ep,
        });
    }
    out
}

/// A pass's candidates, by endpoint, and the partners it picks from them.
pub async fn gossip_partners(state: &AppState, group: &GroupId) -> (Vec<String>, Vec<String>) {
    let candidates = gossip_candidates(state, group).await;
    let all = candidates.iter().map(|c| c.endpoint.clone()).collect();
    (all, pick_partners(candidates, RELIABLE_PARTNERS, CHECK_INS))
}

// ---------------------------------------------------------------------------------------------
// The group digest (plans/NETWORK.md): one question for the heads of every lane, so a pass
// exchanges only for the lanes that differ - and nothing, when none do.

/// The heads this node holds of a group's lanes: its public lanes, and its members-only ones too
/// when `members`.
pub async fn group_heads(
    state: &AppState,
    group: &GroupId,
    members: bool,
) -> Vec<ringtome_proto::fragment::GroupHead> {
    let services: &[u32] =
        if members { &[service::GROUP, service::GROUP_PUBLIC] } else { &[service::GROUP_PUBLIC] };
    crate::net::frontier::instance_heads(&state.node_db, group, services)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(persona, author, service, head, hash)| {
            Some(ringtome_proto::fragment::GroupHead {
                persona: root_of(&persona)?,
                author: crate::pubkey::decode(&author)?,
                service,
                head,
                hash: hash[..8].try_into().ok()?,
            })
        })
        .collect()
}

/// The fragment lane's answer to `WantGroupHeads`, through the group's door: a dialer serving one
/// of its people is told about both kinds of lane when it asks for them; anyone else, about a
/// public group's public lanes alone, and nothing of a private group. `same` when the asker's
/// fingerprint is ours over what it may see.
pub async fn answer_heads(
    state: &AppState,
    dialer: &str,
    group: GroupId,
    members: bool,
    fingerprint: [u8; 32],
) -> (bool, bool, Vec<ringtome_proto::fragment::GroupHead>) {
    let Ok(Some((roster, _))) = folded(state, &group).await else { return (false, false, vec![]) };
    let member_door = !dialer_may_hold(state, &[group], dialer, None).await.is_empty();
    let granted = members && member_door;
    if !granted && !roster.public {
        return (false, false, Vec::new());
    }
    let heads = group_heads(state, &group, granted).await;
    let same = granted == members
        && ringtome_proto::fragment::group_heads_fingerprint(&heads) == fingerprint;
    (same, granted, if same { Vec::new() } else { heads })
}

/// Who, of the personas these heads and ours name, holds a lane the two sides don't agree on:
/// ahead, behind, or held on one side only. Their exchanges are the ones worth making.
pub fn differing(
    ours: &[ringtome_proto::fragment::GroupHead],
    theirs: &[ringtome_proto::fragment::GroupHead],
) -> BTreeSet<Root> {
    let key = |h: &ringtome_proto::fragment::GroupHead| (h.author, h.service);
    let mine: BTreeMap<_, _> = ours.iter().map(|h| (key(h), h)).collect();
    let yours: BTreeMap<_, _> = theirs.iter().map(|h| (key(h), h)).collect();
    let mut out = BTreeSet::new();
    for (k, h) in &yours {
        match mine.get(k) {
            Some(m) if m.head == h.head && m.hash == h.hash => {}
            _ => {
                out.insert(h.persona);
            }
        }
    }
    for (k, m) in &mine {
        if !yours.contains_key(k) {
            out.insert(m.persona);
        }
    }
    out
}

/// The personas a pass asks a partner about: everyone the lanes here name, and anyone the partner's
/// digest names that they don't - a newcomer whose lane only the partner holds yet.
fn with_news(names: &[String], worth: Option<&BTreeSet<String>>) -> Vec<String> {
    let mut out = names.to_vec();
    for w in worth.into_iter().flatten() {
        if !out.contains(w) {
            out.push(w.clone());
        }
    }
    out
}

/// What a partner's digest says to exchange: `None` when it couldn't say (an older node, or no
/// answer) - exchange for everyone, as before the digest - else the personas whose lanes differ,
/// empty when everything agrees.
async fn worth_exchanging(
    state: &AppState,
    group: &GroupId,
    endpoint: &str,
    members: bool,
) -> Option<BTreeSet<String>> {
    let ours = group_heads(state, group, members).await;
    let fp = ringtome_proto::fragment::group_heads_fingerprint(&ours);
    let (same, granted, theirs) =
        crate::net::fragment::fetch_group_heads(state, endpoint, group, members, fp).await.ok()?;
    if same {
        return Some(BTreeSet::new());
    }
    // Told about fewer lanes than we hold: compare like with like.
    let ours = if granted == members { ours } else { group_heads(state, group, granted).await };
    Some(differing(&ours, &theirs).into_iter().map(hex::encode).collect())
}

/// Has this group been heard at `endpoint` before? A machine met for the first time is exchanged
/// with twice for `me`, as [`sync_group`] says why.
async fn heard_at(state: &AppState, group: &GroupId, endpoint: &str) -> bool {
    state
        .node_db
        .fetch_optional::<(i64,)>(
            "SELECT 1 FROM group_peers WHERE group_id = ?1 AND endpoint_id = ?2 LIMIT 1",
            (group.to_vec(), endpoint),
        )
        .await
        .ok()
        .flatten()
        .is_some()
}

/// One gossip pass for `me` in a group: a few partners, and with each one exchange per persona
/// the group's lanes name, `me` first. Each exchange runs both ways, so this node's news goes out
/// and the partner's comes in; any member's node holds every lane, so any partner will do, and
/// news reaches the whole group in about log₃(n) passes.
pub async fn gossip_group(state: &AppState, me: &str, group: &GroupId) -> usize {
    let mut names: Vec<String> =
        named(&lanes_of(state, group).await.unwrap_or_default()).into_iter().collect();
    names.retain(|n| n != me);
    names.insert(0, me.to_string());
    let (_, partners) = gossip_partners(state, group).await;
    let mut exchanged = 0;
    for ep in &partners {
        let first = !heard_at(state, group, ep).await;
        // The digest first (plans/NETWORK.md): only the personas whose lanes the two sides
        // disagree on are worth an exchange - none, on a quiet pass. A machine met for the first
        // time is exchanged with in full, `me` twice, so it learns this node speaks for `me`.
        let worth = if first { None } else { worth_exchanging(state, group, ep, true).await };
        for who in &with_news(&names, worth.as_ref()) {
            if worth.as_ref().is_some_and(|w| !w.contains(who)) {
                continue;
            }
            let times = if first && who == me { 2 } else { 1 };
            for _ in 0..times {
                if exchange(state, who, ep, group).await {
                    exchanged += 1;
                }
            }
        }
    }
    for who in &names {
        crate::fold::fold_now(state, who).await;
    }
    fetch_bodies(state, group, &names.iter().cloned().collect()).await;
    exchanged
}

/// After a write: a gossip pass for that group within a few seconds, debounced per group, so news
/// leaves at once and the minute beat only catches what a push missed (ruling 4's push). On the
/// test rig only when a suite asks (`RINGTOME_TEST_GROUP_PUSH_MS`): a claim about what a node has
/// or hasn't heard can't have a push deciding it halfway through, as with the beat.
fn push_soon(state: &AppState, me: &str, group: GroupId) {
    let delay_ms: u64 = if state.config.local_test {
        match std::env::var("RINGTOME_TEST_GROUP_PUSH_MS").ok().and_then(|v| v.parse().ok()) {
            Some(ms) => ms,
            None => return,
        }
    } else {
        3_000
    };
    type Due = std::collections::HashMap<GroupId, bool>;
    static WAITING: std::sync::LazyLock<std::sync::Mutex<Due>> =
        std::sync::LazyLock::new(Default::default);
    {
        let Ok(mut waiting) = WAITING.lock() else { return };
        if waiting.insert(group, true).is_some() {
            return; // one already waits, and it will carry this write too
        }
    }
    let state = state.clone();
    let me = me.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        if let Ok(mut waiting) = WAITING.lock() {
            waiting.remove(&group);
        }
        gossip_group(&state, &me, &group).await;
    });
}

/// The group-sync beat (lib.rs): every group each persona hosted here is in, owns or is
/// invited to, brought up to date by gossip (plans/NETWORK.md) - the floor under the push
/// after a write and the sync a person asks for, as the room beat is chat's.
pub async fn sync_pass(state: AppState) -> Result<()> {
    let rows: Vec<(Vec<u8>, String)> = state
        .node_db
        .fetch_all("SELECT group_id, root FROM group_people ORDER BY group_id, root", ())
        .await
        .context("listing the groups to keep in step")?;
    for (group, root) in rows {
        let Ok(group) = <[u8; 16]>::try_from(group.as_slice()) else { continue };
        if crate::identity::is_agented(&state.node_db, &root).await.unwrap_or(false) {
            gossip_group(&state, &root, &group).await;
            // Refolded whether or not anything arrived: it writes nothing unless the lanes, or
            // who is hosted here, moved since - and a node that gained the tables in an upgrade
            // (node rung 91 marks every group) fills them here.
            refold(&state, &group).await?;
        }
    }
    public_pass(&state).await?;
    Ok(())
}

/// The public groups this node holds but isn't in, kept in step for whoever here they reach
/// (plans/PUBLIC_GROUPS.md, slice 3): a member's rebroadcast-follower. Their public lanes come
/// from the group's machines - a stranger's node is served those and never a members-only one -
/// so the roster, the claims and the carry stay current with no member here.
async fn public_pass(state: &AppState) -> Result<()> {
    let groups: Vec<(Vec<u8>,)> = state
        .node_db
        .fetch_all("SELECT group_id FROM group_rosters WHERE public = 1", ())
        .await
        .context("listing the public groups held here")?;
    for (g,) in groups {
        let Ok(group) = <[u8; 16]>::try_from(g.as_slice()) else { continue };
        let Some((roster, _)) = folded(state, &group).await? else { continue };
        let hosted_member = {
            let mut any = false;
            for m in &roster.members {
                if crate::identity::is_agented(&state.node_db, &hex::encode(m))
                    .await
                    .unwrap_or(false)
                {
                    any = true;
                    break;
                }
            }
            any
        };
        let carry = carry_readers(state, &roster).await;
        if carry.is_empty() {
            continue; // nobody here wants it carried
        }
        // Paced, outside the group: what it carries is a rebroadcast's kind of news, which nobody
        // waits on by the minute - unless whom it's carried for changed since the last pass.
        if !hosted_member && !public_pass_due(&group, &carry, state.config.local_test, now_ms()) {
            continue;
        }
        // A member here keeps the lanes by gossip; otherwise they come from the group's machines.
        if !hosted_member {
            public_sync(state, &group, &[]).await;
        }
        let Some((roster, _)) = refold(state, &group).await? else { continue };
        // The derivation carried what moved. Again only while some post the group counts isn't
        // here yet: asked of its author and not there, it's asked again now - a share's retry
        // would journal it to the author's rebroadcast-followers, not the ones it was carried for.
        let claims: Vec<(String, [u8; 16])> =
            roster.public_posts.keys().map(|(a, d)| (hex::encode(a), *d)).collect();
        if crate::idface::group_shelf(state, &claims).await.len() < claims.len() {
            recarry(state, &group, &roster, &carry_readers(state, &roster).await, next_noted())
                .await?;
        }
    }
    Ok(())
}

/// How often a public group this node isn't in is brought up to date for the readers it carries
/// for (plans/PUBLIC_GROUPS.md).
const PUBLIC_EVERY_MS: i64 = 10 * 60 * 1000;

/// Is a public group's pass due: its time come round, or whom it carries for changed since its last
/// - so a new follower doesn't wait out the pace. Always on the test rig, where the beat decides.
fn public_pass_due(group: &GroupId, carry: &Carry, local_test: bool, now: i64) -> bool {
    type Last = std::collections::HashMap<GroupId, (i64, Carry)>;
    static LAST: std::sync::LazyLock<std::sync::Mutex<Last>> =
        std::sync::LazyLock::new(Default::default);
    let Ok(mut last) = LAST.lock() else { return true };
    let due = local_test
        || match last.get(group) {
            Some((at, readers)) => now - at >= PUBLIC_EVERY_MS || readers != carry,
            None => true,
        };
    if due {
        last.insert(*group, (now, carry.clone()));
    }
    due
}

/// Bring a public group's public lanes in, as a node outside it: one exchange per persona its
/// lanes name, from a few of its machines - the gossip pass's partners - each served only the
/// public lanes, since this node proves no member.
pub async fn public_sync(state: &AppState, group: &GroupId, seed: &[String]) -> usize {
    let mut names: BTreeSet<String> = named(&lanes_of(state, group).await.unwrap_or_default());
    names.extend(seed.iter().cloned());
    let names: Vec<String> = names.into_iter().collect();
    let (_, mut partners) = gossip_partners(state, group).await;
    if partners.is_empty() {
        // Nothing folded here yet, so no member to judge a machine by: wherever the group was
        // said to be (a follow's `via`), and wherever the names given are served.
        let named: BTreeSet<String> = names.iter().cloned().collect();
        partners = endpoints(state, group, &named).await;
        partners.truncate(RELIABLE_PARTNERS + CHECK_INS);
    }
    if partners.is_empty() {
        // Nothing in the group's ledger here yet - a node that only follows a member. Their
        // machines, as a follow finds them: each key of theirs resolved through its serving
        // record, which must name them.
        for m in members_of(state, group).await.iter().take(8) {
            for leaf in crate::idface::stored_tree_leaves(state, m).await {
                let ep = crate::idface::leaf_via_to_endpoint(state, m, &leaf).await;
                if !partners.contains(&ep) && ep != state.endpoint.id().to_string() {
                    partners.push(ep);
                }
            }
            if partners.len() >= RELIABLE_PARTNERS + CHECK_INS {
                break;
            }
        }
    }
    let mut exchanged = 0;
    for ep in &partners {
        // The digest, over the public lanes: only what differs (plans/NETWORK.md).
        let worth = worth_exchanging(state, group, ep, false).await;
        for who in &with_news(&names, worth.as_ref()) {
            if worth.as_ref().is_some_and(|w| !w.contains(who)) {
                continue;
            }
            if exchange(state, who, ep, group).await {
                exchanged += 1;
            }
        }
    }
    for who in &names {
        crate::fold::fold_now(state, who).await;
    }
    exchanged
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
    Ok(*write_signed(state, data, me, group, entry).await?.hash())
}

/// [`write`] on a lane the caller names (see [`write_signed_on`]).
async fn write_on(
    state: &AppState,
    data: &Store,
    me: &str,
    group: GroupId,
    entry: GroupEntry,
    lane: Option<u32>,
) -> Result<Hash, AppError> {
    Ok(*write_signed_on(state, data, me, group, entry, lane).await?.hash())
}

/// Is this group public (plans/PUBLIC_GROUPS.md)? Its founding says, as this node holds it.
async fn is_public(state: &AppState, group: &GroupId) -> bool {
    matches!(folded(state, group).await, Ok(Some((roster, _))) if roster.public)
}

/// Which of a member device's two lanes an entry goes on, in a public group: the roster's acts and
/// the settings on the public lane, where anyone may read them; content - posts, labels, pins and
/// hides - on the members-only lane. A private group has only the one.
fn lane_service(entry: &GroupEntry, public: bool) -> u32 {
    if !public {
        return service::GROUP;
    }
    match entry {
        GroupEntry::Document { .. }
        | GroupEntry::Label { .. }
        | GroupEntry::MemberPin { .. }
        | GroupEntry::Hide { .. }
        | GroupEntry::Pin { .. } => service::GROUP,
        _ => service::GROUP_PUBLIC,
    }
}

/// Before `me` writes content to a public group's members-only lane from this device: the lane's
/// own join, so the fold counts what follows (plans/PUBLIC_GROUPS.md - each lane joins on its
/// own). The founder's cites the founding; anyone else's their counted join on a public lane.
async fn join_content_lane(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
) -> Result<(), AppError> {
    let Ok(Some((roster, lanes))) = folded(state, group).await else { return Ok(()) };
    if !roster.public {
        return Ok(());
    }
    let device = data.signer().verifying_key().to_bytes();
    if lanes.iter().any(|l| l.device == device) {
        return Ok(()); // this device's members-only lane has begun
    }
    let me_root = root_of(me).unwrap_or_default();
    let grant = if roster.founder == me_root {
        Grant::Founder
    } else {
        let join = lanes
            .iter()
            .filter(|l| l.persona == me_root)
            .flat_map(|l| l.entries.iter())
            .find(|e| matches!(e.body, GroupEntry::Join { .. }) && roster.counted.contains(&e.hash))
            .map(|e| e.hash)
            .ok_or_else(|| {
                AppError::Forbidden(crate::msg!(
                    "roster.members-only",
                    "only the group's members can post to it"
                ))
            })?;
        Grant::Device(join)
    };
    let payload = GroupEntry::Join { grant }
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding a lane's join: {e}")))?;
    crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        service::GROUP,
        Some(*group),
        entry_type::GROUP_ENTRY,
        Payload::Inline(payload),
    )
    .await?;
    crate::fold::fold_now(state, me).await;
    Ok(())
}

/// [`write`], answering the entry itself - an invite's is the evidence its notice carries.
async fn write_signed(
    state: &AppState,
    data: &Store,
    me: &str,
    group: GroupId,
    entry: GroupEntry,
) -> Result<ringtome_proto::SignedEntry, AppError> {
    write_signed_on(state, data, me, group, entry, None).await
}

/// [`write_signed`] on a lane the caller names, where the entry's kind alone can't say: an
/// owner's hide of a public post as the group goes on the public lane.
async fn write_signed_on(
    state: &AppState,
    data: &Store,
    me: &str,
    group: GroupId,
    entry: GroupEntry,
    lane: Option<u32>,
) -> Result<ringtome_proto::SignedEntry, AppError> {
    let payload = entry.encode().map_err(|e| {
        AppError::BadRequest(crate::msg!(
            "roster.not-a-group-entry",
            "that isn't a group entry: {why}",
            why = e
        ))
    })?;
    let public = match &entry {
        GroupEntry::Found(f) => f.public,
        _ => is_public(state, &group).await,
    };
    let lane = lane.unwrap_or_else(|| lane_service(&entry, public));
    if lane == service::GROUP && public {
        join_content_lane(state, data, me, &group).await?;
    }
    let signed = crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        lane,
        Some(group),
        entry_type::GROUP_ENTRY,
        Payload::Inline(payload),
    )
    .await?;
    crate::fold::fold_now(state, me).await;
    push_soon(state, me, group);
    Ok(signed)
}

/// The roster as this node holds it, folded now (nothing written; the fold kept by its stamp) -
/// for `me` only when the group's door opens to them (ruling 3: members see the roster). A node
/// holds a group for whichever of its personas is in it; the others on it see nothing, as they
/// would anywhere else.
async fn current(state: &AppState, group: &GroupId, me: &Root) -> Result<Folded, AppError> {
    let missing =
        || AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"));
    let (roster, lanes) =
        folded(state, group).await.map_err(AppError::Internal)?.ok_or_else(missing)?;
    let mine =
        roster.members.contains(me) || roster.invited.contains(me) || roster.banned.contains(me);
    if !mine {
        return Err(missing());
    }
    Ok((roster, lanes))
}

/// The group's founding statement, off the founder's lane as held.
fn founding_of(lanes: &[Lane]) -> Option<ringtome_proto::roster::Founding> {
    lanes.iter().flat_map(|l| l.entries.iter()).find_map(|e| match &e.body {
        GroupEntry::Found(f) => Some(f.clone()),
        _ => None,
    })
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

/// The removals that count, as `(entry hash, target, ban)`.
fn removals_of(roster: &Roster, lanes: &[Lane]) -> Vec<(Hash, Root, bool)> {
    lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| roster.counted.contains(&e.hash))
        .filter_map(|e| match &e.body {
            GroupEntry::Remove { target, ban, .. } => Some((e.hash, *target, *ban)),
            _ => None,
        })
        .collect()
}

fn roster_json(group: &GroupId, roster: &Roster, lanes: &[Lane], me: &Root) -> serde_json::Value {
    let list = |s: &BTreeSet<Root>| s.iter().map(hex::encode).collect::<Vec<_>>();
    // Removed and not back (Curtis, 2026-10-16: the roster lists them, so an owner can find them
    // again): not in the group, not banned (they're listed as banned), not invited back yet.
    let removed: BTreeSet<Root> = removals_of(roster, lanes)
        .into_iter()
        .map(|(_, target, _)| target)
        .filter(|t| {
            !roster.members.contains(t) && !roster.banned.contains(t) && !roster.invited.contains(t)
        })
        .collect();
    serde_json::json!({
        "group": hex::encode(group),
        "name": roster.name,
        "description": roster.description,
        // Public or private, at founding and for good (plans/PUBLIC_GROUPS.md).
        "public": roster.public,
        "picture": roster.picture.map(|d| face_url(group, &d)),
        "banner": roster.banner.map(|d| face_url(group, &d)),
        // The standing room, #general (plans/GROUP_ROOMS.md).
        "room": roster.room.map(|(author, doc)| serde_json::json!({
            "author": hex::encode(author),
            "doc_id": hex::encode(doc),
        })),
        "join_mode": match roster.join_mode { JoinMode::InviteOnly => "invite-only", JoinMode::Open => "open" },
        "founder": hex::encode(roster.founder),
        "members": roster.members.iter().map(|m| serde_json::json!({
            "root": hex::encode(m),
            "owner": roster.owners.contains_key(m),
        })).collect::<Vec<_>>(),
        "invited": list(&roster.invited),
        "banned": list(&roster.banned),
        "removed": list(&removed),
        "you": {
            "member": roster.members.contains(me),
            "owner": roster.owners.contains_key(me),
        },
    })
}

// ---------------------------------------------------------------------------------------------
// Routes

pub fn router(upload_limit: usize) -> Router<AppState> {
    let upload = || axum::extract::DefaultBodyLimit::max(upload_limit);
    Router::new()
        .route("/api/identity/{root}/groups", get(list_handler).post(found_handler))
        .route("/api/identity/{root}/group-posts/{author}/{doc}", get(post_group_handler))
        .route("/api/identity/{root}/groups/{group}", get(roster_handler))
        .route("/api/identity/{root}/groups/{group}/sync", post(sync_handler))
        .route("/api/identity/{root}/groups/{group}/invites", post(invite_handler))
        .route("/api/identity/{root}/groups/{group}/join", post(join_handler))
        .route("/api/identity/{root}/groups/{group}/open", post(open_handler))
        .route("/api/identity/{root}/groups/{group}/leave", post(leave_handler))
        .route("/api/identity/{root}/groups/{group}/remove", post(remove_handler))
        .route("/api/identity/{root}/groups/{group}/unban", post(unban_handler))
        .route("/api/identity/{root}/groups/{group}/demote", post(demote_handler))
        .route("/api/identity/{root}/groups/{group}/appoint", post(appoint_handler))
        .route("/api/identity/{root}/groups/{group}/settings", post(settings_handler))
        .route("/api/identity/{root}/groups/{group}/general", post(general_handler))
        .route(
            "/api/identity/{root}/groups/{group}/face/{which}",
            post(set_face_handler).delete(clear_face_handler).layer(upload()),
        )
        .route("/api/identity/{root}/groups/{group}/posts", get(posts_handler))
        .route("/api/identity/{root}/groups/{group}/posts/{doc}/replies", get(replies_handler))
        .route("/api/identity/{root}/groups/{group}/publish", post(publish_handler))
        .route(
            "/api/identity/{root}/groups/{group}/follow",
            get(follow_state_handler).post(follow_handler).delete(unfollow_handler),
        )
        .route(
            "/api/identity/{root}/groups/{group}/publish/drawing",
            post(publish_drawing_handler).layer(upload()),
        )
        .route("/api/identity/{root}/docs/{doc_id}/groups", get(draft_groups_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/retract", post(retract_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/close", post(close_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/hide", post(hide_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/pin", post(pin_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/labels", post(label_handler))
        // A group's pictures and bodies, at one address for every member - the embed in a
        // post's words can't name the reader - so the door is the session: any persona on it
        // the group counts.
        .route("/api/groups/{group}/docs/{doc}/body", get(group_body_route))
        .route("/api/groups/{group}/docs/{doc}/body/{name}", get(group_body_named_route))
        .route("/api/groups/{group}/docs/{doc}/thumb", get(group_thumb_route))
        // A group's face - its name, picture, banner and description - to anyone who asks
        // (Curtis, 2026-10-16: an invitee needs to know them, and a public group shows them):
        // no session, and only the face as it stands.
        .route("/api/groups/{group}/face", get(face_handler))
        .route("/api/groups/{group}/public", get(public_page_handler))
        .route("/api/groups/{group}/posts", get(public_feed_handler))
        .route("/api/groups/{group}/labels", get(public_labels_handler))
        .route("/api/id/{seg}/groups", get(persona_public_groups_handler))
        .route("/api/groups/{group}/face/{doc}", get(face_bytes_route))
        .route("/api/groups/{group}/face/{doc}/thumb", get(face_thumb_route))
}

type Answer = Result<Json<serde_json::Value>, AppError>;

/// Where a group's page is in the app (js/apps/groups.js).
pub fn group_route(group_hex: &str) -> String {
    format!("/ringtome/people/groups/{group_hex}")
}

/// The group invites this persona's bell holds, as `(group, inviter, name)`: the notice road's
/// half of an invite (plans/GROUPS.md, section 5), before it's opened.
async fn invites_received(data: &Store) -> Result<Vec<(String, String, String)>, AppError> {
    Ok(data
        .inbox()
        .page(u32::MAX)
        .await?
        .into_iter()
        .filter(|n| n.kind == crate::notifications::KIND_GROUP_INVITE)
        .filter_map(|n| Some((n.doc_id?, n.sender_root, n.detail.unwrap_or_default())))
        .collect())
}

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
    /// A public group (plans/PUBLIC_GROUPS.md): its roster public, and its members may post
    /// as the group. Chosen now and never changed.
    #[serde(default)]
    public: bool,
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
    let founding =
        Founding::sign(&ed25519_dalek::SigningKey::from_bytes(&seed), me, name, req.public);
    let group = founding.id();
    write(&state, &data, &root, group, GroupEntry::Found(founding)).await?;
    // Its standing room, from the start (Curtis, 2026-10-16: "when a group is created a default
    // #general is founded").
    open_general(&state, &data, &root, group, &me).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// What the standing room is called.
const GENERAL: &str = "general";

/// Open the group's standing room as `me`, an owner: a room post on their lane for the group,
/// named in the group's settings (plans/GROUP_ROOMS.md).
async fn open_general(
    state: &AppState,
    data: &Store,
    root: &str,
    group: GroupId,
    me: &Root,
) -> Result<[u8; 16], AppError> {
    let held = state.files.put_public(b"").await.map_err(AppError::Internal)?;
    let doc_id = crate::record::documents::new_doc_id();
    let header = DocHeaderPlain {
        doc_id,
        parents: Vec::new(),
        file_hash: *held.hash.as_bytes(),
        body_hash: *held.hash.as_bytes(),
        title: GENERAL.to_string(),
        sealed_title: None,
        format: Some(ringtome_proto::registry::doc_format::ROOM),
        width: None,
        height: None,
        duration_ms: None,
        thumb_hash: None,
        preview_hash: None,
        refs: Vec::new(),
        genesis_ms: Some(now_ms()),
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
        .map_err(|e| AppError::Internal(anyhow!("encoding a standing room's header: {e}")))?;
    append_document(state, data, root, &group, entry_type::DOC_HEADER, payload).await?;
    drop(held);
    set_setting(state, data, root, group, me, Setting::Room(Some((*me, doc_id)))).await?;
    Ok(doc_id)
}

/// POST `.../groups/{group}/general` - an owner opens the standing room of a group founded before
/// every group had one, or of one whose room is gone (taken down, or hidden).
async fn general_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, _) = current(&state, &group, &me).await?;
    acting(&roster, &me)?;
    if let Some((author, doc)) = roster.room {
        if room_of(&state, &hex::encode(author), &hex::encode(doc)).await.is_some() {
            return Err(AppError::BadRequest(crate::msg!(
                "roster.the-group-has-its-room",
                "the group already has its #general"
            )));
        }
    }
    open_general(&state, &data, &root, group, &me).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// GET `/api/identity/{root}/groups` - the groups this persona is in, or invited to - an invite
/// still unopened among them, as the bell has it: standing `invite`, its name the founding's
/// and its inviter who sent it.
async fn list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Answer {
    let (data, _) = me_of(&state, &session, &root).await?;
    let rows: Vec<(Vec<u8>, String, String, i64)> = state
        .node_db
        .fetch_all(
            "SELECT p.group_id, r.name, p.standing, r.public FROM group_people p
             JOIN group_rosters r ON r.group_id = p.group_id
             WHERE p.root = ?1 ORDER BY r.name",
            (root.as_str(),),
        )
        .await
        .context("listing a persona's groups")
        .map_err(AppError::Internal)?;
    let mut out: Vec<serde_json::Value> = rows
        .iter()
        .map(|(g, name, standing, public)| {
            serde_json::json!({
                "group": hex::encode(g),
                "name": name,
                "standing": standing,
                // Public or private (plans/PUBLIC_GROUPS.md): a public one is also a place to post
                // in public as.
                "public": *public != 0,
            })
        })
        .collect();
    // The drafts posted in each, so the composer's stack leaves them out as it does a draft posted
    // in public, whose `published_as` says so. A takedown drops its row, and the draft comes back.
    let posted: Vec<(Vec<u8>, Vec<u8>)> = state
        .node_db
        .fetch_all("SELECT group_id, source FROM group_drafts WHERE root = ?1", (root.as_str(),))
        .await
        .context("listing the drafts a persona posted in groups")
        .map_err(AppError::Internal)?;
    for row in &mut out {
        let drafts: Vec<String> = posted
            .iter()
            .filter(|(g, _)| row["group"].as_str() == Some(hex::encode(g).as_str()))
            .map(|(_, source)| hex::encode(source))
            .collect();
        row["drafts"] = serde_json::json!(drafts);
    }
    // Each group's picture, off its fold (kept in RAM by its stamp).
    for row in &mut out {
        let Some(group) = row["group"].as_str().and_then(|g| group_of(g).ok()) else { continue };
        if let Ok(Some((roster, _))) = folded(&state, &group).await {
            row["picture"] = serde_json::json!(roster.picture.map(|d| face_url(&group, &d)));
        }
    }
    let held: BTreeSet<String> = rows.iter().map(|(g, _, _, _)| hex::encode(g)).collect();
    for (group, inviter, name) in invites_received(&data).await? {
        if !held.contains(&group) {
            out.push(serde_json::json!({
                "group": group,
                "name": name,
                "standing": "invite",
                "inviter": inviter,
            }));
        }
    }
    Ok(Json(serde_json::json!(out)))
}

/// POST `.../groups/{group}/open` - open an invite the bell holds: fetch the group from the node
/// that delivered it, starting with the inviter's lane, whose invite names the founder. The
/// group's door lets an invitee in, so they see whom they'd be joining before they do.
async fn open_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let group_hex = hex::encode(group);
    let inviters: Vec<String> = invites_received(&data)
        .await?
        .into_iter()
        .filter(|(g, _, _)| *g == group_hex)
        .map(|(_, inviter, _)| inviter)
        .collect();
    if inviters.is_empty() && current(&state, &group, &me).await.is_err() {
        return Err(AppError::NotFound(crate::msg!(
            "roster.no-such-invite",
            "there's no invite to that group here"
        )));
    }
    sync_group(&state, &root, &group, &inviters).await;
    let (roster, lanes) = current(&state, &group, &me).await.map_err(|_| {
        AppError::NotFound(crate::msg!(
            "roster.the-group-cant-be-reached",
            "the group can't be reached just now - try again in a little while"
        ))
    })?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
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
    let founding = founding_of(&lanes).ok_or_else(|| {
        AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"))
    })?;
    let signed = write_signed(
        &state,
        &data,
        &root,
        group,
        GroupEntry::Invite { by, invitee, readmits, founding },
    )
    .await?;
    let invite = *signed.hash();
    // The invite's own road to the invitee (plans/GROUPS.md, section 5): a notice, the invite as
    // its evidence, knocked eagerly. Their node has never heard of the group; this is how it
    // learns, and where to look is the node that knocked.
    crate::outbox::queue_notices(
        &state,
        &data,
        &root,
        vec![(hex::encode(invitee), signed)],
        ringtome_proto::deliver::notice_kind::GROUP_INVITE,
    )
    .await;
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

/// What joining needs. All of it is optional for an invite this node already holds (one the
/// bell's notice opened): the invite is then found on the inviter's lane.
#[derive(Deserialize, Default)]
#[serde(default)]
struct JoinRequest {
    invite: Option<String>,
    founder: Option<String>,
    inviter: Option<String>,
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
    let invite = match &req.invite {
        Some(invite) => hash_of(invite)?,
        None => held_invite(&state, &group, &me).await?,
    };
    for ep in req.via.iter().take(8) {
        remember_peer(&state, &group, ep, "").await;
    }
    let seed: Vec<String> = [req.founder, req.inviter].into_iter().flatten().collect();
    // The join goes on the lane the group's kind says (plans/PUBLIC_GROUPS.md): a public group's
    // on the public lane. Not held yet, the group is fetched first, so its founding says which.
    if !matches!(folded(&state, &group).await, Ok(Some(_))) {
        sync_group(&state, &root, &group, &seed).await;
    }
    let imaol_entry = GroupEntry::Join { grant: Grant::Invite(invite) };
    let lane = lane_service(&imaol_entry, is_public(&state, &group).await);
    let payload = imaol_entry.encode().map_err(|e| AppError::Internal(anyhow!("{e}")))?;
    crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        lane,
        Some(group),
        entry_type::GROUP_ENTRY,
        Payload::Inline(payload),
    )
    .await?;
    crate::fold::fold_now(&state, &root).await;
    sync_group(&state, &root, &group, &seed).await;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// An invite to `me` this node holds that the roster counts and no join has used.
async fn held_invite(state: &AppState, group: &GroupId, me: &Root) -> Result<Hash, AppError> {
    let none = || {
        AppError::NotFound(crate::msg!(
            "roster.no-such-invite",
            "there's no invite to that group here"
        ))
    };
    let (roster, lanes) =
        refold(state, group).await.map_err(AppError::Internal)?.ok_or_else(none)?;
    if !roster.invited.contains(me) {
        return Err(none());
    }
    // A join that used an invite spent it (section 3), so a rejoin needs a fresh one.
    let spent: BTreeSet<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter_map(|e| match &e.body {
            GroupEntry::Join { grant: Grant::Invite(h) } => Some(*h),
            _ => None,
        })
        .collect();
    lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .rfind(|e| {
            roster.counted.contains(&e.hash)
                && !spent.contains(&e.hash)
                && matches!(&e.body, GroupEntry::Invite { invitee, .. } if invitee == me)
        })
        .map(|e| e.hash)
        .ok_or_else(none)
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
    // Every lane but the one the leave goes on, which the leave itself ends: in a public group,
    // the public lane, so the members-only lane is among those anchored (plans/PUBLIC_GROUPS.md).
    let leave_lane = lane_device(
        lane_service(&GroupEntry::Leave { anchors: vec![] }, roster.public),
        &data.signer().verifying_key().to_bytes(),
    );
    let others: Vec<LaneAnchor> = ours.iter().filter(|a| a.device != leave_lane).copied().collect();
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

/// POST `.../groups/{group}/unban` - an owner lifts a ban: every ban on `target` that still
/// stands. They are then removed, not banned, and an invite brings them back (it readmits the
/// removal, as any invite back does).
async fn unban_handler(
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
    let lifted: BTreeSet<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| roster.counted.contains(&e.hash))
        .filter_map(|e| match &e.body {
            GroupEntry::Unban { ban, .. } => Some(*ban),
            _ => None,
        })
        .collect();
    let bans: Vec<Hash> = removals_of(&roster, &lanes)
        .into_iter()
        .filter(|(h, t, ban)| *ban && *t == target && !lifted.contains(h))
        .map(|(h, _, _)| h)
        .collect();
    if bans.is_empty() {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.not-banned",
            "they aren't banned from this group"
        )));
    }
    for ban in bans {
        write(&state, &data, &root, group, GroupEntry::Unban { by, ban }).await?;
    }
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

/// The group's id type, for books.rs.
pub type GroupIdOf = GroupId;

/// The post a persona's own document became in a group, if it's still standing (books.rs).
pub async fn group_post_of(
    state: &AppState,
    root: &str,
    source: &[u8; 16],
    group: &GroupId,
) -> Option<[u8; 16]> {
    let post = published_as(state, root, source, group).await?;
    let (roster, _) = folded(state, group).await.ok()??;
    let (versions, gone) = documents_of(state, group, &roster).await.ok()?;
    (versions.contains_key(&post) && !gone.contains(&post)).then_some(post)
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
    join_content_lane(state, data, me, group).await?;
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
    push_soon(state, me, *group);
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
    media_in(state, data, me, group, source, None).await
}

/// One of the persona's own pictures, films or sounds said in a group room (plans/GROUP_ROOMS.md):
/// a group media document as a post's are, marked part of the room (`part_of`), so the group's
/// page never lists it as a post. Minted once per picture per room's group.
pub async fn room_media(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    room: &[u8; 16],
    source: &[u8; 16],
) -> Result<([u8; 16], crate::record::documents::Format, bool), AppError> {
    media_in(state, data, me, group, source, Some(*room)).await
}

/// The address a room line's group media document is embedded by.
pub fn room_media_target(
    group: &GroupId,
    doc: &[u8; 16],
    format: crate::record::documents::Format,
    animation: bool,
) -> String {
    media_target(group, doc, format, animation)
}

async fn media_in(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    source: &[u8; 16],
    part_of: Option<[u8; 16]>,
) -> Result<([u8; 16], crate::record::documents::Format, bool), AppError> {
    use crate::record::documents::Format;
    // What a picture became in the group's rooms is remembered apart from what it became in its
    // posts: a post's picture is a post's, a room's is the room's.
    let remembered: [u8; 16] = match part_of {
        None => *source,
        Some(_) => {
            let mut h = blake3::Hasher::new();
            h.update(b"ringtome-room-media/");
            h.update(source);
            h.finalize().as_bytes()[..16].try_into().expect("sixteen bytes")
        }
    };
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
    if let Some(minted) = published_as(state, me, &remembered, group).await {
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
    let doc_id = mint_media(
        state,
        data,
        me,
        group,
        Minted {
            body: &body,
            thumb: thumb.as_deref(),
            title: &head.header.title,
            format: head.header.format,
            width: head.header.width,
            height: head.header.height,
            duration_ms: head.header.duration_ms,
            animation: head.header.animation,
            part_of,
        },
    )
    .await?;
    remember_published(state, me, &remembered, group, &doc_id).await?;
    Ok((doc_id, format, head.header.animation))
}

/// A picture's bytes and what its header says of them, for [`mint_media`].
struct Minted<'a> {
    body: &'a [u8],
    thumb: Option<&'a [u8]>,
    title: &'a str,
    format: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
    duration_ms: Option<u64>,
    animation: bool,
    /// The room a line's picture is part of (`room_media`).
    part_of: Option<[u8; 16]>,
}

/// A media document on `me`'s lane for the group: its plaintext bytes and thumbnail in the blob
/// store, its header on the lane - the public twin's shape, minus the public chain.
async fn mint_media(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    m: Minted<'_>,
) -> Result<[u8; 16], AppError> {
    // HELD (`files::Put`) until the header naming them is on the lane.
    let held_body = state.files.put_public(m.body).await.map_err(AppError::Internal)?;
    let held_thumb = match m.thumb {
        Some(t) => Some(state.files.put_public(t).await.map_err(AppError::Internal)?),
        None => None,
    };
    let doc_id = crate::record::documents::new_doc_id();
    let header = DocHeaderPlain {
        doc_id,
        parents: Vec::new(),
        file_hash: *held_body.hash.as_bytes(),
        body_hash: *held_body.hash.as_bytes(),
        title: m.title.to_string(),
        sealed_title: None,
        format: m.format,
        width: m.width,
        height: m.height,
        duration_ms: m.duration_ms,
        thumb_hash: held_thumb.as_ref().map(|t| *t.hash.as_bytes()),
        preview_hash: None,
        refs: Vec::new(),
        genesis_ms: Some(now_ms()),
        reply_to: None,
        thread_root: None,
        settled: false,
        trusted_only: false,
        dated_ms: None,
        animation: m.animation,
        im: false,
        part_of: m.part_of,
        seal_of: None,
        onward: false,
        prints: Default::default(),
    };
    let payload = header
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding a group media header: {e}")))?;
    append_document(state, data, me, group, entry_type::DOC_HEADER, payload).await?;
    drop((held_body, held_thumb));
    Ok(doc_id)
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
    wishes: Wishes,
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
    // What the pictures are, for the post's implicit tags.
    let mut carried: Vec<(Option<u64>, bool)> = Vec::new();
    if format == Format::Marquee {
        let mut swaps: Vec<(String, String)> = Vec::new();
        for found in crate::record::bake::media_refs(&words, me) {
            match found {
                MediaRef::PrivateDoc { target, doc_id } => {
                    let (media, fmt, animation) =
                        group_media(state, data, me, group, &doc_id).await?;
                    carried.push((fmt.to_wire(), animation));
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
    post_version(
        state,
        data,
        me,
        group,
        draft,
        Body { title, format, words, refs, carried },
        wishes,
    )
    .await
}

/// What a group post's version says: its words, already embedding the group's media documents,
/// and what those are, for the post's implicit tags.
struct Body {
    title: String,
    format: crate::record::documents::Format,
    words: String,
    refs: Vec<[u8; 16]>,
    carried: Vec<(Option<u64>, bool)>,
}

/// Post `body` as `draft`'s version in the group: a new post, or an edit of the one the draft
/// already became. The draft's labels go with it, as publishing restates them on the public chain.
async fn post_version(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    draft: &[u8; 16],
    body: Body,
    wishes: Wishes,
) -> Result<[u8; 16], AppError> {
    let Body { title, format, words, refs, carried } = body;
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
    // Once a room, always a room (CHAT.md, ruling 1), as the public publish carries it.
    let room = wishes.room
        || onto
            .as_ref()
            .and_then(|(_, list)| first_version(list))
            .is_some_and(|v| v.header.format == Some(ringtome_proto::registry::doc_format::ROOM));
    // A reply's link (section 7), as the public publish keeps it: named at the first publish and
    // carried by every edit, so an edit never moves a reply to another post.
    let part_of = match &onto {
        Some((_, list)) => first_version(list).and_then(|v| v.header.part_of),
        None => wishes.part_of,
    };
    let (reply_to, thread_root) = match onto {
        Some((_, list)) => first_version(list)
            .map(|v| (v.header.reply_to, v.header.thread_root))
            .unwrap_or_default(),
        None => match wishes.reply_to {
            Some(parent) => {
                let root = reply_link(&roster, &versions, &gone, &me_root, parent)?;
                (Some(parent), Some(root))
            }
            None => (None, None),
        },
    };
    if room && reply_to.is_some() {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.a-reply-isnt-a-room",
            "a reply can't be a room"
        )));
    }
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
        format: if room {
            Some(ringtome_proto::registry::doc_format::ROOM)
        } else {
            format.to_wire()
        },
        width: None,
        height: None,
        duration_ms: None,
        thumb_hash: None,
        preview_hash: None,
        refs,
        genesis_ms: Some(genesis_ms),
        reply_to,
        thread_root,
        settled: wishes.settled,
        trusted_only: false,
        dated_ms: wishes.dated_ms,
        animation: false,
        im: false,
        part_of,
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
    // The post's labels (section 7): the draft's own, as publishing restates them on the public
    // chain, and what it carries - its pictures' kinds, its length - on this lane.
    let (mut desired, word_count) =
        crate::identity::routes::draft_labels(data, &me_root, draft).await?;
    for tag in crate::record::documents::implicit_tags_of(carried.into_iter()) {
        desired.insert(("tag".into(), tag.into()));
    }
    if let Some(length) = word_count.and_then(crate::record::documents::length_tag) {
        desired.insert(("tag".into(), length.into()));
    }
    restate_labels(state, data, me, group, &me_root, &doc_id, &desired).await?;
    Ok(doc_id)
}

// ---------------------------------------------------------------------------------------------
// Labels: tags, descriptions, mentions on a group post (section 7)

/// One label as it stands: who said it, and `key = value`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupLabel {
    pub annotator: String,
    pub key: String,
    pub value: String,
}

/// Every label standing on the group's posts, by post. A statement counts while its annotator
/// is a member at that point of their lane (the roster's `counted`), the last one said about a
/// (who, post, key, value) wins in the order this node received them - as public labels are
/// settled - and the public rules then apply: an author's reaction to their own post falls, and
/// anyone else stands two tags to a person (`annotations::labels_that_stand`).
async fn labels_of(
    state: &AppState,
    group: &GroupId,
    roster: &Roster,
) -> Result<BTreeMap<[u8; 16], Vec<GroupLabel>>, AppError> {
    let rows: Vec<(String, Vec<u8>, Vec<u8>)> = state
        .node_db
        .fetch_all(
            "SELECT persona, hash, body FROM group_lanes WHERE group_id = ?1 AND entry_type = ?2
             ORDER BY rowid",
            (group.to_vec(), i64::from(entry_type::PUBLIC_ANNOTATION)),
        )
        .await
        .context("reading a group's labels")
        .map_err(AppError::Internal)?;
    let mut said: BTreeMap<(String, String, [u8; 16], String, String), bool> = BTreeMap::new();
    for (persona, hash, body) in rows {
        let Ok(hash) = <[u8; 32]>::try_from(hash) else { continue };
        if !roster.counted.contains(&hash) {
            continue;
        }
        let Ok(a) = ringtome_proto::PublicAnnotation::decode(&body) else { continue };
        said.insert(
            (persona, hex::encode(a.target_author), a.target_doc, a.key, a.value),
            a.present,
        );
    }
    let standing: Vec<crate::annotations::Statement> = said
        .into_iter()
        .filter(|(_, present)| *present)
        .map(|((annotator, target_author, doc, key, value), _)| crate::annotations::Statement {
            annotator,
            target_author,
            target_doc: hex::encode(doc),
            key,
            value,
        })
        .collect();
    let mut out: BTreeMap<[u8; 16], Vec<GroupLabel>> = BTreeMap::new();
    for st in crate::annotations::labels_that_stand(standing) {
        let Ok(doc) = doc_of(&st.target_doc) else { continue };
        out.entry(doc).or_default().push(GroupLabel {
            annotator: st.annotator,
            key: st.key,
            value: st.value,
        });
    }
    Ok(out)
}

/// Say one label on the lane, or take it back: on the members-only lane, joined first in a
/// public group.
#[allow(clippy::too_many_arguments)]
async fn say_label(
    state: &AppState,
    me: &str,
    data: &Store,
    group: &GroupId,
    target_author: &Root,
    doc: &[u8; 16],
    key: &str,
    value: &str,
    present: bool,
) -> Result<(), AppError> {
    let payload = ringtome_proto::PublicAnnotation {
        target_author: *target_author,
        target_doc: *doc,
        key: key.to_string(),
        value: value.to_string(),
        present,
    }
    .encode()
    .map_err(|e| {
        AppError::BadRequest(crate::msg!(
            "roster.not-a-label",
            "that label can't be said: {why}",
            why = e
        ))
    })?;
    join_content_lane(state, data, me, group).await?;
    crate::record::imaol::append_on(
        data.db(),
        data.signer(),
        service::GROUP,
        Some(*group),
        entry_type::PUBLIC_ANNOTATION,
        Payload::Inline(payload),
    )
    .await?;
    Ok(())
}

/// Bring `me`'s labels on a post to `desired`: say what's missing, take back what's gone - the
/// public restatement's diff (identity/routes.rs `restate_labels`), on this lane.
async fn restate_labels(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    author: &Root,
    doc: &[u8; 16],
    desired: &BTreeSet<(String, String)>,
) -> Result<(), AppError> {
    crate::fold::fold_now(state, me).await;
    let (roster, _) = refold(state, group).await.map_err(AppError::Internal)?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"))
    })?;
    let mine: BTreeSet<(String, String)> = labels_of(state, group, &roster)
        .await?
        .remove(doc)
        .unwrap_or_default()
        .into_iter()
        .filter(|l| l.annotator == me)
        .map(|l| (l.key, l.value))
        .collect();
    for (k, v) in desired.difference(&mine) {
        say_label(state, me, data, group, author, doc, k, v, true).await?;
    }
    for (k, v) in mine.difference(desired) {
        say_label(state, me, data, group, author, doc, k, v, false).await?;
    }
    crate::fold::fold_now(state, me).await;
    Ok(())
}

/// The thread a reply to `parent` joins, its root: the parent's own root, or the parent when it is
/// one. Refused unless the parent is a post in the group that the replier may see, takes replies,
/// and isn't a room - the public publish's `resolve_reply_link`, read off the group's lanes.
fn reply_link(
    roster: &Roster,
    versions: &BTreeMap<[u8; 16], Vec<Version>>,
    gone: &BTreeSet<[u8; 16]>,
    me: &Root,
    (author, doc): (Root, [u8; 16]),
) -> Result<(Root, [u8; 16]), AppError> {
    let list = versions.get(&doc).filter(|_| !gone.contains(&doc));
    let first = list.and_then(|l| first_version(l)).filter(|v| v.persona == author);
    let shown = list.and_then(|l| display(l));
    let (Some(first), Some(shown)) = (first, shown) else {
        return Err(AppError::NotFound(crate::msg!(
            "roster.no-such-post-to-answer",
            "that post isn't in this group"
        )));
    };
    let hidden_from_me =
        roster.hidden.contains(&first.hash) && author != *me && !roster.owners.contains_key(me);
    if hidden_from_me || shown.header.part_of.is_some() {
        return Err(AppError::NotFound(crate::msg!(
            "roster.no-such-post-to-answer",
            "that post isn't in this group"
        )));
    }
    if shown.header.settled {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.comments-are-off",
            "its author turned off comments for this post"
        )));
    }
    if shown.header.format == Some(ringtome_proto::registry::doc_format::ROOM) {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.a-room-takes-no-replies",
            "a room takes no replies - its talk is inside it"
        )));
    }
    Ok(first.header.thread_root.unwrap_or((author, doc)))
}

/// What a group post's header carries from its publish, as any post's does: the author's claimed
/// date, comments off, and what it answers.
#[derive(Clone, Copy, Debug, Default)]
pub struct Wishes {
    pub dated_ms: Option<i64>,
    pub settled: bool,
    /// A room (plans/GROUP_ROOMS.md): the post is the room, and its talk is said inside it.
    pub room: bool,
    /// The post this answers, `(author, doc)`, when it's a reply (section 7): another post in the
    /// group. Read at the first publish only - an edit keeps the link it was posted with.
    pub reply_to: Option<(Root, [u8; 16])>,
    /// The book a page is part of (books.rs, a book in a group): kept off the group's page, read
    /// in the book. Read at the first publish only, as the reply's link is.
    pub part_of: Option<[u8; 16]>,
}

#[derive(Deserialize)]
struct PublishRequest {
    doc: String,
    #[serde(default)]
    settled: bool,
    #[serde(default)]
    tz_offset_min: i32,
    /// A room for the group (plans/GROUP_ROOMS.md), as the public publish's `room`.
    #[serde(default)]
    room: bool,
    /// A reply to another post in the group, as the public publish's `reply_to`.
    #[serde(default)]
    reply_to: Option<ReplyTo>,
}

#[derive(Deserialize)]
struct ReplyTo {
    author: String,
    doc_id: String,
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
    let draft = doc_of(&req.doc)?;
    // Before the post, as the public door does (made_with.rs): an agent's post says so.
    crate::made_with::mark(&session, &data, &draft).await?;
    let reply_to = match &req.reply_to {
        Some(r) => Some((
            root_of(&r.author).ok_or_else(|| {
                AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
            })?,
            doc_of(&r.doc_id)?,
        )),
        None => None,
    };
    // The preferred date and what it makes of the post, by the rulings every road shares
    // (crate::publication): now, or a plan on the draft naming the group and this device, which
    // the publish-due sweep mints (scheduled.rs), or a refusal.
    let claimed = crate::publication::claimed(&data, &draft, req.tz_offset_min).await?;
    let shape = crate::publication::Shape {
        answers: reply_to.is_some(),
        room: req.room,
        live: live_date(&state, &root, &group, &draft).await?,
    };
    let (dated_ms, date_kept) = match crate::publication::when(claimed, shape, now_ms())? {
        crate::publication::When::Now { dated_ms, kept } => (dated_ms, kept),
        crate::publication::When::Later(at) => {
            let plan = crate::publication::Plan {
                at,
                by: data.leaf_hex(),
                settled: req.settled,
                group: Some(hex::encode(group)),
                ..Default::default()
            };
            crate::publication::schedule(&data, &draft, &plan).await?;
            return Ok(Json(
                serde_json::json!({ "group": hex::encode(group), "scheduled_for": at }),
            ));
        }
    };
    let post = publish(
        &state,
        &data,
        &root,
        &group,
        &draft,
        Wishes { dated_ms, settled: req.settled, room: req.room, reply_to, part_of: None },
    )
    .await?;
    crate::publication::posted(&data, &draft).await?;
    Ok(Json(serde_json::json!({
        "group": hex::encode(group),
        "post": hex::encode(post),
        "date_kept": date_kept,
    })))
}

/// The post `draft` already is in the group, standing, and the date it carries
/// (crate::publication's `Shape::live`): `Some(dated)` for an edit, `None` for a new post.
async fn live_date(
    state: &AppState,
    me: &str,
    group: &GroupId,
    draft: &[u8; 16],
) -> Result<Option<Option<i64>>, AppError> {
    let Some(post) = published_as(state, me, draft, group).await else { return Ok(None) };
    let Some((roster, _)) = refold(state, group).await.map_err(AppError::Internal)? else {
        return Ok(None);
    };
    let (versions, gone) = documents_of(state, group, &roster).await?;
    if gone.contains(&post) {
        return Ok(None);
    }
    Ok(versions.get(&post).and_then(|list| display(list)).map(|v| v.header.dated_ms))
}

#[derive(Deserialize, Default)]
struct DrawingPublish {
    doc: String,
    #[serde(default)]
    settled: bool,
    #[serde(default)]
    tz_offset_min: i32,
}

/// POST `.../groups/{group}/publish/drawing?doc=&settled=&tz_offset_min=` - publish a drawing to
/// the group as a picture, as the public drawing door does (identity/routes.rs): the body is the
/// page's flattened picture, laundered, minted as the group's media document, and posted as the
/// drawing's version with words that are that picture. Publishing again is an edit, with a new
/// picture. A drawing takes no schedule, here or in public.
async fn publish_drawing_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    axum::extract::Query(req): axum::extract::Query<DrawingPublish>,
    picture: axum::body::Bytes,
) -> Answer {
    use crate::record::documents::Format;
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, _) = current(&state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-only",
            "only the group's members can post to it"
        )));
    }
    let draft = doc_of(&req.doc)?;
    let live = live_date(&state, &root, &group, &draft).await?;
    let crate::identity::routes::DrawingDraft { title, dated_ms, date_kept, .. } =
        crate::identity::routes::drawing_draft(&session, &data, &draft, req.tz_offset_min, live)
            .await?;
    let ingested = crate::identity::routes::launder_drawing(picture).await?;
    let media = mint_media(
        &state,
        &data,
        &root,
        &group,
        Minted {
            body: &ingested.body,
            thumb: ingested.thumb_avif.as_deref(),
            title: &title,
            format: Format::Avif.to_wire(),
            width: ingested.width,
            height: ingested.height,
            duration_ms: None,
            animation: false,
            part_of: None,
        },
    )
    .await?;
    let words = crate::identity::routes::drawing_words(
        &title,
        &media_target(&group, &media, Format::Avif, false),
    );
    let body = Body {
        title,
        format: Format::Marquee,
        words,
        refs: vec![media],
        carried: vec![(Format::Avif.to_wire(), false)],
    };
    let wishes = Wishes { dated_ms, settled: req.settled, ..Default::default() };
    let post = post_version(&state, &data, &root, &group, &draft, body, wishes).await?;
    Ok(Json(serde_json::json!({
        "group": hex::encode(group),
        "post": hex::encode(post),
        "date_kept": date_kept,
    })))
}

/// The publish-due sweep's road to a group (scheduled.rs): post the draft its plan names, if
/// its author is still a member. A refusal now is one later too, so it spends the plan, saying why
/// on the draft (plans/ONE_PUBLISH.md, ruling 3).
pub async fn publish_planned(
    state: &AppState,
    data: &Store,
    me: &str,
    group_hex: &str,
    draft: &[u8; 16],
    wishes: Wishes,
) -> Result<[u8; 16], AppError> {
    let group = group_of(group_hex)?;
    let me_root = root_of(me).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })?;
    let posted = match current(state, &group, &me_root).await {
        Ok((roster, _)) if roster.members.contains(&me_root) => {
            publish(state, data, me, &group, draft, wishes).await
        }
        _ => Err(AppError::Forbidden(crate::msg!(
            "roster.members-only",
            "only the group's members can post to it"
        ))),
    };
    crate::publication::settle(data, draft, &posted).await?;
    posted
}

/// Take down `me`'s own document in a group: a retraction on the lane, and its draft a draft again.
/// A book goes with its pages (books.rs), which are part of it.
pub async fn retract_doc(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    doc: &[u8; 16],
) -> Result<(), AppError> {
    let me_root = root_of(me).unwrap_or_default();
    let mut gone_with: Vec<[u8; 16]> = Vec::new();
    if let Ok(Some((roster, _))) = folded(state, group).await {
        let (versions, gone) = documents_of(state, group, &roster).await?;
        for (d, list) in &versions {
            if gone.contains(d) || d == doc {
                continue;
            }
            if first_version(list)
                .is_some_and(|v| v.persona == me_root && v.header.part_of == Some(*doc))
            {
                gone_with.push(*d);
            }
        }
    }
    for d in std::iter::once(*doc).chain(gone_with) {
        append_document(
            state,
            data,
            me,
            group,
            entry_type::POST_RETRACT,
            PostRetraction { doc_id: d }.encode(),
        )
        .await?;
        // Its draft is a draft again: publishing it now makes a new post (Writer's bar reads this).
        state
            .node_db
            .execute(
                "DELETE FROM group_drafts WHERE root = ?1 AND group_id = ?2 AND post = ?3",
                (me, group.to_vec(), d.to_vec()),
            )
            .await
            .context("forgetting a taken-down post's draft")
            .map_err(AppError::Internal)?;
    }
    Ok(())
}

/// Before a book (or anything) goes into a group for its members: `root` is in it.
pub async fn may_post_in(
    state: &AppState,
    root: &str,
    group_hex: &str,
) -> Result<GroupId, AppError> {
    let group = group_of(group_hex)?;
    let me = root_of(root).ok_or_else(|| {
        AppError::BadRequest(crate::msg!("roster.not-a-persona", "that isn't a persona"))
    })?;
    let (roster, _) = current(state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-only",
            "only the group's members can post to it"
        )));
    }
    Ok(group)
}

/// A group document's words as this node holds them - its shown version's body - for a book's
/// payload read back (books.rs).
pub async fn group_doc_body(state: &AppState, group: &GroupId, doc: &[u8; 16]) -> Option<String> {
    let (roster, _) = folded(state, group).await.ok()??;
    let (versions, gone) = documents_of(state, group, &roster).await.ok()?;
    if gone.contains(doc) {
        return None;
    }
    let shown = versions.get(doc).and_then(|l| display(l))?;
    let bytes = crate::idface::public_blob(state, shown.header.file_hash).await.ok()??;
    String::from_utf8(bytes).ok()
}

/// A book's own version in a group (books.rs): its payload as its words, at the id the notebook
/// keeps for it - a new version of it when `me` posted it before and it stands, else its first.
#[allow(clippy::too_many_arguments)]
pub async fn publish_book_doc(
    state: &AppState,
    data: &Store,
    me: &str,
    group: &GroupId,
    book: [u8; 16],
    title: &str,
    payload: &str,
    wishes: Wishes,
) -> Result<(), AppError> {
    let (roster, _) = refold(state, group).await.map_err(AppError::Internal)?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"))
    })?;
    let me_root = root_of(me).unwrap_or_default();
    let (versions, gone) = documents_of(state, group, &roster).await?;
    let standing = versions
        .get(&book)
        .filter(|_| !gone.contains(&book))
        .filter(|list| list.first().is_some_and(|v| v.persona == me_root));
    let (parents, genesis_ms) = match standing {
        Some(list) => (
            display(list).map(|v| vec![v.hash]).unwrap_or_default(),
            first_version(list).and_then(|v| v.header.genesis_ms).unwrap_or_else(now_ms),
        ),
        None => (Vec::new(), now_ms()),
    };
    let held = state.files.put_public(payload.as_bytes()).await.map_err(AppError::Internal)?;
    let header = DocHeaderPlain {
        doc_id: book,
        parents,
        file_hash: *held.hash.as_bytes(),
        body_hash: *held.hash.as_bytes(),
        title: title.to_string(),
        sealed_title: None,
        format: crate::record::documents::Format::Book.to_wire(),
        width: None,
        height: None,
        duration_ms: None,
        thumb_hash: None,
        preview_hash: None,
        refs: Vec::new(),
        genesis_ms: Some(genesis_ms),
        reply_to: None,
        thread_root: None,
        settled: wishes.settled,
        trusted_only: false,
        dated_ms: wishes.dated_ms,
        animation: false,
        im: false,
        part_of: None,
        seal_of: None,
        onward: false,
        prints: Default::default(),
    };
    let encoded = header
        .encode()
        .map_err(|e| AppError::Internal(anyhow!("encoding a group book's header: {e}")))?;
    append_document(state, data, me, group, entry_type::DOC_HEADER, encoded).await?;
    drop(held);
    Ok(())
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
    if roster.room == Some((me, doc)) {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.general-stays",
            "the group's #general can't be taken down"
        )));
    }
    retract_doc(&state, &data, &root, &group, &doc).await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "retracted": hex::encode(doc) })))
}

/// POST `.../groups/{group}/docs/{doc}/close` - close a room of your own in the group for good
/// (CHAT.md, ruling 10): its draft published again, settled, as a public room is closed. The node
/// finds the draft - the post's link to it is `group_drafts`, never a field on the draft - so the
/// app needn't. The group's #general stays open: it is the group's, and has no draft.
async fn close_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, doc)): Path<(String, String, String)>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let doc = doc_of(&doc)?;
    let (roster, _) = current(&state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-only",
            "only the group's members can post to it"
        )));
    }
    if roster.room == Some((me, doc)) {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.general-stays-open",
            "the group's #general stays open"
        )));
    }
    let (versions, gone) = documents_of(&state, &group, &roster).await?;
    let shown = versions
        .get(&doc)
        .filter(|_| !gone.contains(&doc))
        .and_then(|l| l.first().filter(|v| v.persona == me).and(display(l)))
        .ok_or_else(|| {
            AppError::NotFound(crate::msg!(
                "roster.not-a-room-of-yours",
                "that isn't a room of yours in this group"
            ))
        })?;
    if shown.header.format != Some(ringtome_proto::registry::doc_format::ROOM) {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.not-a-room",
            "that post isn't a room"
        )));
    }
    if shown.header.settled {
        return Ok(Json(serde_json::json!({ "group": hex::encode(group), "closed": true })));
    }
    let dated_ms = shown.header.dated_ms;
    let draft: Option<(Vec<u8>,)> = state
        .node_db
        .fetch_optional(
            "SELECT source FROM group_drafts WHERE root = ?1 AND group_id = ?2 AND post = ?3",
            (root.as_str(), group.to_vec(), doc.to_vec()),
        )
        .await
        .context("finding a group room's draft")
        .map_err(AppError::Internal)?;
    let draft: [u8; 16] = draft.and_then(|(d,)| d.try_into().ok()).ok_or_else(|| {
        AppError::NotFound(crate::msg!(
            "roster.the-rooms-draft-is-gone",
            "this room's draft isn't on this computer"
        ))
    })?;
    publish(
        &state,
        &data,
        &root,
        &group,
        &draft,
        Wishes { dated_ms, settled: true, room: true, reply_to: None, part_of: None },
    )
    .await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "closed": true })))
}

/// GET `/api/identity/{root}/docs/{doc_id}/groups` - the groups this draft is posted in, and as
/// which post: Writer's publish bar says where it went (slice 4c).
async fn draft_groups_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, doc)): Path<(String, String)>,
) -> Answer {
    me_of(&state, &session, &root).await?;
    let doc = doc_of(&doc)?;
    let rows: Vec<(Vec<u8>, Vec<u8>, String)> = state
        .node_db
        .fetch_all(
            "SELECT d.group_id, d.post, r.name FROM group_drafts d
             JOIN group_rosters r ON r.group_id = d.group_id
             WHERE d.root = ?1 AND d.source = ?2 ORDER BY r.name",
            (root.as_str(), doc.to_vec()),
        )
        .await
        .context("reading where a draft was posted")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!(rows
        .into_iter()
        .map(|(g, post, name)| serde_json::json!({
            "group": hex::encode(g),
            "post": hex::encode(post),
            "name": name,
        }))
        .collect::<Vec<_>>())))
}

#[derive(Deserialize)]
struct LabelRequest {
    value: String,
    present: bool,
}

/// POST `.../groups/{group}/docs/{doc}/labels` - a member tags a group post, or takes their tag
/// back, as anyone may a public post: two tags to a person on somebody else's post, the rule
/// every reader applies (`labels_of`). An author's own labels come from their draft, at publish.
async fn label_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, doc)): Path<(String, String, String)>,
    Json(req): Json<LabelRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let doc = doc_of(&doc)?;
    let (roster, _) = current(&state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-only-label",
            "only the group's members can tag its posts"
        )));
    }
    let value = req.value.trim();
    if value.is_empty() || value.chars().count() > ringtome_proto::PublicAnnotation::MAX_TAG_CHARS {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.a-tag-is-a-word",
            "a tag is a word or two, at most {cap} characters",
            cap = ringtome_proto::PublicAnnotation::MAX_TAG_CHARS
        )));
    }
    let (versions, gone) = documents_of(&state, &group, &roster).await?;
    let author = versions
        .get(&doc)
        .filter(|_| !gone.contains(&doc))
        .and_then(|list| display(list))
        .map(|v| v.persona)
        .ok_or_else(|| {
            AppError::NotFound(crate::msg!("roster.no-such-post", "no such post in this group"))
        })?;
    say_label(
        &state,
        &root,
        &data,
        &group,
        &author,
        &doc,
        ringtome_proto::PublicAnnotation::TAG_KEY,
        value,
        req.present,
    )
    .await?;
    // Your own post's tag is filed on its draft too, as the public card does: publishing again
    // restates the draft's labels, and a tag said only here would be taken back.
    if author == me {
        let drafts: Vec<(Vec<u8>,)> = state
            .node_db
            .fetch_all(
                "SELECT source FROM group_drafts WHERE root = ?1 AND group_id = ?2 AND post = ?3",
                (root.as_str(), group.to_vec(), doc.to_vec()),
            )
            .await
            .context("finding a group post's draft")
            .map_err(AppError::Internal)?;
        for (source,) in drafts {
            let Ok(draft) = <[u8; 16]>::try_from(source.as_slice()) else { continue };
            if req.present {
                data.annotations().tag(&draft, value).await?;
            } else {
                data.annotations().untag(&draft, value).await?;
            }
        }
    }
    crate::fold::fold_now(&state, &root).await;
    push_soon(&state, &root, group);
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "doc": hex::encode(doc) })))
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
    // A members-only post by its first version; a public post as the group (plans/PUBLIC_GROUPS.md)
    // by its claim - the smallest counted, as the fold names it - hidden on the public lane, so
    // everyone carrying it hears.
    let members_only = versions.get(&doc).and_then(|l| first_version(l)).map(|v| v.hash);
    let claim = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| roster.counted.contains(&e.hash))
        .filter(|e| matches!(&e.body, GroupEntry::Public { doc: d, retract: false } if *d == doc))
        .map(|e| e.hash)
        .min();
    let (post, lane) = match (members_only, claim) {
        (Some(p), _) => (p, None),
        (None, Some(c)) => (c, Some(service::GROUP_PUBLIC)),
        (None, None) => {
            return Err(AppError::NotFound(crate::msg!(
                "roster.no-such-post",
                "no such post in this group"
            )))
        }
    };
    // Replace every hide of it this node has seen, so the newest word settles it.
    let replaces: Vec<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| roster.counted.contains(&e.hash))
        .filter(|e| matches!(&e.body, GroupEntry::Hide { post: p, .. } if *p == post))
        .map(|e| e.hash)
        .collect();
    write_signed_on(
        &state,
        &data,
        &root,
        group,
        GroupEntry::Hide { by, post, hidden: req.hidden, replaces },
        lane,
    )
    .await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "hidden": req.hidden })))
}

#[derive(Deserialize)]
struct PinRequest {
    pinned: bool,
}

/// POST `.../groups/{group}/docs/{doc}/pin` - pin a post, or take its pin away (slice 4d;
/// Curtis, 2026-10-15/16). Any member pins any post: an owner's pin goes in the owners' layer,
/// shown first, anyone else's in the members'. Unpinning takes away what the caller may: an
/// owner, every pin on it; a member, a member's pin - anyone's, since members unpin each other's -
/// but never an owner's.
async fn pin_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, doc)): Path<(String, String, String)>,
    Json(req): Json<PinRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let doc = doc_of(&doc)?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::Forbidden(crate::msg!(
            "roster.members-pin",
            "only the group's members pin its posts"
        )));
    }
    let owner = roster.acting_as(&me);
    let (versions, _) = documents_of(&state, &group, &roster).await?;
    // A members-only post by its first version; a public post as the group by its claim, pinned on
    // the public lane where anyone carrying the group sees it (Curtis, 2026-10-18) - as a hide.
    let members_only = versions.get(&doc).and_then(|l| first_version(l)).map(|v| v.hash);
    let claim = roster.public_posts.iter().find(|((_, d), _)| *d == doc).map(|(_, c)| *c);
    let (post, lane) = match (members_only, claim) {
        (Some(p), _) => (p, None),
        (None, Some(c)) => (c, Some(service::GROUP_PUBLIC)),
        (None, None) => {
            return Err(AppError::NotFound(crate::msg!(
                "roster.no-such-post",
                "no such post in this group"
            )))
        }
    };
    // Every pin of it this node has seen, layer by layer, replaced so the newest word settles it.
    let seen = |owners: bool| -> Vec<Hash> {
        lanes
            .iter()
            .flat_map(|l| l.entries.iter())
            .filter(|e| roster.counted.contains(&e.hash))
            .filter(|e| match &e.body {
                GroupEntry::Pin { post: p, .. } => owners && *p == post,
                GroupEntry::MemberPin { post: p, .. } => !owners && *p == post,
                _ => false,
            })
            .map(|e| e.hash)
            .collect()
    };
    let member_entry = |pinned: bool| GroupEntry::MemberPin { post, pinned, replaces: seen(false) };
    if req.pinned {
        let entry = match owner {
            Some(by) => GroupEntry::Pin { by, post, pinned: true, replaces: seen(true) },
            None => member_entry(true),
        };
        write_on(&state, &data, &root, group, entry, lane).await?;
    } else {
        if roster.owner_pins.contains(&post) {
            let Some(by) = owner else {
                return Err(AppError::Forbidden(crate::msg!(
                    "roster.owners-pin-stays",
                    "an owner pinned that - only an owner takes it down"
                )));
            };
            write_on(
                &state,
                &data,
                &root,
                group,
                GroupEntry::Pin { by, post, pinned: false, replaces: seen(true) },
                lane,
            )
            .await?;
        }
        if !seen(false).is_empty() {
            write_on(&state, &data, &root, group, member_entry(false), lane).await?;
        }
    }
    let (roster, _) = current(&state, &group, &me).await?;
    let pin = if roster.owner_pins.contains(&post) {
        Some("owner")
    } else if roster.member_pins.contains(&post) {
        Some("member")
    } else {
        None
    };
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "pinned": pin })))
}

/// GET `.../groups/{group}/posts` - the group's page: its posts, newest first, each at its
/// newest version, hidden ones marked (an owner sees them; the app decides how).
/// GET `.../groups/{group}/posts/{doc}/replies` - one level of a group post's thread, for its
/// members: the public thread's answer (idface.rs `id_post_replies`), off the one replies memo's
/// rows for this group, in the order asked for. A post with comments off has none to show.
async fn replies_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, doc)): Path<(String, String, String)>,
    axum::extract::Query(query): axum::extract::Query<crate::idface::RepliesQuery>,
) -> Answer {
    let (_, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let doc_id = doc_of(&doc)?;
    let (roster, _) = current(&state, &group, &me).await?;
    if !roster.members.contains(&me) {
        return Err(AppError::NotFound(crate::msg!(
            "roster.no-such-group-here",
            "no such group here"
        )));
    }
    let (versions, gone) = documents_of(&state, &group, &roster).await?;
    let list = versions.get(&doc_id).filter(|_| !gone.contains(&doc_id));
    let (Some(first), Some(shown)) =
        (list.and_then(|l| first_version(l)), list.and_then(|l| display(l)))
    else {
        return Err(AppError::NotFound(crate::msg!(
            "roster.no-such-post",
            "no such post in this group"
        )));
    };
    if shown.header.settled {
        return Ok(Json(serde_json::json!({
            "replies": [], "more": false, "seeking": false, "settled": true,
        })));
    }
    let author = hex::encode(first.persona);
    let after = match (query.after_ms, query.after_doc.clone()) {
        (Some(ms), Some(d)) => Some((ms, d)),
        _ => None,
    };
    let (mut replies, more) = match after {
        None => crate::replies::replies_level(&state.node_db, &author, &doc, Some(&group)).await,
        Some(after) => {
            crate::replies::replies_of(&state.node_db, &author, &doc, Some(after), Some(&group))
                .await
        }
    }
    .map_err(AppError::Internal)?;
    crate::idface::order_level(&state, Some(&session), &query, &mut replies).await?;
    let bylines = crate::idface::level_bylines(&state, &replies).await;
    Ok(Json(serde_json::json!({
        "replies": replies, "more": more, "seeking": false, "bylines": bylines,
    })))
}

async fn posts_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    let (_, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let (roster, _) = current(&state, &group, &me).await?;
    let (versions, gone) = documents_of(&state, &group, &roster).await?;
    let mut labels = labels_of(&state, &group, &roster).await?;
    let mut posts = Vec::new();
    for post in listed(&versions, &gone, &roster) {
        if !sees(&roster, &me, &post) {
            continue;
        }
        let Listed { doc, shown, first, edited, hidden } = post;
        let doc = &doc;
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
            "posted_ms": shown.header.dated_ms.or(first.header.genesis_ms),
            "edited": edited,
            "settled": shown.header.settled,
            "hidden": hidden,
            "annotations": labels.remove(doc).unwrap_or_default().into_iter().map(|l| serde_json::json!({
                "annotator": l.annotator,
                "key": l.key,
                "value": l.value,
            })).collect::<Vec<_>>(),
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

// ---------------------------------------------------------------------------------------------
// The group's face (Curtis, 2026-10-16): a name, a picture, a banner and a description, set by
// owners only, as owner settings - the picture and banner media documents on the setting owner's
// lane, which every member's node fetches with the group's other pictures. Shown to anyone who
// asks, since an invitee needs to know them and a public group shows them.

/// Where a face picture is served, to anyone: its document id in the address, so it is kept.
fn face_url(group: &GroupId, doc: &[u8; 16]) -> String {
    format!("/api/groups/{}/face/{}", hex::encode(group), hex::encode(doc))
}

/// Write one of the group's settings as an owner, replacing every write of that setting this
/// node has seen - so the newest word settles it, whatever its writer's rank.
async fn set_setting(
    state: &AppState,
    data: &Store,
    root: &str,
    group: GroupId,
    me: &Root,
    setting: Setting,
) -> Result<(), AppError> {
    let (roster, lanes) = current(state, &group, me).await?;
    let by = acting(&roster, me)?;
    let kind = std::mem::discriminant(&setting);
    let replaces: Vec<Hash> = lanes
        .iter()
        .flat_map(|l| l.entries.iter())
        .filter(|e| roster.counted.contains(&e.hash))
        .filter(|e| {
            matches!(&e.body, GroupEntry::Set { setting: s, .. }
                if std::mem::discriminant(s) == kind)
        })
        .map(|e| e.hash)
        .collect();
    write(state, data, root, group, GroupEntry::Set { by, setting, replaces, accepted: vec![] })
        .await?;
    Ok(())
}

#[derive(Deserialize)]
struct SettingsRequest {
    name: Option<String>,
    description: Option<String>,
}

/// POST `.../groups/{group}/settings {name?, description?}` - an owner renames the group or
/// rewrites its description.
async fn settings_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
    Json(req): Json<SettingsRequest>,
) -> Answer {
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    if let Some(name) = &req.name {
        let name = name.trim();
        if name.is_empty() || name.len() > GroupEntry::MAX_NAME_BYTES || name.contains('\n') {
            return Err(AppError::BadRequest(crate::msg!(
                "roster.a-name-is-one-short-line",
                "a group's name is one short line"
            )));
        }
    }
    if let Some(d) = &req.description {
        if d.len() > GroupEntry::MAX_DESCRIPTION_BYTES {
            return Err(AppError::BadRequest(crate::msg!(
                "roster.that-description-is-too-long",
                "that description is too long"
            )));
        }
    }
    if let Some(name) = req.name {
        set_setting(&state, &data, &root, group, &me, Setting::Name(name.trim().to_string()))
            .await?;
    }
    if let Some(d) = req.description {
        set_setting(&state, &data, &root, group, &me, Setting::Description(d.trim().to_string()))
            .await?;
    }
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// Which of the face's pictures an address names.
fn face_which(which: &str) -> Result<bool, AppError> {
    match which {
        "picture" => Ok(true),
        "banner" => Ok(false),
        _ => Err(AppError::NotFound(crate::msg!(
            "roster.no-such-picture",
            "a group has a picture and a banner, nothing else"
        ))),
    }
}

/// POST `.../groups/{group}/face/{picture|banner}` (multipart `image`) - an owner sets the group's
/// picture or banner: laundered as every upload is, minted as a media document on the owner's
/// lane, and named by the setting. A picture may move (a small animation, as a person's may); a
/// banner is a still.
async fn set_face_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, which)): Path<(String, String, String)>,
    mut parts: axum::extract::Multipart,
) -> Answer {
    use crate::record::documents::Format;
    let picture = face_which(&which)?;
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    // The upload is read before anything refuses it, so a refusal answers a finished request: an
    // answer sent while the picture is still on its way lands as a broken pipe at the sender, never
    // as the refusal (the groupposts flake on "mcp group postin", 2026-10-18: "write EPIPE" where a
    // non-owner's upload should have been told 403). The owner is checked before it's worked on.
    let mut image: Option<Vec<u8>> = None;
    while let Some(field) = parts.next_field().await.map_err(|e| {
        AppError::BadRequest(crate::msg!(
            "identity.routes.bad-multipart-body-e-2",
            "bad multipart body: {e}",
            e = e
        ))
    })? {
        if field.name().unwrap_or("") == "image" {
            image = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| {
                        AppError::BadRequest(crate::msg!(
                            "identity.routes.bad-multipart-part-image-e",
                            "bad multipart part `image`: {e}",
                            e = e
                        ))
                    })?
                    .to_vec(),
            );
        }
    }
    let (roster, _) = current(&state, &group, &me).await?;
    acting(&roster, &me)?;
    let bytes = image.ok_or_else(|| {
        AppError::BadRequest(crate::msg!(
            "identity.routes.missing-image-part",
            "missing `image` part"
        ))
    })?;
    let ingested =
        crate::media::lane::crush(move || crate::media::crush_with_progress(&bytes, &|_| {}))
            .await
            .map_err(|e| AppError::Internal(anyhow!("group picture crush task: {e}")))?
            .map_err(|e| {
                AppError::BadRequest(crate::msg!(
                    "roster.that-doesnt-work-as-a-picture",
                    "that doesn't work as the group's picture: {e}",
                    e = e
                ))
            })?;
    let fits = match ingested.format {
        Format::Avif => true,
        Format::Apng => picture,
        _ => false,
    };
    if !fits {
        return Err(AppError::BadRequest(if picture {
            crate::msg!(
                "roster.a-groups-picture-is-a-picture",
                "a group's picture is a still image or a small animation"
            )
        } else {
            crate::msg!("roster.a-groups-banner-is-a-still", "a group's banner is a still picture")
        }));
    }
    let doc = mint_media(
        &state,
        &data,
        &root,
        &group,
        Minted {
            body: &ingested.body,
            thumb: ingested.thumb_avif.as_deref(),
            title: if picture { "picture" } else { "banner" },
            format: ingested.format.to_wire(),
            width: ingested.width,
            height: ingested.height,
            duration_ms: ingested.duration_ms,
            animation: ingested.animation,
            part_of: None,
        },
    )
    .await?;
    let setting = if picture { Setting::Picture(Some(doc)) } else { Setting::Banner(Some(doc)) };
    set_setting(&state, &data, &root, group, &me, setting).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// DELETE `.../groups/{group}/face/{picture|banner}` - back to none.
async fn clear_face_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group, which)): Path<(String, String, String)>,
) -> Answer {
    let picture = face_which(&which)?;
    let (data, me) = me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    let setting = if picture { Setting::Picture(None) } else { Setting::Banner(None) };
    set_setting(&state, &data, &root, group, &me, setting).await?;
    let (roster, lanes) = current(&state, &group, &me).await?;
    Ok(Json(roster_json(&group, &roster, &lanes, &me)))
}

/// The group as this node holds it, for its face: any group held here, to anyone.
async fn face_of(state: &AppState, group: &str) -> Result<(GroupId, Folded), AppError> {
    let group = group_of(group)?;
    let folded = folded(state, &group).await.map_err(AppError::Internal)?.ok_or_else(|| {
        AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"))
    })?;
    Ok((group, folded))
}

/// GET `/api/groups/{group}/face` - the group's name, picture, banner and description, to anyone.
/// GET `/api/groups/{group}/public` - a public group's open page (plans/PUBLIC_GROUPS.md, ruling
/// 6), to anyone, signed in or not: its face, its members and owners with their names, and its
/// public posts, newest claimed first - as this node holds them. A private group, or one this node
/// doesn't hold, is no such group: nothing says a private one exists.
async fn public_page_handler(State(state): State<AppState>, Path(group): Path<String>) -> Answer {
    let missing =
        || AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"));
    let group = group_of(&group)?;
    let Some((roster, _)) = folded(&state, &group).await.map_err(AppError::Internal)? else {
        return Err(missing());
    };
    if !roster.public {
        return Err(missing());
    }
    let roots: Vec<String> = roster.members.iter().map(hex::encode).collect();
    let names =
        crate::profiles::bylines(&state.node_db, &roots).await.map_err(AppError::Internal)?;
    let members: Vec<serde_json::Value> = roster
        .members
        .iter()
        .map(|m| {
            let root = hex::encode(m);
            let b = names.get(&root);
            serde_json::json!({
                "root": root,
                "owner": roster.owners.contains_key(m),
                "name": b.and_then(|b| b.name.clone()),
                "avatar": b.and_then(|b| b.avatar.clone()),
            })
        })
        .collect();
    let posts: Vec<(String, String, i64)> = state
        .node_db
        .fetch_all(
            "SELECT author, doc, claimed_ms FROM group_public_posts WHERE group_id = ?1
             ORDER BY claimed_ms DESC LIMIT 200",
            (group.to_vec(),),
        )
        .await
        .context("reading a group's public posts")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({
        "group": hex::encode(group),
        "public": true,
        "name": roster.name,
        "description": roster.description,
        "picture": roster.picture.map(|d| face_url(&group, &d)),
        "banner": roster.banner.map(|d| face_url(&group, &d)),
        "founder": hex::encode(roster.founder),
        "members": members,
        "posts": posts.into_iter().map(|(author, doc, at)| serde_json::json!({
            "author": author,
            "doc_id": doc,
            "claimed_ms": at,
        })).collect::<Vec<_>>(),
        // Where this page was answered: a follow from another node asks here first.
        "endpoint": state.endpoint.id().to_string(),
    })))
}

/// The posts a public group counts as its own, `(author, doc)`, for its feed - or no such group,
/// for a private one or one this node doesn't hold.
async fn public_claims(
    state: &AppState,
    group: &GroupId,
) -> Result<Vec<(String, [u8; 16])>, AppError> {
    let missing =
        || AppError::NotFound(crate::msg!("roster.no-such-group-here", "no such group here"));
    let Some((roster, _)) = folded(state, group).await.map_err(AppError::Internal)? else {
        return Err(missing());
    };
    if !roster.public {
        return Err(missing());
    }
    Ok(roster.public_posts.keys().map(|(a, d)| (hex::encode(a), *d)).collect())
}

/// A public group's pinned public posts (Curtis, 2026-10-18), as its fold holds them: each by its
/// author and doc, an owner's pin above a member's, in claim order within each.
async fn public_pins(state: &AppState, group: &GroupId) -> Vec<(String, [u8; 16], &'static str)> {
    let Ok(Some((roster, _))) = folded(state, group).await else { return Vec::new() };
    let mut pins: Vec<_> = roster
        .public_posts
        .iter()
        .filter_map(|((a, d), claim)| {
            let pin = if roster.owner_pins.contains(claim) {
                "owner"
            } else if roster.member_pins.contains(claim) {
                "member"
            } else {
                return None;
            };
            Some((hex::encode(a), *d, pin))
        })
        .collect();
    pins.sort_by_key(|p| p.2 != "owner");
    pins
}

fn cursor_of(q: &crate::idface::PostsQuery) -> Result<Option<(i64, [u8; 16])>, AppError> {
    match (q.after_ms, q.after_doc.as_deref()) {
        (Some(ms), Some(doc)) => Ok(Some((ms, doc_of(doc)?))),
        _ => Ok(None),
    }
}

/// GET `/api/groups/{group}/posts` - a public group's feed (plans/PUBLIC_GROUPS.md, ruling 6), to
/// anyone: its public posts as full cards, newest first, a page at a time, narrowed by the words
/// and the picks as a persona's shelf is.
async fn public_feed_handler(
    State(state): State<AppState>,
    Path(group): Path<String>,
    axum::extract::Query(q): axum::extract::Query<crate::idface::PostsQuery>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Answer {
    let group = group_of(&group)?;
    let claims = public_claims(&state, &group).await?;
    let after = cursor_of(&q)?;
    let pins = public_pins(&state, &group).await;
    let mut page = crate::idface::group_feed_json(
        &state,
        &claims,
        after,
        raw.as_deref(),
        q.q.as_deref(),
        q.as_root.as_deref(),
    )
    .await?;
    // Pinned above the feed (Curtis, 2026-10-18), as a members-only post's pin is: on the first
    // page, whatever their age, narrowed by the same words and picks. Every row says its pin.
    let pin_of = |author: &str, doc: &str| {
        pins.iter().find(|(a, d, _)| a == author && hex::encode(d) == doc).map(|p| p.2)
    };
    let mark = |rows: &mut serde_json::Value| {
        for row in rows.as_array_mut().into_iter().flatten() {
            let pin = pin_of(
                row["author"].as_str().unwrap_or_default(),
                row["doc_id"].as_str().unwrap_or_default(),
            );
            row["pinned"] = serde_json::json!(pin);
        }
    };
    mark(&mut page["posts"]);
    if after.is_none() && !pins.is_empty() {
        let pinned: Vec<(String, [u8; 16])> =
            pins.iter().map(|(a, d, _)| (a.clone(), *d)).collect();
        let mut rows = crate::idface::group_feed_json(
            &state,
            &pinned,
            None,
            raw.as_deref(),
            q.q.as_deref(),
            q.as_root.as_deref(),
        )
        .await?["posts"]
            .take();
        mark(&mut rows);
        // Owners' pins first, as the fold's order says; the feed sorted them newest first.
        if let Some(list) = rows.as_array_mut() {
            list.sort_by_key(|r| r["pinned"].as_str() != Some("owner"));
        }
        page["pinned"] = rows;
    }
    Ok(Json(page))
}

/// GET `/api/groups/{group}/labels` - its feed's facets, as a persona's page counts theirs.
async fn public_labels_handler(
    State(state): State<AppState>,
    Path(group): Path<String>,
    axum::extract::Query(q): axum::extract::Query<crate::idface::PostsQuery>,
    axum::extract::RawQuery(raw): axum::extract::RawQuery,
) -> Answer {
    let group = group_of(&group)?;
    let claims = public_claims(&state, &group).await?;
    Ok(Json(
        crate::idface::group_labels_json(
            &state,
            &claims,
            raw.as_deref(),
            q.q.as_deref(),
            q.as_root.as_deref(),
        )
        .await?,
    ))
}

/// GET `/api/id/{seg}/groups` - the public groups a persona is in, as this node knows (ruling 4:
/// membership is public). A private group's membership is never here.
async fn persona_public_groups_handler(
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Answer {
    let Some(root) = crate::speakable::parse(&root).and_then(|p| match p {
        crate::speakable::Parsed::Ok(r) => Some(hex::encode(r)),
        _ => None,
    }) else {
        return Err(AppError::BadRequest(crate::msg!(
            "roster.not-a-persona",
            "that isn't a persona"
        )));
    };
    let rows: Vec<(Vec<u8>, String)> = state
        .node_db
        .fetch_all(
            "SELECT p.group_id, r.name FROM group_people p
             JOIN group_rosters r ON r.group_id = p.group_id
             WHERE p.root = ?1 AND r.public = 1 AND p.standing IN ('member', 'owner')
             ORDER BY r.name",
            (root.as_str(),),
        )
        .await
        .context("listing a persona's public groups")
        .map_err(AppError::Internal)?;
    let mut out = Vec::new();
    for (g, name) in rows {
        let Ok(group) = <[u8; 16]>::try_from(g.as_slice()) else { continue };
        let picture = match folded(&state, &group).await {
            Ok(Some((roster, _))) => roster.picture.map(|d| face_url(&group, &d)),
            _ => None,
        };
        out.push(
            serde_json::json!({ "group": hex::encode(group), "name": name, "picture": picture }),
        );
    }
    Ok(Json(serde_json::json!(out)))
}

/// GET `.../groups/{group}/follow` - whether `root` follows this group.
async fn follow_state_handler(
    session: Session,
    State(state): State<AppState>,
    Path((root, group)): Path<(String, String)>,
) -> Answer {
    me_of(&state, &session, &root).await?;
    let group = group_of(&group)?;
    Ok(Json(serde_json::json!({
        "group": hex::encode(group),
        "following": follows_group(&state, &root, &group).await,
    })))
}

async fn face_handler(State(state): State<AppState>, Path(group): Path<String>) -> Answer {
    let (group, (roster, _)) = face_of(&state, &group).await?;
    Ok(Json(serde_json::json!({
        "group": hex::encode(group),
        "name": roster.name,
        "description": roster.description,
        "picture": roster.picture.map(|d| face_url(&group, &d)),
        "banner": roster.banner.map(|d| face_url(&group, &d)),
    })))
}

/// The bytes of the face as it stands - the picture or the banner the settings name now, and no
/// other document of the group's, past or present.
async fn face_bytes(
    state: &AppState,
    group: &str,
    doc: &str,
    thumb: bool,
) -> Result<axum::response::Response, AppError> {
    use axum::http::header;
    use axum::response::IntoResponse;
    let missing = || {
        AppError::NotFound(crate::msg!("roster.not-the-groups-face", "that isn't the group's face"))
    };
    let (group, (roster, _)) = face_of(state, group).await?;
    let doc = doc_of(doc)?;
    if roster.picture != Some(doc) && roster.banner != Some(doc) {
        return Err(missing());
    }
    let (versions, gone) = documents_of(state, &group, &roster).await?;
    if gone.contains(&doc) {
        return Err(missing());
    }
    let shown = versions.get(&doc).and_then(|l| display(l)).ok_or_else(missing)?;
    let format = crate::record::documents::Format::from_wire(shown.header.format);
    let (hash, mime) = if thumb {
        (shown.header.thumb_hash.ok_or_else(missing)?, "image/avif")
    } else {
        (shown.header.file_hash, format.mime())
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
    // A media document never changes, and its id is in the address: kept.
    Ok((
        [
            (header::CONTENT_TYPE, mime),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

/// GET `/api/groups/{group}/face/{doc}`.
async fn face_bytes_route(
    State(state): State<AppState>,
    Path((group, doc)): Path<(String, String)>,
) -> Result<axum::response::Response, AppError> {
    face_bytes(&state, &group, &doc, false).await
}

/// GET `/api/groups/{group}/face/{doc}/thumb`.
async fn face_thumb_route(
    State(state): State<AppState>,
    Path((group, doc)): Path<(String, String)>,
) -> Result<axum::response::Response, AppError> {
    face_bytes(&state, &group, &doc, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn machine(endpoint: &str, reliability: f64, tried: Option<i64>, dark: bool) -> Candidate {
        Candidate {
            endpoint: endpoint.to_string(),
            reliability,
            last_ok_ms: tried,
            last_tried_ms: tried,
            dark,
        }
    }

    /// Two by reliability, then the one least lately tried - a never-tried machine first - and a
    /// dark one only when nothing else is left (plans/NETWORK.md, ruling 4).
    #[test]
    fn gossip_prefers_the_reliable_and_keeps_a_slot_for_the_rest() {
        let picked = pick_partners(
            vec![
                machine("steady", 0.95, Some(100), false),
                machine("good", 0.9, Some(90), false),
                machine("flaky", 0.3, Some(50), false),
                machine("shut", 0.2, Some(10), false),
                machine("dark", 0.99, Some(99), true),
                machine("new", 0.5, None, false),
            ],
            2,
            1,
        );
        assert_eq!(picked, vec!["steady", "good", "new"], "the new machine gets the check-in");

        let picked = pick_partners(
            vec![
                machine("steady", 0.95, Some(100), false),
                machine("good", 0.9, Some(90), false),
                machine("flaky", 0.3, Some(50), false),
                machine("shut", 0.2, Some(10), false),
            ],
            2,
            1,
        );
        assert_eq!(picked, vec!["steady", "good", "shut"], "then the one tried longest ago");

        let picked = pick_partners(
            vec![
                machine("a", 0.9, Some(1), true),
                machine("b", 0.9, Some(2), true),
                machine("c", 0.4, Some(3), false),
                machine("d", 0.9, Some(4), true),
            ],
            2,
            1,
        );
        assert_eq!(picked, vec!["c", "a", "b"], "dark ones only to fill");
    }

    /// Outside a group, its pass comes round every ten minutes - at once when whom it carries for
    /// changed, and every beat on the test rig.
    #[test]
    fn a_public_pass_is_paced_unless_its_readers_change() {
        let group = [9u8; 16];
        let carry: Carry = vec![("ada".into(), vec!["dee".into()])];
        assert!(public_pass_due(&group, &carry, false, 1_000), "the first pass");
        assert!(!public_pass_due(&group, &carry, false, 2_000), "not again a second later");
        let more: Carry = vec![("ada".into(), vec!["dee".into(), "eve".into()])];
        assert!(public_pass_due(&group, &more, false, 3_000), "a new reader doesn't wait");
        assert!(!public_pass_due(&group, &more, false, 4_000));
        assert!(public_pass_due(&group, &more, false, 3_000 + PUBLIC_EVERY_MS), "its time came");
        assert!(public_pass_due(&[8u8; 16], &more, true, 1), "the rig's beat decides");
        assert!(public_pass_due(&[8u8; 16], &more, true, 2));
    }

    /// The digest's comparison (plans/NETWORK.md): only the personas whose lanes the two sides
    /// disagree on - ahead, behind, or held on one side alone.
    #[test]
    fn a_digest_names_only_the_lanes_that_differ() {
        use ringtome_proto::fragment::GroupHead;
        let head = |p: u8, a: u8, n: u64| GroupHead {
            persona: [p; 32],
            author: [a; 32],
            service: service::GROUP_PUBLIC,
            head: n,
            hash: [n as u8; 8],
        };
        let ours = vec![head(1, 11, 5), head(2, 22, 7), head(3, 33, 2)];
        assert!(differing(&ours, &ours).is_empty(), "the same: nothing to exchange");
        let theirs = vec![head(1, 11, 6), head(2, 22, 7), head(4, 44, 1)];
        assert_eq!(
            differing(&ours, &theirs),
            BTreeSet::from([[1u8; 32], [3u8; 32], [4u8; 32]]),
            "ahead, ours alone, theirs alone"
        );
        assert_eq!(
            with_news(&["a".into()], Some(&BTreeSet::from(["b".to_string(), "a".to_string()]))),
            vec!["a".to_string(), "b".to_string()],
        );
    }

    /// A small group asks everyone, in no particular order of merit.
    #[test]
    fn a_small_group_asks_every_machine() {
        let picked = pick_partners(
            vec![machine("a", 0.1, None, true), machine("b", 0.9, Some(1), false)],
            2,
            1,
        );
        assert_eq!(picked, vec!["a", "b"]);
    }
}
