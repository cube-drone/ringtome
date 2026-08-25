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

/// How far back the feed reaches, ever: one year. The follow point is the guarantee -
/// everything published after it must land in the feed, holes forbidden - and history
/// before it is a courtesy with a floor, not an obligation to genesis (Curtis, 2026-08-16).
/// Both walks honor it: the forward catch-up will not page past it chasing an ancient mark,
/// and the backward dig declares itself done on reaching it.
const FILL_HORIZON_MS: i64 = 365 * 24 * 3600 * 1000;

/// Follow edges the history dig advances per beat. A pace, not a cap: every pair is reached,
/// a page at a time, round after round - this only bounds how many author shelves one beat
/// opens (the census's concern) and how fast a fresh node's node.db grows.
const FILL_PAIRS_PER_BEAT: usize = 4;

/// The forward high-water mark: the newest `updated_ms` this node has journaled for the
/// author, so a move journals only what passed it (the delta) instead of re-upserting the
/// whole page per reader. PERSISTED (2026-08-16, `journal_marks`) - it lived in sweep_marks,
/// in-memory and boot-reset, which quietly capped every catch-up at one page: a node dark
/// (or merely rebooted) through more than twenty posts journaled the newest twenty and
/// skipped the rest forever, despite holding the full chain. Durable, the mark makes the gap
/// exact, and `journal_for` pages down until it closes it.
async fn journal_mark(node_db: &crate::db::Db, author_root: &str) -> Result<Option<i64>> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT newest_ms FROM journal_marks WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("reading the journal mark")?;
    Ok(row.map(|(ms,)| ms))
}

/// Advance the mark, monotone - the chain_heads discipline: lagging under-reports, and an
/// under-report re-upserts idempotently; leading would skip rows forever.
async fn record_journal_mark(node_db: &crate::db::Db, author_root: &str, newest_ms: i64) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO journal_marks (author_root, newest_ms) VALUES (?1, ?2)
             ON CONFLICT (author_root) DO UPDATE SET newest_ms = excluded.newest_ms
             WHERE excluded.newest_ms > newest_ms",
            (author_root, newest_ms),
        )
        .await
        .context("advancing the journal mark")?;
    Ok(())
}

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
    // The same event, mirrored into the death log: `retract_vanished` reconciles this node's
    // FEEDS against the author's shelf; this makes the deaths this node just learned SERVABLE,
    // proofs attached, to anyone who asks "what died since N?" (fragments::deaths_since). Both
    // ride the public move because both are consequences of exactly it.
    crate::fragments::mirror_retractions(state, root_hex).await;
    // The edge graph rides the same move: if the mover publishes edges, re-mirror them into
    // the node-level graph (probe-gated inside - a persona with no follows-public chain
    // costs one primary-key read).
    crate::edgegraph::refresh_from(state, root_hex).await;
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
/// Only the DELTA is written: the persisted high-water mark remembers the newest
/// `updated_ms` already journaled for this author, so the common move (one new post) writes
/// one row per reader, not the whole page per reader - re-upserting nineteen unchanged rows
/// per reader was most of the fan-out write bill, and it stalled the sweep this runs inside.
///
/// The catch-up is EXACT (2026-08-16): the walk pages down the shelf until the gap to the
/// mark closes, so a node dark through two hundred posts journals two hundred rows on its
/// first move - coverage after the follow point is contiguous, holes forbidden. Two floors
/// bound the walk: the year horizon (nothing older ever journals), and on a first-ever move
/// (no mark) the single newest page - the new-follow burst-to-bound, with everything older
/// left to the history dig's pace (`fill_pass`).
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
    // that reader DOES follow shared one - or because their trust graph vouches for the
    // author (DISCOVERY slice 2: the demand rollup is the THIRD reader criterion beside
    // followers and share-followers). Returning early on direct followers alone would make
    // both arrival paths journal to nobody, forever.
    let mut wanting = crate::speculative::wanting_readers(&state.node_db, author_root).await?;
    wanting.retain(|(reader, _)| !readers.contains(reader));
    if readers.is_empty() && wanting.is_empty() && !anyone_shares(state, author_root).await? {
        return Ok(0); // the common case, and it costs one query per index
    }
    let mark = journal_mark(&state.node_db, author_root).await?;
    // Where the walk may stop paging. A missing mark (first move ever for this author) means
    // the newest page alone - `i64::MAX` stops the walk after one page. Otherwise the walk
    // owes every row whose updated_ms could pass the filter below, and pages are keyed by
    // GENESIS - but the edit window bounds how far updated_ms can outrun genesis_ms, so
    // `mark - edit_window` is the genesis depth that provably covers them all. The horizon
    // floors both cases.
    let floor = mark
        .map_or(i64::MAX, |m| {
            m.saturating_sub(crate::record::documents::edit_window_ms())
        })
        .max(now_ms() - FILL_HORIZON_MS);
    let mut cursor: Option<(i64, [u8; 16])> = None;
    let mut fresh: Vec<JournalRow> = Vec::new();
    let mut newest: Option<i64> = None;
    // The newest page whole, for the speculative readers below: their rows are the
    // burst-to-bound with no year dig - the history courtesy belongs to chosen
    // relationships (DISCOVERY stage 3) - so however deep the mark-driven walk goes for
    // the real readers, speculation journals from this page alone.
    let mut first_page: Vec<JournalRow> = Vec::new();
    loop {
        let page = shelf_page(state, author_root, cursor).await?;
        let Some(last) = page.last() else {
            break; // the shelf ends (or was empty: the move was profile/keys, not posts)
        };
        if first_page.is_empty() {
            first_page = page.clone();
        }
        newest = newest.max(page.iter().map(|r| r.updated_ms).max());
        let bottom = last.published_ms;
        cursor = last.cursor();
        // `>=` at the boundary, not `>`: two posts sharing the boundary millisecond but
        // arriving across two exchanges would slip a strict filter forever; re-upserting one
        // boundary row per move costs a fraction of a chunk.
        fresh.extend(
            page.into_iter()
                .filter(|r| mark.is_none_or(|m| r.updated_ms >= m)),
        );
        if bottom < floor || cursor.is_none() {
            break; // the gap is closed (or a corrupt id ended the keyset - the dig's backstop)
        }
    }
    if fresh.is_empty() {
        return Ok(0);
    }
    let fresh: Vec<&JournalRow> = fresh.iter().collect();
    if !readers.is_empty() {
        journal_rows(&state.node_db, author_root, &readers, &fresh, None).await?;
    }
    // The third criterion's rows: marked, bylined with each pair's introducer, newest page
    // only, and never touching a row that already exists (journal_rows_suggested's DO
    // NOTHING is the whole precedence ladder). Best-effort beside the real writes - a
    // speculative miss is the next move's to retry, not this journal's to fail.
    if !wanting.is_empty() && !first_page.is_empty() {
        let suggested: Vec<&JournalRow> = first_page.iter().collect();
        if let Err(e) =
            journal_rows_suggested(&state.node_db, author_root, &wanting, &suggested).await
        {
            tracing::warn!(author = %author_root, error = ?e, "journaling speculative rows failed");
        }
    }
    // The same rows, to the people who follow whoever shared these documents.
    if let Err(e) = journal_shares_of(state, author_root, &fresh).await {
        tracing::warn!(author = %author_root, error = ?e, "journaling shares of this author failed");
    }
    // Advance only after the write landed: a failed write leaves the mark behind, and the
    // next move re-journals the same delta (idempotent) instead of skipping it forever.
    if let Some(newest) = newest {
        record_journal_mark(&state.node_db, author_root, newest).await?;
    }
    Ok(readers.len() + wanting.len())
}

/// One public page of the author's shelf, shaped for journaling - the one user-DB open on
/// the journal path, shared by all three arrival flows (`journal_for`, `backfill_follow`,
/// `fill_pass`). `after` is `public_docs`' keyset cursor: None is the newest page, and a
/// row's own [`JournalRow::cursor`] resumes below it.
async fn shelf_page(
    state: &AppState,
    author_root: &str,
    after: Option<(i64, [u8; 16])>,
) -> Result<Vec<JournalRow>> {
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
        crate::record::documents::public_docs(&db, after, crate::idface::POSTS_PAGE).await?;
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
#[derive(Clone)]
pub(crate) struct JournalRow {
    pub(crate) doc_id_hex: String,
    pub(crate) title: String,
    pub(crate) format: String,
    pub(crate) published_ms: i64,
    pub(crate) updated_ms: i64,
}

impl JournalRow {
    /// This row as a `public_docs` keyset cursor - the next page begins below it. None only
    /// for a doc_id that is not 16 hex-decoded bytes, which no fold ever writes; the callers
    /// treat it as "stop paging", never as an error to propagate mid-walk.
    fn cursor(&self) -> Option<(i64, [u8; 16])> {
        let bytes = hex::decode(&self.doc_id_hex).ok()?;
        Some((self.published_ms, <[u8; 16]>::try_from(bytes.as_slice()).ok()?))
    }
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
///
/// Between two SHARERS, the first one keeps the column: `via_root` is the INTRODUCER, the person
/// this document reached you through, and that is a fact about the past like `arrived_ms` beside it
/// rather than a slot for whoever spoke most recently. It used to take the newest sharer, which
/// made a viral post's byline mutate under the reader while the words never changed, and named
/// somebody arbitrary while dropping everyone else in silence. Who ELSE passed it along is a
/// question with a real answer now ([`followed_sharers`]), asked at read time.
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
                     -- A follow arrival outranks any byline: the reader pulls this author.
                     WHEN excluded.via_root IS NULL THEN NULL
                     -- A share CONVERTS a speculative row - byline set, marking shed below.
                     -- Without this branch a via-less speculative row read as \"follow row\"
                     -- and the share's byline was dropped whenever the acquisition pass won
                     -- the race to journal first (2026-08-25, three CI flakes' one face).
                     WHEN feed_journal.suggested_via IS NOT NULL THEN excluded.via_root
                     -- A genuine follow row stays a follow row, whoever shares it later.
                     WHEN feed_journal.via_root IS NULL THEN NULL
                     -- Among sharers, the first sighted keeps the byline.
                     ELSE feed_journal.via_root
                 END,
                 suggested_via = NULL",
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
    if let Some(via) = via_root {
        remember_sharer(node_db, author_root, readers, rows, via, now).await?;
    }
    Ok(())
}

/// The speculative twin of [`journal_rows`] (DISCOVERY slice 2): rows for readers whose
/// trust graph admits the author, marked with `suggested_via` - the introducer whose vouch
/// journaled them, `via_root`'s sibling and the same kind of fact about the past.
///
/// `ON CONFLICT DO NOTHING` is the whole precedence ladder in one clause: a row that
/// already exists is never touched, whichever kind it is. Real beats speculative (a
/// follow's or share's row keeps its standing when speculation arrives late), and between
/// two introducers the first keeps the byline - the same first-sighting rule `via_root`
/// settled on, for the same reason: the byline is a fact about how the document reached
/// you, not a slot for whoever vouched most recently. Conversion runs the other way in
/// [`journal_rows`]: any real arrival clears the marking in place.
/// Excise an evicted author's SPECULATIVE feed rows, every reader at once (DISCOVERY slice
/// 4): rows a vouch journaled and no dial ever claimed go with the mirror that backed them.
/// Real rows are untouched by construction - an author with real rows has a subscription or
/// a share standing, and the eviction sweep never reaches them.
pub async fn excise_suggested(node_db: &crate::db::Db, author_root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM feed_journal WHERE author_root = ?1 AND suggested_via IS NOT NULL",
            (author_root,),
        )
        .await
        .context("excising an evicted author's speculative rows")?;
    Ok(())
}

async fn journal_rows_suggested(
    node_db: &crate::db::Db,
    author_root: &str,
    wanting: &[(String, String)],
    rows: &[&JournalRow],
) -> Result<()> {
    let now = now_ms();
    let pairs: Vec<(&String, &String, &&JournalRow)> = wanting
        .iter()
        .flat_map(|(reader, introducer)| rows.iter().map(move |row| (reader, introducer, row)))
        .collect();
    for chunk in pairs.chunks(JOURNAL_CHUNK_ROWS) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let b = i * 9;
                format!(
                    "(?{},?{},?{},?{},?{},?{},?{},?{},?{})",
                    b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7, b + 8, b + 9
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO feed_journal
               (reader_root, author_root, doc_id, title, format,
                published_ms, updated_ms, arrived_ms, suggested_via)
             VALUES {}
             ON CONFLICT (reader_root, author_root, doc_id) DO NOTHING",
            placeholders.join(",")
        );
        let params: Vec<turso::Value> = chunk
            .iter()
            .flat_map(|(reader, introducer, row)| {
                [
                    turso::Value::Text((*reader).clone()),
                    turso::Value::Text(author_root.to_string()),
                    turso::Value::Text(row.doc_id_hex.clone()),
                    turso::Value::Text(row.title.clone()),
                    turso::Value::Text(row.format.clone()),
                    turso::Value::Integer(row.published_ms),
                    turso::Value::Integer(row.updated_ms),
                    turso::Value::Integer(now),
                    turso::Value::Text((*introducer).clone()),
                ]
            })
            .collect();
        node_db
            .execute(&sql, turso::params_from_iter(params))
            .await
            .context("journaling speculative rows")?;
    }
    Ok(())
}

/// Note that this sharer passed these documents to these readers - the crowd `feed_journal`'s one
/// row cannot hold (`feed_shares`).
///
/// `DO NOTHING` on conflict, so `shared_ms` keeps the moment we FIRST heard it from them. Every
/// frontier move re-folds a sharer's whole pointer list, so this runs constantly with nothing new
/// to say, and a stamp that crept forward on each pass would slowly reorder the crowd and unseat
/// the introducer.
async fn remember_sharer(
    node_db: &crate::db::Db,
    author_root: &str,
    readers: &[String],
    rows: &[&JournalRow],
    via_root: &str,
    now: i64,
) -> Result<()> {
    for reader in readers {
        for row in rows {
            node_db
                .execute(
                    "INSERT INTO feed_shares
                       (reader_root, author_root, doc_id, via_root, shared_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (reader_root, author_root, doc_id, via_root) DO NOTHING",
                    (
                        reader.as_str(),
                        author_root,
                        row.doc_id_hex.as_str(),
                        via_root,
                        now,
                    ),
                )
                .await
                .context("noting who passed a document along")?;
        }
    }
    Ok(())
}

/// A sharer withdrew: forget that they ever passed this document along, in every feed on this node.
///
/// Runs for FOREIGN sharers as well as hosted ones, which is the whole point - the crowd is made of
/// people on other computers, and "I stopped sharing this" has to be able to shrink it. The feed row
/// itself is not touched here: it may have arrived through somebody else entirely, and whether it
/// survives is `excise_shared`'s question, asked of the fragment rather than of any one sharer.
pub async fn forget_sharer(
    node_db: &crate::db::Db,
    via_root: &str,
    author_root: &str,
    doc_id: &str,
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM feed_shares
             WHERE author_root = ?1 AND doc_id = ?2 AND via_root = ?3",
            (author_root, doc_id, via_root),
        )
        .await
        .context("forgetting a withdrawn share")?;
    Ok(())
}

/// Every trace of a departing persona's feed crowd: the rows in THEIR feed, and their name in
/// everybody else's. The counterpart to `rebroadcast::forget_holder`, for the same moment.
pub async fn forget_reader_shares(node_db: &crate::db::Db, root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM feed_shares WHERE reader_root = ?1 OR via_root = ?1",
            (root,),
        )
        .await
        .context("dropping a departing persona's share crowd")?;
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
    let pins: Vec<(String, String, i64)> = state
        .node_db
        .fetch_all(
            "SELECT DISTINCT holder_root, doc_id, updated_ms FROM rebroadcast_pins
             WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("reading who shares this author")?;
    if pins.is_empty() {
        return Ok(0); // nobody here shares them - the common case, one indexed query
    }

    let mut by_holder: std::collections::BTreeMap<String, Vec<JournalRow>> = Default::default();
    for (holder, doc_hex, shared_ms) in pins {
        if let Some(row) = fresh.iter().find(|r| r.doc_id_hex == doc_hex) {
            by_holder
                .entry(holder)
                .or_default()
                .push(as_shared(row, shared_ms));
        }
    }

    let mut written = 0usize;
    for (holder, rows) in by_holder {
        let rows: Vec<&JournalRow> = rows.iter().collect();
        let readers = share_readers(state, &holder).await?;
        if readers.is_empty() {
            continue;
        }
        journal_rows(&state.node_db, author_root, &readers, &rows, Some(&holder)).await?;
        written += readers.len();
    }
    Ok(written)
}

/// One post's facts, restamped as a SHARE rather than as its author's publication.
///
/// **The feed-worthy event is the share, not the writing** (Curtis, 2026-08-11). A three-year-old
/// post passed along today is news today; sorting it by when it was written buries it three years
/// down the reader's feed, where nobody will ever see the thing their friend just recommended.
/// The first cut got this wrong twice - once by keeping the author's genesis stamp, once by using
/// the moment the fragment happened to be fetched, which is an implementation artifact with no
/// meaning to any reader.
///
/// The stamp is the POINTER'S ARRIVAL on this node, not the sharer's claimed clock. Same choice
/// the bell already makes for published edges ("this replica's arrival stamp - the bell orders by
/// it"), and it buys the same thing: no trusting a stranger's wall clock, so nobody pins
/// themselves to the top of everyone's feed forever by claiming next Tuesday. The honest cost is
/// that two readers can order the same share slightly differently - by when each of them learned
/// of it - which is already true of every notification.
///
/// `updated_ms` keeps the author's own, because that answers a different question: the share is
/// when this reached you, and `updated_ms` is when the words last changed.
fn as_shared(row: &JournalRow, shared_ms: i64) -> JournalRow {
    JournalRow {
        published_ms: shared_ms,
        ..row.clone()
    }
}

/// Journal one share whose content arrived late - the delivery the original fold could not
/// make because the fragment fetch failed the first time (`fragments::drain_wants`).
/// Every sharer of one document that ANY local reader follows - the union, over readers, of
/// the per-reader byline ledger (2026-08-15, the multi-origin walk). NOT a sharer index: a row
/// exists only where journaling delivered through a real follow edge, so this is exactly
/// "relationships this node's own users created", which is the bound the candidate walk should
/// have. Introducer-first, deterministically - the earliest to stand behind the document is
/// asked first.
pub async fn sharers_of_doc(
    node_db: &crate::db::Db,
    author_root: &str,
    doc_hex: &str,
) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT via_root FROM feed_shares
             WHERE author_root = ?1 AND doc_id = ?2
             GROUP BY via_root ORDER BY MIN(shared_ms)",
            (author_root, doc_hex),
        )
        .await
        .context("listing a document's sharers")?;
    Ok(rows.into_iter().map(|(v,)| v).collect())
}

/// The per-AUTHOR union of the same - the blob-healing candidates: bodies are wanted per
/// author, and any sharer of ANY of their documents this node journals is a node that holds
/// (or knows who holds) that author's public bytes.
pub async fn sharers_of_author(
    node_db: &crate::db::Db,
    author_root: &str,
) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT via_root FROM feed_shares WHERE author_root = ?1
             GROUP BY via_root ORDER BY MIN(shared_ms)",
            (author_root,),
        )
        .await
        .context("listing an author's sharers")?;
    Ok(rows.into_iter().map(|(v,)| v).collect())
}

pub(crate) async fn journal_late_share(
    state: &AppState,
    sharer_root: &str,
    author_root: &str,
    row: &JournalRow,
) {
    let readers = match share_readers(state, sharer_root).await {
        Ok(r) if !r.is_empty() => r,
        _ => return,
    };
    let shared = as_shared(row, now_ms());
    if let Err(e) = journal_rows(
        &state.node_db,
        author_root,
        &readers,
        &[&shared],
        Some(sharer_root),
    )
    .await
    {
        tracing::warn!(sharer = %sharer_root, author = %author_root, error = ?e, "late share journal failed");
    }
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
        Ok(_) => {
            tracing::debug!(sharer = %sharer_root, "share fold: nobody here follows their shares");
            return;
        }
        Err(e) => {
            tracing::debug!(sharer = %sharer_root, error = ?e, "share readers lookup failed");
            return;
        }
    };
    tracing::debug!(
        sharer = %sharer_root,
        readers = readers.len(),
        pointers = pointers.len(),
        "share fold: resolving shared documents"
    );

    // Group by author so each author's shelf is opened once, however many of their documents
    // this sharer carries.
    let mut by_author: std::collections::BTreeMap<&str, Vec<&crate::record::imaol::RebroadcastRow>> =
        Default::default();
    for row in pointers.iter().filter(|r| !r.is_retracted()) {
        by_author.entry(&row.author_root).or_default().push(row);
    }

    for (author_root, rows) in by_author {
        // Our own copy of the author's shelf, when we have one AND a relationship keeps it
        // current - `speculative::speculative_only`, the same freshness-contract gate the
        // fragment door applies, and it MUST be the same gate (2026-08-22, the intermittent
        // fourth-hop red): this fold once read a hunch-held mirror's shelf, journaled the
        // share from it, and minted no fragment - so this node's own reader saw the post
        // while the door, rightly hiding the hunch, had NOTHING to serve the next hop. A
        // journaled share must leave the node able to answer for it, and the fragment path
        // below is what does that. (This comment once said "the pin keeps them current" -
        // stale since 2026-08-11: a share obliges a copy, never a subscription.) Empty is
        // the NORMAL case on a reader's node, and the fragment path below is the whole
        // point of this feature: a reader gets one document, never a subscription.
        let hunch_held = crate::speculative::speculative_only(state, author_root)
            .await
            .unwrap_or(false);
        let page = if hunch_held {
            Vec::new()
        } else {
            shelf_page(state, author_root, None).await.unwrap_or_default()
        };
        tracing::debug!(
            author = %author_root, held = page.len(), wanted = rows.len(),
            "share fold: author shelf"
        );

        let mut wanted: Vec<JournalRow> = Vec::new();
        for r in &rows {
            let doc_hex = hex::encode(r.doc_id);
            if let Some(held) = page.iter().find(|p| p.doc_id_hex == doc_hex) {
                wanted.push(as_shared(held, r.received_at_ms));
                continue;
            }
            if let Some(row) =
                crate::fragments::journalable(state, sharer_root, author_root, &r.doc_id).await
            {
                wanted.push(as_shared(&row, r.received_at_ms));
            }
        }
        if wanted.is_empty() {
            continue;
        }
        let refs: Vec<&JournalRow> = wanted.iter().collect();
        if let Err(e) = journal_rows(
            &state.node_db,
            author_root,
            &readers,
            &refs,
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
        // The same freshness-contract gate as the share fold's shelf read (and the fragment
        // door's): a hunch-held mirror's shelf must not seed feed rows the node cannot
        // answer for onward. A gated page just means the instant backfill skips - the share
        // fold's own beat journals it through the fragment path, obligation attached.
        let page = if crate::speculative::speculative_only(state, author_root).await? {
            Vec::new()
        } else {
            shelf_page(state, author_root, None).await?
        };
        let doc_hex = hex::encode(doc_id);
        let Some(row) = page.iter().find(|r| r.doc_id_hex == doc_hex) else {
            // The document is not on the author's shelf here - either we hold nothing of theirs
            // yet (the pin was just written; sync has not run) or it is older than the page.
            // Both heal on the author's next move, which is why this is not an error.
            return Ok(0);
        };
        // The share was minted a moment ago, so its arrival on this node is now. Restamped
        // through the same door as every other share, rather than left carrying the author's
        // publication date.
        let shared = as_shared(row, now_ms());
        journal_rows(&state.node_db, author_root, &readers, &[&shared], Some(sharer_root)).await?;
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
        let page = shelf_page(state, author_root, None).await?;
        if page.is_empty() {
            return Ok(0);
        }
        let all: Vec<&JournalRow> = page.iter().collect();
        journal_rows(&state.node_db, author_root, &just_them, &all, None).await?;
        // Coverage begins HERE, so the mark must too (2026-08-16, caught by the dig's own
        // integration test): `journal_for` only records a mark when it journals, and an
        // author followed by nobody journals to nobody - so a first follow used to leave
        // the mark unset, and the next arrival after a dark stretch fell back to "newest
        // page only", skipping the middle forever. The follow point is the anchor.
        if let Some(newest) = page.iter().map(|r| r.updated_ms).max() {
            record_journal_mark(&state.node_db, author_root, newest).await?;
        }
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

/// The history dig: every follow edge's feed, extended backward one page per beat until it
/// reaches the year horizon (Curtis, 2026-08-16: "everything after the follow point" is the
/// guarantee; history is a courtesy with a floor). The slow half of the journal's two walks -
/// `journal_for` keeps coverage contiguous from the follow point forward, this fills what was
/// published before it - and POSTS ONLY for now: an old share needs its fragment fetched to
/// journal at all, a network walk per row against possibly-dark authors, and that lane wants
/// its own pacing (NEXT_STEPS carries it).
///
/// Cheap by construction: chain sync has never had a window, so a followed author's full
/// public chain is already on the local shelf - the dig is local reads feeding local writes,
/// no dials anywhere. Hosted personas dig their own history too (a fresh device adopting a
/// persona owes its feed the persona's own posts, same as any reader's).
///
/// Per (reader, author) rather than per author because history is per relationship: each
/// edge has its own follow point, its own cursor, and its own done. The dig journals with
/// `via_root = NULL` - the reader follows this author, and direct is the stronger claim.
pub async fn fill_pass(state: AppState) -> Result<()> {
    let mut pairs = crate::net::subscriptions::eager_follows(&state.node_db).await?;
    for root in crate::identity::hosted_roots(&state.node_db)
        .await
        .map_err(|e| anyhow::anyhow!("{e}"))?
    {
        pairs.push((root.clone(), root)); // your own posts, in your own feed (2026-08-05)
    }
    if pairs.is_empty() {
        return Ok(());
    }
    type FillRow = (String, String, Option<i64>, Option<String>, Option<i64>);
    /// One edge's dig state as the pass holds it: the resume cursor, and whether it's done.
    type DigState = (Option<(i64, [u8; 16])>, bool);
    let rows: Vec<FillRow> = state
        .node_db
        .fetch_all(
            "SELECT reader_root, author_root, cursor_ms, cursor_doc, done_ms FROM journal_fill",
            (),
        )
        .await
        .context("reading the history dig's cursors")?;
    let mut memo: std::collections::HashMap<(String, String), DigState> = Default::default();
    for (reader, author, ms, doc, done) in rows {
        let cursor = match (ms, doc.and_then(|d| hex::decode(d).ok())) {
            (Some(ms), Some(doc)) => <[u8; 16]>::try_from(doc.as_slice()).ok().map(|d| (ms, d)),
            _ => None,
        };
        memo.insert((reader, author), (cursor, done.is_some()));
    }

    let mut advanced = 0usize;
    for (reader, author) in pairs {
        if advanced >= FILL_PAIRS_PER_BEAT {
            break;
        }
        let (cursor, done) = memo
            .get(&(reader.clone(), author.clone()))
            .cloned()
            .unwrap_or((None, false));
        if done {
            continue;
        }
        // A stat answers "is their shelf even here" before anything opens: a followed
        // persona whose content never arrived has nothing to dig THROUGH - and `shelf_page`'s
        // polite empty for that case reads as "shelf exhausted", which would mark the pair
        // done and hollow out its history when the chain finally lands.
        if state.user_dbs.db_mtime_ms(&author).is_none() {
            continue;
        }
        match dig_one(&state, &reader, &author, cursor).await {
            Ok(()) => advanced += 1,
            Err(e) => {
                tracing::debug!(reader = %reader, author = %author, error = ?e, "history dig failed")
            }
        }
    }
    Ok(())
}

/// One page of one edge's dig: journal what lands above the horizon, move the cursor below
/// the page, declare done at the shelf's end or the horizon - whichever comes first.
async fn dig_one(
    state: &AppState,
    reader_root: &str,
    author_root: &str,
    cursor: Option<(i64, [u8; 16])>,
) -> Result<()> {
    let raw = shelf_page(state, author_root, cursor).await?;
    let horizon = now_ms() - FILL_HORIZON_MS;
    let keep: Vec<&JournalRow> = raw.iter().filter(|r| r.published_ms >= horizon).collect();
    if !keep.is_empty() {
        journal_rows(
            &state.node_db,
            author_root,
            &[reader_root.to_string()],
            &keep,
            None,
        )
        .await?;
    }
    let last = raw.last();
    let done = raw.len() < crate::idface::POSTS_PAGE as usize
        || last.is_some_and(|l| l.published_ms < horizon)
        || last.is_some_and(|l| l.cursor().is_none());
    let next = last.and_then(|l| l.cursor());
    state
        .node_db
        .execute(
            "INSERT INTO journal_fill (reader_root, author_root, cursor_ms, cursor_doc, done_ms)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (reader_root, author_root) DO UPDATE SET
                 cursor_ms = excluded.cursor_ms,
                 cursor_doc = excluded.cursor_doc,
                 done_ms = excluded.done_ms",
            (
                reader_root,
                author_root,
                next.map(|(ms, _)| ms),
                next.map(|(_, doc)| hex::encode(doc)),
                if done { Some(now_ms()) } else { None },
            ),
        )
        .await
        .context("advancing the history dig's cursor")?;
    if done {
        tracing::info!(reader = %reader_root, author = %author_root, "history dig reached its floor");
    }
    Ok(())
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

/// Drop the journal rows a SHARED document put in people's feeds.
///
/// The `via_root IS NOT NULL` guard is the whole subtlety: a document can sit in one feed
/// because a friend shared it and in another because that reader follows the author directly.
/// Losing the fragment kills the first - it was the only copy of those words on this node - and
/// must not touch the second, where the author's own chain is still here.
///
/// Lives in this module because `feed_journal` does (tests/conventions.rs). `fragments::forget`
/// is the caller: it knows a copy is going, and this knows what that means for a feed.
pub(crate) async fn excise_shared(
    node_db: &crate::db::Db,
    author_root: &str,
    doc_id: &str,
) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM feed_journal
             WHERE author_root = ?1 AND doc_id = ?2 AND via_root IS NOT NULL",
            (author_root, doc_id),
        )
        .await
        .context("retracting a forgotten fragment from feeds")?;
    // The crowd goes with the row. Nobody's share survives a document that no longer exists here,
    // and a `feed_shares` row outliving its `feed_journal` row would count toward a byline that
    // has nothing left to byline.
    node_db
        .execute(
            "DELETE FROM feed_shares WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("retracting a forgotten fragment's sharers")?;
    Ok(())
}

/// An edited shared document's new title, into the rows that already point at it.
pub(crate) async fn retitle_shared(
    node_db: &crate::db::Db,
    author_root: &str,
    doc_id: &str,
    title: &str,
) -> Result<()> {
    node_db
        .execute(
            "UPDATE feed_journal SET title = ?3
             WHERE author_root = ?1 AND doc_id = ?2 AND via_root IS NOT NULL",
            (author_root, doc_id, title),
        )
        .await
        .context("refreshing a shared document's title")?;
    Ok(())
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
        // The dig's memo goes with the rows it described: a re-follow must start a fresh
        // dig, or it would inherit a cursor pointing below rows this excise just deleted
        // and leave the refollowed history permanently hollow above it.
        state
            .node_db
            .execute(
                "DELETE FROM journal_fill WHERE reader_root = ?1 AND author_root = ?2",
                (reader_root, author.as_str()),
            )
            .await
            .context("resetting an unfollowed author's history dig")?;
    }
    Ok(())
}

/// Dial the nodes that have asked about this persona, in the background - a dead asker's
/// timeout must not stall the sweep that noticed the post.
///
/// The persona's own devices are excluded: the eager loop already keeps them current on its
/// own debounce, and dialing them twice buys nothing but a no-op exchange.
async fn push_to_askers(state: &AppState, root_hex: &str) {
    let state = state.clone();
    let root = root_hex.to_string();
    // Detached: no fold should wait on a network round trip it only benefits from. The
    // awaited body stands alone so the test beat ("demand-push") can run the same push to
    // completion - a rung push a test then asserts on cannot be a spawn.
    tokio::spawn(async move {
        push_to_askers_now(&state, &root).await;
    });
}

/// The push itself, awaited: dial every asker (demand ledger, devices excluded) with this
/// persona's chains. See `push_to_askers` for why the fold hook wraps this in a spawn.
pub(crate) async fn push_to_askers_now(state: &AppState, root_hex: &str) {
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
    match crate::net::sync::sync_peers(state, root_hex, &targets).await {
        Ok(results) => {
            let reached = results.iter().filter(|r| r.ok).count();
            tracing::info!(root = %root_hex, reached, of = results.len(),
                "pushed a public move to the nodes that asked");
        }
        Err(e) => tracing::debug!(root = %root_hex, error = ?e, "fanout push failed"),
    }
}

/// One row of a reader's feed, as the journal holds it.
#[derive(Debug, Clone)]
pub struct FeedRow {
    pub author_root: String,
    /// Who shared this into the reader's feed, if it arrived by rebroadcast rather than by a
    /// follow. `None` is the ordinary case and means "you follow this author".
    pub via_root: Option<String>,
    /// The introducer whose vouch journaled this row speculatively (DISCOVERY slice 2);
    /// `None` is every real row. Mutually exclusive with `via_root` by construction.
    pub suggested_via: Option<String>,
    pub doc_id: String,
    pub title: String,
    pub format: Option<String>,
    pub published_ms: i64,
    pub updated_ms: i64,
    pub arrived_ms: i64,
}

/// How many of a document's other sharers a feed row will carry. A count is exact; a LIST is a
/// payload, and a viral post shared by everyone you follow would otherwise put two hundred names
/// on one row. The count beside it stays honest, so "and 200 others" is still sayable with twelve
/// names behind the hover.
pub const VIA_OTHERS_CAP: usize = 12;

/// Everyone this reader follows who passed each of these documents along, **earliest first** - so
/// the head of each list is the introducer and the tail is the crowd behind them.
///
/// Two indexed node.db reads for a whole page, never one per row, and each in its owning module
/// (`feed_shares` here, `subscriptions` in [`crate::net::subscriptions`]) so the conventions cop
/// stays satisfied.
///
/// **The subscription filter happens HERE rather than at write time**, which is the one place this
/// differs from every other memo in the file. `feed_shares` keeps a row for a share that reached
/// the reader, and whether the reader still follows that sharer is asked when the question is
/// asked - so unfollowing somebody removes them from the crowd with no cleanup pass, no delete,
/// and no chance of a stale name surviving in a list nobody thought to reconcile.
///
/// The reader's own shares count: your own recommendation belongs in your own feed, which is
/// already why `share_readers` puts it there, so the reader is exempt from the follow test.
pub async fn followed_sharers(
    node_db: &crate::db::Db,
    reader_root: &str,
    rows: &[FeedRow],
) -> Result<std::collections::BTreeMap<(String, String), Vec<String>>> {
    let mut out: std::collections::BTreeMap<(String, String), Vec<String>> = Default::default();
    // Only rows that ARRIVED as a share can have sharers to name. A row you hold because you
    // follow its author has `via_root` cleared (the stronger claim), and showing "also shared by"
    // on it would be answering a question the row is not asking.
    let wanted: std::collections::BTreeSet<(String, String)> = rows
        .iter()
        .filter(|r| r.via_root.is_some())
        .map(|r| (r.author_root.clone(), r.doc_id.clone()))
        .collect();
    if wanted.is_empty() {
        return Ok(out);
    }
    let docs = hex_in_list(wanted.iter().map(|(_, d)| d));
    if docs.is_empty() {
        return Ok(out);
    }

    // One reader, the page's documents. `doc_id IN (...)` under the PK's leading `reader_root`
    // rather than a row-value IN over pairs: the author is checked against `wanted` below, which
    // costs a handful of discarded rows and buys a query shape whose portability is not in doubt.
    let shares: Vec<(String, String, String, i64)> = node_db
        .fetch_all(
            &format!(
                "SELECT author_root, doc_id, via_root, shared_ms FROM feed_shares
                 WHERE reader_root = ?1 AND doc_id IN ({})",
                docs.join(",")
            ),
            (reader_root,),
        )
        .await
        .context("reading who passed this page's documents along")?;
    let shares: Vec<(String, String, String, i64)> = shares
        .into_iter()
        .filter(|(a, d, _, _)| wanted.contains(&(a.clone(), d.clone())))
        .collect();
    if shares.is_empty() {
        return Ok(out);
    }

    let sharers: Vec<String> = shares
        .iter()
        .map(|(_, _, via, _)| via.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect();
    let followed =
        crate::net::subscriptions::rebroadcast_follows_among(node_db, reader_root, &sharers).await?;

    // Earliest share first, sharer as the tiebreak so a page renders the same way twice.
    let mut ordered = shares;
    ordered.sort_by(|a, b| a.3.cmp(&b.3).then_with(|| a.2.cmp(&b.2)));
    for (author, doc, via, _) in ordered {
        if via != reader_root && !followed.contains(&via) {
            continue;
        }
        out.entry((author, doc)).or_default().push(via);
    }
    Ok(out)
}

/// A quoted hex IN-list, the belt-and-braces `profiles::bylines` uses: anything that is not hex
/// cannot name a row these tables hold, so the list can carry nothing else.
fn hex_in_list<'a>(values: impl Iterator<Item = &'a String>) -> Vec<String> {
    values
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|v| format!("'{v}'"))
        .collect()
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
    type Row = (String, Option<String>, Option<String>, String, String, Option<String>, i64, i64, i64);
    // Text only, twice over: the shelf read upstream no longer journals media documents at
    // all (`public_docs` filters them - they're ingredients, not posts), and this clause
    // makes journals written BEFORE that filter harmless rather than a page of raw bytes
    // rendered as text.
    let rows: Vec<Row> = match before {
        None => node_db
            .fetch_all(
                "SELECT author_root, via_root, suggested_via, doc_id, title, format, published_ms, updated_ms, arrived_ms
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
                "SELECT author_root, via_root, suggested_via, doc_id, title, format, published_ms, updated_ms, arrived_ms
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
            |(author_root, via_root, suggested_via, doc_id, title, format, published_ms, updated_ms, arrived_ms)| FeedRow {
                author_root,
                via_root,
                suggested_via,
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

    #[tokio::test]
    async fn the_journal_mark_is_monotone() {
        // The chain_heads discipline: lagging under-reports (idempotent re-upserts), leading
        // would skip rows forever - so an out-of-order advance must lose.
        let db = crate::db::test_node_db().await;
        assert_eq!(journal_mark(&db, "aa").await.unwrap(), None);
        record_journal_mark(&db, "aa", 100).await.unwrap();
        record_journal_mark(&db, "aa", 90).await.unwrap();
        assert_eq!(journal_mark(&db, "aa").await.unwrap(), Some(100), "a lagging report cannot drag it back");
        record_journal_mark(&db, "aa", 110).await.unwrap();
        assert_eq!(journal_mark(&db, "aa").await.unwrap(), Some(110));
    }

    #[test]
    fn a_journal_row_is_its_own_cursor() {
        let row = post("ab", "t", 5);
        let (ms, doc) = row.cursor().expect("a fold-written doc_id resumes the keyset");
        assert_eq!(ms, row.published_ms);
        assert_eq!(hex::encode(doc), row.doc_id_hex);
        let garbled = JournalRow { doc_id_hex: "zz".into(), ..post("cd", "t", 5) };
        assert!(garbled.cursor().is_none(), "corrupt ids stop paging rather than looping");
    }

    fn post(doc: &str, title: &str, updated_ms: i64) -> JournalRow {
        JournalRow {
            doc_id_hex: format!("{doc:0>32}"),
            title: title.to_string(),
            format: "plaintext".to_string(),
            published_ms: 1_000,
            updated_ms,
        }
    }

    /// A fragment is the ONLY copy of that document on this node - the author's chain is not
    /// here - so a journal row that outlived it would render a title with no words behind it,
    /// forever. `retract_vanished` cannot reach this case: it reconciles against the author's
    /// shelf, and a reader has no shelf to read.
    #[tokio::test]
    async fn excising_a_shared_document_leaves_the_rows_we_hold_ourselves() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let doc = "11".repeat(16);

        // One shared row (via someone) and one direct row for the same author's other post.
        db.execute(
            "INSERT INTO feed_journal
               (reader_root, author_root, doc_id, title, format, published_ms, updated_ms,
                arrived_ms, via_root)
             VALUES (?1, ?2, ?3, 'shared', 'plaintext', 1, 1, 1, ?4),
                    (?1, ?2, 'other', 'mine', 'plaintext', 1, 1, 1, NULL)",
            (
                "cc".repeat(32),
                author.as_str(),
                doc.as_str(),
                "bb".repeat(32),
            ),
        )
        .await
        .unwrap();

        excise_shared(&db, &author, &doc).await.unwrap();

        let rows: Vec<(String,)> = db
            .fetch_all("SELECT title FROM feed_journal ORDER BY title", ())
            .await
            .unwrap();
        assert_eq!(
            rows.iter().map(|(t,)| t.as_str()).collect::<Vec<_>>(),
            vec!["mine"],
            "the shared row goes; a row we hold on our own account is untouched"
        );
    }

    /// The precedence ladder, both directions (DISCOVERY slice 2): a real arrival converts
    /// a speculative row in place - same primary key, marking shed - and a speculative
    /// write never touches an existing row of any kind. Planted red against a version
    /// without `suggested_via = NULL` in the real upsert before it was trusted.
    #[tokio::test]
    async fn real_arrivals_convert_speculative_rows_and_never_the_reverse() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let reader = "bb".repeat(32);
        let introducer = "cc".repeat(32);
        let row = JournalRow {
            doc_id_hex: "11".repeat(16),
            title: "the-unasked-for-post".into(),
            format: "plaintext".into(),
            published_ms: 1,
            updated_ms: 1,
        };
        let rows = [&row];
        let wanting = [(reader.clone(), introducer.clone())];

        // Speculative first: the row lands marked.
        journal_rows_suggested(&db, &author, &wanting, &rows).await.unwrap();
        let marked: Vec<(Option<String>,)> = db
            .fetch_all("SELECT suggested_via FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(marked, vec![(Some(introducer.clone()),)], "the row lands marked");

        // A real (follow) arrival converts in place: one row, marking shed.
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, None).await.unwrap();
        let converted: Vec<(Option<String>, Option<String>)> = db
            .fetch_all("SELECT suggested_via, via_root FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(converted, vec![(None, None)], "one row, real, marking gone");

        // And never the reverse: a late speculative write leaves the real row untouched.
        journal_rows_suggested(&db, &author, &wanting, &rows).await.unwrap();
        let still: Vec<(Option<String>,)> = db
            .fetch_all("SELECT suggested_via FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(still, vec![(None,)], "speculation never downgrades a real row");
    }

    /// The share-lane half of the conversion, pinned after it failed in the wild (2026-08-25,
    /// the first post-switchover CI runs): a SHARE landing on a speculative row must convert
    /// it into a share row - byline set, marking shed. The upsert's via CASE read "existing
    /// `via_root IS NULL`" as "this is a follow row, and follows outrank share bylines" - but
    /// a speculative row is ALSO via-less, so whenever the acquisition pass journaled a post
    /// before the share fold did, the share's byline was dropped and the row was left looking
    /// like a follow row for an author the reader does not follow. The flake wore three
    /// tests' faces (rebroadcast's via-less row, cascade's seeds, sharedby's crowd counts)
    /// because winning that race is a cadence coin flip.
    #[tokio::test]
    async fn a_share_arrival_converts_a_speculative_row_and_keeps_its_byline() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let reader = "bb".repeat(32);
        let introducer = "cc".repeat(32);
        let sharer = "dd".repeat(32);
        let row = JournalRow {
            doc_id_hex: "11".repeat(16),
            title: "t".into(),
            format: "plaintext".into(),
            published_ms: 1,
            updated_ms: 1,
        };
        let rows = [&row];
        let wanting = [(reader.clone(), introducer.clone())];

        // The race's losing order: speculation first, then the real share.
        journal_rows_suggested(&db, &author, &wanting, &rows).await.unwrap();
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, Some(&sharer))
            .await
            .unwrap();
        let converted: Vec<(Option<String>, Option<String>)> = db
            .fetch_all("SELECT suggested_via, via_root FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(
            converted,
            vec![(None, Some(sharer.clone()))],
            "a share converts a speculative row: byline set, marking shed"
        );

        // The ladder above shares still holds: a follow arrival outranks the byline...
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, None)
            .await
            .unwrap();
        // ...and a genuine follow row is never re-bylined by a later share.
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, Some(&sharer))
            .await
            .unwrap();
        let follow: Vec<(Option<String>, Option<String>)> = db
            .fetch_all("SELECT suggested_via, via_root FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(
            follow,
            vec![(None, None)],
            "a follow row outranks a share byline, still"
        );
    }

    /// The `via_root IS NOT NULL` guard, from the other side. A document we hold BOTH ways -
    /// shared to us and also followed directly - must not lose its direct row when the fragment
    /// is dropped: we still have the author's chain, and the words are still there.
    #[tokio::test]
    async fn a_direct_row_survives_its_fragment_being_dropped() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let doc = "11".repeat(16);
        db.execute(
            "INSERT INTO feed_journal
               (reader_root, author_root, doc_id, title, format, published_ms, updated_ms,
                arrived_ms, via_root)
             VALUES (?1, ?2, ?3, 'followed', 'plaintext', 1, 1, 1, NULL)",
            ("cc".repeat(32), author.as_str(), doc.as_str()),
        )
        .await
        .unwrap();

        excise_shared(&db, &author, &doc).await.unwrap();

        let (count,): (i64,) = db
            .fetch_one("SELECT COUNT(*) FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(count, 1, "following them is a claim of our own");
    }

    /// The stamp that orders a share is the SHARE, not the writing. A three-year-old post passed
    /// along today is news today; ordering it by its publication date buries it three years down
    /// the feed, which is the same as not delivering it.
    #[tokio::test]
    async fn a_share_sorts_by_when_it_was_shared_not_when_it_was_written() {
        let db = crate::db::test_node_db().await;
        let author = "aa".repeat(32);
        let sharer = "bb".repeat(32);
        let reader = vec!["cc".repeat(32)];

        // An old post - written long ago, shared just now.
        let ancient = post("0", "an old favourite", 1_000);
        let shared_at = 9_000_000;
        let restamped = as_shared(&ancient, shared_at);
        assert_eq!(
            restamped.published_ms, shared_at,
            "the share's arrival is what the feed orders by"
        );
        assert_eq!(
            restamped.updated_ms, ancient.updated_ms,
            "and the words' own history is untouched - that answers a different question"
        );

        journal_rows(&db, &author, &reader, &[&restamped], Some(&sharer))
            .await
            .unwrap();
        let (published, updated): (i64, i64) = db
            .fetch_one("SELECT published_ms, updated_ms FROM feed_journal", ())
            .await
            .unwrap();
        assert_eq!(published, shared_at);
        assert_eq!(updated, ancient.updated_ms);
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

    /// The candidate walk's source: the union over readers of the byline ledger,
    /// introducer-first, one row per sharer however many readers they reached - and empty for
    /// a document nobody local was ever journaled a share of, which is the scope bound ("we
    /// only lean on relationships our own users created") as a property of a query.
    #[tokio::test]
    async fn sharers_union_is_introducer_first_and_demand_scoped() {
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);
        let doc = hex::encode([1u8; 16]);
        let other_doc = hex::encode([2u8; 16]);
        let (bob, sam, rae, kim) = ("b".repeat(64), "c".repeat(64), "d".repeat(64), "e".repeat(64));

        let insert = |reader: String, doc: String, via: String, ms: i64| {
            let db = db.clone();
            let alice = alice.clone();
            async move {
                db.execute(
                    "INSERT INTO feed_shares (reader_root, author_root, doc_id, via_root, shared_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    (reader, alice, doc, via, ms),
                )
                .await
                .unwrap();
            }
        };
        // Sam introduced the doc to one reader; Bob reached two readers, later.
        insert(rae.clone(), doc.clone(), sam.clone(), 100).await;
        insert(rae.clone(), doc.clone(), bob.clone(), 200).await;
        insert(kim.clone(), doc.clone(), bob.clone(), 150).await;
        // A different document's sharer must not leak into this one's walk.
        insert(kim.clone(), other_doc.clone(), kim.clone(), 50).await;

        let sharers = sharers_of_doc(&db, &alice, &doc).await.unwrap();
        assert_eq!(
            sharers,
            vec![sam.clone(), bob.clone()],
            "introducer first, one row per sharer across readers"
        );

        let by_author = sharers_of_author(&db, &alice).await.unwrap();
        assert_eq!(by_author, vec![kim.clone(), sam.clone(), bob.clone()],
            "the per-author union spans documents, earliest stand first");

        assert!(
            sharers_of_doc(&db, &alice, &hex::encode([9u8; 16])).await.unwrap().is_empty(),
            "a document nobody local was journaled a share of yields nothing to dial"
        );
    }
}
