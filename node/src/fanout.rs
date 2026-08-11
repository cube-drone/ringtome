//! Fan-out: what happens the moment a persona's public lane moves.
//!
//! Two acts, both hanging off the same edge - `net::frontier`'s "the fingerprint moved":
//!
//!   - **Journal locally.** Every reader on this node who follows the persona gets a row in
//!     `feed_journal`. Fast, append-shaped, honest about what came, and nothing more: ordering
//!     and ranking are decided when the reader opens their feed, in their own database where
//!     the interest dials live.
//!   - **Push to the nodes that asked.** For a persona this node AUTHORS, dial everyone in
//!     `identity_demand` and run the ordinary exchange. There is no "new post" message and no
//!     notification format anywhere in this: the push IS a sync, the receiver's own gate
//!     validates what arrives, and the receiver's own journal write is the notification -
//!     evidence crosses wires, opinions stay home.
//!
//! Why the edge is the FRONTIER MAP's and not the eager loop's: the eager tracker fingerprints
//! every chain including the private ones - that is its job, it keeps a persona's own devices
//! current - so a dial hung there would ring strangers' doorbells on every private save, and
//! the TIMING of those dials would leak exactly what canon holds private (the count and cadence
//! of private activity - PROJECT_PLAN, Chains). The frontier map is public-only by
//! construction, so its edge is the one that may be heard off-membrane.
use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::AppState;

/// Dials per public move. Everyone past the cap learns by their own wake pass - "pushes are
/// latency; the pull on re-contact is correctness" (HISTORY 2026-08-07) - and the recency
/// rotation in `demand::askers_of` means the NEXT move pushes to different nodes, so a cap
/// costs a popular persona's quieter followers promptness, never data. The follower side
/// paces itself at 8 pulls per beat (`idface::FOLLOW_REFRESH_CAP`); this is the author
/// side's same-order-of-politeness number. It also bounds the sequential dial loop's worst
/// case to cap x dial-timeout in a background task, which is what demoted concurrent
/// dialing from prerequisite to polish (NEXT_STEPS, Popularity Problems).
const PUSH_DIAL_CAP: i64 = 16;

/// The per-author high-water mark's domain in `sweep_marks`: the newest `updated_ms` this
/// node has journaled for the author, so a move journals only what passed it (the delta)
/// instead of re-upserting the whole page per reader. In-memory and boot-reset like every
/// mark: the first move after a restart re-journals one full page, and the upsert makes
/// that a no-op rather than a duplicate.
const JOURNAL_MARK: &str = "journal";

/// Rows per multi-row journal upsert: 8 binds each, kept well under SQLite's classic
/// 999-variable floor so the statement never outgrows the engine.
const JOURNAL_CHUNK_ROWS: usize = 100;

/// A persona's public frontier moved on this node. Journal it for local readers, and - if the
/// persona is ours to speak for - push it to the nodes that have asked about them.
///
/// Best-effort throughout: this runs behind sweeps and exchanges, and a bookkeeping failure
/// must not fail the machinery that detected the change.
///
/// Returns a BOXED future, and that is load-bearing, not style: the push this starts runs an
/// exchange, and an exchange that ingests something ends by calling back into this function -
/// so an ordinary `async fn` would have a type that contains itself, which Rust cannot name.
/// The erasure is the knot-cut. The runtime cycle is already safe on its own: an up-to-date
/// peer exchanges nothing, `received` stays 0, and the chain goes quiet.
pub fn after_public_move<'a>(
    state: &'a AppState,
    root_hex: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(after_public_move_inner(state, root_hex))
}

async fn after_public_move_inner(state: &AppState, root_hex: &str) {
    // The byline cache rides the same edge: a rename is PROFILE_PUBLIC moving, which is
    // exactly what fired this. Refreshing here (not per-render) is what lets every list on
    // the node answer "who is this?" without opening this persona's database.
    if let Err(e) = crate::profiles::refresh(state, root_hex).await {
        tracing::debug!(root = %root_hex, error = ?e, "byline refresh failed");
    }
    match journal_for(state, root_hex).await {
        Ok(readers) if readers > 0 => {
            tracing::info!(root = %root_hex, readers, "journaled a public move");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(root = %root_hex, error = ?e, "feed journal write failed"),
    }
    match retract_vanished(state, root_hex).await {
        Ok(n) if n > 0 => {
            tracing::info!(root = %root_hex, rows = n, "retracted vanished documents from feeds");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(root = %root_hex, error = ?e, "feed retraction failed"),
    }
    // Push onward only for personas this node authors. Relaying someone ELSE's lane onward is
    // rebroadcast - a consent question, not a routing one - and waits for its own design.
    match crate::identity::is_agented(&state.node_db, root_hex).await {
        Ok(true) => push_to_askers(state, root_hex).await,
        Ok(false) => {}
        Err(e) => tracing::debug!(error = ?e, "agented check failed in fanout"),
    }
}

/// One journal row per (reader who follows them) x (post that moved past the watermark).
///
/// The newest page is the whole journal window, and that bound is doing deliberate work:
/// following someone with years of history journals their latest twenty posts, not their life
/// story ("backfill is the burst to bound" - PROJECT_PLAN, Data Layer). The older posts are not
/// lost - they are on the persona's page, where reading further back is a choice.
///
/// Within the page, only the DELTA is written: the high-water mark remembers the newest
/// `updated_ms` already journaled for this author, so the common move (one new post) writes
/// one row per reader, not the whole page per reader - re-upserting nineteen unchanged rows
/// per reader was most of the fan-out write bill, and it stalled the sweep this runs inside.
async fn journal_for(state: &AppState, author_root: &str) -> Result<usize> {
    let mut readers = crate::net::subscriptions::followers_of(&state.node_db, author_root).await?;
    // Your own posts appear in your own feed, as if you had written them - which you did
    // (Curtis, 2026-08-05). The author follows nobody to get this; being hosted is enough.
    if crate::identity::is_agented(&state.node_db, author_root)
        .await
        .unwrap_or(false)
        && !readers.iter().any(|r| r == author_root)
    {
        readers.push(author_root.to_string());
    }
    // **Not "nobody follows them" - "nobody here wants them at all".** A reader can hold no
    // interest in this author whatsoever and still be owed their documents, because someone
    // that reader DOES follow shared one. Returning early on direct followers alone would make
    // sharing an unfollowed author's post journal to nobody, forever, which is most of what
    // sharing is for.
    if readers.is_empty() && !anyone_shares(state, author_root).await? {
        return Ok(0); // the common case, and it costs one query per index
    }
    let page = shelf_page(state, author_root).await?;
    if page.is_empty() {
        return Ok(0); // the move was profile/keys, not posts - nothing feed-shaped arrived
    }
    // `>=` at the boundary, not `>`: two posts sharing the boundary millisecond but arriving
    // across two exchanges would slip a strict filter forever; re-upserting one boundary row
    // per move costs a fraction of a chunk. A missing mark (first move since boot) takes the
    // whole page - the boot catch-up, and the heal for any mark this logic ever gets wrong.
    let mark = state.sweep_marks.last(JOURNAL_MARK, author_root);
    let fresh: Vec<&JournalRow> = page
        .iter()
        .filter(|r| mark.is_none_or(|m| r.updated_ms >= m))
        .collect();
    if fresh.is_empty() {
        return Ok(0);
    }
    if !readers.is_empty() {
        journal_rows(&state.node_db, author_root, &readers, &fresh, None).await?;
    }
    // The same page, to the people who follow whoever shared these documents.
    if let Err(e) = journal_shares_of(state, author_root, &fresh).await {
        tracing::warn!(author = %author_root, error = ?e, "journaling shares of this author failed");
    }
    // Advance only after the write landed: a failed write leaves the mark behind, and the
    // next move re-journals the same delta (idempotent) instead of skipping it forever.
    if let Some(newest) = page.iter().map(|r| r.updated_ms).max() {
        state.sweep_marks.record(JOURNAL_MARK, author_root, newest);
    }
    Ok(readers.len())
}

/// The author's newest public page, shaped for journaling - the one user-DB open on the
/// journal path, shared by both arrival flows (`journal_for`, `backfill_follow`).
async fn shelf_page(state: &AppState, author_root: &str) -> Result<Vec<JournalRow>> {
    // `get`, not `create`: a followed persona whose content has never arrived here has no
    // shelf to page, and asking for one used to WRITE them an empty database (~96 KB, once
    // per contact - a whole ledger's worth on a device adopting one). Nothing to journal.
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .with_context(|| format!("opening {author_root} to read its shelf"))?
    else {
        return Ok(Vec::new());
    };
    let posts =
        crate::record::documents::public_docs(&db, None, crate::idface::POSTS_PAGE).await?;
    Ok(posts
        .into_iter()
        .map(|p| JournalRow {
            doc_id_hex: hex::encode(p.doc_id),
            title: p.title,
            format: crate::record::documents::Format::from_wire(p.format)
                .as_str()
                .to_string(),
            published_ms: p.genesis_ms,
            updated_ms: p.head_ms,
        })
        .collect())
}

/// One post's journalable facts, computed once per move rather than once per (reader x post).
struct JournalRow {
    doc_id_hex: String,
    title: String,
    format: String,
    published_ms: i64,
    updated_ms: i64,
}

/// Write (reader x post) journal rows as chunked multi-row upserts: one statement - one round
/// trip, one commit - per chunk, where the row-at-a-time version paid both PER ROW and froze
/// the frontier sweep for the duration (this runs inline in it). arrived_ms survives the
/// upsert: it answers "when did this reach me", and a re-publication changes what the post
/// says, not when it arrived.
/// `via_root` is who SHARED these documents into the readers' feeds, or `None` when the readers
/// follow the author directly.
///
/// The upsert's rule for that column is the one judgment in here: **a direct arrival always
/// clears it, and a share never overwrites a direct arrival.** Following someone is the stronger
/// claim - if you follow the author, their post is theirs in your feed, not something a third
/// party showed you - and the two paths race freely (the author moves; someone shares an old
/// post), so which wins has to be a rule rather than an ordering.
async fn journal_rows(
    node_db: &crate::db::Db,
    author_root: &str,
    readers: &[String],
    rows: &[&JournalRow],
    via_root: Option<&str>,
) -> Result<()> {
    let now = now_ms();
    let pairs: Vec<(&String, &&JournalRow)> = readers
        .iter()
        .flat_map(|reader| rows.iter().map(move |row| (reader, row)))
        .collect();
    for chunk in pairs.chunks(JOURNAL_CHUNK_ROWS) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let b = i * 9;
                format!(
                    "(?{},?{},?{},?{},?{},?{},?{},?{},?{})",
                    b + 1,
                    b + 2,
                    b + 3,
                    b + 4,
                    b + 5,
                    b + 6,
                    b + 7,
                    b + 8,
                    b + 9
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO feed_journal
               (reader_root, author_root, doc_id, title, format,
                published_ms, updated_ms, arrived_ms, via_root)
             VALUES {}
             ON CONFLICT (reader_root, author_root, doc_id) DO UPDATE SET
                 title = excluded.title,
                 format = excluded.format,
                 updated_ms = excluded.updated_ms,
                 via_root = CASE
                     WHEN excluded.via_root IS NULL THEN NULL
                     WHEN feed_journal.via_root IS NULL THEN NULL
                     ELSE excluded.via_root
                 END",
            placeholders.join(",")
        );
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|(reader, row)| {
                [
                    turso::Value::Text((*reader).clone()),
                    turso::Value::Text(author_root.to_string()),
                    turso::Value::Text(row.doc_id_hex.clone()),
                    turso::Value::Text(row.title.clone()),
                    turso::Value::Text(row.format.clone()),
                    turso::Value::Integer(row.published_ms),
                    turso::Value::Integer(row.updated_ms),
                    turso::Value::Integer(now),
                    match via_root {
                        Some(v) => turso::Value::Text(v.to_string()),
                        None => turso::Value::Null,
                    },
                ]
            })
            .collect();
        node_db
            .execute(&sql, turso::params_from_iter(params))
            .await
            .context("journaling arrivals")?;
    }
    Ok(())
}

/// Does anyone on this node share a document of this author's? One indexed probe, asked only
/// when no local reader follows them directly.
async fn anyone_shares(state: &AppState, author_root: &str) -> Result<bool> {
    let row: Option<(i64,)> = state
        .node_db
        .fetch_optional(
            "SELECT 1 FROM rebroadcast_pins WHERE author_root = ?1 LIMIT 1",
            (author_root,),
        )
        .await
        .context("checking whether anyone shares this author")?;
    Ok(row.is_some())
}

/// The share side of a public move: when an author's documents change, the people who follow
/// whoever SHARED those documents see the change too.
///
/// Rides inside `journal_for`, on the page it already read, for a reason the conventions cop
/// cares about: the shared documents live in the AUTHOR's database, which is open at exactly
/// this moment and would otherwise have to be reopened once per sharer. The reverse index -
/// which of this author's documents are shared, and by whom - is `rebroadcast_pins`, which is
/// node-level and needs no user database at all.
///
/// Readers come from the rebroadcast dial, never the interest dial: someone who follows the
/// sharer for their writing does not thereby ask for their recommendations.
async fn journal_shares_of(
    state: &AppState,
    author_root: &str,
    fresh: &[&JournalRow],
) -> Result<usize> {
    let pins: Vec<(String, String)> = state
        .node_db
        .fetch_all(
            "SELECT DISTINCT holder_root, doc_id FROM rebroadcast_pins WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("reading who shares this author")?;
    if pins.is_empty() {
        return Ok(0); // nobody here shares them - the common case, one indexed query
    }

    let mut by_holder: std::collections::BTreeMap<String, Vec<&JournalRow>> = Default::default();
    for (holder, doc_hex) in pins {
        if let Some(row) = fresh.iter().find(|r| r.doc_id_hex == doc_hex) {
            by_holder.entry(holder).or_default().push(row);
        }
    }

    let mut written = 0usize;
    for (holder, rows) in by_holder {
        let readers = share_readers(state, &holder).await?;
        if readers.is_empty() {
            continue;
        }
        journal_rows(&state.node_db, author_root, &readers, &rows, Some(&holder)).await?;
        written += readers.len();
    }
    Ok(written)
}

/// Who sees `sharer_root`'s shares: everyone dialled in for their rebroadcasts, plus the sharer
/// themselves. Your own shares belong in your own feed for the same reason your own posts do -
/// you put them there.
async fn share_readers(state: &AppState, sharer_root: &str) -> Result<Vec<String>> {
    let mut readers =
        crate::net::subscriptions::rebroadcast_followers_of(&state.node_db, sharer_root).await?;
    if crate::identity::is_agented(&state.node_db, sharer_root)
        .await
        .unwrap_or(false)
        && !readers.iter().any(|r| r == sharer_root)
    {
        readers.push(sharer_root.to_string());
    }
    Ok(readers)
}

/// A sharer's rebroadcast lane moved: journal what they share to the local readers who follow
/// them for it.
///
/// **This is the path that carries a share ACROSS nodes**, and its absence was a hole in the
/// first cut of the feed: `journal_shares_of` fires on the shared AUTHOR's move, which never
/// happens on a node that does not hold that author, and `backfill_share` fires only in the
/// share route on the sharer's own node. So a reader syncing a foreign sharer's pointers
/// journaled nothing, forever - the normal case for a network with more than one node.
///
/// One user-database open per shared AUTHOR, not per pointer: the documents live in their
/// authors' databases, and a prolific sharer's pointers cluster into far fewer authors than
/// pointers. Bounded further by only opening authors whose documents we actually hold.
///
/// Best-effort: this hangs off a frontier move, and a feed row that fails to write is picked up
/// by the author's next move or the next fold.
pub async fn journal_shares_by(
    state: &AppState,
    sharer_root: &str,
    pointers: &[crate::record::imaol::RebroadcastRow],
) {
    let readers = match share_readers(state, sharer_root).await {
        Ok(r) if !r.is_empty() => r,
        Ok(_) => return, // nobody here follows them for shares - the common case
        Err(e) => {
            tracing::debug!(sharer = %sharer_root, error = ?e, "share readers lookup failed");
            return;
        }
    };

    // Group by author so each author's shelf is opened once, however many of their documents
    // this sharer carries.
    let mut by_author: std::collections::BTreeMap<&str, Vec<&crate::record::imaol::RebroadcastRow>> =
        Default::default();
    for row in pointers.iter().filter(|r| !r.is_retracted()) {
        by_author.entry(&row.author_root).or_default().push(row);
    }

    for (author_root, rows) in by_author {
        let page = match shelf_page(state, author_root).await {
            Ok(p) if !p.is_empty() => p,
            // We hold nothing of this author yet. Correct and expected on a reader's node: the
            // pointer says what was shared, and resolving it to content is the fragment
            // ledger's job, which is not built. The row is simply not written until it can be.
            Ok(_) => continue,
            Err(e) => {
                tracing::debug!(author = %author_root, error = ?e, "shelf read failed for a share");
                continue;
            }
        };
        let wanted: Vec<&JournalRow> = rows
            .iter()
            .filter_map(|r| {
                let doc_hex = hex::encode(r.doc_id);
                page.iter().find(|p| p.doc_id_hex == doc_hex)
            })
            .collect();
        if wanted.is_empty() {
            continue;
        }
        if let Err(e) = journal_rows(
            &state.node_db,
            author_root,
            &readers,
            &wanted,
            Some(sharer_root),
        )
        .await
        {
            tracing::warn!(sharer = %sharer_root, author = %author_root, error = ?e, "journaling a share failed");
        }
    }
}

/// A new share's backfill: the shared document, journaled to the sharer's rebroadcast-followers
/// NOW rather than whenever the original author next posts.
///
/// The exact shape of `backfill_follow`, and for the exact reason: without it the common gesture
/// (share something, look at your feed) shows nothing, because the author may not move again for
/// weeks. One user-database open, on a path a person just clicked - not a loop.
///
/// Infallible by design: the share itself is already signed and on the chain, so a journaling
/// failure must not fail the request. The author's next public move journals it anyway.
pub async fn backfill_share(
    state: &AppState,
    sharer_root: &str,
    author_root: &str,
    doc_id: &[u8; 16],
) {
    let attempt = async {
        let readers = share_readers(state, sharer_root).await?;
        if readers.is_empty() {
            return Ok(0);
        }
        let page = shelf_page(state, author_root).await?;
        let doc_hex = hex::encode(doc_id);
        let Some(row) = page.iter().find(|r| r.doc_id_hex == doc_hex) else {
            // The document is not on the author's shelf here - either we hold nothing of theirs
            // yet (the pin was just written; sync has not run) or it is older than the page.
            // Both heal on the author's next move, which is why this is not an error.
            return Ok(0);
        };
        journal_rows(&state.node_db, author_root, &readers, &[row], Some(sharer_root)).await?;
        Ok::<usize, anyhow::Error>(readers.len())
    };
    match attempt.await {
        Ok(n) if n > 0 => {
            tracing::info!(sharer = %sharer_root, author = %author_root, readers = n, "backfilled a share");
        }
        Ok(_) => {}
        Err(e) => {
            tracing::warn!(sharer = %sharer_root, author = %author_root, error = ?e, "share backfill failed")
        }
    }
}

/// A new follow's backfill: the author's newest page, journaled to this one reader, NOW -
/// not whenever the author next moves. Without this, the common gesture (follow from their
/// /id page, which already resynced them on visit) followed nothing: the follow-moment sync
/// receives zero, `after_public_move` never fires, and the feed stays empty until the author
/// next posts. Same burst-to-bound as any backfill: their latest page, not their life story.
///
/// Infallible by design: the caller is the subscription memo's refresh, and a persona whose
/// database is not here yet (followed by pasted address, never synced) must not fail it -
/// the first real sync will fire `after_public_move` and journal them then.
pub async fn backfill_follow(state: &AppState, reader_root: &str, author_root: &str) {
    // The FULL page, never the watermark's delta: the mark records what current followers
    // already have, and this reader is new and has none of it.
    let just_them = [reader_root.to_string()];
    let attempt = async {
        let page = shelf_page(state, author_root).await?;
        if page.is_empty() {
            return Ok(0);
        }
        let all: Vec<&JournalRow> = page.iter().collect();
        journal_rows(&state.node_db, author_root, &just_them, &all, None).await?;
        Ok::<usize, anyhow::Error>(1)
    };
    match attempt.await {
        Ok(n) if n > 0 => {
            tracing::info!(reader = %reader_root, author = %author_root, "backfilled a new follow");
        }
        Ok(_) => {}
        Err(e) => {
            tracing::debug!(reader = %reader_root, author = %author_root, error = ?e,
                "follow backfill skipped - their shelf isn't here yet");
        }
    }
}

/// The journal's other direction: rows whose DOCUMENTS are gone. The upsert half above only
/// ever adds and updates; this is the reconcile that makes the journal honest when the public
/// lane shrinks - today that means a repudiation's genesis cut ("that device was never me"),
/// whose eviction deletes the disproven entries and refolds every view. The feed journal is a
/// delivery memo, not a view over the log, so the rebuild never touches it - without this, a
/// disproven post's title kept rendering in every follower's feed as live content, laundered
/// by the delivery record of a delivery nobody can re-verify.
///
/// Retraction DELETES, no tombstone - same doctrine as the unfollow excision: the rows are
/// bookkeeping, not history, and a "previously delivered" marker would keep disproven words
/// in the room under a politer name. Runs on the same edge as journaling and reconciles ALL
/// readers' rows for this author at once; the empty-journal early return keeps the common
/// case (nobody here ever heard of them) at one indexed query.
async fn retract_vanished(state: &AppState, author_root: &str) -> Result<u64> {
    let journaled: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT DISTINCT doc_id FROM feed_journal WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("listing an author's journaled documents")?;
    if journaled.is_empty() {
        return Ok(0);
    }
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .with_context(|| format!("opening {author_root} to check its public lane"))?
    else {
        return Ok(0); // nothing of theirs held: nothing to reconcile against
    };
    // **Serialized against eviction, because this is the one reader that DESTROYS state based
    // on what it sees.** `drop_views_fed_by` clears the document views and their watermarks in
    // separate statements, and `Db::execute` takes `stmt_lock` per statement - so between the
    // two there is a real window where `doc_heads` is empty while the POSTS watermark still
    // says "already folded". `public_doc_ids` catches up before reading, which heals every
    // other reader, but a catch-up finds nothing past an un-cleared watermark: inside that
    // window the shelf reads as legitimately EMPTY. Any other reader shrugs and renders an
    // empty page for a millisecond. This one concludes every journaled document has vanished
    // and deletes the lot - including an honest post whose row nothing will ever rewrite,
    // because the journal is only written forward on a public move that has already happened.
    //
    // The eviction path runs under this same gate (`net::sync::ingest_batch` holds it across
    // `refold_after_eviction`), so taking it here is what makes "the views are settled" true
    // rather than likely. No deadlock: `lock_ingest` is acquired in exactly one other place,
    // and `after_public_move` is never called from inside it.
    let _gate = db.lock_ingest().await;
    let alive = crate::record::documents::public_doc_ids(&db).await?;
    let stale: Vec<String> = journaled
        .into_iter()
        .map(|(id,)| id)
        .filter(|id| !alive.contains(id))
        .filter(|id| id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit()))
        .collect();
    if stale.is_empty() {
        return Ok(0);
    }
    let quoted: Vec<String> = stale.iter().map(|id| format!("'{id}'")).collect();
    state
        .node_db
        .execute(
            &format!(
                "DELETE FROM feed_journal WHERE author_root = ?1 AND doc_id IN ({})",
                quoted.join(",")
            ),
            (author_root,),
        )
        .await
        .context("retracting vanished documents from the feed journal")?;
    Ok(stale.len() as u64)
}

/// Unfollow (or block) excises: every journal row from an author this reader no longer
/// eagerly follows is deleted, in the same breath that drops the subscription. "Don't show"
/// means it retroactively too - the feed is the reader's room, and stopping listening to
/// someone includes what they already said in it. The rows are a node-level delivery memo,
/// not history (the posts still exist on the author's shelf; a re-follow backfills them
/// right back), so deletion loses nothing anyone owns.
///
/// `unfollowed` is the DELTA - the authors who just crossed out of the eager set - because
/// the subscription rewrite is the one place that knows it, and the delta is almost always
/// one name. The old form took the whole eager set and deleted its complement (a NOT IN
/// literal that grew with the follow count and re-parsed per call); rows for never-followed
/// authors don't exist to need that healing - journaling only ever writes for eager
/// followers, and the journal is disposable besides. Own rows stay exempt (your posts are
/// in your feed because you are hosted here, not because you follow yourself).
pub async fn excise_unfollowed(
    state: &AppState,
    reader_root: &str,
    unfollowed: &[String],
) -> Result<()> {
    for author in unfollowed.iter().filter(|a| *a != reader_root) {
        state
            .node_db
            .execute(
                "DELETE FROM feed_journal WHERE reader_root = ?1 AND author_root = ?2",
                (reader_root, author.as_str()),
            )
            .await
            .context("excising an unfollowed author from the feed journal")?;
    }
    Ok(())
}

/// Dial the nodes that have asked about this persona, in the background - a dead asker's
/// timeout must not stall the sweep that noticed the post.
///
/// The persona's own devices are excluded: the eager loop already keeps them current on its
/// own debounce, and dialing them twice buys nothing but a no-op exchange.
async fn push_to_askers(state: &AppState, root_hex: &str) {
    let askers = match crate::net::demand::askers_of(&state.node_db, root_hex, PUSH_DIAL_CAP).await
    {
        Ok(a) => a,
        Err(e) => {
            tracing::debug!(error = ?e, "reading demand for fanout failed");
            return;
        }
    };
    let devices: std::collections::HashSet<String> =
        match crate::net::sync::peers_for(&state.node_db, root_hex).await {
            Ok(p) => p.into_iter().collect(),
            Err(_) => Default::default(),
        };
    let targets: Vec<String> = askers.into_iter().filter(|a| !devices.contains(a)).collect();
    if targets.is_empty() {
        return;
    }
    let state = state.clone();
    let root = root_hex.to_string();
    tokio::spawn(async move {
        match crate::net::sync::sync_peers(&state, &root, &targets).await {
            Ok(results) => {
                let reached = results.iter().filter(|r| r.ok).count();
                tracing::info!(root = %root, reached, of = results.len(),
                    "pushed a public move to the nodes that asked");
            }
            Err(e) => tracing::debug!(root = %root, error = ?e, "fanout push failed"),
        }
    });
}

/// One row of a reader's feed, as the journal holds it.
#[derive(Debug, Clone)]
pub struct FeedRow {
    pub author_root: String,
    /// Who shared this into the reader's feed, if it arrived by rebroadcast rather than by a
    /// follow. `None` is the ordinary case and means "you follow this author".
    pub via_root: Option<String>,
    pub doc_id: String,
    pub title: String,
    pub format: Option<String>,
    pub published_ms: i64,
    pub updated_ms: i64,
    pub arrived_ms: i64,
}

/// One page of a reader's feed, strictly chronological (published DESC), keyset-cursored like
/// the public shelf - and for the same reason: this stream grows at the head while somebody
/// reads down it, and an offset would skip a row for every arrival.
///
/// Chronology is the WHOLE ordering, deliberately: how a good feed ranks is a million-dollar
/// question this draft does not pretend to answer. The reader's interest dials affect only how
/// items RENDER (size, opacity, truncation) - which is the client's business, off its own
/// mirror, where those dials live.
pub async fn feed_page(
    node_db: &crate::db::Db,
    reader_root: &str,
    before: Option<(i64, String)>,
    limit: i64,
) -> Result<Vec<FeedRow>> {
    type Row = (String, Option<String>, String, String, Option<String>, i64, i64, i64);
    // Text only, twice over: the shelf read upstream no longer journals media documents at
    // all (`public_docs` filters them - they're ingredients, not posts), and this clause
    // makes journals written BEFORE that filter harmless rather than a page of raw bytes
    // rendered as text.
    let rows: Vec<Row> = match before {
        None => node_db
            .fetch_all(
                "SELECT author_root, via_root, doc_id, title, format, published_ms, updated_ms, arrived_ms
                 FROM feed_journal WHERE reader_root = ?1
                   AND format IN ('marquee', 'plaintext')
                 ORDER BY published_ms DESC, doc_id LIMIT ?2",
                (reader_root, limit),
            )
            .await,
        // Numbered placeholders: ?2 appears twice and binds ONE value - the first version
        // passed `ms` twice and bound five values into four slots, which turso refused with
        // "bind index 5 out of bounds"... only on the cursor branch, which no test paged.
        Some((ms, doc)) => node_db
            .fetch_all(
                "SELECT author_root, via_root, doc_id, title, format, published_ms, updated_ms, arrived_ms
                 FROM feed_journal WHERE reader_root = ?1
                   AND format IN ('marquee', 'plaintext')
                   AND (published_ms < ?2 OR (published_ms = ?2 AND doc_id > ?3))
                 ORDER BY published_ms DESC, doc_id LIMIT ?4",
                (reader_root, ms, doc.as_str(), limit),
            )
            .await,
    }
    .context("reading a feed page")?;
    Ok(rows
        .into_iter()
        .map(
            |(author_root, via_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)| FeedRow {
                author_root,
                via_root,
                doc_id,
                title,
                format,
                published_ms,
                updated_ms,
                arrived_ms,
            },
        )
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(doc: &str, title: &str, updated_ms: i64) -> JournalRow {
        JournalRow {
            doc_id_hex: format!("{doc:0>32}"),
            title: title.to_string(),
            format: "plaintext".to_string(),
            published_ms: 1_000,
            updated_ms,
        }
    }

    /// The one judgment in the write path, and both directions of it. Following someone is the
    /// stronger claim: their post is THEIRS in your feed, not something a third party showed
    /// you. The two paths race freely - the author moves, someone shares an old post - so which
    /// wins has to be a rule rather than an ordering.
    #[tokio::test]
    async fn a_direct_follow_outranks_a_share_whichever_lands_first() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let sharer = "bb".repeat(32);
        let reader = vec!["cc".repeat(32)];
        let posts = [post("0", "words", 1_000)];
        let refs: Vec<&JournalRow> = posts.iter().collect();

        let via = |db: &crate::db::Db| {
            let db = db.clone();
            async move {
                let row: (Option<String>,) = db
                    .fetch_one("SELECT via_root FROM feed_journal", ())
                    .await
                    .unwrap();
                row.0
            }
        };

        // Share first, then the direct arrival: the share's byline is cleared.
        journal_rows(&db, &author, &reader, &refs, Some(&sharer)).await.unwrap();
        assert_eq!(via(&db).await.as_deref(), Some(sharer.as_str()));
        journal_rows(&db, &author, &reader, &refs, None).await.unwrap();
        assert_eq!(via(&db).await, None, "a direct arrival clears the share byline");

        // And the other order: a share must not overwrite a row that arrived directly.
        journal_rows(&db, &author, &reader, &refs, Some(&sharer)).await.unwrap();
        assert_eq!(
            via(&db).await,
            None,
            "once you follow the author, a share does not relabel their post"
        );
    }

    /// Two people sharing the same document is still one row per reader - the journal is keyed
    /// per (reader, author, doc), and a post does not appear twice because it was popular.
    #[tokio::test]
    async fn a_document_shared_twice_is_still_one_row() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let reader = vec!["cc".repeat(32)];
        let posts = [post("0", "words", 1_000)];
        let refs: Vec<&JournalRow> = posts.iter().collect();

        journal_rows(&db, &author, &reader, &refs, Some(&"b1".repeat(32))).await.unwrap();
        journal_rows(&db, &author, &reader, &refs, Some(&"b2".repeat(32))).await.unwrap();

        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(count, 1, "popularity does not duplicate a post in one feed");
    }

    /// The load-bearing claim: turso executes a MULTI-ROW upsert - many VALUES groups, one
    /// ON CONFLICT with `excluded.` references - correctly across chunk boundaries. This is
    /// the statement shape the batching rests on, and the reason it gets a real database
    /// rather than a reading of the docs.
    #[tokio::test]
    async fn journal_rows_batches_across_chunks_and_upserts() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let readers: Vec<String> = (0..3).map(|i| format!("{i:0>64}")).collect();
        let posts: Vec<JournalRow> = (0..40)
            .map(|i| post(&i.to_string(), "first words", 2_000 + i))
            .collect();
        let refs: Vec<&JournalRow> = posts.iter().collect();

        // 3 readers x 40 posts = 120 pairs: two chunks, the second partial.
        journal_rows(&db, &author, &readers, &refs, None).await.unwrap();
        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(count, 120);

        // The upsert half: re-journal one edited post. A sentinel arrival stamp proves the
        // conflict arm ran an UPDATE (not insert-or-ignore) and left arrived_ms alone.
        db.execute("UPDATE feed_journal SET arrived_ms = 42", ())
            .await
            .unwrap();
        let edited = [post("0", "better words", 9_000)];
        let edited_refs: Vec<&JournalRow> = edited.iter().collect();
        journal_rows(&db, &author, &readers, &edited_refs, None).await.unwrap();

        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(count, 120, "an edit rewrites rows, never adds them");
        let rows: Vec<(String, i64, i64)> = db
            .fetch_all(
                "SELECT title, updated_ms, arrived_ms FROM feed_journal WHERE doc_id = ?1",
                (format!("{:0>32}", "0"),),
            )
            .await
            .unwrap();
        assert_eq!(rows.len(), 3);
        for (title, updated_ms, arrived_ms) in rows {
            assert_eq!(title, "better words");
            assert_eq!(updated_ms, 9_000);
            assert_eq!(arrived_ms, 42, "arrival is set once, never rewritten");
        }
    }
}
