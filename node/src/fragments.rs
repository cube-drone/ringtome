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
    let now = now_ms();
    node_db
        .execute(
            "INSERT INTO fragments
               (author_root, doc_id, origin_root, version, entry, auth_path, title, format,
                body_hash, fetched_ms, checked_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
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
            ),
        )
        .await
        .context("remembering a fragment")?;
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
    node_db
        .execute(
            "DELETE FROM fragments WHERE author_root = ?1 AND doc_id = ?2",
            (author_root, doc_id),
        )
        .await
        .context("forgetting a fragment")?;
    crate::fanout::excise_shared(node_db, author_root, doc_id).await
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
/// `revalidate` walks, for the same reason). Deliberately uncapped: the peer set scales with
/// relationships, this design's favorite number, and a cap here would reintroduce exactly the
/// tail-staleness the cursor exists to delete. Own personas are skipped - their log IS this
/// log.
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
        let mut cursor = death_cursor(&state.node_db, &peer).await?;
        loop {
            let Some((proofs, next, raw)) =
                crate::net::fragment::fetch_deaths(state, &peer, cursor as u64).await
            else {
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
                advance_death_cursor(&state.node_db, &peer, cursor).await?;
            }
            if raw < crate::net::fragment::DEATHS_PAGE as usize {
                break; // a short page means the log is drained
            }
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
    if let Ok(Some(f)) = held(&state.node_db, author_root, &doc_hex).await {
        return Some(row_of(&f, &doc_hex));
    }
    // Buried already? Then there is nothing to journal and nobody worth dialling. `remember` is
    // what makes this safe rather than merely tidy - but a stale sharer's pointer is re-folded
    // on every frontier move they make, so without this the node would dial out for the same
    // dead document forever, and throw the answer away every time.
    if entombed(&state.node_db, author_root, doc_id).await.unwrap_or(false) {
        return None;
    }

    let author = crate::pubkey::decode(author_root)?;
    match crate::net::fragment::fetch(state, origin_root, &author, doc_id).await {
        crate::net::fragment::Fetched::Have(verified, entry, auth_path) => {
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
            let f = held(&state.node_db, author_root, &doc_hex).await.ok()??;
            Some(row_of(&f, &doc_hex))
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
pub async fn sweep(state: crate::AppState) -> Result<()> {
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
            "SELECT author_root, doc_id, origin_root FROM fragments
             WHERE checked_ms <= ?1 ORDER BY checked_ms LIMIT ?2",
            (due, SWEEP_CAP),
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
        match crate::net::fragment::revalidate(&state, &origin_root, &author, &doc_id).await {
            crate::net::fragment::Fetched::Have(verified, entry, auth_path) => {
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

    drain_wants(&state).await?;
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
            crate::net::fragment::Fetched::Have(verified, entry, auth_path) => {
                remember(&state.node_db, &origin_root, &author_hex, &verified, &entry, &auth_path)
                    .await?;
                let _ = crate::net::bodies::want(
                    &state.node_db,
                    &author_hex,
                    &verified.header.file_hash,
                )
                .await;
                settle_want(&state.node_db, &author_hex, &doc_hex).await?;
                tracing::info!(author = %author_hex, doc = %doc_hex, "a wanted fragment arrived");
                if let Some(f) = held(&state.node_db, &author_hex, &doc_hex).await? {
                    crate::fanout::journal_late_share(
                        state,
                        &origin_root,
                        &author_hex,
                        &row_of(&f, &doc_hex),
                    )
                    .await;
                }
            }
            crate::net::fragment::Fetched::Gone { entry, auth_path } => {
                entomb(&state.node_db, &author_hex, &doc_hex, &entry, &auth_path).await?;
                settle_want(&state.node_db, &author_hex, &doc_hex).await?;
            }
            crate::net::fragment::Fetched::Unknown => {}
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
        ringtome_proto::fragment::VerifiedFragment {
            doc_id: doc,
            version: [7u8; 32],
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
