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
    // Push onward only for personas this node authors. Relaying someone ELSE's lane onward is
    // rebroadcast - a consent question, not a routing one - and waits for its own design.
    match crate::identity::is_agented(&state.node_db, root_hex).await {
        Ok(true) => push_to_askers(state, root_hex).await,
        Ok(false) => {}
        Err(e) => tracing::debug!(error = ?e, "agented check failed in fanout"),
    }
}

/// One journal row per (reader who follows them) x (post on their newest page).
///
/// The newest page is the whole journal window, and that bound is doing deliberate work:
/// following someone with years of history journals their latest twenty posts, not their life
/// story ("backfill is the burst to bound" - PROJECT_PLAN, Data Layer). The older posts are not
/// lost - they are on the persona's page, where reading further back is a choice.
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
    if readers.is_empty() {
        return Ok(0); // nobody here follows them - the common case, and it costs one query
    }
    journal_page(state, author_root, &readers).await
}

/// The shelf's newest page, journaled to exactly these readers. The shared bottom half of
/// both arrival paths: a public move journals to every current follower (`journal_for`), and
/// a NEW follow journals to its one new reader (`backfill_follow`).
async fn journal_page(state: &AppState, author_root: &str, readers: &[String]) -> Result<usize> {
    let db = state
        .user_dbs
        .get(author_root)
        .await
        .with_context(|| format!("opening {author_root} to read its shelf"))?;
    let posts =
        crate::record::documents::public_docs(&db, None, crate::idface::POSTS_PAGE).await?;
    if posts.is_empty() {
        return Ok(0); // the move was profile/keys, not posts - nothing feed-shaped arrived
    }

    let now = now_ms();
    let mut journaled = 0;
    for reader in readers {
        for p in &posts {
            // arrived_ms survives the upsert: it answers "when did this reach me", and a
            // re-publication changes what the post says, not when it arrived.
            state
                .node_db
                .execute(
                    "INSERT INTO feed_journal
                       (reader_root, author_root, doc_id, title, format,
                        published_ms, updated_ms, arrived_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT (reader_root, author_root, doc_id) DO UPDATE SET
                         title = excluded.title,
                         format = excluded.format,
                         updated_ms = excluded.updated_ms",
                    (
                        reader.as_str(),
                        author_root,
                        hex::encode(p.doc_id),
                        p.title.as_str(),
                        crate::record::documents::Format::from_wire(p.format).as_str(),
                        p.genesis_ms,
                        p.head_ms,
                        now,
                    ),
                )
                .await
                .context("journaling an arrival")?;
        }
        journaled += 1;
    }
    Ok(journaled)
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
    let just_them = [reader_root.to_string()];
    match journal_page(state, author_root, &just_them).await {
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

/// Unfollow (or block) excises: every journal row from an author this reader no longer
/// eagerly follows is deleted, in the same breath that drops the subscription. "Don't show"
/// means it retroactively too - the feed is the reader's room, and stopping listening to
/// someone includes what they already said in it. The rows are a node-level delivery memo,
/// not history (the posts still exist on the author's shelf; a re-follow backfills them
/// right back), so deletion loses nothing anyone owns.
///
/// `followed` is the CURRENT eager set; own rows are exempt (your posts are in your feed
/// because you are hosted here, not because you follow yourself).
pub async fn excise_unfollowed(
    state: &AppState,
    reader_root: &str,
    followed: &[String],
) -> Result<()> {
    let quoted: Vec<String> = followed
        .iter()
        .filter(|r| r.len() == 64 && r.chars().all(|c| c.is_ascii_hexdigit()))
        .map(|r| format!("'{r}'"))
        .collect();
    state
        .node_db
        .execute(
            &format!(
                "DELETE FROM feed_journal WHERE reader_root = ?1 AND author_root != ?1
                 AND author_root NOT IN ({})",
                if quoted.is_empty() { "''".into() } else { quoted.join(",") }
            ),
            (reader_root,),
        )
        .await
        .context("excising unfollowed authors from the feed journal")?;
    Ok(())
}

/// Dial the nodes that have asked about this persona, in the background - a dead asker's
/// timeout must not stall the sweep that noticed the post.
///
/// The persona's own devices are excluded: the eager loop already keeps them current on its
/// own debounce, and dialing them twice buys nothing but a no-op exchange.
async fn push_to_askers(state: &AppState, root_hex: &str) {
    let askers = match crate::net::demand::askers_of(&state.node_db, root_hex).await {
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
    type Row = (String, String, String, Option<String>, i64, i64, i64);
    // Text only, twice over: the shelf read upstream no longer journals media documents at
    // all (`public_docs` filters them - they're ingredients, not posts), and this clause
    // makes journals written BEFORE that filter harmless rather than a page of raw bytes
    // rendered as text.
    let rows: Vec<Row> = match before {
        None => node_db
            .fetch_all(
                "SELECT author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms
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
                "SELECT author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms
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
            |(author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)| FeedRow {
                author_root,
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
