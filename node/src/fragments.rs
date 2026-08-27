//! The fragment ledger: documents this node holds without holding their authors.
//!
//! The bookkeeping half of the reader's rebroadcast path (PROJECT_PLAN, *What travels with a
//! share*). `net::fragment` is the wire; this is the memory of what came over it, who to ask
//! again, and when we last checked.
//!
//! ## A claim, not a subscription
//!
//! Every row here exists because a local reader follows somebody who SHARED this document. It
//! carries no obligation to the author, creates no sync edge, and dies the moment the pointer
//! that wanted it does. That is the whole point: a reader receives a fragment, never a
//! subscription, or a dense network degrades to every persona synced to every computer.
//!
//! ## Revalidation is against the origin, and that is what makes deletion travel
//!
//! `origin_root` is who handed us the pointer. Asking THEM rather than the author means the
//! retraction cascade runs entirely over edges that already exist: the author tombstones, the
//! sharer's pin sees it, the sharer answers `Gone`, this row dies, and whoever fetched from us
//! hears the same on their next pass. Staleness is bounded per hop, which is the honest cost.

use anyhow::{Context, Result};

use crate::clock::now_ms;
use crate::db::Db;

/// One held fragment, as a journaling caller reads it. Deliberately not the whole row: the
/// origin and the body hash are the ledger's own business (revalidation, blob healing), and a
/// consumer that could see them would be tempted to act on them.
#[derive(Debug, Clone)]
pub struct Fragment {
    pub title: String,
    pub format: Option<String>,
}

/// Remember a verified fragment, or refresh what we already knew of it.
///
/// The version is allowed to move: an author editing inside the edit window re-signs the header,
/// and the origin will hand over the newer one. What may never move without a re-verification is
/// the entry itself, which is why the caller passes bytes that `verify_fragment` has already
/// approved rather than anything this function trusts on its own.
///
/// **A buried document is never taken back.** Verification proves the author wrote these words;
/// it says nothing about *when the sharer last heard*, and a peer who was asleep through a
/// takedown holds a perfectly signed copy of a post that no longer exists. This is the guard for
/// that, and it lives here because this is the single door all three intake paths land on - the
/// first fetch, the revalidation sweep, and the want-drain.
pub async fn remember(
    node_db: &Db,
    origin_root: &str,
    author_root: &str,
    verified: &ringtome_proto::fragment::VerifiedFragment,
    entry: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<()> {
    // Final for the document id, exactly as the author's own shelf treats it
    // (`documents::retracted_doc_ids`): re-publishing after a delete mints a NEW id, so there is
    // no legitimate arrival a tombstone could wrongly refuse.
    if entombed(node_db, author_root, &verified.doc_id).await? {
        tracing::debug!(
            author = %author_root, doc = %hex::encode(verified.doc_id), origin = %origin_root,
            "refused a fragment for a document we know to be gone"
        );
        return Ok(());
    }
    // The edit window, shelf side (2026-08-15): a version claiming to postdate its own
    // genesis by more than the window is admitted and ignored - the fold's posture, on the
    // one node that has no chain to fold. Both stamps are the author's own claims. And a
    // genesis that MOVES between fetches is refused as malformed: an honest author's genesis
    // never changes, so drift is corruption or nonsense, not a case to honor (carries no
    // security weight - the freeze itself contains the forger, whose rewrite the established
    // network simply never asks about; Curtis, 2026-08-15).
    if let Some(genesis) = verified.header.genesis_ms {
        if verified.timestamp_ms
            > genesis.saturating_add(crate::record::documents::edit_window_ms())
        {
            tracing::debug!(
                author = %author_root, doc = %hex::encode(verified.doc_id),
                "ignored an edit past the window");
            return Ok(());
        }
    }
    let held_row: Option<(Option<i64>, Vec<u8>, String)> = node_db
        .fetch_optional(
            "SELECT genesis_ms, entry, version FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, hex::encode(verified.doc_id)),
        )
        .await
        .context("reading a held fragment")?;
    if let Some((held_genesis, held_entry, held_version)) = held_row {
        if held_genesis.is_some() && held_genesis != verified.header.genesis_ms {
            tracing::warn!(
                author = %author_root, doc = %hex::encode(verified.doc_id),
                "refused a fragment whose genesis moved between fetches");
            return Ok(());
        }
        // The ordering rule (2026-08-15): an arriving version OLDER by the author's own
        // numbers changes nothing. Without it, "which version does a fragment holder have?"
        // was a function of network ARRIVAL ORDER - the last answerer won, so a sharer whose
        // chain knowledge had fossilized could roll an edit back at every node the author
        // could not out-answer, and heterogeneous sharers made the copy oscillate. This is
        // the LWW-register move: same-leaf-chain versions compare by `seq` (pure causal
        // order, no stamps consulted), cross-device versions by `(claimed stamp, hash)` -
        // `display_head`'s own comparator, so fragment holders and chain holders converge on
        // the same answer from the same author-signed numbers. No local clock, no network
        // time, no cross-author comparison anywhere; an author whose devices' clocks disagree
        // confuses only their own document's holders, in-window, until the freeze.
        //
        // The SAME version passes through: the wholesale re-store is how `checked_ms`
        // advances, and refusing an identical refresh would leave the row perpetually due.
        // A held entry that no longer decodes fails OPEN - corruption must not wedge a row
        // against every future update; the serving door already refuses to serve it.
        if held_version != hex::encode(verified.version) {
            if let (Ok(held), Ok(arriving)) = (
                ringtome_proto::SignedEntry::decode(&held_entry),
                ringtome_proto::SignedEntry::decode(entry),
            ) {
                let (h, a) = (held.entry(), arriving.entry());
                let older = if a.chain.author == h.chain.author {
                    a.seq < h.seq
                } else {
                    (a.timestamp_ms, *arriving.hash()) < (h.timestamp_ms, *held.hash())
                };
                if older {
                    tracing::debug!(
                        author = %author_root, doc = %hex::encode(verified.doc_id),
                        "ignored a version older than the one held - arrival order is not authorship order");
                    return Ok(());
                }
            }
        }
    }
    let now = now_ms();
    node_db
        .execute(
            "INSERT INTO fragments
               (author_root, doc_id, origin_root, version, entry, auth_path, title, format,
                body_hash, genesis_ms, fetched_ms, checked_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?11, ?10, ?10)
             ON CONFLICT (author_root, doc_id) DO UPDATE SET
                 origin_root = excluded.origin_root,
                 version = excluded.version,
                 entry = excluded.entry,
                 auth_path = excluded.auth_path,
                 title = excluded.title,
                 format = excluded.format,
                 body_hash = excluded.body_hash,
                 checked_ms = excluded.checked_ms",
            (
                author_root,
                hex::encode(verified.doc_id),
                origin_root,
                hex::encode(verified.version),
                entry,
                pack_path(auth_path),
                verified.header.title.as_str(),
                crate::record::documents::Format::from_wire(verified.header.format)
                    .as_str()
                    .to_string(),
                verified.header.file_hash.to_vec(),
                now,
                verified.header.genesis_ms,
            ),
        )
        .await
        .context("remembering a fragment")?;
    // A reply fragment's link joins the replies memo (COMMENTS.md slice 2); the fragment
    // lifecycle owns the row - `forget_one` is the other half.
    if let Err(e) = crate::replies::note_reply(node_db, author_root, verified).await {
        tracing::debug!(author = %author_root, error = ?e, "noting a reply fragment failed");
    }
    Ok(())
}

/// Drop one fragment: the author withdrew it, or nobody wants it any more.
///
/// **The feed rows go with it.** A fragment is the only copy of that document on this node - its
/// author's chain is not here - so a journal row that outlived it would render a title with no
/// words behind it forever, which is worse than the row simply being gone. This is the same rule
/// `retract_vanished` applies to followed authors, applied where that sweep cannot reach: it
/// reconciles against the author's shelf, and on a reader's node there is no shelf to read.
pub async fn forget(node_db: &Db, author_root: &str, doc_id: &str) -> Result<()> {
    forget_one(node_db, author_root, doc_id).await?;
    // The cover cascade (2026-08-14): if this was a POST, the media fragments it covered lose
    // a reason to exist, and the ones with no covers left go with it. One level deep by
    // construction - a public post's refs only ever name media twins (the bake refuses
    // anything else), and media documents are leaves.
    for media in drop_covers_of_post(node_db, author_root, doc_id).await? {
        tracing::debug!(author = %author_root, media = %media, post = %doc_id,
            "a media fragment lost its last cover - dropped with its post");
        forget_one(node_db, author_root, &media).await?;
    }
    Ok(())
}

async fn forget_one(node_db: &Db, author_root: &str, doc_id: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("forgetting a fragment")?;
    if let Err(e) = crate::replies::forget_reply(node_db, author_root, doc_id).await {
        tracing::debug!(author = %author_root, error = ?e, "forgetting a reply link failed");
    }
    crate::fanout::excise_shared(node_db, author_root, doc_id).await
}

// ---------------------------------------------------------------------------------------------
// Covers: why a media fragment exists.
//
// A share is an implicit rebroadcast of the post's media (PROJECT_PLAN: one pointer, one
// budget, one renderable whole), and the signed header's `refs` say exactly what that means -
// so a post fragment's arrival obliges this node to hold its refs, and a post fragment's death
// releases them. `fragment_covers` is the refcount that makes both directions local: a row per
// (media, covering post), minted from the header, reconciled when an edit's refs change,
// dropped with the post - and doubling as media's own retry ledger, deliberately NOT
// `fragment_wants`, whose drain journals arrivals into feeds and an image is not a post.

/// Reconcile one post's cover rows against its (possibly newly edited) refs, returning the
/// media that just lost their LAST cover - the caller forgets those. Pure bookkeeping, no
/// network, so the refcount is unit-testable.
pub async fn reconcile_covers(
    node_db: &Db,
    author_root: &str,
    post_hex: &str,
    refs: &[[u8; 16]],
) -> Result<Vec<String>> {
    let want: std::collections::HashSet<String> = refs.iter().map(hex::encode).collect();
    let held: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT media_doc FROM fragment_covers WHERE author_root = ?1 AND post_doc = ?2",
            (author_root, post_hex),
        )
        .await
        .context("reading a post's covers")?;
    let mut orphaned = Vec::new();
    for (media,) in held {
        if !want.contains(&media) {
            node_db
                .execute(
                    "DELETE FROM fragment_covers
                     WHERE author_root = ?1 AND post_doc = ?2 AND media_doc = ?3",
                    (author_root, post_hex, media.as_str()),
                )
                .await
                .context("dropping an edited-away cover")?;
            if !covered(node_db, author_root, &media).await? {
                orphaned.push(media);
            }
        }
    }
    for media in &want {
        node_db
            .execute(
                "INSERT OR IGNORE INTO fragment_covers (author_root, media_doc, post_doc)
                 VALUES (?1, ?2, ?3)",
                (author_root, media.as_str(), post_hex),
            )
            .await
            .context("recording a cover")?;
    }
    Ok(orphaned)
}

/// Drop every cover a dying post held, returning the media left with none.
async fn drop_covers_of_post(
    node_db: &Db,
    author_root: &str,
    post_hex: &str,
) -> Result<Vec<String>> {
    let held: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT media_doc FROM fragment_covers WHERE author_root = ?1 AND post_doc = ?2",
            (author_root, post_hex),
        )
        .await
        .context("reading a dying post's covers")?;
    node_db
        .execute(
            "DELETE FROM fragment_covers WHERE author_root = ?1 AND post_doc = ?2",
            (author_root, post_hex),
        )
        .await
        .context("dropping a dying post's covers")?;
    let mut orphaned = Vec::new();
    for (media,) in held {
        if !covered(node_db, author_root, &media).await? {
            orphaned.push(media);
        }
    }
    Ok(orphaned)
}

/// Does anything still claim this media?
async fn covered(node_db: &Db, author_root: &str, media_hex: &str) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM fragment_covers WHERE author_root = ?1 AND media_doc = ?2 LIMIT 1",
            (author_root, media_hex),
        )
        .await
        .context("counting a media fragment's covers")?;
    Ok(row.is_some())
}

/// A post fragment landed (or revalidated): record what it covers and fetch what is missing,
/// from the SAME origin that served the post - the pointer's edge is the media's edge, so a
/// shared image survives its author sleeping exactly as the post does. Depth one, no
/// recursion: refs of the fetched media are ignored by construction.
pub async fn cover_refs(
    state: &crate::AppState,
    origin_root: &str,
    author_root: &str,
    post_hex: &str,
    refs: &[[u8; 16]],
) {
    if let Err(e) = cover_refs_inner(state, origin_root, author_root, post_hex, refs).await {
        tracing::debug!(author = %author_root, post = %post_hex, error = ?e, "cover walk failed");
    }
}

async fn cover_refs_inner(
    state: &crate::AppState,
    origin_root: &str,
    author_root: &str,
    post_hex: &str,
    refs: &[[u8; 16]],
) -> Result<()> {
    for media in reconcile_covers(&state.node_db, author_root, post_hex, refs).await? {
        tracing::debug!(author = %author_root, media = %media,
            "an edit dropped the last cover - media fragment released");
        forget_one(&state.node_db, author_root, &media).await?;
    }
    for media in refs {
        let media_hex = hex::encode(media);
        if held(&state.node_db, author_root, &media_hex).await?.is_some() {
            continue;
        }
        fetch_cover(state, origin_root, author_root, media).await;
    }
    Ok(())
}

/// One held fragment's proof, as stored: the author's exact signed bytes and the packed
/// delegation path - what the thread door serves for a reply that arrived as a share
/// (COMMENTS.md slice 6).
pub async fn held_proof(
    node_db: &crate::db::Db,
    author_root: &str,
    doc_hex: &str,
) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_hex),
        )
        .await
        .context("reading a held fragment's proof")?;
    Ok(row.map(|(entry, packed)| (entry, unpack_path(&packed))))
}

/// Fetch one door-learned reply and remember it - `fetch_cover`'s shape for a post: the
/// replier's own public document, wanted from the replier themself, remembered on the
/// fragment shelf (whose intake notes the reply link) with its words wanted behind it.
/// No feed row - a door-learned reply is thread context, not an arrival in anyone's river.
pub async fn fetch_post(
    state: &crate::AppState,
    origin_root: &str,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) {
    let author_root = hex::encode(author);
    if let Ok(Some(_)) = held(&state.node_db, &author_root, &hex::encode(doc_id)).await {
        return; // already on the shelf; the memo already knows it
    }
    match crate::net::fragment::fetch(state, origin_root, author, doc_id).await {
        crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by) => {
            if let Err(e) = remember(
                &state.node_db,
                origin_root,
                &author_root,
                &verified,
                &entry,
                &auth_path,
            )
            .await
            {
                tracing::debug!(author = %author_root, error = ?e,
                    "could not store a door-learned reply");
                return;
            }
            let _ = crate::net::bodies::want(&state.node_db, &author_root, &verified.header.file_hash).await;
            if let Some(ep) = &served_by {
                let _ = note_deliverer(&state.node_db, &author_root, ep).await;
            }
            heal_soon(state, &author_root, origin_root);
        }
        crate::net::fragment::Fetched::Gone { entry, auth_path } => {
            let doc_hex = hex::encode(doc_id);
            let _ = entomb(&state.node_db, &author_root, &doc_hex, &entry, &auth_path).await;
            let _ = forget_one(&state.node_db, &author_root, &doc_hex).await;
        }
        crate::net::fragment::Fetched::Unknown => {
            // The replier's node is dark; the claim stands in the memo and the row renders
            // hollow until somebody who holds the words answers.
        }
    }
}

/// Fetch one covered media document from an origin and remember it - the media half of what
/// `journalable` does for the post, minus the feed row an image must never become.
async fn fetch_cover(
    state: &crate::AppState,
    origin_root: &str,
    author_root: &str,
    media: &[u8; 16],
) {
    let Some(author) = crate::pubkey::decode(author_root) else {
        return;
    };
    let media_hex = hex::encode(media);
    match crate::net::fragment::fetch(state, origin_root, &author, media).await {
        crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by) => {
            if let Err(e) = remember(
                &state.node_db,
                origin_root,
                author_root,
                &verified,
                &entry,
                &auth_path,
            )
            .await
            {
                tracing::warn!(author = %author_root, media = %media_hex, error = ?e,
                    "could not store a covered media fragment");
                return;
            }
            // The bytes an image needs are more than a post's: body, thumbnail, preview -
            // whichever the signed header names.
            let mut blobs = vec![verified.header.file_hash];
            blobs.extend(verified.header.thumb_hash);
            blobs.extend(verified.header.preview_hash);
            for hash in blobs {
                let _ = crate::net::bodies::want(&state.node_db, author_root, &hash).await;
            }
            if let Some(ep) = &served_by {
                let _ = note_deliverer(&state.node_db, author_root, ep).await;
            }
            heal_soon(state, author_root, origin_root);
        }
        crate::net::fragment::Fetched::Gone { entry, auth_path } => {
            // The author retracted the media twin itself. The proof travels like any death's.
            let _ = entomb(&state.node_db, author_root, &media_hex, &entry, &auth_path).await;
            let _ = forget_one(&state.node_db, author_root, &media_hex).await;
        }
        crate::net::fragment::Fetched::Unknown => {
            // Nothing learned; the cover row IS the retry - `heal_covers` asks again on the
            // next beat, from whatever origin the covering post has by then.
        }
    }
}

/// Media fetches the walk could not finish, retried on the sweep beat: any cover whose media
/// fragment is not held is a fetch owed, asked of the covering post's CURRENT origin. Skips
/// the entombed - a dead twin is not owed, it is buried.
async fn heal_covers(state: &crate::AppState) -> Result<()> {
    type Row = (String, String, String, String);
    let rows: Vec<Row> = state
        .node_db
        .fetch_all(
            "SELECT c.author_root, c.media_doc, c.post_doc, f.origin_root
             FROM fragment_covers c
             JOIN fragments f ON f.author_root = c.author_root AND f.doc_id = c.post_doc
             WHERE NOT EXISTS (
                 SELECT 1 FROM fragments m
                 WHERE m.author_root = c.author_root AND m.doc_id = c.media_doc
             )
             LIMIT 16",
            (),
        )
        .await
        .context("listing uncovered media fetches")?;
    for (author_hex, media_hex, post_hex, origin_root) in rows {
        let Ok(bytes) = hex::decode(&media_hex) else { continue };
        let Ok(media) = <[u8; 16]>::try_from(bytes.as_slice()) else { continue };
        if entombed(&state.node_db, &author_hex, &media).await? {
            continue;
        }
        // The covering POST's sharers stand behind the image too (implicit rebroadcast), so
        // the walk is origin-first then the ledger - same order, same cap, same bound as
        // `revalidate`'s (2026-08-15).
        let mut candidates = vec![origin_root];
        for sharer in crate::fanout::sharers_of_doc(&state.node_db, &author_hex, &post_hex)
            .await
            .unwrap_or_default()
        {
            if !candidates.contains(&sharer) && sharer != author_hex {
                candidates.push(sharer);
            }
        }
        for candidate in candidates.iter().take(4) {
            fetch_cover(state, candidate, &author_hex, &media).await;
            if held(&state.node_db, &author_hex, &media_hex).await?.is_some() {
                break;
            }
        }
    }
    Ok(())
}

/// Remember that a document is gone, having just dropped the copy of it.
///
/// **The hop the cascade was losing.** Dropping a fragment on `Gone` is right, and it destroys
/// this node's own ability to say what happened: the next reader down the share tree asks, gets
/// `Unknown` - "nothing learned, keep what you have" - and holds a deleted post forever.
/// Deletion then travels exactly two hops from its author and stops.
///
/// So the content goes and the FACT stays - and since 2026-08-13, the fact is the author's own
/// signed retraction rather than this node's say-so. The proof is stored beside the memo for
/// the same reason a fragment stores its auth path: this node cannot re-derive it (it never
/// held the author's chain), and the next asker down the tree deserves evidence, not hearsay.
/// The caller MUST have verified it (`verify_retraction`) before it lands here; this function
/// records, it does not judge.
///
/// `ON CONFLICT DO NOTHING` keeps the first proof heard: retraction is final per doc_id, so
/// any genuine proof is as good as any other, forever.
pub async fn entomb(
    node_db: &Db,
    author_root: &str,
    doc_id: &str,
    entry: &[u8],
    auth_path: &[Vec<u8>],
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO fragment_tombstones (author_root, doc_id, heard_ms, entry, auth_path)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (author_root, doc_id) DO NOTHING",
            (author_root, doc_id, now_ms(), entry, pack_path(auth_path)),
        )
        .await
        .context("recording that a document is gone")?;
    Ok(())
}

/// One page of the death log, strictly after `since`: what this node can prove died, in the
/// order it heard. The answering half of `WantDeaths` - and the whole cursor design in one
/// query, because an empty result IS the steady-state answer.
///
/// `limit` is the wire's page discipline, not a politeness budget: proofs are small (an entry
/// plus a short path), so a page of eight sits far under the frame cap with room for deep
/// delegation paths.
pub async fn deaths_since(node_db: &Db, since: i64, limit: i64) -> Result<Vec<LoggedDeath>> {
    type Row = (i64, String, String, Vec<u8>, Vec<u8>);
    let rows: Vec<Row> = node_db
        .fetch_all(
            "SELECT id, author_root, doc_id, entry, auth_path FROM fragment_tombstones
             WHERE id > ?1 ORDER BY id LIMIT ?2",
            (since, limit),
        )
        .await
        .context("reading the death log")?;
    Ok(rows
        .into_iter()
        .map(|(id, author_root, doc_id, entry, packed)| LoggedDeath {
            id,
            author_root,
            doc_id,
            entry,
            auth_path: unpack_path(&packed),
        })
        .collect())
}

/// One row of the death log, as the serving door reads it.
pub struct LoggedDeath {
    pub id: i64,
    pub author_root: String,
    pub doc_id: String,
    pub entry: Vec<u8>,
    pub auth_path: Vec<Vec<u8>>,
}

/// Where the next ask of this peer resumes. Zero for a peer never asked - the log's ids start
/// at one, so zero reads their whole history, which is exactly right for first contact.
pub async fn death_cursor(node_db: &Db, origin_root: &str) -> Result<i64> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT cursor FROM death_cursors WHERE origin_root = ?1",
            (origin_root,),
        )
        .await
        .context("reading a death cursor")?;
    Ok(row.map(|(c,)| c).unwrap_or(0))
}

/// Remember how far into this peer's log we have read. The cursor is THEIR id space, stored
/// opaquely - advancing it is the only write, and it advances even past proofs we skipped
/// (unheld documents, garbage), because the per-document sweep is the backstop for anything a
/// peer garbled and a stuck cursor would re-serve the same page forever.
pub async fn advance_death_cursor(node_db: &Db, origin_root: &str, cursor: i64) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO death_cursors (origin_root, cursor, asked_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (origin_root) DO UPDATE SET
                 cursor = excluded.cursor,
                 asked_ms = excluded.asked_ms",
            (origin_root, cursor, now_ms()),
        )
        .await
        .context("advancing a death cursor")?;
    Ok(())
}

/// Mirror one held author's chain-folded retractions into the death log, proofs attached.
///
/// The log's second tributary. Deaths heard over the wire land in the log through `entomb`;
/// deaths this node learns by HOLDING the author's chain (a follow's sync, a pin's) fold into
/// that persona's `public_retractions` and would otherwise be servable only one-at-a-time by
/// the chain door - a cursor ask against this node would never see them. So the same frontier
/// hooks that fold notifications and rebroadcast pins call here, and every death this node
/// knows becomes one gossipable row regardless of how it arrived.
///
/// Cheap in the steady state: one indexed diff against the log, and proof assembly only for
/// rows the log lacks - which scales with the author's regret, not their chain.
pub async fn mirror_retractions(state: &crate::AppState, author_root: &str) {
    if let Err(e) = mirror_retractions_inner(state, author_root).await {
        tracing::debug!(author = %author_root, error = ?e, "retraction mirror failed");
    }
}

async fn mirror_retractions_inner(state: &crate::AppState, author_root: &str) -> Result<()> {
    let Some(db) = state
        .user_dbs
        .get(author_root)
        .await
        .context("opening the author's database")?
    else {
        return Ok(());
    };
    let retracted = crate::record::documents::retracted_doc_ids(&db)
        .await
        .map_err(|e| anyhow::anyhow!("listing {author_root}'s retractions: {e}"))?;
    if retracted.is_empty() {
        return Ok(());
    }
    let known: Vec<(String,)> = state
        .node_db
        .fetch_all(
            "SELECT doc_id FROM fragment_tombstones WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("diffing the death log")?;
    let known: std::collections::HashSet<String> = known.into_iter().map(|(d,)| d).collect();
    for doc_hex in retracted.iter().filter(|d| !known.contains(*d)) {
        let Ok(doc_bytes) = hex::decode(doc_hex) else { continue };
        let Ok(doc_id) = <[u8; 16]>::try_from(doc_bytes.as_slice()) else { continue };
        let proof = crate::record::documents::retraction_proof(&db, author_root, &doc_id)
            .await
            .map_err(|e| anyhow::anyhow!("assembling a retraction proof: {e}"))?;
        // No proof, no row: a fold that knows a hash the chain no longer holds (a repudiation's
        // genesis cut) has nothing servable to say. Same rule as the serving door.
        if let Some((entry, auth_path)) = proof {
            entomb(&state.node_db, author_root, doc_hex, &entry, &auth_path).await?;
            tracing::debug!(author = %author_root, doc = %doc_hex, "mirrored a chain retraction into the death log");
        }
    }
    Ok(())
}

/// The reap: one cursor ask per peer covers deletion for everything they serve us.
///
/// The batch half of revalidation (PROJECT_PLAN, *Retraction cursors carry the delete-sets
/// between nodes*). The per-document sweep stays for edit freshness and as the backstop; this
/// is what decouples DELETION latency from the size of the shelf - a node holding ten thousand
/// shares hears every death in O(peers) asks per beat, not O(documents) dials spread over days
/// behind `SWEEP_CAP`.
///
/// Who gets asked: every distinct origin (the tree - edges that already exist), plus every
/// distinct fragment author unless the tree-only lane is forced (the same star-and-tree order
/// `revalidate` walks, for the same reason), plus the COHORT last (2026-08-15) - the sibling
/// nodes of this node's own personas, whose logs carry deaths this node slept through after
/// their sources left for good. Deliberately uncapped: the peer set scales with
/// relationships, this design's favorite number, and a cap here would reintroduce exactly the
/// tail-staleness the cursor exists to delete. Own personas are skipped - their log IS this
/// log - but their sibling NODES are not: same persona, different shelf.
pub async fn reap(state: &crate::AppState) -> Result<()> {
    let mut peers: Vec<(String,)> = state
        .node_db
        .fetch_all("SELECT DISTINCT origin_root FROM fragments", ())
        .await
        .context("listing origins to reap from")?;
    if !crate::net::fragment::tree_only() {
        peers.extend(
            state
                .node_db
                .fetch_all::<(String,)>("SELECT DISTINCT author_root FROM fragments", ())
                .await
                .context("listing authors to reap from")?,
        );
    }
    let mut seen = std::collections::HashSet::new();
    for (peer,) in peers {
        if !seen.insert(peer.clone()) {
            continue;
        }
        if crate::identity::is_agented(&state.node_db, &peer)
            .await
            .unwrap_or(false)
        {
            continue;
        }
        drain_death_log(state, ReapDoor::Origin(&peer)).await?;
    }
    for endpoint in crate::net::sync::cohort_endpoints(state)
        .await
        .unwrap_or_default()
    {
        drain_death_log(state, ReapDoor::Cohort(&endpoint)).await?;
    }
    Ok(())
}

/// One door the reap knocks on. An origin is a persona root, resolved to dial candidates the
/// usual way; a cohort sibling is a bare endpoint - not a persona in any fragment's tree -
/// dialed directly, its cursor keyed under a `cohort:` prefix so the two keyspaces (both
/// 64-hex strings) can never collide in `death_cursors`.
enum ReapDoor<'a> {
    Origin(&'a str),
    Cohort(&'a str),
}

/// Drain one peer's death log from wherever its cursor left off.
async fn drain_death_log(state: &crate::AppState, door: ReapDoor<'_>) -> Result<()> {
    let key = match door {
        ReapDoor::Origin(root) => root.to_string(),
        ReapDoor::Cohort(endpoint) => format!("cohort:{endpoint}"),
    };
    let mut cursor = death_cursor(&state.node_db, &key).await?;
    loop {
        let page = match door {
            ReapDoor::Origin(root) => {
                crate::net::fragment::fetch_deaths(state, root, cursor as u64).await
            }
            ReapDoor::Cohort(endpoint) => {
                crate::net::fragment::fetch_deaths_at(state, endpoint, cursor as u64).await
            }
        };
        let Some((proofs, next, raw)) = page else {
            break; // silence: nothing learned, the cursor holds, the next beat retries
        };
        for p in proofs {
            apply_death(&state.node_db, &p).await?;
        }
        // Advanced even past skipped proofs (unheld documents, garbage): a stuck cursor
        // would re-serve the same page forever, and the per-document sweep is the backstop
        // for anything a peer garbled.
        if next as i64 > cursor {
            cursor = next as i64;
            advance_death_cursor(&state.node_db, &key, cursor).await?;
        }
        if raw < crate::net::fragment::DEATHS_PAGE as usize {
            break; // a short page means the log is drained
        }
    }
    Ok(())
}

/// Bury one death from a batch, if it is ours to bury.
///
/// **Demand-scoped, and that bound is load-bearing**: a peer's log names every death it has
/// heard, and a node that entombed them all would grow its forever-set with every deletion
/// anyone it talks to ever relayed - unbounded, and about documents it never held. So a death
/// for a document we do not hold changes nothing here; if a pointer to it ever arrives,
/// `journalable` will ask, hear `Gone` with proof, and bury it then. The caller has already
/// verified the proof (`fetch_deaths`, at the wire edge); this function is bookkeeping.
///
/// The memo-then-forget order is the sweep's own: a crash between the two leaves a tombstone
/// and a stale fragment, which the next pass resolves - never a node that forgot both the
/// words and the reason.
pub async fn apply_death(
    node_db: &Db,
    p: &ringtome_proto::fragment::DeathProof,
) -> Result<bool> {
    let author_hex = hex::encode(p.author);
    let doc_hex = hex::encode(p.doc_id);
    if held(node_db, &author_hex, &doc_hex).await?.is_none() {
        return Ok(false); // not our funeral
    }
    tracing::info!(
        author = %author_hex, doc = %doc_hex,
        "a death arrived by cursor - dropping the copy"
    );
    entomb(node_db, &author_hex, &doc_hex, &p.entry, &p.auth_path).await?;
    forget(node_db, &author_hex, &doc_hex).await?;
    Ok(true)
}

/// What the anonymous serving routes need to hand a fragment-held document to a browser: the
/// decoded header, straight from the author's own signed entry.
///
/// **The last inch of the share tree** (2026-08-14): the ledger held verified entries and the
/// blob store held healed bytes, and no route connected either to the reader's own browser -
/// so every reader past the chain rendered "these words haven't reached this computer",
/// forever, under months of green cascade tests that stopped at the database.
///
/// Re-verified from its own bytes on the way out - the `tomb_proof` fetch posture, for the
/// same reason: a row corrupted on disk must not serve, however it got here. And the tombstone
/// is consulted first, because `entomb` and `forget` are two writes with a crash window
/// between them, and the door must not serve a document out of that window.
pub async fn serving_header(
    node_db: &Db,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Result<Option<ringtome_proto::registry::DocHeaderPlain>> {
    if entombed(node_db, author_root, doc_id).await? {
        return Ok(None);
    }
    let row: Option<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, hex::encode(doc_id)),
        )
        .await
        .context("reading a fragment for serving")?;
    let Some((entry, packed)) = row else {
        return Ok(None);
    };
    let Some(author) = crate::pubkey::decode(author_root) else {
        return Ok(None);
    };
    match ringtome_proto::fragment::verify_fragment(author, *doc_id, &entry, &unpack_path(&packed))
    {
        Ok(v) => Ok(Some(v.header)),
        Err(e) => {
            tracing::warn!(
                author = %author_root, doc = %hex::encode(doc_id), error = ?e,
                "a stored fragment failed its own proof at the serving door"
            );
            Ok(None)
        }
    }
}

/// Ring the eager body heal behind a fragment arrival: the header just landed from this
/// origin, so the bytes it names are one dial away at the same door - spawned, because no
/// fold or sweep should wait on a network round trip it only benefits from. The public-edge
/// mint's eager-knock idiom: the sweep exists for the doors that were shut, not as the normal
/// path to an open one.
fn heal_soon(state: &crate::AppState, author_root: &str, origin_root: &str) {
    let state = state.clone();
    let author = author_root.to_string();
    let origin = origin_root.to_string();
    tokio::spawn(async move {
        crate::net::bodies::heal_from(&state, &author, &origin).await;
    });
}

/// Every blob hash the fragment shelf references: bodies from the column, thumbs and previews
/// decoded from the stored signed entries. The reaper's mark for the shelf - and STRICT: a row
/// whose entry no longer decodes is corruption, and the caller must abort the run rather than
/// reap blobs this function can no longer name.
pub async fn blob_refs(node_db: &Db) -> Result<Vec<[u8; 32]>> {
    let rows: Vec<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_all("SELECT body_hash, entry FROM fragments", ())
        .await
        .context("reading the shelf's blob references")?;
    let mut out = Vec::new();
    for (body, entry) in rows {
        out.push(
            <[u8; 32]>::try_from(body.as_slice())
                .map_err(|_| anyhow::anyhow!("corrupt body_hash on the fragment shelf"))?,
        );
        let signed = ringtome_proto::SignedEntry::decode(&entry)
            .map_err(|e| anyhow::anyhow!("corrupt fragment entry: {e}"))?;
        let ringtome_proto::Payload::Inline(payload) = &signed.entry().payload else {
            anyhow::bail!("a fragment entry's payload is not inline");
        };
        let header = ringtome_proto::DocHeaderPlain::decode(payload)
            .map_err(|e| anyhow::anyhow!("corrupt fragment header: {e}"))?;
        out.push(header.file_hash);
        out.extend(header.thumb_hash);
        out.extend(header.preview_hash);
    }
    Ok(out)
}

/// Remember WHO SERVED one of this author's fragments - the endpoint that actually answered
/// the ask, stamped per author. The rung the 2026-08-23 cascade diagnosis found missing:
/// `origins_of` and the sharers union below both derive from what this node's own ledger
/// NAMES, and a reader one follow deep names exactly one sharer - so when that sharer goes
/// dark, the candidate walk holds only dark endpoints while the node that physically handed
/// over the header (provably alive, provably holding or knowing who holds the bytes) was
/// remembered nowhere. The `speculative_fetches.last_via` idiom, applied to fragments.
/// Does ANY fragment row stand behind this author here? The eviction sweep's share-side
/// keeper (DISCOVERY slice 4): a fragment is a reader-facing promise, and a chain mirror
/// with fragments beside it stays until the shares themselves retire.
pub async fn any_for_author(node_db: &Db, author_root: &str) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM fragments WHERE author_root = ?1 LIMIT 1",
            (author_root,),
        )
        .await
        .context("probing an author's fragment shelf")?;
    Ok(row.is_some())
}

/// Forget an evicted author's deliverer stamps - endpoints that served chains this node no
/// longer holds are no longer heal candidates for anything.
pub async fn forget_deliverers(node_db: &Db, author_root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM fragment_deliverers WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("forgetting an evicted author's deliverers")?;
    Ok(())
}

/// Forget an evicted author's outstanding fragment wants - a want is a promise to keep
/// asking, and eviction is the decision that nobody is owed the answer.
pub async fn forget_wants(node_db: &Db, author_root: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM fragment_wants WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("forgetting an evicted author's wants")?;
    Ok(())
}

pub async fn note_deliverer(node_db: &Db, author_root: &str, endpoint_id: &str) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO fragment_deliverers (author_root, endpoint_id, served_at_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT (author_root, endpoint_id) DO UPDATE SET
                 served_at_ms = excluded.served_at_ms",
            (author_root, endpoint_id, now_ms()),
        )
        .await
        .context("remembering a fragment deliverer")?;
    Ok(())
}

/// The endpoints that most recently served this author's fragments, freshest first - already
/// endpoint-shaped, so a heal walk dials them directly with no resolution ladder (and no
/// chance of the dial-an-unresolved-key mistake). Capped: an author served by many relays
/// wants the recent few, not a census.
pub async fn deliverers_of(node_db: &Db, author_root: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT endpoint_id FROM fragment_deliverers
             WHERE author_root = ?1 ORDER BY served_at_ms DESC LIMIT 4",
            (author_root,),
        )
        .await
        .context("listing an author's fragment deliverers")?;
    Ok(rows.into_iter().map(|(e,)| e).collect())
}

/// Everyone who ever handed this node a pointer at this author's documents - the body-healing
/// candidates a pure fragment holder actually has. The profile-via, the askers and the sync
/// peers all come from relationships with the AUTHOR, and a reader past the chain has none of
/// them; who it has is the tree, and the tree is written in this column.
pub async fn origins_of(node_db: &Db, author_root: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT DISTINCT origin_root FROM fragments WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("listing a fragment author's origins")?;
    Ok(rows.into_iter().map(|(o,)| o).collect())
}

/// The stored proof, for answering onward: the author's signed `post-retract` and its
/// delegation path, exactly as they arrived. The serving door's half of `entomb`.
pub async fn tomb_proof(
    node_db: &Db,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM fragment_tombstones
             WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, hex::encode(doc_id)),
        )
        .await
        .context("reading a tombstone's proof")?;
    Ok(row.map(|(entry, packed)| (entry, unpack_path(&packed))))
}

/// Do we know this document to be gone? The answer a node can still give after it has forgotten
/// everything else about it.
pub async fn entombed(node_db: &Db, author_root: &str, doc_id: &[u8; 16]) -> Result<bool> {
    let row: Option<(i64,)> = node_db
        .fetch_optional(
            "SELECT 1 FROM fragment_tombstones WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, hex::encode(doc_id)),
        )
        .await
        .context("reading a fragment tombstone")?;
    Ok(row.is_some())
}

/// One held fragment, if we have it.
/// The held fragment's SIGNED header, decoded - the reply resolver's fragment rung
/// (COMMENTS.md slice 1): replying to a post you met as a share needs its header's own
/// thread claims, and the stored entry carries them verbatim.
pub async fn held_header(
    node_db: &Db,
    author_root: &str,
    doc_id: &str,
) -> Result<Option<ringtome_proto::registry::DocHeaderPlain>> {
    let row: Option<(Vec<u8>,)> = node_db
        .fetch_optional(
            "SELECT entry FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("reading a fragment's entry")?;
    let Some((entry,)) = row else { return Ok(None) };
    let Ok(signed) = ringtome_proto::SignedEntry::decode(&entry) else {
        return Ok(None);
    };
    let ringtome_proto::Payload::Inline(payload) = &signed.entry().payload else {
        return Ok(None);
    };
    Ok(ringtome_proto::registry::DocHeaderPlain::decode(payload).ok())
}

pub async fn held(node_db: &Db, author_root: &str, doc_id: &str) -> Result<Option<Fragment>> {
    let row: Option<(String, Option<String>, Vec<u8>, String)> = node_db
        .fetch_optional(
            "SELECT title, format, body_hash, origin_root FROM fragments
             WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("reading a fragment")?;
    Ok(row.map(|(title, format, _body_hash, _origin_root)| Fragment { title, format }))
}

/// A fragment we can pass along, as the bytes a fragment response carries.
///
/// **Relaying is the availability story**: a node that fetched a share can answer for it, so a
/// document survives its author and its sharer both going dark, for as long as anyone who cared
/// about it is still up. The entry is handed on exactly as its author signed it, so the hop adds
/// nothing that has to be trusted.
///
/// The authorization path is stored beside the entry because it cannot be re-derived here: this
/// node does not hold the author's identity chain either. It travels with the entry, and the
/// receiving node re-verifies both.
pub async fn relayable(
    node_db: &Db,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Result<Option<(Vec<u8>, Vec<Vec<u8>>)>> {
    let row: Option<(Vec<u8>, Vec<u8>)> = node_db
        .fetch_optional(
            "SELECT entry, auth_path FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, hex::encode(doc_id)),
        )
        .await
        .context("reading a relayable fragment")?;
    let Some((entry, packed)) = row else {
        return Ok(None);
    };
    Ok(Some((entry, unpack_path(&packed))))
}

/// The authorization path, stored as one blob: a CBOR-free length-prefixed concatenation, because
/// this value is never read by anything but its own unpacker and a table column is not a protocol.
pub fn pack_path(path: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for rung in path {
        out.extend_from_slice(&(rung.len() as u32).to_be_bytes());
        out.extend_from_slice(rung);
    }
    out
}

pub fn unpack_path(packed: &[u8]) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + 4 <= packed.len() {
        let len = u32::from_be_bytes([packed[i], packed[i + 1], packed[i + 2], packed[i + 3]])
            as usize;
        i += 4;
        if i + len > packed.len() {
            break; // truncated: return what parsed, and the fragment simply fails re-verification
        }
        out.push(packed[i..i + len].to_vec());
        i += len;
    }
    out
}


/// What version of somebody else's document this node currently holds - the head from their
/// chain if we sync them, otherwise the fragment we fetched.
///
/// This is what a share endorses when the client does not name a version, and it is the honest
/// value: the reader read bytes that came from exactly this head. `None` means we hold nothing
/// of that document, and a node cannot vouch for words it has never seen.
pub async fn current_version(
    state: &crate::AppState,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> Option<[u8; 32]> {
    let author_hex = hex::encode(author);
    if let Ok(Some(db)) = state.user_dbs.get(&author_hex).await {
        if let Ok(Some(head)) = crate::record::documents::public_head(&db, doc_id).await {
            return Some(head.head);
        }
    }
    let row: Option<(String,)> = state
        .node_db
        .fetch_optional(
            "SELECT version FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_hex.as_str(), hex::encode(doc_id)),
        )
        .await
        .ok()
        .flatten();
    row.and_then(|(v,)| {
        let bytes = hex::decode(v).ok()?;
        <[u8; 32]>::try_from(bytes.as_slice()).ok()
    })
}

/// The fragment path: get this document from the origin if we do not have it, and hand back what
/// a feed row needs.
///
/// **Fetch-on-journal rather than fetch-on-read.** A feed row carries a title, so the row cannot
/// exist until the document does - and doing it here means one fetch per shared document rather
/// than one per reader who scrolls past it. `None` means the share stays unjournaled for now,
/// which is the honest outcome when no origin will answer: the pointer is still on the chain and
/// the next fold tries again.
pub async fn journalable(
    state: &crate::AppState,
    origin_root: &str,
    author_root: &str,
    doc_id: &[u8; 16],
) -> Option<crate::fanout::JournalRow> {
    let doc_hex = hex::encode(doc_id);
    // Every branch below SPEAKS (2026-08-24, the residual-tail dig): a pointer that stalls
    // for a minute at this function used to be indistinguishable from one that resolved -
    // held-hit, entomb-skip, and each fetch outcome were all silent, and the dig burned its
    // hours proving healthy layers healthy instead of reading which branch swallowed the doc.
    if let Ok(Some(f)) = held(&state.node_db, author_root, &doc_hex).await {
        tracing::debug!(author = %author_root, doc = %doc_hex, "journalable: held, journaling");
        return Some(row_of(&f, &doc_hex));
    }
    // Buried already? Then there is nothing to journal and nobody worth dialling. `remember` is
    // what makes this safe rather than merely tidy - but a stale sharer's pointer is re-folded
    // on every frontier move they make, so without this the node would dial out for the same
    // dead document forever, and throw the answer away every time.
    if entombed(&state.node_db, author_root, doc_id).await.unwrap_or(false) {
        tracing::debug!(author = %author_root, doc = %doc_hex, "journalable: entombed, skipping");
        return None;
    }

    let author = crate::pubkey::decode(author_root)?;
    tracing::debug!(author = %author_root, doc = %doc_hex, origin = %origin_root,
        "journalable: not held, fetching");
    // The fetch on its OWN task, the fold's wait ceilinged - deadlines bound the WAIT,
    // never the exchange (the acquire_one idiom, brought here by the 2026-08-24 CI
    // evidence): twice, mark-bounded artifacts showed this very await produce no outcome
    // for 60-187 seconds while the peer's door had answered in single-digit milliseconds
    // and the 8s per-candidate timeout inside never fired - a timer that cannot fire means
    // the enclosing task was stuck inside a synchronous poll, i.e. something on this
    // node blocked, and the share fold (which runs INLINE on the sync serve path) blocked
    // with it. The cause is still hunted (REFACTOR: the hung-exchange entry); this makes
    // the fold immune to it either way. On the ceiling the fetch is DETACHED to finish and
    // the fold takes the Unknown road: a want is noted, and the drain's beat owns recovery
    // in seconds instead of "whenever this sharer's chain next moves".
    let fetch_state = state.clone();
    let fetch_origin = origin_root.to_string();
    let fetch_doc = *doc_id;
    let mut pull = tokio::spawn(async move {
        crate::net::fragment::fetch(&fetch_state, &fetch_origin, &author, &fetch_doc).await
    });
    let fetched = match tokio::time::timeout(JOURNALABLE_FETCH_CEILING, &mut pull).await {
        Ok(Ok(f)) => f,
        Ok(Err(join_error)) => {
            tracing::debug!(author = %author_root, doc = %doc_hex,
                "journalable fetch died: {join_error}");
            crate::net::fragment::Fetched::Unknown
        }
        Err(_) => {
            tracing::debug!(author = %author_root, doc = %doc_hex, origin = %origin_root,
                "journalable fetch still in flight at the fold's ceiling - detached; the want ladder takes over");
            crate::net::fragment::Fetched::Unknown
        }
    };
    match fetched {
        crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by) => {
            if let Err(e) = remember(
                &state.node_db,
                origin_root,
                author_root,
                &verified,
                &entry,
                &auth_path,
            )
            .await
            {
                tracing::warn!(author = %author_root, error = ?e, "could not store a fragment");
                return None;
            }
            // The words themselves ride the ordinary blob lane behind the header, exactly as a
            // followed author's bodies do: note the shortfall and let `net::bodies` heal it.
            // A row whose body has not landed renders as "still arriving", which is a state the
            // feed already knows how to show.
            if let Err(e) =
                crate::net::bodies::want(&state.node_db, author_root, &verified.header.file_hash)
                    .await
            {
                tracing::debug!(author = %author_root, error = ?e, "could not note a fragment body");
            }
            if let Some(ep) = &served_by {
                let _ = note_deliverer(&state.node_db, author_root, ep).await;
            }
            heal_soon(state, author_root, origin_root);
            // The implicit rebroadcast: what this post's signed header covers travels with
            // it, from the same origin, before any reader asks.
            cover_refs(state, origin_root, author_root, &doc_hex, &verified.header.refs).await;
            Some(row_of_verified(&verified, &doc_hex))
        }
        crate::net::fragment::Fetched::Gone { entry, auth_path } => {
            // The author withdrew it while it was being fetched. Drop whatever we held and do
            // not journal - "speech deletes", arriving down the share tree.
            tracing::debug!(
                author = %author_root, doc = %doc_hex,
                "a shared document was withdrawn by its author"
            );
            let _ = entomb(&state.node_db, author_root, &doc_hex, &entry, &auth_path).await;
            let _ = forget(&state.node_db, author_root, &doc_hex).await;
            None
        }
        crate::net::fragment::Fetched::Unknown => {
            // Not an error and not the end: the pointer can fold before the content is
            // reachable - as small a race as "C heard about the share before B finished
            // syncing the post" - and the share fold only re-runs when the SHARER's chain
            // moves. Without a retry ledger, that race ate the share forever, silently
            // (found 2026-08-11: two pointers folded, one fragment established, and the
            // second was never asked for again). The want row is what asks again.
            tracing::debug!(
                author = %author_root, origin = %origin_root, doc = %doc_hex,
                "no origin could serve this shared document yet - noted for retry"
            );
            if let Err(e) = note_want(&state.node_db, author_root, &doc_hex, origin_root).await {
                tracing::debug!(author = %author_root, error = ?e, "could not note a fragment want");
            }
            None
        }
    }
}

/// The same row, from the VERIFIED fragment still in hand - for the two arms that just
/// stored it. They used to re-read `held()` to build this, and the re-read was a failure
/// point with no failure story: `journalable`'s tail swallowed it entirely (`.ok()??`), so
/// a transient busy error on a loaded node turned a SUCCESSFUL fetch into "nothing to
/// journal" - silently, with no retry, because wants only mint on the Unknown arm. The row
/// then waited for an unrelated future fold: 187 seconds in the CI artifact that finally
/// caught it narrated end to end (2026-08-24, the residual tail's actual face, read
/// straight from the TEST MARK window). The fragment in hand is the same bytes `remember`
/// just stored; nothing needs the database to repeat them.
fn row_of_verified(
    verified: &ringtome_proto::fragment::VerifiedFragment,
    doc_hex: &str,
) -> crate::fanout::JournalRow {
    let now = now_ms();
    crate::fanout::JournalRow {
        doc_id_hex: doc_hex.to_string(),
        title: verified.header.title.clone(),
        format: crate::record::documents::Format::from_wire(verified.header.format)
            .as_str()
            .to_string(),
        // Placeholders the caller REPLACES, exactly as `row_of` documents.
        published_ms: now,
        updated_ms: now,
    }
}

fn row_of(f: &Fragment, doc_hex: &str) -> crate::fanout::JournalRow {
    // A fragment has no genesis/head stamps of its own - those are folded facts about a chain we
    // do not hold. Both stamps here are placeholders that the caller REPLACES: `fanout::as_shared`
    // sets `published_ms` to the pointer's arrival, because what orders a share in a feed is when
    // it was shared. Leaving the fetch moment here as the final answer was the first cut's bug.
    let now = crate::clock::now_ms();
    crate::fanout::JournalRow {
        doc_id_hex: doc_hex.to_string(),
        title: f.title.clone(),
        format: f.format.clone().unwrap_or_else(|| "plaintext".to_string()),
        published_ms: now,
        updated_ms: now,
    }
}


/// Note that a share's content could not be fetched, so the sweep keeps trying.
///
/// Idempotent, and it never resets an existing row's backoff - the same discipline as
/// `bodies::want`, for the same reason.
async fn note_want(
    node_db: &Db,
    author_root: &str,
    doc_id: &str,
    origin_root: &str,
) -> Result<()> {
    node_db
        .execute(
            "INSERT INTO fragment_wants (author_root, doc_id, origin_root, first_noted_ms)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (author_root, doc_id) DO NOTHING",
            (author_root, doc_id, origin_root, now_ms()),
        )
        .await
        .context("noting a wanted fragment")?;
    Ok(())
}

/// A want that landed or died stops being wanted.
async fn settle_want(node_db: &Db, author_root: &str, doc_id: &str) -> Result<()> {
    node_db
        .execute(
            "DELETE FROM fragment_wants WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("settling a fragment want")?;
    Ok(())
}

/// A want nobody has been able to satisfy stops being asked about after this long - the
/// outbox's give-up: an unmet want three days old is a share of something that has probably
/// been gone longer than it was ever here.
const WANT_GIVE_UP_MS: i64 = 3 * 24 * 60 * 60 * 1000;
/// How long the share fold waits on one document's fetch before detaching it and taking
/// the want road. Above the per-candidate FETCH_TIMEOUT (a healthy multi-candidate walk
/// fits), far below a settle window - the fold runs inline on the sync serve path, and its
/// wait is everyone's wait.
const JOURNALABLE_FETCH_CEILING: std::time::Duration = std::time::Duration::from_secs(10);

/// How long a held fragment may go unconfirmed before we ask its origin again.
///
/// This is the **author-control dial**, and it is the honest cost of the whole design: a
/// retraction takes one interval per hop of the share tree to reach the leaves (PROJECT_PLAN,
/// What travels with a share). Shorter means deletion travels faster and idle nodes chatter
/// more; longer means a withdrawn post lingers. Half an hour is a first guess, not a measured
/// one - it wants revisiting once there is a network to measure.
const REVALIDATE_AFTER_MS: i64 = 30 * 60 * 1000;

/// The interval in force, with a test override. Real cadences make the cascade untestable -
/// nobody waits half an hour per hop in a suite - so under `RINGTOME_LOCAL_TEST` the harness may
/// shorten it with `RINGTOME_TEST_REVALIDATE_MS`, exactly as it shrinks the inbox tiers.
fn revalidate_after_ms() -> i64 {
    if std::env::var("RINGTOME_LOCAL_TEST").is_ok() {
        if let Some(n) = std::env::var("RINGTOME_TEST_REVALIDATE_MS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
        {
            return n.max(0);
        }
    }
    REVALIDATE_AFTER_MS
}

/// Fragments revalidated per sweep. A politeness budget: each one is a dial to somebody else's
/// node, and a reader holding a thousand shares must not wake up and knock a thousand times.
const SWEEP_CAP: i64 = 16;

/// Ask the origins again: is what we hold still what they serve?
///
/// **The piece that makes deletion travel past the first hop.** Everything else was already in
/// place - the author's tombstone, the sharer's pin noticing it, the door answering `Gone` - and
/// none of it reached a reader, because nothing ever asked a second time. A fragment fetched
/// once was held forever, and `Gone` was unreachable code.
///
/// Revalidating against the ORIGIN rather than the author is what keeps this cheap: the origin
/// is a node we already have a reason to talk to, so the cascade runs over edges that exist.
/// The cost is per-hop staleness, which is the trade the design took deliberately.
async fn revalidate_due_fragments(state: &crate::AppState) -> Result<()> {
    // Jittered, because the author is asked FIRST and a viral post means every holder asking the
    // same node. Without a spread, ten thousand readers knock on the same second, every interval,
    // forever - a thundering herd this design would otherwise create on exactly the people whose
    // work travelled furthest. The origin fallback sheds load when they stop answering; the
    // jitter is what stops them being knocked over in the first place.
    let spread = crate::clock::now_ms() % (revalidate_after_ms() / 4).max(1);
    let due = crate::clock::now_ms() - revalidate_after_ms() - spread;
    let rows: Vec<(String, String, String)> = state
        .node_db
        .fetch_all(
            // Frozen documents are excluded outright (2026-08-15): past the window there is
            // no edit to check for, ever, and deletion travels by cursor - so the sweep's
            // population is the young end of the shelf, O(posting-rate x window), a rolling
            // buffer that never grows with history. NULL genesis is frozen-from-birth (media,
            // and anything predating the anchor). Local clock, scheduling only - the HONOR
            // rule compares the author's own two stamps and lives in `remember`.
            "SELECT author_root, doc_id, origin_root FROM fragments
             WHERE checked_ms <= ?1
               AND genesis_ms IS NOT NULL AND genesis_ms > ?3
             ORDER BY checked_ms LIMIT ?2",
            (due, SWEEP_CAP, now_ms() - crate::record::documents::edit_window_ms()),
        )
        .await
        .context("listing fragments due for revalidation")?;

    if !rows.is_empty() {
        tracing::debug!(due = rows.len(), "fragment sweep: revalidating");
    }
    for (author_hex, doc_hex, origin_root) in rows {
        let (Some(author), Some(doc_id)) = (
            crate::pubkey::decode(&author_hex),
            hex::decode(&doc_hex)
                .ok()
                .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok()),
        ) else {
            continue;
        };
        // The due list is a snapshot, and rows die mid-pass: a post's `Gone` cascades its
        // covered media out from under the very same sweep that queued them, and re-storing
        // from the stale snapshot resurrected an uncovered media fragment FOREVER - the
        // author retracts the post, never the twin, so the origin answers `Have` on every
        // later beat and the row self-perpetuates (caught 2026-08-14, first run of the
        // image-rides test: Cleo re-held "cat" seconds after dropping it with its post). A
        // sweep REVALIDATES what is held; what is no longer held is no longer its business.
        if held(&state.node_db, &author_hex, &doc_hex).await?.is_none() {
            continue;
        }
        match crate::net::fragment::revalidate(state, &origin_root, &author, &doc_id).await {
            crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by) => {
                tracing::debug!(
                    author = %author_hex, doc = %doc_hex, origin = %origin_root,
                    title = %verified.header.title,
                    "fragment sweep: still served"
                );
                // Re-stored wholesale, so an EDIT lands the same way a first fetch did: new
                // version, new title, new body hash. The feed row's title is refreshed from the
                // same write, and the new body is noted as wanted - an edited post whose words
                // have not arrived renders as "still arriving", which the feed already knows.
                remember(
                    &state.node_db,
                    &origin_root,
                    &author_hex,
                    &verified,
                    &entry,
                    &auth_path,
                )
                .await?;
                crate::fanout::retitle_shared(
                    &state.node_db,
                    &author_hex,
                    &doc_hex,
                    &verified.header.title,
                )
                .await?;
                let _ = crate::net::bodies::want(
                    &state.node_db,
                    &author_hex,
                    &verified.header.file_hash,
                )
                .await;
                if let Some(ep) = &served_by {
                    let _ = note_deliverer(&state.node_db, &author_hex, ep).await;
                }
                heal_soon(state, &author_hex, &origin_root);
                // An edit can change what a post embeds; the reconcile inside drops covers
                // the new refs no longer name and releases orphaned media.
                cover_refs(state, &origin_root, &author_hex, &doc_hex, &verified.header.refs)
                    .await;
            }
            crate::net::fragment::Fetched::Gone { entry, auth_path } => {
                tracing::info!(
                    author = %author_hex, doc = %doc_hex,
                    "a shared document was withdrawn by its author - dropping the copy"
                );
                // The memo FIRST: a crash between these two leaves a tombstone and a stale
                // fragment, which the next sweep resolves. The other order leaves a node that
                // has forgotten both the words and the reason, and lies to everyone downstream.
                entomb(&state.node_db, &author_hex, &doc_hex, &entry, &auth_path).await?;
                forget(&state.node_db, &author_hex, &doc_hex).await?;
            }
            crate::net::fragment::Fetched::Unknown => {
                tracing::debug!(
                    author = %author_hex, origin = %origin_root, doc = %doc_hex,
                    "fragment sweep: nobody could answer"
                );
                // Nothing learned about the DOCUMENT - only that this origin could not answer.
                // Holding on is correct: "silence preserves, speech deletes", and an origin
                // being asleep is silence. The stamp still moves so one unreachable origin does
                // not sit at the head of the queue starving every other fragment.
                touch(&state.node_db, &author_hex, &doc_hex).await?;
            }
        }
    }
    Ok(())
}

/// Make every fragment (and unmet want) due NOW - the test beat's lever
/// (test_endpoints, the settle switchover): the sweep's queries select by elapsed time,
/// so a rung sweep would otherwise revalidate nothing. Scoped to one author when given.
pub(crate) async fn force_due(node_db: &Db, author_root: Option<&str>) -> Result<()> {
    match author_root {
        Some(author) => {
            node_db
                .execute(
                    "UPDATE fragments SET checked_ms = 0 WHERE author_root = ?1",
                    (author,),
                )
                .await?;
            node_db
                .execute(
                    "UPDATE fragment_wants SET last_tried_ms = 0 WHERE author_root = ?1",
                    (author,),
                )
                .await?;
        }
        None => {
            node_db.execute("UPDATE fragments SET checked_ms = 0", ()).await?;
            node_db
                .execute("UPDATE fragment_wants SET last_tried_ms = 0", ())
                .await?;
        }
    }
    Ok(())
}

/// Every distinct origin the shelf holds for one author - the test beat's body-heal walks
/// the eager heal from each, awaited (test_endpoints).
pub(crate) async fn origins_of_author(node_db: &Db, author_root: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = node_db
        .fetch_all(
            "SELECT DISTINCT origin_root FROM fragments WHERE author_root = ?1",
            (author_root,),
        )
        .await
        .context("listing an author's fragment origins")?;
    Ok(rows.into_iter().map(|(o,)| o).collect())
}

/// One maintenance beat over everything fragment-shaped: four named jobs sharing a cadence
/// because each is retry-work the others create - a revalidation notices an edit and mints a
/// want, a drained want journals a share whose covers then need healing, and the reap's
/// cursors advance over whatever the dials above learned. One beat, four jobs, each honest
/// about its own errors; the order is the dependency order.
pub async fn sweep(state: crate::AppState) -> Result<()> {
    // Edit freshness on the young end of the shelf: per-document dials, origin-first.
    revalidate_due_fragments(&state).await?;
    // The recovery half of the share fold: fragments whose first ask failed.
    drain_wants(&state).await?;
    // Media the cover walk could not finish - the same recovery posture as the wants drain,
    // on its own ledger so an image can never be journaled as a post.
    if let Err(e) = heal_covers(&state).await {
        tracing::debug!(error = ?e, "cover heal failed; next beat retries");
    }
    // The batch pass rides the same beat: per-document dials above for edit freshness on the
    // young end of the shelf, one cursor ask per peer here for deletion everywhere. Errors are
    // the beat's to absorb - a failed reap is retried next beat from the same cursors.
    if let Err(e) = reap(&state).await {
        tracing::debug!(error = ?e, "reap failed; next beat resumes from the same cursors");
    }
    Ok(())
}

/// The recovery half of the share fold: fetch the fragments whose first ask failed.
///
/// A satisfied want journals the share to the sharer's readers on the spot - the delivery the
/// original fold could not make. `shared_ms` is now rather than the pointer's arrival, which is
/// honest: for THIS node the share became real when its content did.
async fn drain_wants(state: &crate::AppState) -> Result<()> {
    let now = now_ms();
    let rows: Vec<(String, String, String, i64, i64)> = state
        .node_db
        .fetch_all(
            "SELECT author_root, doc_id, origin_root, first_noted_ms, tries FROM fragment_wants
             WHERE last_tried_ms <= ?1 ORDER BY last_tried_ms LIMIT ?2",
            (now - revalidate_after_ms(), SWEEP_CAP),
        )
        .await
        .context("listing unmet fragment wants")?;

    for (author_hex, doc_hex, origin_root, first_noted, _tries) in rows {
        if now - first_noted > WANT_GIVE_UP_MS {
            settle_want(&state.node_db, &author_hex, &doc_hex).await?;
            continue;
        }
        state
            .node_db
            .execute(
                "UPDATE fragment_wants SET last_tried_ms = ?3, tries = tries + 1
                 WHERE author_root = ?1 AND doc_id = ?2",
                (author_hex.as_str(), doc_hex.as_str(), now),
            )
            .await
            .context("stamping a want attempt")?;

        let (Some(author), Some(doc_id)) = (
            crate::pubkey::decode(&author_hex),
            hex::decode(&doc_hex)
                .ok()
                .and_then(|b| <[u8; 16]>::try_from(b.as_slice()).ok()),
        ) else {
            settle_want(&state.node_db, &author_hex, &doc_hex).await?;
            continue;
        };
        match crate::net::fragment::revalidate(state, &origin_root, &author, &doc_id).await {
            crate::net::fragment::Fetched::Unknown => {
                // The want stays and rotates to the back of the oldest-first queue. Speak
                // (2026-08-23, the flake hunt's rule): an origin answering "Unknown" here
                // usually means ITS upstream hop has not synced yet - the multi-hop seed
                // race - and this line is what lets a log say which hop starved when a
                // share takes a minute to journal.
                tracing::debug!(author = %author_hex, doc = %doc_hex, origin = %origin_root,
                    "fragment want: origin cannot answer yet; requeued");
            }
            crate::net::fragment::Fetched::Have(verified, entry, auth_path, served_by) => {
                remember(&state.node_db, &origin_root, &author_hex, &verified, &entry, &auth_path)
                    .await?;
                let _ = crate::net::bodies::want(
                    &state.node_db,
                    &author_hex,
                    &verified.header.file_hash,
                )
                .await;
                if let Some(ep) = &served_by {
                    let _ = note_deliverer(&state.node_db, &author_hex, ep).await;
                }
                heal_soon(state, &author_hex, &origin_root);
                cover_refs(state, &origin_root, &author_hex, &doc_hex, &verified.header.refs)
                    .await;
                settle_want(&state.node_db, &author_hex, &doc_hex).await?;
                tracing::info!(author = %author_hex, doc = %doc_hex, "a wanted fragment arrived");
                crate::fanout::journal_late_share(
                    state,
                    &origin_root,
                    &author_hex,
                    &row_of_verified(&verified, &doc_hex),
                )
                .await;
            }
            crate::net::fragment::Fetched::Gone { entry, auth_path } => {
                entomb(&state.node_db, &author_hex, &doc_hex, &entry, &auth_path).await?;
                settle_want(&state.node_db, &author_hex, &doc_hex).await?;
            }
        }
    }
    Ok(())
}

/// Record that we asked, whatever the answer was.
///
/// `checked_ms` is "when we last ASKED", not "when we last succeeded". Those are different facts
/// and the second is the more interesting one - it is what a "this share has not been confirmed
/// in a week" badge would read - but nothing needs it yet, and one column that means one thing
/// beats two where one is always guessed at. It wants its own column the day something asks.
async fn touch(node_db: &Db, author_root: &str, doc_id: &str) -> Result<()> {
    node_db
        .execute(
            "UPDATE fragments SET checked_ms = ?3 WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id, crate::clock::now_ms()),
        )
        .await
        .context("stamping a revalidation attempt")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_round_trips_through_its_column() {
        for path in [
            Vec::new(),
            vec![vec![1u8, 2, 3]],
            vec![vec![1u8; 40], vec![2u8; 7], vec![3u8; 100]],
        ] {
            assert_eq!(unpack_path(&pack_path(&path)), path);
        }
    }

    /// Truncation must degrade to a shorter path, never to a panic: the bytes come off disk, and
    /// a half-written row is a corruption to survive rather than to crash on. A short path fails
    /// `walk_auth_path` on the next use, which is the correct outcome.
    #[test]
    fn a_truncated_path_yields_what_parsed() {
        let packed = pack_path(&[vec![1u8; 10], vec![2u8; 10]]);
        assert_eq!(unpack_path(&packed[..packed.len() - 4]).len(), 1);
        assert!(unpack_path(&[0, 0, 0]).is_empty());
    }

    fn verified(doc: [u8; 16]) -> ringtome_proto::fragment::VerifiedFragment {
        // Genesis and stamp equal: a fresh post, squarely in its window. The window tests
        // below choose their own numbers.
        verified_at(doc, 1_000, Some(1_000))
    }

    fn verified_at(
        doc: [u8; 16],
        timestamp_ms: i64,
        genesis_ms: Option<i64>,
    ) -> ringtome_proto::fragment::VerifiedFragment {
        ringtome_proto::fragment::VerifiedFragment {
            doc_id: doc,
            version: [7u8; 32],
            timestamp_ms,
            header: ringtome_proto::registry::DocHeaderPlain {
                doc_id: doc,
                parents: Vec::new(),
                file_hash: [1u8; 32],
                body_hash: [2u8; 32],
                title: "the words".to_string(),
                format: None,
                width: None,
                height: None,
                duration_ms: None,
                thumb_hash: None,
                preview_hash: None,
                refs: Vec::new(),
                genesis_ms,
                reply_to: None,
                thread_root: None,
            },
        }
    }

    /// **A verified fragment is not the same claim as a current one.** Verification proves the
    /// author signed these words; it is silent on whether the sharer has heard that they were
    /// taken down since. A peer that slept through a takedown holds a flawlessly signed copy of
    /// a dead post, and before 2026-08-13 handing it over was enough to bring it back - words,
    /// feed row and all - at any depth the share tree reached.
    #[tokio::test]
    async fn a_buried_document_is_not_taken_back() {
        let db = crate::db::test_node_db().await;
        let author = "a".repeat(64);
        let doc = [3u8; 16];
        let doc_hex = hex::encode(doc);

        remember(&db, &"b".repeat(64), &author, &verified(doc), &[1, 2, 3], &[])
            .await
            .unwrap();
        assert!(
            held(&db, &author, &doc_hex).await.unwrap().is_some(),
            "precondition: it arrived the ordinary way first"
        );

        // The author takes it down: drop the words, keep the fact. The proof bytes are opaque
        // to this layer - `entomb` records what its caller verified, it does not judge - so
        // stand-ins are honest here, and round-tripping them below is part of the claim.
        entomb(&db, &author, &doc_hex, &[9, 9, 9], &[vec![8]]).await.unwrap();
        forget(&db, &author, &doc_hex).await.unwrap();

        // And now somebody who never heard offers it back, from a different origin.
        remember(&db, &"c".repeat(64), &author, &verified(doc), &[1, 2, 3], &[])
            .await
            .unwrap();

        assert!(
            held(&db, &author, &doc_hex).await.unwrap().is_none(),
            "a tombstone outranks a stale sharer, however well signed their copy is"
        );
        assert!(
            entombed(&db, &author, &doc).await.unwrap(),
            "and the fact survives the attempt"
        );
        assert_eq!(
            tomb_proof(&db, &author, &doc).await.unwrap(),
            Some((vec![9, 9, 9], vec![vec![8]])),
            "and the proof serves back exactly as it was stored - evidence, not hearsay"
        );
    }

    /// The log IS the tombstone table: every death gets a strictly increasing id, "since N"
    /// reads exactly what came after N, and re-hearing a death grows nothing - one row per
    /// document, forever, which is what lets a cursor be a promise instead of a heuristic.
    #[tokio::test]
    async fn the_death_log_answers_since_exactly() {
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);

        for (i, doc) in [[1u8; 16], [2u8; 16], [3u8; 16]].iter().enumerate() {
            entomb(&db, &alice, &hex::encode(doc), &[i as u8], &[]).await.unwrap();
        }
        // Re-hearing the second death: finality means one row per document, first proof wins.
        entomb(&db, &alice, &hex::encode([2u8; 16]), &[99], &[]).await.unwrap();

        let all = deaths_since(&db, 0, 10).await.unwrap();
        assert_eq!(all.len(), 3, "three documents died, three rows - re-hearing added nothing");
        assert!(
            all.windows(2).all(|w| w[0].id < w[1].id),
            "ids strictly increase in hearing order"
        );
        assert_eq!(all[1].auth_path, Vec::<Vec<u8>>::new());
        assert_eq!(all[1].entry, vec![1u8], "the re-heard death kept its FIRST proof");

        let after = deaths_since(&db, all[0].id, 10).await.unwrap();
        assert_eq!(after.len(), 2, "since-N excludes N itself");
        assert_eq!(after[0].id, all[1].id);

        assert!(
            deaths_since(&db, all[2].id, 10).await.unwrap().is_empty(),
            "a caught-up cursor reads an empty page - the steady state costs nothing"
        );

        // The page limit is a wire discipline, honored mid-log.
        let paged = deaths_since(&db, 0, 2).await.unwrap();
        assert_eq!(paged.len(), 2);
        let rest = deaths_since(&db, paged[1].id, 2).await.unwrap();
        assert_eq!(rest.len(), 1, "the next page resumes where the last ended, losing nothing");
    }

    /// A death you never held is not your funeral. A peer's log names every death it has
    /// heard, and a node that buried them all would grow its forever-set with every deletion
    /// anyone it talks to ever relayed - unbounded, and about documents it never carried. The
    /// bound: nothing enters this node's log by cursor unless this node held the words.
    #[tokio::test]
    async fn a_death_by_cursor_is_only_ours_if_we_hold_the_document() {
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);
        let held_doc = [1u8; 16];
        let stranger_doc = [2u8; 16];

        remember(&db, &"b".repeat(64), &alice, &verified(held_doc), &[1], &[])
            .await
            .unwrap();

        let death = |doc| ringtome_proto::fragment::DeathProof {
            author: crate::pubkey::decode(&alice).unwrap(),
            doc_id: doc,
            entry: vec![7],
            auth_path: Vec::new(),
        };

        assert!(
            !apply_death(&db, &death(stranger_doc)).await.unwrap(),
            "a stranger's death is heard and not kept"
        );
        assert!(
            !entombed(&db, &alice, &stranger_doc).await.unwrap(),
            "no tombstone grows for a document this node never held"
        );

        assert!(apply_death(&db, &death(held_doc)).await.unwrap());
        assert!(
            held(&db, &alice, &hex::encode(held_doc)).await.unwrap().is_none(),
            "the held document's words are dropped"
        );
        assert!(
            entombed(&db, &alice, &held_doc).await.unwrap(),
            "and its death is kept, provable, gossipable"
        );
    }

    /// The cover refcount: a media fragment lives exactly as long as some covering post
    /// fragment does. Two posts embed one image; one dies, the image stays; the last dies,
    /// the image goes - and an EDIT that drops the embed releases it the same way.
    #[tokio::test]
    async fn a_media_fragment_lives_while_anything_covers_it() {
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);
        let image = [9u8; 16];
        let image_hex = hex::encode(image);
        let (post_a, post_b) = (hex::encode([1u8; 16]), hex::encode([2u8; 16]));

        // The image fragment, held; both posts claim it.
        remember(&db, &"b".repeat(64), &alice, &verified(image), &[1], &[]).await.unwrap();
        assert!(reconcile_covers(&db, &alice, &post_a, &[image]).await.unwrap().is_empty());
        assert!(reconcile_covers(&db, &alice, &post_b, &[image]).await.unwrap().is_empty());

        // Post A dies: the image is still covered by B.
        forget(&db, &alice, &post_a).await.unwrap();
        assert!(
            held(&db, &alice, &image_hex).await.unwrap().is_some(),
            "one cover left is one reason to exist"
        );

        // Post B's EDIT drops the embed: the last cover goes, and the caller is told.
        let orphaned = reconcile_covers(&db, &alice, &post_b, &[]).await.unwrap();
        assert_eq!(orphaned, vec![image_hex.clone()], "the reconcile names what it released");

        // (cover_refs would forget it; the bookkeeping test does it by hand.)
        forget(&db, &alice, &image_hex).await.unwrap();
        assert!(held(&db, &alice, &image_hex).await.unwrap().is_none());
    }

    /// The forget cascade in one move: a post fragment dying takes its solely-covered media
    /// with it, without the caller knowing media was involved at all.
    #[tokio::test]
    async fn forgetting_a_post_drops_its_uncovered_media() {
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);
        let image = [9u8; 16];
        let post = hex::encode([1u8; 16]);

        remember(&db, &"b".repeat(64), &alice, &verified(image), &[1], &[]).await.unwrap();
        reconcile_covers(&db, &alice, &post, &[image]).await.unwrap();

        forget(&db, &alice, &post).await.unwrap();
        assert!(
            held(&db, &alice, &hex::encode(image)).await.unwrap().is_none(),
            "the image went with the only post that carried it"
        );
    }

    /// The shelf side of the edit window: a version whose claimed stamp postdates its own
    /// genesis claim by more than the window is admitted and ignored - and a genesis that
    /// MOVES between fetches is refused as malformed (an honest author's never does; the
    /// check carries no security weight, the freeze itself contains the forger).
    #[tokio::test]
    async fn the_shelf_ignores_late_edits_and_moving_geneses() {
        let day = 24 * 60 * 60 * 1000;
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);
        let doc = [4u8; 16];
        let doc_hex = hex::encode(doc);
        let bob = "b".repeat(64);

        remember(&db, &bob, &alice, &verified_at(doc, 1_000, Some(1_000)), &[1], &[])
            .await
            .unwrap();

        // An in-window edit updates the row (title travels with the wholesale re-store).
        let mut edit = verified_at(doc, 1_000 + day - 1, Some(1_000));
        edit.header.title = "revised".into();
        remember(&db, &bob, &alice, &edit, &[2], &[]).await.unwrap();
        assert_eq!(held(&db, &alice, &doc_hex).await.unwrap().unwrap().title, "revised");

        // A late edit is ignored: the row stands as it was.
        let mut late = verified_at(doc, 1_000 + day + 1, Some(1_000));
        late.header.title = "rug".into();
        remember(&db, &bob, &alice, &late, &[3], &[]).await.unwrap();
        assert_eq!(
            held(&db, &alice, &doc_hex).await.unwrap().unwrap().title,
            "revised",
            "past the window, what was said is what was said"
        );

        // A moved genesis is refused even in-window-by-its-own-lights.
        let mut drifted = verified_at(doc, day + 3_000, Some(day + 2_000));
        drifted.header.title = "relaunched".into();
        remember(&db, &bob, &alice, &drifted, &[4], &[]).await.unwrap();
        assert_eq!(
            held(&db, &alice, &doc_hex).await.unwrap().unwrap().title,
            "revised",
            "a genesis that moves between fetches is nonsense, not a case to honor"
        );
    }

    /// The ordering rule: arrival order is not authorship order. Same-chain versions compare
    /// by seq - pure causal order, and it OUTRANKS the stamps (a skewed clock cannot reorder
    /// one device's own chain) - cross-device versions by (claimed stamp, hash),
    /// `display_head`'s comparator, so fragment and chain holders converge identically.
    #[tokio::test]
    async fn an_older_version_arriving_late_changes_nothing() {
        let db = crate::db::test_node_db().await;
        let alice = "a".repeat(64);
        let doc = [6u8; 16];
        let doc_hex = hex::encode(doc);
        let bob = "b".repeat(64);
        let key_one = ringtome_proto::SigningKey::from_bytes(&[41u8; 32]);
        let key_two = ringtome_proto::SigningKey::from_bytes(&[42u8; 32]);

        let entry_bytes = |key: &ringtome_proto::SigningKey, seq: u64, ts: i64| {
            let entry = ringtome_proto::Entry {
                v: ringtome_proto::ENTRY_VERSION,
                entry_type: ringtome_proto::registry::entry_type::DOC_HEADER,
                chain: ringtome_proto::ChainId {
                    author: key.verifying_key().to_bytes(),
                    service: ringtome_proto::registry::service::POSTS,
                },
                seq,
                prev_hash: ringtome_proto::ZERO_HASH,
                timestamp_ms: ts,
                payload: ringtome_proto::Payload::Inline(vec![0xa0]),
            };
            ringtome_proto::SignedEntry::create(&entry, key)
                .unwrap()
                .bytes()
                .to_vec()
        };
        let titled = |title: &str, ts: i64| {
            let mut v = verified_at(doc, ts, Some(100));
            v.header.title = title.into();
            v.version = [ts as u8; 32]; // distinct version identity per store
            v
        };

        // Same chain: seq 5 at stamp 500 held; seq 4 arrives wearing a LATER stamp - the
        // clock lies, the chain does not. Refused.
        remember(&db, &bob, &alice, &titled("v-held", 500), &entry_bytes(&key_one, 5, 500), &[])
            .await
            .unwrap();
        remember(&db, &bob, &alice, &titled("v-rollback", 900), &entry_bytes(&key_one, 4, 900), &[])
            .await
            .unwrap();
        assert_eq!(
            held(&db, &alice, &doc_hex).await.unwrap().unwrap().title,
            "v-held",
            "same-chain seq outranks any stamp"
        );

        // Cross-device: another leaf's version with an OLDER claimed stamp is refused...
        remember(&db, &bob, &alice, &titled("v-stale", 200), &entry_bytes(&key_two, 9, 200), &[])
            .await
            .unwrap();
        assert_eq!(held(&db, &alice, &doc_hex).await.unwrap().unwrap().title, "v-held");

        // ...and a NEWER one is stored: the same comparator display_head runs on full chains.
        remember(&db, &bob, &alice, &titled("v-newer", 800), &entry_bytes(&key_two, 2, 800), &[])
            .await
            .unwrap();
        assert_eq!(
            held(&db, &alice, &doc_hex).await.unwrap().unwrap().title,
            "v-newer",
            "newer by the author's own numbers wins, whoever delivered it"
        );
    }

    #[tokio::test]
    async fn a_cursor_starts_at_zero_and_remembers_its_advance() {
        let db = crate::db::test_node_db().await;
        let bob = "b".repeat(64);
        assert_eq!(
            death_cursor(&db, &bob).await.unwrap(),
            0,
            "a peer never asked is read from the top - ids start at one, so zero means everything"
        );
        advance_death_cursor(&db, &bob, 7).await.unwrap();
        assert_eq!(death_cursor(&db, &bob).await.unwrap(), 7);
        advance_death_cursor(&db, &bob, 12).await.unwrap();
        assert_eq!(death_cursor(&db, &bob).await.unwrap(), 12);
    }
}
