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

pub(crate) fn group_of(hex_group: &str) -> Result<GroupId, AppError> {
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

/// Fold a group from the memo and keep what the door reads. `None` when no valid founding for
/// it is held.
async fn refold(state: &AppState, group: &GroupId) -> Result<Option<(Roster, Vec<Lane>)>> {
    // One refold of a group at a time (2026-10-16): each clears the group's people and journal
    // and writes them again, and two at once interleaved those - the second's inserts met the
    // first's rows and failed, and a page's burst of body requests (each of which refolded, then)
    // read "these words haven't reached this computer" on the author's own posts.
    let lock = refold_lock(group);
    let _held = lock.lock().await;
    let Some((roster, lanes)) = folded(state, group).await? else { return Ok(None) };
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
    rejournal(state, group, &roster).await?;
    Ok(Some((roster, lanes)))
}

/// The group as its held lanes fold now: computed, nothing written. What a read wants - the
/// memo is kept by [`refold`], which every arrival and every write already runs.
async fn folded(state: &AppState, group: &GroupId) -> Result<Option<(Roster, Vec<Lane>)>> {
    let lanes = lanes_of(state, group).await?;
    Ok(fold::build(*group, &lanes).map(|roster| (roster, lanes)))
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
        .filter(|(doc, _)| !gone.contains(*doc) && !embedded.contains(*doc))
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

/// Write each hosted member's rows of the group's journal, as the group now stands: a member
/// who left or was removed keeps none, and a post they may no longer see leaves. An unchanged
/// version keeps the words it was searched by, so a refold reads only what moved.
async fn rejournal(state: &AppState, group: &GroupId, roster: &Roster) -> Result<()> {
    let db = &state.node_db;
    let (versions, gone) =
        documents_of(state, group, roster).await.map_err(|e| anyhow!("{e:?}"))?;
    let posts = listed(&versions, &gone, roster);
    let mut labels = labels_of(state, group, roster).await.map_err(|e| anyhow!("{e:?}"))?;
    let held: Vec<(String, Vec<u8>, String)> = db
        .fetch_all(
            "SELECT DISTINCT doc_id, version, tokens FROM group_journal WHERE group_id = ?1",
            (group.to_vec(),),
        )
        .await
        .context("reading a group's journal")?;
    let mut readers: Vec<Root> = Vec::new();
    for m in &roster.members {
        if crate::identity::is_agented(db, &hex::encode(m)).await.unwrap_or(false) {
            readers.push(*m);
        }
    }
    db.execute("DELETE FROM group_journal WHERE group_id = ?1", (group.to_vec(),))
        .await
        .context("clearing a group's journal")?;
    for post in &posts {
        let doc_hex = hex::encode(post.doc);
        let tokens =
            match held.iter().find(|(d, v, _)| *d == doc_hex && v[..] == post.shown.hash[..]) {
                Some((_, _, tokens)) => tokens.clone(),
                None => {
                    let words = crate::idface::public_blob(state, post.shown.header.file_hash)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|b| String::from_utf8(b).ok())
                        .unwrap_or_default();
                    crate::search::tokens_of(&post.shown.header.title, &words)
                }
            };
        let said = serde_json::to_string(
            &labels
                .remove(&post.doc)
                .unwrap_or_default()
                .into_iter()
                .map(|l| serde_json::json!({ "annotator": l.annotator, "key": l.key, "value": l.value }))
                .collect::<Vec<_>>(),
        )?;
        let format = crate::record::documents::Format::from_wire(post.shown.header.format).as_str();
        // Its claimed date when it has one, as any post sorts by its (PUBLISH.md).
        let published = post.shown.header.dated_ms.or(post.first.header.genesis_ms).unwrap_or(0);
        let updated = post.shown.header.genesis_ms.unwrap_or(published);
        let minted = post.first.header.genesis_ms.unwrap_or(0);
        use turso::Value;
        for reader in readers.iter().filter(|r| sees(roster, r, post)) {
            let owns = roster.owners.contains_key(reader);
            db.execute(
                "INSERT INTO group_journal (reader_root, group_id, group_name, author_root, doc_id,
                   title, format, published_ms, updated_ms, version, tokens, labels, hidden, owns,
                   settled, dated_ms, minted_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                turso::params_from_iter([
                    Value::Text(hex::encode(reader)),
                    Value::Blob(group.to_vec()),
                    Value::Text(roster.name.clone()),
                    Value::Text(hex::encode(post.shown.persona)),
                    Value::Text(doc_hex.clone()),
                    Value::Text(post.shown.header.title.clone()),
                    Value::Text(format.to_string()),
                    Value::Integer(published),
                    Value::Integer(updated),
                    Value::Blob(post.shown.hash.to_vec()),
                    Value::Text(tokens.clone()),
                    Value::Text(said.clone()),
                    Value::Integer(post.hidden as i64),
                    Value::Integer(owns as i64),
                    Value::Integer(post.shown.header.settled as i64),
                    post.shown.header.dated_ms.map_or(Value::Null, Value::Integer),
                    Value::Integer(minted),
                ]),
            )
            .await
            .context("journalling a group post")?;
        }
    }
    Ok(())
}

/// One of a reader's group journal rows: a feed row, its group, and its labels.
pub struct GroupFeedRow {
    pub row: crate::fanout::FeedRow,
    pub tokens: String,
    pub labels: Vec<crate::annotations::KnownAnnotation>,
}

/// A group journal row as [`JOURNAL_COLUMNS`] reads it.
type JournalRow = (
    String,
    Vec<u8>,
    String,
    String,
    String,
    String,
    i64,
    i64,
    String,
    String,
    i64,
    i64,
    i64,
    Option<i64>,
    i64,
);

const JOURNAL_COLUMNS: &str = "author_root, group_id, group_name, doc_id, title, format,
    published_ms, updated_ms, tokens, labels, hidden, owns, settled, dated_ms, minted_ms";

fn journal_row(
    (
        author,
        group,
        name,
        doc,
        title,
        format,
        published,
        updated,
        tokens,
        labels,
        hidden,
        owns,
        settled,
        dated,
        minted,
    ): JournalRow,
) -> GroupFeedRow {
    let labels: Vec<serde_json::Value> = serde_json::from_str(&labels).unwrap_or_default();
    GroupFeedRow {
        row: crate::fanout::FeedRow {
            author_root: author,
            via_root: None,
            suggested_via: None,
            doc_id: doc,
            title,
            format: Some(format),
            published_ms: published,
            updated_ms: updated,
            arrived_ms: published,
            settled: settled != 0,
            trusted_only: false,
            onward: false,
            dated_ms: dated,
            // A row from before rung 87 knows no genesis until its group refolds.
            minted_ms: if minted == 0 { published } else { minted },
            group: Some(crate::fanout::GroupMark {
                id: hex::encode(group),
                name,
                hidden: hidden != 0,
                owns: owns != 0,
            }),
        },
        tokens,
        labels: labels
            .into_iter()
            .filter_map(|l| {
                Some(crate::annotations::KnownAnnotation {
                    annotator: l["annotator"].as_str()?.to_string(),
                    key: l["key"].as_str()?.to_string(),
                    value: l["value"].as_str()?.to_string(),
                })
            })
            .collect(),
    }
}

/// A reader's group posts, newest first (ties by document id, highest first), after `before`,
/// at most `limit` - or all of them, without one. `own` is the feed's "me" chip, and `since_ms`
/// a best order's window.
pub async fn feed_rows(
    state: &AppState,
    reader: &str,
    before: Option<&(i64, String)>,
    limit: Option<i64>,
    own: crate::fanout::Own,
    since_ms: Option<i64>,
) -> Result<Vec<GroupFeedRow>> {
    let mut sql = format!(
        "SELECT {JOURNAL_COLUMNS}
         FROM group_journal WHERE reader_root = ?1 AND (published_ms, doc_id) < (?2, ?3)"
    );
    match own {
        crate::fanout::Own::In => {}
        crate::fanout::Own::Out => sql.push_str(" AND author_root <> reader_root"),
        crate::fanout::Own::Only => sql.push_str(" AND author_root = reader_root"),
    }
    if let Some(since) = since_ms {
        sql.push_str(&format!(" AND published_ms >= {since}"));
    }
    sql.push_str(" ORDER BY published_ms DESC, doc_id DESC");
    if let Some(limit) = limit {
        sql.push_str(&format!(" LIMIT {limit}"));
    }
    let (ms, doc) = before.cloned().unwrap_or((i64::MAX, String::new()));
    let rows: Vec<JournalRow> = state
        .node_db
        .fetch_all(&sql, (reader, ms, doc.as_str()))
        .await
        .context("reading a reader's group posts")?;
    Ok(rows.into_iter().map(journal_row).collect())
}

/// One of a reader's group posts, for its own page - or None, when it isn't theirs to see.
pub async fn feed_row(
    state: &AppState,
    reader: &str,
    group: &GroupId,
    doc: &str,
) -> Result<Option<GroupFeedRow>> {
    let rows: Vec<JournalRow> = state
        .node_db
        .fetch_all(
            &format!(
                "SELECT {JOURNAL_COLUMNS} FROM group_journal
                 WHERE reader_root = ?1 AND group_id = ?2 AND doc_id = ?3"
            ),
            (reader, group.to_vec(), doc),
        )
        .await
        .context("reading a group post")?;
    Ok(rows.into_iter().next().map(journal_row))
}

/// Is `(author, doc)` a group post this node holds - in a hosted member's journal, or posted by
/// one of this node's own personas? A public road refuses one (plans/GROUPS.md, section 7): a
/// public tag on it, or a tag taken back, names the post on the tagger's public chain.
pub async fn holds_group_post(state: &AppState, author: &str, doc: &[u8; 16]) -> Result<bool> {
    let journalled: Vec<(i64,)> = state
        .node_db
        .fetch_all(
            "SELECT 1 FROM group_journal WHERE author_root = ?1 AND doc_id = ?2 LIMIT 1",
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
            "SELECT group_id, group_name FROM group_journal
             WHERE reader_root = ?1 AND author_root = ?2 AND doc_id = ?3 LIMIT 1",
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
            // Refolded whether or not anything arrived: the feed's journal of the group is
            // written there, and a node that gained it in an upgrade fills it here (slice 4b).
            refold(&state, &group).await?;
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
    Ok(*write_signed(state, data, me, group, entry).await?.hash())
}

/// [`write`], answering the entry itself - an invite's is the evidence its notice carries.
async fn write_signed(
    state: &AppState,
    data: &Store,
    me: &str,
    group: GroupId,
    entry: GroupEntry,
) -> Result<ringtome_proto::SignedEntry, AppError> {
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
    Ok(signed)
}

/// The roster as this node holds it, folded now (nothing written) - for `me` only when the
/// group's door opens to them (ruling 3: members see the roster). A node holds a group for whichever of its
/// personas is in it; the others on it see nothing, as they would anywhere else.
async fn current(
    state: &AppState,
    group: &GroupId,
    me: &Root,
) -> Result<(Roster, Vec<Lane>), AppError> {
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

pub fn router() -> Router<AppState> {
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
        .route("/api/identity/{root}/groups/{group}/posts", get(posts_handler))
        .route("/api/identity/{root}/groups/{group}/publish", post(publish_handler))
        .route("/api/identity/{root}/docs/{doc_id}/groups", get(draft_groups_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/retract", post(retract_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/hide", post(hide_handler))
        .route("/api/identity/{root}/groups/{group}/docs/{doc}/labels", post(label_handler))
        // A group's pictures and bodies, at one address for every member - the embed in a
        // post's words can't name the reader - so the door is the session: any persona on it
        // the group counts.
        .route("/api/groups/{group}/docs/{doc}/body", get(group_body_route))
        .route("/api/groups/{group}/docs/{doc}/body/{name}", get(group_body_named_route))
        .route("/api/groups/{group}/docs/{doc}/thumb", get(group_thumb_route))
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

/// GET `/api/identity/{root}/groups` - the groups this persona is in, or invited to - an invite
/// still unopened among them, as the bell has it: standing `invite`, its name the founding's
/// and its inviter who sent it.
async fn list_handler(
    session: Session,
    State(state): State<AppState>,
    Path(root): Path<String>,
) -> Answer {
    let (data, _) = me_of(&state, &session, &root).await?;
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
    let mut out: Vec<serde_json::Value> = rows
        .iter()
        .map(|(g, name, standing)| {
            serde_json::json!({
                "group": hex::encode(g),
                "name": name,
                "standing": standing,
            })
        })
        .collect();
    let held: BTreeSet<String> = rows.iter().map(|(g, _, _)| hex::encode(g)).collect();
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
    let seed: Vec<String> = [req.founder, req.inviter].into_iter().flatten().collect();
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

/// Say one label on the lane, or take it back.
#[allow(clippy::too_many_arguments)]
async fn say_label(
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
        say_label(data, group, author, doc, k, v, true).await?;
    }
    for (k, v) in mine.difference(desired) {
        say_label(data, group, author, doc, k, v, false).await?;
    }
    crate::fold::fold_now(state, me).await;
    Ok(())
}

/// What a group post's header carries from its publish, as any post's does: the author's claimed
/// date, and comments off.
#[derive(Clone, Copy, Debug, Default)]
pub struct Wishes {
    pub dated_ms: Option<i64>,
    pub settled: bool,
}

#[derive(Deserialize)]
struct PublishRequest {
    doc: String,
    #[serde(default)]
    settled: bool,
    #[serde(default)]
    tz_offset_min: i32,
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
    // The preferred date, as the public publish resolves it (identity/routes.rs): the draft's
    // `display_date` with the request's timezone, re-read at every publish.
    let dated_ms = data
        .annotations()
        .field(&draft, store::DISPLAY_DATE)
        .await?
        .and_then(|v| crate::record::documents::claimed_ms(&v, now_ms(), req.tz_offset_min));
    // A future date is a schedule, as for any post (PUBLISH.md ruling 3): a plan on the draft,
    // naming the group and this device, which the publish-due sweep mints (scheduled.rs).
    if let Some(at) = dated_ms.filter(|at| *at > now_ms()) {
        let plan = serde_json::json!({
            "at": at,
            "by": data.leaf_hex(),
            "settled": req.settled,
            "group": hex::encode(group),
        });
        data.annotations().set_field(&draft, store::PUBLISH_PLAN, &plan.to_string()).await?;
        return Ok(Json(serde_json::json!({ "group": hex::encode(group), "scheduled_for": at })));
    }
    let post =
        publish(&state, &data, &root, &group, &draft, Wishes { dated_ms, settled: req.settled })
            .await?;
    clear_plan(&data, &draft).await?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "post": hex::encode(post) })))
}

/// The publish-due sweep's road to a group (scheduled.rs): post the draft its plan names, if
/// its author is still a member - and spend the plan either way, since a refusal now is one
/// later too.
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
    clear_plan(data, draft).await?;
    posted
}

/// A draft posted is no longer planned: its plan, if it had one, is spent.
pub async fn clear_plan(data: &Store, draft: &[u8; 16]) -> Result<(), AppError> {
    if data.annotations().field(draft, store::PUBLISH_PLAN).await?.is_some_and(|p| !p.is_empty()) {
        data.annotations().set_field(draft, store::PUBLISH_PLAN, "").await?;
    }
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
    append_document(
        &state,
        &data,
        &root,
        &group,
        entry_type::POST_RETRACT,
        PostRetraction { doc_id: doc }.encode(),
    )
    .await?;
    // Its draft is a draft again: publishing it now makes a new post (Writer's bar reads this).
    state
        .node_db
        .execute(
            "DELETE FROM group_drafts WHERE root = ?1 AND group_id = ?2 AND post = ?3",
            (root.as_str(), group.to_vec(), doc.to_vec()),
        )
        .await
        .context("forgetting a taken-down post's draft")
        .map_err(AppError::Internal)?;
    Ok(Json(serde_json::json!({ "group": hex::encode(group), "retracted": hex::encode(doc) })))
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
