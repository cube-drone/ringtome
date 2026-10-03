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
async fn record_journal_mark(
    node_db: &crate::db::Db,
    author_root: &str,
    newest_ms: i64,
) -> Result<()> {
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
    moved: &'a [u32],
    force: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(after_public_move_inner(state, root_hex, moved, force))
}

/// `moved` names the public services whose fingerprints changed (frontier::refresh_moved);
/// each act below reads exactly one of them, and runs only when that one moved (2026-08-28,
/// the quadratic fold: a share used to re-journal the whole shelf, a post re-mirror every
/// edge). The push is the exception - it carries the persona's whole lane, so any move
/// rings it.
async fn after_public_move_inner(state: &AppState, root_hex: &str, moved: &[u32], force: bool) {
    use ringtome_proto::registry::service;
    let has = |s: u32| moved.contains(&s);
    // The byline cache rides the same edge: a rename is PROFILE_PUBLIC moving, which is
    // exactly what fired this. Refreshing here (not per-render) is what lets every list on
    // the node answer "who is this?" without opening this persona's database.
    if has(service::PROFILE_PUBLIC) || has(service::IDENTITY_PUBLIC) {
        if let Err(e) = crate::profiles::refresh(state, root_hex).await {
            tracing::debug!(root = %root_hex, error = ?e, "byline refresh failed");
        }
    }
    if has(service::POSTS) {
        // Sub-act timing at debug, the fold-legs line one level down (2026-08-28): when
        // the journal leg grows, this says which act.
        let t = std::time::Instant::now();
        match journal_for(state, root_hex).await {
            Ok(readers) if readers > 0 => {
                tracing::info!(root = %root_hex, readers, "journaled a public move");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(root = %root_hex, error = ?e, "feed journal write failed"),
        }
        let t_journal = t.elapsed();
        let t = std::time::Instant::now();
        match retract_vanished(state, root_hex, force).await {
            Ok(n) if n > 0 => {
                tracing::info!(root = %root_hex, rows = n, "retracted vanished documents from feeds");
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(root = %root_hex, error = ?e, "feed retraction failed"),
        }
        let t_retract = t.elapsed();
        let t = std::time::Instant::now();
        // The same event, mirrored into the death log: `retract_vanished` reconciles this
        // node's FEEDS against the author's shelf; this makes the deaths this node just
        // learned SERVABLE, proofs attached, to anyone who asks "what died since N?"
        // (fragments::deaths_since). Both ride the public move because both are
        // consequences of exactly it.
        crate::fragments::mirror_retractions(state, root_hex).await;
        tracing::debug!(
            root = %root_hex,
            journal_for_ms = t_journal.as_millis() as u64,
            retract_ms = t_retract.as_millis() as u64,
            mirror_ms = t.elapsed().as_millis() as u64,
            "journal acts"
        );
    }
    // The edge graph rides the same move: if the mover publishes edges, re-mirror them into
    // the node-level graph (probe-gated inside - a persona with no follows-public chain
    // costs one primary-key read).
    if has(service::FOLLOWS_PUBLIC) {
        crate::edgegraph::refresh_from(state, root_hex).await;
    }
    // Push onward only for personas this node authors. Relaying someone ELSE's lane onward is
    // rebroadcast - a consent question, not a routing one - and waits for its own design.
    let t = std::time::Instant::now();
    match crate::identity::is_agented(&state.node_db, root_hex).await {
        Ok(true) => push_to_askers(state, root_hex).await,
        Ok(false) => {}
        Err(e) => tracing::debug!(error = ?e, "agented check failed in fanout"),
    }
    tracing::debug!(root = %root_hex, push_ms = t.elapsed().as_millis() as u64, "push act");
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
    let t_all = std::time::Instant::now();
    let mut readers = crate::net::subscriptions::followers_of(&state.node_db, author_root).await?;
    // Your own posts appear in your own feed, as if you had written them - which you did
    // (Curtis, 2026-08-05). The author follows nobody to get this; being hosted is enough.
    if crate::identity::is_agented(&state.node_db, author_root).await.unwrap_or(false)
        && !readers.iter().any(|r| r == author_root)
    {
        readers.push(author_root.to_string());
    }
    // **Not "nobody follows them" - "nobody here wants them at all".** A reader can hold no
    // interest in this author whatsoever and still be owed their documents, because someone
    // that reader DOES follow shared one - or because their trust graph vouches for the
    // author (PROJECT_PLAN's Discovery, slice 2: the demand rollup is the THIRD reader criterion beside
    // followers and share-followers). Returning early on direct followers alone would make
    // both arrival paths journal to nobody, forever.
    let t_readers = t_all.elapsed();
    let t = std::time::Instant::now();
    let mut wanting = crate::speculative::wanting_readers(&state.node_db, author_root).await?;
    wanting.retain(|(reader, _)| !readers.contains(reader));
    let t_wanting = t.elapsed();
    if readers.is_empty() && wanting.is_empty() && !anyone_shares(state, author_root).await? {
        return Ok(0); // the common case, and it costs one query per index
    }
    let t = std::time::Instant::now();
    let mark = journal_mark(&state.node_db, author_root).await?;
    let t_mark = t.elapsed();
    // Where the delta may reach. A missing mark (first move ever for this author) means the
    // newest page alone - `i64::MAX` stops the walk after one page. Otherwise the delta reads by
    // `updated_ms` from the mark, so an edit to a post of any age is caught by its own fresh stamp
    // (posts edit forever since 2026-10-02; this once also reached back an edit window by
    // genesis, which the delta-by-stamp had already made moot). The horizon floors both cases.
    let floor = mark.unwrap_or(i64::MAX).max(now_ms() - FILL_HORIZON_MS);
    // `fresh` is what the real readers get; `first_page` is the newest page whole, for the
    // speculative readers below - their rows are the burst-to-bound with no year dig (the
    // history courtesy belongs to chosen relationships, PROJECT_PLAN's Discovery stage 3),
    // so however deep the real readers' delta reaches, speculation journals from that page.
    let t = std::time::Instant::now();
    let (fresh, first_page): (Vec<JournalRow>, Vec<JournalRow>) = match mark {
        // The DELTA, by its own stamp (2026-08-28): everything whose head moved at or past
        // the mark, one indexed read. This replaced a keyset walk back to `mark -
        // edit_window` (the day posts once froze after) - correct, but a day's worth of posts re-paged per move, which under
        // test-data's cadence was the author's whole history every time. The horizon still
        // floors it, and `>=` at the boundary keeps the same-millisecond sibling.
        Some(m) => {
            let delta = shelf_updated_since(state, author_root, m.max(floor)).await?;
            let first = if wanting.is_empty() {
                Vec::new()
            } else {
                shelf_page(state, author_root, None).await?
            };
            (delta, first)
        }
        // First move ever for this author: the newest page alone - the new-follow
        // burst-to-bound, everything older left to the history dig's pace (`fill_pass`).
        None => {
            let page = shelf_page(state, author_root, None).await?;
            (page.clone(), page)
        }
    };
    let newest: Option<i64> = fresh.iter().map(|r| r.updated_ms).max();
    let t_delta = t.elapsed();
    if fresh.is_empty() {
        return Ok(0);
    }
    let fresh: Vec<&JournalRow> = fresh.iter().collect();
    let t = std::time::Instant::now();
    if !readers.is_empty() {
        journal_rows(&state.node_db, author_root, &readers, &fresh, None).await?;
    }
    let t_rows = t.elapsed();
    let t = std::time::Instant::now();
    // The third criterion's rows: marked, bylined with each pair's introducer, newest page
    // only, and never touching a row that already exists (journal_rows_suggested's DO
    // NOTHING is the whole precedence ladder). Best-effort beside the real writes - a
    // speculative miss is the next move's to retry, not this journal's to fail.
    if !wanting.is_empty() && !first_page.is_empty() {
        // Trusted-only posts never ride discovery (Curtis, 2026-09-01): the speculative
        // lane is the one surface the reader never chose - no follow, no share, no trust
        // umbrella - and a gated post advertised there is a hollow card for strangers.
        // Followers still get the row (they chose the author; untrusted ones read the
        // honest hollow line), and the sharer-scoped lane is slice 2b's own gate.
        let suggested: Vec<&JournalRow> = first_page.iter().filter(|r| !r.trusted_only).collect();
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
    let t_shares = t.elapsed();
    // Advance only after the write landed: a failed write leaves the mark behind, and the
    // next move re-journals the same delta (idempotent) instead of skipping it forever.
    if let Some(newest) = newest {
        record_journal_mark(&state.node_db, author_root, newest).await?;
    }
    tracing::debug!(
        author = %author_root,
        readers = readers.len(), fresh = fresh.len(),
        readers_ms = t_readers.as_millis() as u64,
        wanting_ms = t_wanting.as_millis() as u64,
        mark_ms = t_mark.as_millis() as u64,
        delta_ms = t_delta.as_millis() as u64,
        rows_ms = t_rows.as_millis() as u64,
        shares_ms = t_shares.as_millis() as u64,
        total_ms = t_all.elapsed().as_millis() as u64,
        "journal_for steps"
    );
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
        // A page of a book is never a feed row of its own (PROJECT_PLAN's Books, ruling 4): the book,
        // and later its updates, are what reach feeds. A rule of the fold, not a courtesy
        // of the client.
        .filter(|p| p.part_of.is_none())
        .map(|p| JournalRow {
            // The stamp first: `title` moves out of `p` below, and the display stamp reads it.
            published_ms: p.display_ms(),
            doc_id_hex: hex::encode(p.doc_id),
            title: p.title,
            format: crate::record::documents::Format::from_wire(p.format).as_str().to_string(),
            updated_ms: p.head_ms,
            settled: p.settled,
            trusted_only: p.trusted_only,
            onward: p.onward,
            dated_ms: p.dated_ms,
            minted_ms: p.genesis_ms,
        })
        .collect())
}

/// The shelf's delta since a stamp, shaped for journaling - `shelf_page`'s twin for the
/// mark-driven move. Bounded by `JOURNAL_DELTA_CAP`; a delta that fills it is a node dark
/// through more posts than a person writes in a season, and the log says so - the next
/// move takes the rest, since the mark advances only past what was written.
async fn shelf_updated_since(
    state: &AppState,
    author_root: &str,
    since_ms: i64,
) -> Result<Vec<JournalRow>> {
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .with_context(|| format!("opening {author_root} to read its shelf delta"))?
    else {
        return Ok(Vec::new());
    };
    let posts =
        crate::record::documents::public_docs_updated_since(&db, since_ms, JOURNAL_DELTA_CAP)
            .await?;
    if posts.len() as i64 >= JOURNAL_DELTA_CAP {
        tracing::warn!(author = %author_root, cap = JOURNAL_DELTA_CAP,
            "a journal delta hit its cap; the remainder rides the next move");
    }
    Ok(posts
        .into_iter()
        // A page of a book is never a feed row of its own (PROJECT_PLAN's Books, ruling 4): the book,
        // and later its updates, are what reach feeds. A rule of the fold, not a courtesy
        // of the client.
        .filter(|p| p.part_of.is_none())
        .map(|p| JournalRow {
            // The stamp first: `title` moves out of `p` below, and the display stamp reads it.
            published_ms: p.display_ms(),
            doc_id_hex: hex::encode(p.doc_id),
            title: p.title,
            format: crate::record::documents::Format::from_wire(p.format).as_str().to_string(),
            updated_ms: p.head_ms,
            settled: p.settled,
            trusted_only: p.trusted_only,
            onward: p.onward,
            dated_ms: p.dated_ms,
            minted_ms: p.genesis_ms,
        })
        .collect())
}

/// Rows per journal delta read. Generous: the common move is one post.
const JOURNAL_DELTA_CAP: i64 = 1000;

/// One post's journalable facts, computed once per move rather than once per (reader x post).
#[derive(Clone)]
pub struct JournalRow {
    pub(crate) doc_id_hex: String,
    pub(crate) title: String,
    pub(crate) format: String,
    pub(crate) published_ms: i64,
    pub(crate) updated_ms: i64,
    /// The author's no-shares-no-replies wish (PROJECT_PLAN's Post visibility), off the journaled header.
    pub(crate) settled: bool,
    /// Trusted-readers-only, same source.
    pub(crate) trusted_only: bool,
    /// Sealed and passable (Contact tags, ruling 7), same source.
    pub(crate) onward: bool,
    /// The author's claimed date (PUBLISH.md), off the header - None when none was claimed.
    pub(crate) dated_ms: Option<i64>,
    /// The header's genesis - when the post was actually written down. 0 from a fragment,
    /// which carries no genesis of its own.
    pub(crate) minted_ms: i64,
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
    let pairs: Vec<(&String, &&JournalRow)> =
        readers.iter().flat_map(|reader| rows.iter().map(move |row| (reader, row))).collect();
    for chunk in pairs.chunks(JOURNAL_CHUNK_ROWS) {
        let placeholders: Vec<String> = (0..chunk.len())
            .map(|i| {
                let b = i * 14;
                format!(
                    "(?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{})",
                    b + 1,
                    b + 2,
                    b + 3,
                    b + 4,
                    b + 5,
                    b + 6,
                    b + 7,
                    b + 8,
                    b + 9,
                    b + 10,
                    b + 11,
                    b + 12,
                    b + 13,
                    b + 14
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO feed_journal
               (reader_root, author_root, doc_id, title, format,
                published_ms, updated_ms, arrived_ms, settled, trusted_only, onward, dated_ms, minted_ms, via_root)
             VALUES {}
             ON CONFLICT (reader_root, author_root, doc_id) DO UPDATE SET
                 title = excluded.title,
                 format = excluded.format,
                 updated_ms = excluded.updated_ms,
                 settled = excluded.settled,
                 trusted_only = excluded.trusted_only,
                 onward = excluded.onward,
                 dated_ms = excluded.dated_ms,
                 minted_ms = excluded.minted_ms,
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
                    turso::Value::Integer(i64::from(row.settled)),
                    turso::Value::Integer(i64::from(row.trusted_only)),
                    turso::Value::Integer(i64::from(row.onward)),
                    match row.dated_ms {
                        Some(d) => turso::Value::Integer(d),
                        None => turso::Value::Null,
                    },
                    turso::Value::Integer(row.minted_ms),
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
        crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
    }
    if let Some(via) = via_root {
        remember_sharer(node_db, author_root, readers, rows, via, now).await?;
    }
    Ok(())
}

/// The speculative twin of [`journal_rows`] (PROJECT_PLAN's Discovery, slice 2): rows for readers whose
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
/// Excise an evicted author's SPECULATIVE feed rows, every reader at once (PROJECT_PLAN's Discovery, slice
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
    crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
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
                let b = i * 14;
                format!(
                    "(?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{},?{})",
                    b + 1,
                    b + 2,
                    b + 3,
                    b + 4,
                    b + 5,
                    b + 6,
                    b + 7,
                    b + 8,
                    b + 9,
                    b + 10,
                    b + 11,
                    b + 12,
                    b + 13,
                    b + 14
                )
            })
            .collect();
        let sql = format!(
            "INSERT INTO feed_journal
               (reader_root, author_root, doc_id, title, format,
                published_ms, updated_ms, arrived_ms, settled, trusted_only, onward, dated_ms, minted_ms, suggested_via)
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
                    turso::Value::Integer(i64::from(row.settled)),
                    turso::Value::Integer(i64::from(row.trusted_only)),
                    turso::Value::Integer(i64::from(row.onward)),
                    match row.dated_ms {
                        Some(d) => turso::Value::Integer(d),
                        None => turso::Value::Null,
                    },
                    turso::Value::Integer(row.minted_ms),
                    turso::Value::Text((*introducer).clone()),
                ]
            })
            .collect();
        node_db
            .execute(&sql, turso::params_from_iter(params))
            .await
            .context("journaling speculative rows")?;
        crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
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
                    (reader.as_str(), author_root, row.doc_id_hex.as_str(), via_root, now),
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
        .execute("DELETE FROM feed_shares WHERE reader_root = ?1 OR via_root = ?1", (root,))
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
            by_holder.entry(holder).or_default().push(as_shared(row, shared_ms));
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
    JournalRow { published_ms: shared_ms, ..row.clone() }
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
pub async fn sharers_of_author(node_db: &crate::db::Db, author_root: &str) -> Result<Vec<String>> {
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
    if let Err(e) =
        journal_rows(&state.node_db, author_root, &readers, &[&shared], Some(sharer_root)).await
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
    if crate::identity::is_agented(&state.node_db, sharer_root).await.unwrap_or(false)
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
    let mut by_author: std::collections::BTreeMap<
        &str,
        Vec<&crate::record::imaol::RebroadcastRow>,
    > = Default::default();
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
        let hunch_held =
            crate::speculative::speculative_only(state, author_root).await.unwrap_or(false);
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
        if let Err(e) =
            journal_rows(&state.node_db, author_root, &readers, &refs, Some(sharer_root)).await
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
///
/// **`done` is a verdict on a WHOLE shelf**, and a short page cannot tell "exhausted" from
/// "still landing", so the pass refuses to dig a shelf that is known to be partial (no
/// database yet; held as a peek) and a whole fetch that replaces a peek restarts the dig
/// (`restart_history_dig`). The residual: a persona whose FIRST fetch is whole (followed by
/// pasted address, never peeked) can be dug mid-landing, if a beat falls inside that one
/// exchange. Nothing marks an exchange in flight per root today; the window is one
/// request wide and no test has fallen into it.
pub async fn fill_pass(state: AppState) -> Result<()> {
    let mut pairs = crate::net::subscriptions::eager_follows(&state.node_db).await?;
    for root in
        crate::identity::hosted_roots(&state.node_db).await.map_err(|e| anyhow::anyhow!("{e}"))?
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
        let (cursor, done) =
            memo.get(&(reader.clone(), author.clone())).cloned().unwrap_or((None, false));
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
        // The same hazard one step later (2026-09-23, the journalfill claim failing ~1 run in
        // 5): a PEEK's database is here - identity chains land first - and holds no posts,
        // because a peek's shelf is twenty fragments that arrive behind the page (PROJECT_PLAN's
        // Peeks, ruling 4), or is still landing. A follow promotes the peek to a whole fetch
        // INSIDE the follow's own request, so between the subscription row and the fetch's
        // return the pair is already an eager follow over an empty shelf; the free-running
        // loop read one empty page, wrote `done`, and the thirty posts of history that
        // arrived a moment later never reached the feed, because nothing reopens a finished
        // dig. The mark is set by the peek fetch and cleared by the whole one; until then
        // the pair stays UNDUG rather than done.
        if state.peeked.is_behind(&author) {
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
        journal_rows(&state.node_db, author_root, &[reader_root.to_string()], &keep, None).await?;
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

/// Forget every reader's dig of one author, so each starts over from the newest page on
/// the next beat. For the moment a shelf becomes whole where it was partial before - a peek
/// promoted by a follow (`idface::fetch_foreign_with`) - because any `done` written against
/// the partial shelf was a verdict on the wrong shelf. Cheap to redo: the dig is local reads,
/// a page per beat.
pub async fn restart_history_dig(node_db: &crate::db::Db, author_root: &str) -> Result<()> {
    node_db
        .execute("DELETE FROM journal_fill WHERE author_root = ?1", (author_root,))
        .await
        .context("restarting an author's history dig")?;
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
async fn retract_vanished(state: &AppState, author_root: &str, force: bool) -> Result<u64> {
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .with_context(|| format!("opening {author_root} to check its public lane"))?
    else {
        return Ok(0); // nothing of theirs held: nothing to reconcile against
    };
    // A PEEK's mirror (PROJECT_PLAN's Peeks, ruling 4) holds no posts lane at all, so "not on their shelf
    // here" would read every journaled share of theirs as vanished (the first rig run under
    // the peek did exactly that, hiding the trust reveal). A peek's words live on the
    // fragment ledger, whose own death road (`fragments::mirror_retractions`, the deaths
    // page) is the judge; this sweep has nothing to reconcile against.
    if crate::idface::peek_held(state, author_root).await {
        return Ok(0);
    }
    // The vanish gate (2026-08-28, the quadratic fold): this reconcile diffs every journaled
    // id against every live id, and it used to run on every POSTS move - a new post paid
    // for a takedown that never happened, at a cost that grew with both lists. Nothing can
    // have vanished unless the live count DROPPED or the retraction count ROSE since the
    // last look (a takedown does both, a repudiation's genesis cut does the first), so two
    // counts answer the common move for free. Boot-reset marks (loops::FreshnessMarks) make
    // the first fold after a restart reconcile once, unconditionally - the catch-up. A new
    // post landing in the same move as a cut is the one shape the counts can hide, and the
    // next cut or the boot reconcile takes it.
    let alive = crate::record::documents::public_doc_count(&db).await?;
    let dead = crate::record::documents::retracted_doc_ids(&db).await?.len() as i64;
    let seen_alive = state.sweep_marks.last("vanish-alive", author_root);
    let seen_dead = state.sweep_marks.last("vanish-dead", author_root);
    state.sweep_marks.record("vanish-alive", author_root, alive);
    state.sweep_marks.record("vanish-dead", author_root, dead);
    if let (Some(a), Some(d), false) = (seen_alive, seen_dead, force) {
        if alive >= a && dead == d {
            return Ok(0);
        }
    }
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
    crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
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
    crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
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
    crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
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
        crate::search::journal_or_labels_moved(); // the tag cloud's cache (search.rs)
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
    /// The introducer whose vouch journaled this row speculatively (PROJECT_PLAN's Discovery, slice 2);
    /// `None` is every real row. Mutually exclusive with `via_root` by construction.
    pub suggested_via: Option<String>,
    pub doc_id: String,
    pub title: String,
    pub format: Option<String>,
    pub published_ms: i64,
    pub updated_ms: i64,
    pub arrived_ms: i64,
    /// The author's no-shares-no-replies wish, off the journaled header.
    pub settled: bool,
    /// Trusted-readers-only, same source.
    pub trusted_only: bool,
    /// Sealed and passable (Contact tags, ruling 7): the share button shows, and the sharer's
    /// trust opens the seal one hop further.
    pub onward: bool,
    /// The author's claimed date, when one was claimed (PUBLISH.md).
    pub dated_ms: Option<i64>,
    /// When the post was actually written down; 0 when the row came from a fragment.
    pub minted_ms: i64,
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
        crate::net::subscriptions::rebroadcast_follows_among(node_db, reader_root, &sharers)
            .await?;

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

/// What the reader's own journal knows about these posts - title and stamp, for dressing a
/// reply row's quote-card with its PARENT (PROJECT_PLAN's Replies slice 3). Page-scoped: one indexed
/// read under the journal's leading `reader_root`, the `followed_sharers` shape. Best-effort
/// by design - a parent the journal never met dresses as a bare "link", which is the
/// mini-card's own degraded case.
pub async fn journal_cards(
    node_db: &crate::db::Db,
    reader_root: &str,
    posts: &[(String, String)],
) -> Result<std::collections::HashMap<(String, String), (String, i64)>> {
    let docs = hex_in_list(posts.iter().map(|(_, d)| d));
    if docs.is_empty() {
        return Ok(Default::default());
    }
    let rows: Vec<(String, String, String, i64)> = node_db
        .fetch_all(
            &format!(
                "SELECT author_root, doc_id, title, published_ms FROM feed_journal
                 WHERE reader_root = ?1 AND doc_id IN ({})",
                docs.join(",")
            ),
            (reader_root,),
        )
        .await
        .context("dressing quote-cards from the journal")?;
    Ok(rows
        .into_iter()
        .filter(|(a, d, _, _)| posts.contains(&(a.clone(), d.clone())))
        .map(|(a, d, title, ms)| ((a, d), (title, ms)))
        .collect())
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
/// Who introduced one document to one reader here: the feed journal's byline (CHAT.md;
/// Curtis, 2026-09-19). The onward hop's `via` for a door the client reached by address
/// rather than by card - a room's, which the address bar names and no card dresses.
pub async fn introducer(
    node_db: &crate::db::Db,
    reader_root: &str,
    author_root: &str,
    doc_hex: &str,
) -> Option<String> {
    node_db
        .fetch_optional::<(Option<String>,)>(
            "SELECT via_root FROM feed_journal WHERE reader_root = ?1 AND author_root = ?2 AND doc_id = ?3",
            (reader_root, author_root, doc_hex),
        )
        .await
        .ok()
        .flatten()
        .and_then(|(v,)| v)
}

/// The newest trusted-only posts in any reader's feed here - `(reader, author, doc, via)`, newest
/// arrival first - what the key prefetch walks (`keyprefetch.rs`, 2026-09-29): a sealed post's
/// key is asked for while its author's node is known to be up, not when somebody opens it later.
pub async fn sealed_rows(
    node_db: &crate::db::Db,
    limit: i64,
) -> Result<Vec<(String, String, String, Option<String>)>> {
    node_db
        .fetch_all(
            "SELECT reader_root, author_root, doc_id, via_root FROM feed_journal
             WHERE trusted_only = 1 AND reader_root != author_root
             ORDER BY arrived_ms DESC LIMIT ?1",
            (limit,),
        )
        .await
        .context("reading the feeds' sealed posts")
}

/// Every room in any reader's feed here (CHAT.md; Curtis, 2026-09-18): `(reader, author,
/// doc, published_ms)` - what the room pulse walks to keep busy rooms cycling.
pub async fn rooms_in_feeds(node_db: &crate::db::Db) -> Result<Vec<(String, String, String, i64)>> {
    node_db
        .fetch_all(
            "SELECT reader_root, author_root, doc_id, published_ms FROM feed_journal WHERE format = 'room'",
            (),
        )
        .await
        .context("listing the rooms in feeds")
}

/// A room's feed time is its last word's (Curtis, 2026-09-18): every reader's row for the
/// room moves up to `latest_ms` when that is newer than where the row sits. Rooms only,
/// and only forward - the keyset the feed pages by is `published_ms`, so a moved row simply
/// sorts where a fresh post would.
pub async fn bump_room_time(
    node_db: &crate::db::Db,
    author_root: &str,
    doc_hex: &str,
    latest_ms: i64,
) -> Result<u64> {
    node_db
        .execute(
            "UPDATE feed_journal SET published_ms = ?3
             WHERE author_root = ?1 AND doc_id = ?2 AND format = 'room' AND published_ms < ?3",
            (author_root, doc_hex, latest_ms),
        )
        .await
        .context("moving a room up its readers' feeds")
        .inspect(|_| crate::search::journal_or_labels_moved())
}

pub async fn feed_page(
    node_db: &crate::db::Db,
    reader_root: &str,
    before: Option<(i64, String)>,
    limit: i64,
    // The reader's own posts, or not, or only them (Curtis, 2026-09-27: the feed page's "me"
    // chip; three-state 2026-10-01). Filtered here, in the query, so a page is still a full page
    // when the reader has been busy.
    own: Own,
) -> Result<Vec<FeedRow>> {
    // Text only, twice over: the shelf read upstream no longer journals media documents at
    // all (`public_docs` filters them - they're ingredients, not posts), and this clause
    // makes journals written BEFORE that filter harmless rather than a page of raw bytes
    // rendered as text.
    let filter = JournalFilter { own, ..JournalFilter::feed(reader_root) };
    journal_page(node_db, &filter, before, limit).await
}

/// The reader's own posts in a journal read: among the rest (the default), left out, or alone -
/// the feed's "me" chip, three-state like every chip on the strip (2026-10-01).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Own {
    In,
    Out,
    Only,
}

impl Own {
    /// From the feed's `me=` parameter: `0` (or `false`, `no`) leaves them out, `only` keeps
    /// nothing else, anything else - or nothing - is the default.
    pub fn from_param(me: Option<&str>) -> Self {
        match me {
            Some("0" | "false" | "no") => Own::Out,
            Some("only") => Own::Only,
            _ => Own::In,
        }
    }
}

/// The kinds of post a feed shows: text, books and rooms - never media, which are ingredients.
pub const FEED_FORMATS: &[&str] = &["marquee", "plaintext", "book", "room"];

/// Which of one reader's journal rows a caller wants (2026-09-27, PROJECT_PLAN's Scores and sort
/// orders, *Shape*): the one filter every reader of the journal goes through, in SQL on an index -
/// where the search, the facets, the chats column and "chat with them" each used to take the
/// newest 5000 rows and filter in memory, and silently lost everything older.
pub struct JournalFilter<'a> {
    pub reader: &'a str,
    /// The reader's own posts: among the rest, left out, or alone ("me").
    pub own: Own,
    /// Only these formats (a feed's text kinds, or `room` alone); empty for any.
    pub formats: &'a [&'a str],
    /// Only rows published at or after this - a best order's window.
    pub since_ms: Option<i64>,
    /// The curiosity dial's stop, with the reader's dials in it (`selectivity::stop_rule`); the
    /// reader's own rows always pass it.
    pub stop: Option<crate::selectivity::StopRule>,
}

impl<'a> JournalFilter<'a> {
    /// What the feed shows: the text kinds, the reader's own included, the whole of time.
    pub fn feed(reader: &'a str) -> Self {
        JournalFilter { reader, own: Own::In, formats: FEED_FORMATS, since_ms: None, stop: None }
    }

    /// The WHERE clause over journal columns spelled `{t}column` (`t` empty, or an alias and a
    /// dot), the reader bound as `?1`. The formats are this file's own words and the stop's roots
    /// are checked hex, so nothing a caller typed reaches the SQL.
    fn clause(&self, t: &str) -> String {
        let mut parts = vec![format!("{t}reader_root = ?1")];
        if !self.formats.is_empty() {
            let known: Vec<String> = self
                .formats
                .iter()
                .filter(|f| f.bytes().all(|b| b.is_ascii_lowercase()))
                .map(|f| format!("'{f}'"))
                .collect();
            parts.push(format!("{t}format IN ({})", known.join(",")));
        }
        match self.own {
            Own::In => {}
            Own::Out => parts.push(format!("{t}author_root <> {t}reader_root")),
            Own::Only => parts.push(format!("{t}author_root = {t}reader_root")),
        }
        if let Some(since) = self.since_ms {
            parts.push(format!("{t}published_ms >= {since}"));
        }
        if let Some(stop) = &self.stop {
            parts.push(format!("({t}author_root = {t}reader_root OR {})", stop.sql(t)));
        }
        parts.join(" AND ")
    }
}

const JOURNAL_COLUMNS: &str = "author_root, via_root, suggested_via, doc_id, title, format, published_ms, updated_ms, arrived_ms, settled, trusted_only, onward, dated_ms, minted_ms";

/// One page of a reader's journal through `filter`, newest first (ties by document id, highest
/// first), after `before` (the last row shown's `(published_ms, doc_id)`).
pub async fn journal_page(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
    before: Option<(i64, String)>,
    limit: i64,
) -> Result<Vec<FeedRow>> {
    // Pinned to the time index (node rung 0058): this engine's planner reaches for another index
    // on its own and sorts the whole journal for every page. Newest first, ties by id newest
    // first - one direction, walked backwards, no sort.
    let sql = page_sql(filter, before.is_some());
    let rows: Vec<JournalTuple> = match before {
        None => node_db.fetch_all(&sql, (filter.reader, limit)).await,
        Some((ms, doc)) => node_db.fetch_all(&sql, (filter.reader, ms, doc.as_str(), limit)).await,
    }
    .context("reading a journal page")?;
    Ok(rows.into_iter().map(journal_row).collect())
}

/// One page of a reader's journal through `filter` in their "best" order (PROJECT_PLAN's Scores and
/// sort orders, *Shape*): score high first, then newest, then document id (score.rs `Rank`),
/// after `after`. The stored scores (score.rs) keep only posts somebody the reader weighs reacted
/// to, so the order is three runs, each read the way it is cheap: the posts scored above zero; the
/// zero run - the great bulk - off the journal's time index, the scores probed by key, streaming
/// whatever its size; then the posts scored below zero. A cursor's score says which run it
/// stopped in. The scored runs are read by the window for a month or less, and off the score
/// index for a year (the timing check at 131,072 posts, 26,215 scored: a day 16 ms, a month
/// 29 ms, a year 123 ms - the year's sort by score, ties by time, is the one sort left).
pub async fn best_page(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
    after: Option<crate::score::Rank>,
    limit: i64,
) -> Result<Vec<(crate::score::Rank, FeedRow)>> {
    let run_of = |milli: i64| match milli.signum() {
        1 => 0,
        0 => 1,
        _ => 2,
    };
    let from = after.as_ref().map_or(0, |r| run_of(r.milli));
    let mut out: Vec<(crate::score::Rank, FeedRow)> = Vec::new();
    for run in from..3 {
        let want = limit - out.len() as i64;
        if want <= 0 {
            break;
        }
        let cursor = after.as_ref().filter(|r| run_of(r.milli) == run);
        let rows = if run == 1 {
            unscored_run(node_db, filter, cursor, want).await?
        } else {
            scored_run(node_db, filter, run == 0, cursor, want).await?
        };
        out.extend(rows);
    }
    Ok(out)
}

/// The scored run's SQL: `?1` the reader, then (with a cursor) `?2..?4` the cursor's score, time
/// and id, and the limit last. Read by the journal's window when `by_window`, else off the score
/// index; either way pinned, since this engine's planner picks neither of its own accord.
fn scored_sql(filter: &JournalFilter<'_>, above: bool, cursor: bool, by_window: bool) -> String {
    let columns = aliased_columns("j.");
    let sign = if above { "p.milli > 0" } else { "p.milli < 0" };
    // Pinned twice over - each table's index, and (CROSS JOIN) which one drives: left to itself
    // the planner drove from the journal and rescanned the scores for every row, 131,072 times.
    let (tables, clause) = if by_window {
        // The window first, as its own range scan: joined directly, the planner dropped the
        // window's range and walked the reader's whole journal.
        (
            format!(
                "(SELECT {JOURNAL_COLUMNS}, reader_root FROM feed_journal INDEXED BY feed_journal_by_time WHERE {}) j
                 CROSS JOIN post_scores p INDEXED BY sqlite_autoindex_post_scores_1
                   ON p.reader_root = j.reader_root AND p.author_root = j.author_root AND p.doc_id = j.doc_id",
                filter.clause("")
            ),
            "1".to_string(),
        )
    } else {
        (
            "post_scores p INDEXED BY post_scores_by_score
             CROSS JOIN feed_journal j INDEXED BY sqlite_autoindex_feed_journal_1
               ON j.reader_root = p.reader_root AND j.author_root = p.author_root AND j.doc_id = p.doc_id"
                .to_string(),
            filter.clause("j."),
        )
    };
    let head = format!(
        "SELECT {columns}, p.milli FROM {tables} WHERE p.reader_root = ?1 AND {sign} AND {clause}"
    );
    if cursor {
        format!(
            "{head} AND (p.milli < ?2 OR (p.milli = ?2 AND (j.published_ms < ?3 OR (j.published_ms = ?3 AND j.doc_id < ?4))))
             ORDER BY p.milli DESC, j.published_ms DESC, j.doc_id DESC LIMIT ?5"
        )
    } else {
        format!("{head} ORDER BY p.milli DESC, j.published_ms DESC, j.doc_id DESC LIMIT ?2")
    }
}

/// The unscored run's SQL: `?1` the reader, then (with a cursor) `?2..?3` its time and id, and
/// the limit last. The journal's time index walked backwards, each row's score probed by key -
/// both pinned, since this engine's planner scans every score of the reader per row otherwise.
fn unscored_sql(filter: &JournalFilter<'_>, cursor: bool) -> String {
    let columns = aliased_columns("j.");
    let clause = filter.clause("j.");
    let head = format!(
        "SELECT {columns} FROM feed_journal j INDEXED BY feed_journal_by_time
         WHERE {clause} AND NOT EXISTS (
             SELECT 1 FROM post_scores p INDEXED BY sqlite_autoindex_post_scores_1
             WHERE p.reader_root = j.reader_root AND p.author_root = j.author_root AND p.doc_id = j.doc_id
         )"
    );
    if cursor {
        format!(
            "{head} AND (j.published_ms < ?2 OR (j.published_ms = ?2 AND j.doc_id < ?3))
             ORDER BY j.published_ms DESC, j.doc_id DESC LIMIT ?4"
        )
    } else {
        format!("{head} ORDER BY j.published_ms DESC, j.doc_id DESC LIMIT ?2")
    }
}

/// One page of a reader's journal through `filter` in the hot order (PROJECT_PLAN's Scores and sort
/// orders, slice 2): each post at `published + score x 1h` (score.rs `hot_of`), after `after`,
/// with each row's score beside it. Two streams merged, neither sorting the feed: the unscored -
/// whose hot key is their time - off the time index as best's middle run reads them; and the
/// scored, which a score can only have moved by as far as the reader's highest and lowest scores
/// reach, so only the scored posts published within that reach of this page are read, each score
/// probed by key.
pub async fn hot_page(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
    after: Option<crate::score::HotRank>,
    limit: i64,
) -> Result<Vec<(crate::score::HotRank, FeedRow, i64)>> {
    use crate::score::{hot_of, HotRank, HOT_MS_PER_MILLI};
    let (lowest, highest): (Option<i64>, Option<i64>) = node_db
        .fetch_one(
            "SELECT MIN(milli), MAX(milli) FROM post_scores WHERE reader_root = ?1",
            (filter.reader,),
        )
        .await
        .context("reading the reach of a reader's scores")?;
    let reach_up = highest.unwrap_or(0).max(0).saturating_mul(HOT_MS_PER_MILLI);
    let reach_down = lowest.unwrap_or(0).min(0).saturating_mul(HOT_MS_PER_MILLI);
    // The unscored: a page of them, their hot key their time.
    let cursor = after.as_ref().map(|r| crate::score::Rank {
        milli: 0,
        published_ms: r.hot_ms,
        doc_id: r.doc_id.clone(),
    });
    let unscored = unscored_run(node_db, filter, cursor.as_ref(), limit).await?;
    // Below this page's last unscored post, the next page takes over.
    let floor = if unscored.len() as i64 == limit {
        unscored.last().map_or(i64::MIN, |(r, _)| r.published_ms)
    } else {
        i64::MIN
    };
    let ceiling = after.as_ref().map_or(i64::MAX, |r| r.hot_ms);
    // The scored whose hot key can fall in [floor, ceiling]: published within the reach of it.
    let (from, to) = (floor.saturating_sub(reach_up), ceiling.saturating_sub(reach_down));
    type Row = (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
        i64,
        i64,
    );
    let rows: Vec<Row> = node_db
        .fetch_all(&hot_scored_sql(filter), (filter.reader, from, to))
        .await
        .context("reading a hot page's scored posts")?;
    let mut all: Vec<(HotRank, FeedRow, i64)> = unscored
        .into_iter()
        .map(|(r, row)| (HotRank { hot_ms: r.published_ms, doc_id: r.doc_id }, row, 0))
        .collect();
    for (a, b, c, d, e, f, g, h, i, j, k, l, m, n, milli) in rows {
        let row = journal_row((a, b, c, d, e, f, g, h, i, j, k, l, m, n));
        let rank = HotRank { hot_ms: hot_of(row.published_ms, milli), doc_id: row.doc_id.clone() };
        let in_page = rank.hot_ms >= floor && after.as_ref().is_none_or(|c| c.before(&rank));
        if in_page {
            all.push((rank, row, milli));
        }
    }
    all.sort_by(|(a, _, _), (b, _, _)| (b.hot_ms, &b.doc_id).cmp(&(a.hot_ms, &a.doc_id)));
    all.truncate(limit as usize);
    Ok(all)
}

/// The hot page's scored posts: those published in `[?2, ?3]`, the window a range of the time
/// index and each score probed by key - pinned, table and order both.
fn hot_scored_sql(filter: &JournalFilter<'_>) -> String {
    let columns = aliased_columns("j.");
    format!(
        "SELECT {columns}, p.milli FROM
           (SELECT {JOURNAL_COLUMNS}, reader_root FROM feed_journal INDEXED BY feed_journal_by_time
            WHERE {} AND published_ms >= ?2 AND published_ms <= ?3) j
         CROSS JOIN post_scores p INDEXED BY sqlite_autoindex_post_scores_1
           ON p.reader_root = j.reader_root AND p.author_root = j.author_root AND p.doc_id = j.doc_id
         WHERE p.reader_root = ?1",
        filter.clause("")
    )
}

fn aliased_columns(t: &str) -> String {
    JOURNAL_COLUMNS.split(", ").map(|c| format!("{t}{c}")).collect::<Vec<_>>().join(", ")
}

/// Best's first or last run: the posts scored above (or below) zero, score order.
async fn scored_run(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
    above: bool,
    after: Option<&crate::score::Rank>,
    limit: i64,
) -> Result<Vec<(crate::score::Rank, FeedRow)>> {
    type Row = (
        String,
        Option<String>,
        Option<String>,
        String,
        String,
        Option<String>,
        i64,
        i64,
        i64,
        i64,
        i64,
        i64,
        Option<i64>,
        i64,
        i64,
    );
    // A month or less: read by the window; a year: off the score index.
    let by_window = filter
        .since_ms
        .is_some_and(|since| crate::clock::now_ms() - since <= 31 * 24 * 3600 * 1000);
    let sql = scored_sql(filter, above, after.is_some(), by_window);
    let rows: Vec<Row> = match after {
        None => node_db.fetch_all(&sql, (filter.reader, limit)).await,
        Some(r) => {
            node_db
                .fetch_all(&sql, (filter.reader, r.milli, r.published_ms, r.doc_id.as_str(), limit))
                .await
        }
    }
    .context("reading a best page's scored run")?;
    Ok(rows
        .into_iter()
        .map(|(a, b, c, d, e, f, g, h, i, j, k, l, m, n, milli)| {
            let row = journal_row((a, b, c, d, e, f, g, h, i, j, k, l, m, n));
            (
                crate::score::Rank {
                    milli,
                    published_ms: row.published_ms,
                    doc_id: row.doc_id.clone(),
                },
                row,
            )
        })
        .collect())
}

/// Best's middle run: every post nobody the reader weighs reacted to, newest first - the journal's
/// own page, less the scored.
async fn unscored_run(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
    after: Option<&crate::score::Rank>,
    limit: i64,
) -> Result<Vec<(crate::score::Rank, FeedRow)>> {
    let sql = unscored_sql(filter, after.is_some());
    let rows: Vec<JournalTuple> = match after {
        None => node_db.fetch_all(&sql, (filter.reader, limit)).await,
        Some(r) => {
            node_db.fetch_all(&sql, (filter.reader, r.published_ms, r.doc_id.as_str(), limit)).await
        }
    }
    .context("reading a best page's unscored run")?;
    Ok(rows
        .into_iter()
        .map(|t| {
            let row = journal_row(t);
            (
                crate::score::Rank {
                    milli: 0,
                    published_ms: row.published_ms,
                    doc_id: row.doc_id.clone(),
                },
                row,
            )
        })
        .collect())
}

/// A journal page's SQL: `?1` the reader, then (with a cursor) `?2..?3` its time and id, and the
/// limit last. Numbered placeholders: a value used twice binds ONCE (the first cursor branch bound
/// five values into four slots, which turso refused only on the branch no test paged).
fn page_sql(filter: &JournalFilter<'_>, cursor: bool) -> String {
    let clause = filter.clause("");
    let from = "FROM feed_journal INDEXED BY feed_journal_by_time";
    if cursor {
        format!(
            "SELECT {JOURNAL_COLUMNS} {from} WHERE {clause}
               AND (published_ms < ?2 OR (published_ms = ?2 AND doc_id < ?3))
             ORDER BY published_ms DESC, doc_id DESC LIMIT ?4"
        )
    } else {
        format!("SELECT {JOURNAL_COLUMNS} {from} WHERE {clause} ORDER BY published_ms DESC, doc_id DESC LIMIT ?2")
    }
}

/// These posts' rows in a reader's journal, through `filter` - each found by the journal's key, for
/// a search or a pick that has already named a small set of posts (search.rs, annotations.rs). In
/// no order; posts not in the reader's feed, or not through the filter, are simply absent.
pub async fn journal_rows_for(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
    posts: &[(String, String)],
) -> Result<Vec<FeedRow>> {
    let sql = format!(
        "SELECT {JOURNAL_COLUMNS} FROM feed_journal INDEXED BY sqlite_autoindex_feed_journal_1
         WHERE {} AND author_root = ?2 AND doc_id = ?3",
        filter.clause("")
    );
    let mut out = Vec::new();
    for (author, doc) in posts {
        let row: Option<JournalTuple> = node_db
            .fetch_optional(&sql, (filter.reader, author.as_str(), doc.as_str()))
            .await
            .context("reading a post's journal row")?;
        out.extend(row.map(journal_row));
    }
    Ok(out)
}

/// Every row of a reader's journal through `filter`, newest first, unbounded - for a filter that
/// picks a small kind (`room`, off the rooms index), or a window (the tag cloud's year, off the
/// time index) - never the whole of a journal. Pinned either way: this engine's planner picks
/// badly on its own.
pub async fn journal_all(
    node_db: &crate::db::Db,
    filter: &JournalFilter<'_>,
) -> Result<Vec<FeedRow>> {
    let index =
        if filter.formats == ["room"] { "feed_journal_by_format" } else { "feed_journal_by_time" };
    let rows: Vec<JournalTuple> = node_db
        .fetch_all(
            &format!(
                "SELECT {JOURNAL_COLUMNS} FROM feed_journal INDEXED BY {index} WHERE {} ORDER BY published_ms DESC, doc_id DESC",
                filter.clause("")
            ),
            (filter.reader,),
        )
        .await
        .context("reading a reader's journal")?;
    Ok(rows.into_iter().map(journal_row).collect())
}

/// One journal row's columns, as every journal SELECT lists them.
type JournalTuple = (
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    Option<String>,
    i64,
    i64,
    i64,
    i64,
    i64,
    i64,
    Option<i64>,
    i64,
);

fn journal_row(
    (
        author_root,
        via_root,
        suggested_via,
        doc_id,
        title,
        format,
        published_ms,
        updated_ms,
        arrived_ms,
        settled,
        trusted_only,
        onward,
        dated_ms,
        minted_ms,
    ): JournalTuple,
) -> FeedRow {
    FeedRow {
        author_root,
        via_root,
        suggested_via,
        doc_id,
        title,
        format,
        published_ms,
        updated_ms,
        arrived_ms,
        dated_ms,
        minted_ms,
        settled: settled != 0,
        trusted_only: trusted_only != 0,
        onward: onward != 0,
    }
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
        assert_eq!(
            journal_mark(&db, "aa").await.unwrap(),
            Some(100),
            "a lagging report cannot drag it back"
        );
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
            settled: false,
            trusted_only: false,
            onward: false,
            doc_id_hex: format!("{doc:0>32}"),
            title: title.to_string(),
            format: "plaintext".to_string(),
            published_ms: 1_000,
            updated_ms,
            dated_ms: None,
            minted_ms: 0,
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
            ("cc".repeat(32), author.as_str(), doc.as_str(), "bb".repeat(32)),
        )
        .await
        .unwrap();

        excise_shared(&db, &author, &doc).await.unwrap();

        let rows: Vec<(String,)> =
            db.fetch_all("SELECT title FROM feed_journal ORDER BY title", ()).await.unwrap();
        assert_eq!(
            rows.iter().map(|(t,)| t.as_str()).collect::<Vec<_>>(),
            vec!["mine"],
            "the shared row goes; a row we hold on our own account is untouched"
        );
    }

    /// The precedence ladder, both directions (PROJECT_PLAN's Discovery, slice 2): a real arrival converts
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
            settled: false,
            trusted_only: false,
            onward: false,
            doc_id_hex: "11".repeat(16),
            title: "the-unasked-for-post".into(),
            format: "plaintext".into(),
            published_ms: 1,
            updated_ms: 1,
            dated_ms: None,
            minted_ms: 0,
        };
        let rows = [&row];
        let wanting = [(reader.clone(), introducer.clone())];

        // Speculative first: the row lands marked.
        journal_rows_suggested(&db, &author, &wanting, &rows).await.unwrap();
        let marked: Vec<(Option<String>,)> =
            db.fetch_all("SELECT suggested_via FROM feed_journal", ()).await.unwrap();
        assert_eq!(marked, vec![(Some(introducer.clone()),)], "the row lands marked");

        // A real (follow) arrival converts in place: one row, marking shed.
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, None).await.unwrap();
        let converted: Vec<(Option<String>, Option<String>)> =
            db.fetch_all("SELECT suggested_via, via_root FROM feed_journal", ()).await.unwrap();
        assert_eq!(converted, vec![(None, None)], "one row, real, marking gone");

        // And never the reverse: a late speculative write leaves the real row untouched.
        journal_rows_suggested(&db, &author, &wanting, &rows).await.unwrap();
        let still: Vec<(Option<String>,)> =
            db.fetch_all("SELECT suggested_via FROM feed_journal", ()).await.unwrap();
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
            settled: false,
            trusted_only: false,
            onward: false,
            doc_id_hex: "11".repeat(16),
            title: "t".into(),
            format: "plaintext".into(),
            published_ms: 1,
            updated_ms: 1,
            dated_ms: None,
            minted_ms: 0,
        };
        let rows = [&row];
        let wanting = [(reader.clone(), introducer.clone())];

        // The race's losing order: speculation first, then the real share.
        journal_rows_suggested(&db, &author, &wanting, &rows).await.unwrap();
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, Some(&sharer))
            .await
            .unwrap();
        let converted: Vec<(Option<String>, Option<String>)> =
            db.fetch_all("SELECT suggested_via, via_root FROM feed_journal", ()).await.unwrap();
        assert_eq!(
            converted,
            vec![(None, Some(sharer.clone()))],
            "a share converts a speculative row: byline set, marking shed"
        );

        // The ladder above shares still holds: a follow arrival outranks the byline...
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, None).await.unwrap();
        // ...and a genuine follow row is never re-bylined by a later share.
        journal_rows(&db, &author, std::slice::from_ref(&reader), &rows, Some(&sharer))
            .await
            .unwrap();
        let follow: Vec<(Option<String>, Option<String>)> =
            db.fetch_all("SELECT suggested_via, via_root FROM feed_journal", ()).await.unwrap();
        assert_eq!(follow, vec![(None, None)], "a follow row outranks a share byline, still");
    }

    /// The curiosity dial in SQL (`selectivity::stop_predicate`) against the rule it restates
    /// (`selectivity::visible_at`), row for row: every author dial against every path level,
    /// each author's post arriving direct, shared by a sharer at every rebroadcast dial, and
    /// suggested - and the reader's own post through every stop.
    #[tokio::test]
    async fn the_dial_in_sql_keeps_exactly_what_the_rule_keeps() {
        use crate::selectivity::{stop_rule, visible_at, Facts, RowView};
        let db = crate::db::test_node_db().await;
        let reader = "ee".repeat(32);
        let bands = [None, Some("none"), Some("low"), Some("medium"), Some("high"), Some("max")];
        let root = |kind: u8, n: usize| format!("{kind:02x}{n:062x}");
        let mut facts = Facts::new();
        let mut levels = std::collections::HashMap::new();
        let sharers: Vec<String> = (0..bands.len()).map(|v| root(0xbb, v)).collect();
        for (v, band) in bands.iter().enumerate() {
            if let Some(b) = band {
                facts
                    .entry(sharers[v].clone())
                    .or_default()
                    .insert("interest_rebroadcasts".into(), b.to_string());
            }
        }
        struct Row {
            author: String,
            doc: String,
            via: Option<String>,
            suggested: Option<String>,
        }
        let mut rows: Vec<Row> = Vec::new();
        let mut n = 0;
        for dial in bands {
            for level in bands {
                let author = root(0xaa, n);
                n += 1;
                if let Some(d) = dial {
                    facts
                        .entry(author.clone())
                        .or_default()
                        .insert("interest".into(), d.to_string());
                }
                if let Some(l) = level {
                    levels.insert(author.clone(), l.to_string());
                }
                let mut push = |via: Option<String>, suggested: Option<String>| {
                    rows.push(Row {
                        author: author.clone(),
                        doc: format!("{:032x}", rows.len()),
                        via,
                        suggested,
                    });
                };
                push(None, None);
                for s in &sharers {
                    push(Some(s.clone()), None);
                }
                push(None, Some(root(0xcc, 0)));
            }
        }
        rows.push(Row {
            author: reader.clone(),
            doc: format!("{:032x}", rows.len()),
            via: None,
            suggested: None,
        });
        for (i, r) in rows.iter().enumerate() {
            db.execute(
                "INSERT INTO feed_journal
                   (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms, via_root, suggested_via)
                 VALUES (?1, ?2, ?3, 't', 'marquee', ?4, ?4, ?4, ?5, ?6)",
                (reader.as_str(), r.author.as_str(), r.doc.as_str(), i as i64, r.via.as_deref(), r.suggested.as_deref()),
            )
            .await
            .unwrap();
        }
        for stop in [
            "explorer",
            "highly-speculative",
            "speculative",
            "interest",
            "medium",
            "high",
            "nonsense",
        ] {
            let want: std::collections::BTreeSet<&str> = rows
                .iter()
                .filter(|r| {
                    r.author == reader
                        || visible_at(
                            stop,
                            &RowView {
                                author: &r.author,
                                via: r.via.as_deref(),
                                suggested_via: r.suggested.as_deref(),
                                suggested_level: r
                                    .suggested
                                    .as_ref()
                                    .and_then(|_| levels.get(&r.author))
                                    .map(String::as_str),
                            },
                            &facts,
                        )
                })
                .map(|r| r.doc.as_str())
                .collect();
            let filter = JournalFilter {
                stop: stop_rule(stop, &facts, &levels),
                ..JournalFilter::feed(&reader)
            };
            let got = journal_all(&db, &filter).await.unwrap();
            let got: std::collections::BTreeSet<&str> =
                got.iter().map(|r| r.doc_id.as_str()).collect();
            assert_eq!(got, want, "the {stop} stop");
            assert!(
                want.len() < rows.len() || matches!(stop, "explorer" | "nonsense"),
                "the {stop} stop keeps something back - a case worth the name"
            );
        }
    }

    /// The journal filter's other terms: formats, the reader's own, a window, and a page after a
    /// cursor - and a room found under any number of newer posts (the chats column's 5000 cap).
    #[tokio::test]
    async fn the_journal_filter_pages_and_narrows_in_sql() {
        let db = crate::db::test_node_db().await;
        let reader = "ee".repeat(32);
        let other = "aa".repeat(32);
        let row = |author: &str, doc: String, format: &str, ms: i64| {
            (author.to_string(), doc, format.to_string(), ms)
        };
        let mut rows = vec![
            row(&other, "d-room".into(), "room", 1),
            row(&reader, "d-mine".into(), "marquee", 2),
        ];
        for i in 0..6000 {
            rows.push(row(&other, format!("d-{i:05}"), "marquee", 10 + i));
        }
        rows.push(row(&other, "d-media".into(), "avif", 99_999));
        for (author, doc, format, ms) in &rows {
            db.execute(
                "INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)
                 VALUES (?1, ?2, ?3, 't', ?4, ?5, ?5, ?5)",
                (reader.as_str(), author.as_str(), doc.as_str(), format.as_str(), *ms),
            )
            .await
            .unwrap();
        }
        let rooms =
            journal_all(&db, &JournalFilter { formats: &["room"], ..JournalFilter::feed(&reader) })
                .await
                .unwrap();
        assert_eq!(
            rooms.iter().map(|r| r.doc_id.as_str()).collect::<Vec<_>>(),
            ["d-room"],
            "under 6000 newer posts"
        );
        let first = journal_page(&db, &JournalFilter::feed(&reader), None, 2).await.unwrap();
        assert_eq!(
            first.iter().map(|r| r.doc_id.as_str()).collect::<Vec<_>>(),
            ["d-05999", "d-05998"],
            "no media"
        );
        let next = journal_page(
            &db,
            &JournalFilter::feed(&reader),
            Some((first[1].published_ms, first[1].doc_id.clone())),
            2,
        )
        .await
        .unwrap();
        assert_eq!(
            next.iter().map(|r| r.doc_id.as_str()).collect::<Vec<_>>(),
            ["d-05997", "d-05996"]
        );
        let oldest = journal_page(
            &db,
            &JournalFilter { since_ms: None, ..JournalFilter::feed(&reader) },
            Some((10, "d-00000".into())),
            5,
        )
        .await
        .unwrap();
        assert_eq!(
            oldest.iter().map(|r| r.doc_id.as_str()).collect::<Vec<_>>(),
            ["d-mine", "d-room"],
            "paged to the very end"
        );
        let not_mine = journal_page(
            &db,
            &JournalFilter { own: Own::Out, ..JournalFilter::feed(&reader) },
            Some((10, "d-00000".into())),
            5,
        )
        .await
        .unwrap();
        assert_eq!(not_mine.iter().map(|r| r.doc_id.as_str()).collect::<Vec<_>>(), ["d-room"]);
        let window = journal_page(
            &db,
            &JournalFilter { since_ms: Some(6008), ..JournalFilter::feed(&reader) },
            None,
            100,
        )
        .await
        .unwrap();
        assert_eq!(window.len(), 2, "published at or after the window's start");
    }

    /// Hot's paging against brute force (PROJECT_PLAN's Scores and sort orders, slice 2): 300 posts
    /// over a month - many sharing a timestamp - 40% scored between three dislikes and six likes;
    /// paged seven at a time, the pages concatenated must be every post in hot order, once.
    #[tokio::test]
    async fn hot_pages_are_the_hot_order_in_full() {
        use crate::score::{hot_of, HotRank};
        let db = crate::db::test_node_db().await;
        let reader = "ee".repeat(32);
        let author = "aa".repeat(32);
        // A small deterministic generator - the case is fixed, the spread is not hand-picked.
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let hour = 3_600_000_i64;
        let mut want: Vec<(i64, String)> = Vec::new();
        for i in 0..300 {
            let doc = format!("{i:032x}");
            let published = 1_000_000_000_000 + ((next() % 720) as i64) * hour; // on the hour: ties
            db.execute(
                "INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)
                 VALUES (?1, ?2, ?3, 't', 'marquee', ?4, ?4, ?4)",
                (reader.as_str(), author.as_str(), doc.as_str(), published),
            )
            .await
            .unwrap();
            let milli = if next() % 10 < 4 { (next() % 9000) as i64 - 3000 } else { 0 };
            if milli != 0 {
                db.execute(
                    "INSERT INTO post_scores (reader_root, author_root, doc_id, milli) VALUES (?1, ?2, ?3, ?4)",
                    (reader.as_str(), author.as_str(), doc.as_str(), milli),
                )
                .await
                .unwrap();
            }
            want.push((hot_of(published, milli), doc));
        }
        want.sort_by(|a, b| b.cmp(a));
        let filter = JournalFilter::feed(&reader);
        let mut got: Vec<(i64, String)> = Vec::new();
        let mut after: Option<HotRank> = None;
        for _ in 0..100 {
            let page = hot_page(&db, &filter, after.clone(), 7).await.unwrap();
            if page.is_empty() {
                break;
            }
            after = page.last().map(|(r, _, _)| r.clone());
            got.extend(page.into_iter().map(|(r, _, _)| (r.hot_ms, r.doc_id)));
        }
        assert_eq!(got.len(), want.len(), "every post, once");
        assert_eq!(got, want, "in hot order");
    }

    /// The journal's reads walk their indexes and never sort the journal (node rung 0058): this
    /// engine's planner, left alone, reached for the rooms index and sorted a reader's whole journal
    /// for every feed page - 3 s a page at 131,072 posts. The pins hold only while the planner obeys
    /// them, so this asks it. (The scored runs sort by score: their one sort, over scored posts.)
    #[tokio::test]
    async fn the_journal_reads_walk_their_indexes() {
        let db = crate::db::test_node_db().await;
        let reader = "ee".repeat(32);
        let filter = JournalFilter { since_ms: Some(0), ..JournalFilter::feed(&reader) };
        let plan = |sql: String| {
            let db = db.clone();
            async move {
                let rows: Vec<(i64, i64, i64, String)> =
                    db.fetch_all(&format!("EXPLAIN QUERY PLAN {sql}"), ()).await.unwrap();
                rows.into_iter().map(|(_, _, _, d)| d).collect::<Vec<_>>().join(" | ")
            }
        };
        for (name, sql) in [
            ("a feed page", page_sql(&filter, false)),
            ("a later feed page", page_sql(&filter, true)),
            ("best's unscored run", unscored_sql(&filter, false)),
            ("best's unscored run, later", unscored_sql(&filter, true)),
        ] {
            let p = plan(sql).await;
            assert!(p.contains("feed_journal_by_time"), "{name} walks the time index: {p}");
            assert!(!p.contains("SORTER"), "{name} streams, never sorts: {p}");
        }
        let p = plan(unscored_sql(&filter, false)).await;
        assert!(
            p.contains("post_scores_1 (reader_root=? AND author_root=? AND doc_id=?)"),
            "a score probed by key: {p}"
        );
        // Hot's scored posts: a bounded range of the time index, each score by key.
        let p = plan(hot_scored_sql(&filter)).await;
        assert!(
            p.contains(
                "feed_journal_by_time (reader_root=? AND published_ms>=? AND published_ms<=?)"
            ),
            "hot reads a bounded range: {p}"
        );
        assert!(
            p.contains("post_scores_1 (reader_root=? AND author_root=? AND doc_id=?)"),
            "hot probes each score by key: {p}"
        );
        // A search's or a pick's small set, met with the journal by key.
        let p = plan(format!(
            "SELECT {JOURNAL_COLUMNS} FROM feed_journal INDEXED BY sqlite_autoindex_feed_journal_1 WHERE {} AND author_root = ?2 AND doc_id = ?3",
            filter.clause("")
        ))
        .await;
        assert!(
            p.contains("feed_journal_1 (reader_root=? AND author_root=? AND doc_id=?)"),
            "a post by its key: {p}"
        );
        // The tag cloud's year, and the chats column's rooms.
        let p = plan(format!(
            "SELECT {JOURNAL_COLUMNS} FROM feed_journal INDEXED BY feed_journal_by_time WHERE {}",
            filter.clause("")
        ))
        .await;
        assert!(
            p.contains("feed_journal_by_time (reader_root=? AND published_ms>=?)"),
            "a window reads only the window: {p}"
        );
        // The scored runs: which table drives, and the other probed by key. Left to itself the
        // planner drove the year's run from the journal and rescanned every score per row - a
        // page that never finished at 131,072 posts.
        for above in [true, false] {
            let p = plan(scored_sql(&filter, above, true, true)).await;
            assert!(
                p.contains("feed_journal_by_time (reader_root=? AND published_ms>=?)"),
                "a month or less reads only its window: {p}"
            );
            assert!(
                p.contains("post_scores_1 (reader_root=? AND author_root=? AND doc_id=?)"),
                "and probes each score by key: {p}"
            );
            let p = plan(scored_sql(&filter, above, true, false)).await;
            assert!(
                p.starts_with("SEARCH p USING INDEX post_scores_by_score"),
                "a year is driven from the score index: {p}"
            );
            assert!(
                p.contains("feed_journal_1 (reader_root=? AND author_root=? AND doc_id=?)"),
                "and probes the journal by key: {p}"
            );
        }
    }

    /// The timing check behind the plan's million-row aim (2026-09-27): a 100,000-post journal
    /// over two years, 20,000 of them scored, and every best window's first page and a deep page
    /// timed. Ignored in the suite - it measures, it does not judge; run it by name.
    #[tokio::test]
    #[ignore]
    async fn best_pages_at_scale() {
        let db = crate::db::test_node_db().await;
        let reader = "ee".repeat(32);
        let author = "aa".repeat(32);
        let now = crate::clock::now_ms();
        let span = 2 * 365 * 24 * 3600 * 1000_i64;
        // One row doubled seventeen times: 131,072 posts evenly over two years (a statement per
        // row takes minutes on this engine - itself worth knowing).
        let n: i64 = 1 << 17;
        let step = span / n;
        let started = std::time::Instant::now();
        db.execute(
            "INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)
             VALUES (?1, ?2, 'd', 't', 'marquee', ?3, ?3, ?3)",
            (reader.as_str(), author.as_str(), now),
        )
        .await
        .unwrap();
        for k in 0..17 {
            db.execute(
                &format!(
                    "INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)
                     SELECT reader_root, author_root, doc_id || '-{k}', title, format, published_ms - {}, updated_ms, arrived_ms
                     FROM feed_journal WHERE reader_root = ?1",
                    (1_i64 << k) * step
                ),
                (reader.as_str(),),
            )
            .await
            .unwrap();
        }
        // Every fifth post scored, from -1000 to +3999, none zero.
        db.execute(
            &format!(
                "INSERT INTO post_scores (reader_root, author_root, doc_id, milli)
                 SELECT reader_root, author_root, doc_id, ((((?2 - published_ms) / {step}) * 7919) % 5000) - 999
                 FROM feed_journal WHERE reader_root = ?1 AND ((?2 - published_ms) / {step}) % 5 = 0"
            ),
            (reader.as_str(), now),
        )
        .await
        .unwrap();
        let (posts,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM feed_journal", ()).await.unwrap();
        let (scored,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM post_scores", ()).await.unwrap();
        assert_eq!(posts, n);
        eprintln!("scored: {scored}");
        eprintln!("fixture: {n} posts in {:?}", started.elapsed());
        {
            let filter = JournalFilter::feed(&reader);
            let t = std::time::Instant::now();
            let first = hot_page(&db, &filter, None, 21).await.unwrap();
            let first_ms = t.elapsed();
            let mut cursor = first.last().map(|(r, _, _)| r.clone());
            let t = std::time::Instant::now();
            for _ in 0..50 {
                let Some(c) = cursor.take() else { break };
                let page = hot_page(&db, &filter, Some(c), 21).await.unwrap();
                cursor = page.last().map(|(r, _, _)| r.clone());
            }
            eprintln!(
                "hot: first page {first_ms:?} ({} rows); next 50 pages {:?}",
                first.len(),
                t.elapsed()
            );
        }
        for (name, window) in [
            ("day", Some("day")),
            ("week", Some("week")),
            ("month", Some("month")),
            ("year", Some("year")),
        ] {
            let filter = JournalFilter {
                since_ms: Some(now - crate::score::window_ms(window)),
                ..JournalFilter::feed(&reader)
            };
            let t = std::time::Instant::now();
            let first = best_page(&db, &filter, None, 21).await.unwrap();
            let first_ms = t.elapsed();
            let mut cursor = first.last().map(|(r, _)| r.clone());
            let t = std::time::Instant::now();
            let mut pages = 0;
            while let Some(c) = cursor.take() {
                let page = best_page(&db, &filter, Some(c), 21).await.unwrap();
                pages += 1;
                if pages >= 50 || page.len() < 21 {
                    break;
                }
                cursor = page.last().map(|(r, _)| r.clone());
            }
            eprintln!(
                "{name}: first page {:?} ({} rows); next {pages} pages {:?}",
                first_ms,
                first.len(),
                t.elapsed()
            );
        }
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

        let (count,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM feed_journal", ()).await.unwrap();
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

        journal_rows(&db, &author, &reader, &[&restamped], Some(&sharer)).await.unwrap();
        let (published, updated): (i64, i64) =
            db.fetch_one("SELECT published_ms, updated_ms FROM feed_journal", ()).await.unwrap();
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
                let row: (Option<String>,) =
                    db.fetch_one("SELECT via_root FROM feed_journal", ()).await.unwrap();
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

        let (count,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM feed_journal", ()).await.unwrap();
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
        let posts: Vec<JournalRow> =
            (0..40).map(|i| post(&i.to_string(), "first words", 2_000 + i)).collect();
        let refs: Vec<&JournalRow> = posts.iter().collect();

        // 3 readers x 40 posts = 120 pairs: two chunks, the second partial.
        journal_rows(&db, &author, &readers, &refs, None).await.unwrap();
        let (count,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM feed_journal", ()).await.unwrap();
        assert_eq!(count, 120);

        // The upsert half: re-journal one edited post. A sentinel arrival stamp proves the
        // conflict arm ran an UPDATE (not insert-or-ignore) and left arrived_ms alone.
        db.execute("UPDATE feed_journal SET arrived_ms = 42", ()).await.unwrap();
        let edited = [post("0", "better words", 9_000)];
        let edited_refs: Vec<&JournalRow> = edited.iter().collect();
        journal_rows(&db, &author, &readers, &edited_refs, None).await.unwrap();

        let (count,): (i64,) = db.fetch_one("SELECT COUNT(*) FROM feed_journal", ()).await.unwrap();
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
        assert_eq!(
            by_author,
            vec![kim.clone(), sam.clone(), bob.clone()],
            "the per-author union spans documents, earliest stand first"
        );

        assert!(
            sharers_of_doc(&db, &alice, &hex::encode([9u8; 16])).await.unwrap().is_empty(),
            "a document nobody local was journaled a share of yields nothing to dial"
        );
    }
}
