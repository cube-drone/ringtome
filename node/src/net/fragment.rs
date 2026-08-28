//! Fragment fetch: one shared document, from whoever handed us the pointer.
//!
//! The reader's half of a rebroadcast. A node holding "B shared A's document D" needs D's words
//! and must not subscribe to A to get them (PROJECT_PLAN, *What travels with a share*: a chain
//! pin never propagates with viewing). So this asks B - the **origin**, the edge the pointer
//! arrived by - for exactly one document.
//!
//! ## Serving is answering for what we already carry, never fetching on demand
//!
//! The door below reads this node's own shelves and nothing else. It will not go and get a
//! document it lacks in order to satisfy a stranger, because that would make any node a lever
//! for pulling arbitrary content onto any other - *Pull, Not Push* with extra steps. `Unknown`
//! is a complete and honest answer, and the asker has other origins to try.
//!
//! ## Why `Gone` is a different word from `Unknown`
//!
//! `Gone` says the document was withdrawn - the author retracted, our pin saw it, and the asker
//! should drop their copy. `Unknown` says we do not carry it, so ask somebody else. A reader
//! that could not tell them apart would delete a live share every time it asked the wrong node,
//! which is why the protocol spends a whole message tag on the distinction.
//!
//! And since 2026-08-13, `Gone` is not a word at all but a document: the author's own signed
//! `post-retract`, carried with its delegation path and verified at the receiving edge exactly
//! as a fragment is. Before that, `Have` proved itself while its opposite was taken on the
//! answering node's say-so - and under tombstone finality, a lying origin could permanently
//! bury any document it had ever served, for its whole subtree, whenever the author was dark.
//! Now deletion is as unforgeable as content: a node relays the retraction it heard, and a
//! node that cannot show the author's word for a death moves nothing.

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use ringtome_proto::fragment::{
    verify_fragment, FragmentMessage, VerifiedFragment, FRAGMENT_ALPN, MAX_FRAGMENT_FRAME_BYTES,
};

use crate::AppState;

/// How long one fragment fetch may take, dial included. A shared document is not urgent - the
/// feed row appears when it appears - and a node that cannot answer promptly is better retried.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

// ---------------------------------------------------------------------------------------------
// Frame IO. Its own pair for the same reason `net::deliver` has its own: the framing (4-byte
// big-endian length + canonical CBOR) is identical on purpose, but the message type is not.

async fn write_frame(send: &mut SendStream, msg: &FragmentMessage) -> Result<()> {
    let body = msg.encode();
    let len = u32::try_from(body.len()).map_err(|_| anyhow!("fragment frame too large"))?;
    send.write_all(&len.to_be_bytes())
        .await
        .context("writing fragment frame length")?;
    send.write_all(&body)
        .await
        .context("writing fragment frame body")?;
    Ok(())
}

async fn read_frame(recv: &mut RecvStream) -> Result<Option<FragmentMessage>> {
    let mut len_bytes = [0u8; 4];
    if recv.read_exact(&mut len_bytes).await.is_err() {
        return Ok(None); // clean end of stream at a frame boundary
    }
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > MAX_FRAGMENT_FRAME_BYTES {
        return Err(anyhow!("fragment frame of {len} bytes exceeds limit"));
    }
    let mut body = vec![0u8; len];
    recv.read_exact(&mut body)
        .await
        .context("reading fragment frame body")?;
    Ok(Some(FragmentMessage::decode(&body).map_err(|e| {
        anyhow!("undecodable fragment frame: {e}")
    })?))
}

// ---------------------------------------------------------------------------------------------
// The door

/// Proofs per `Deaths` page. Eight small entries with short paths sit far under the 16KB frame
/// cap even at MAX_AUTH_PATH depth; the decode-side cap (`MAX_DEATHS_PER_PAGE`) is looser on
/// purpose, so this can grow without a protocol conversation.
pub(crate) const DEATHS_PAGE: i64 = 8;

/// Serve one fragment request: a `Want` for one document, or a `WantDeaths` for a page of the
/// death log (the retraction-cursor slice, 2026-08-13 - one ask covers every death this node
/// can prove, instead of one dial per document the asker holds).
pub async fn serve(conn: Connection, state: AppState) -> Result<()> {
    let (mut send, mut recv) = conn.accept_bi().await.context("accepting fragment stream")?;
    let answer = match read_frame(&mut recv).await? {
        Some(FragmentMessage::Want { author, doc_id }) => {
            answer_for(&state, &author, &doc_id).await
        }
        Some(FragmentMessage::WantDeaths { since }) => deaths_page(&state, since).await,
        Some(FragmentMessage::WantReplies { author, doc_id, since }) => {
            // The author's thread door (PROJECT_PLAN's Replies slice 6): claims, never words, curated
            // by the author's own bit. A node that does not host this author answers an
            // empty page rather than an error - "nothing to say" is a fact, not a fault.
            let (proofs, cursor) = crate::replies::door_page(
                &state,
                &hex::encode(author),
                &hex::encode(doc_id),
                since,
            )
            .await;
            FragmentMessage::Replies { proofs, cursor }
        }
        _ => return Err(anyhow!("expected a Want, WantDeaths, or WantReplies")),
    };
    write_frame(&mut send, &answer).await?;
    send.finish().ok();
    conn.closed().await;
    Ok(())
}

/// One page of "what died since N", from the log. Rows whose stored identity fails to parse are
/// skipped rather than fatal - the asker verifies every proof anyway, and one corrupt row must
/// not wedge the cursor for everything behind it.
async fn deaths_page(state: &AppState, since: u64) -> FragmentMessage {
    let rows = match crate::fragments::deaths_since(&state.node_db, since as i64, DEATHS_PAGE).await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!(error = ?e, "death log read failed");
            return FragmentMessage::Deaths {
                proofs: Vec::new(),
                cursor: since,
            };
        }
    };
    let mut cursor = since;
    let mut proofs = Vec::new();
    for row in rows {
        cursor = row.id as u64;
        let (Some(author), Ok(doc_bytes)) = (
            crate::pubkey::decode(&row.author_root),
            hex::decode(&row.doc_id),
        ) else {
            continue;
        };
        let Ok(doc_id) = <[u8; 16]>::try_from(doc_bytes.as_slice()) else {
            continue;
        };
        proofs.push(ringtome_proto::fragment::DeathProof {
            author,
            doc_id,
            entry: row.entry,
            auth_path: row.auth_path,
        });
    }
    FragmentMessage::Deaths { proofs, cursor }
}

/// What we can honestly say about one document of somebody else's.
///
/// Three shelves, in order. First our own copy of the author's chain - and only when a
/// RELATIONSHIP keeps that copy current (someone here follows them, hosts them, or met them;
/// `speculative::speculative_only` is the gate) - because then it is the most current thing
/// we have, and it reports a retraction itself. (This used to say "or one of our people
/// SHARED them and the pin keeps them current" - stale since 2026-08-11, when a share
/// stopped subscribing the sharer to the author and started obliging a fragment COPY
/// instead; the sharer's answer lives on the third shelf now.) Then the tombstone, because a
/// document we know to be dead is dead no matter what we still have lying around. Only then
/// our own fragment ledger, so a live fragment can be relayed one more hop by a node that
/// never held the author either.
async fn answer_for(state: &AppState, author: &[u8; 32], doc_id: &[u8; 16]) -> FragmentMessage {
    let author_hex = hex::encode(author);
    let answer = answer_inner(state, &author_hex, doc_id).await;
    tracing::debug!(
        author = %author_hex, doc = %hex::encode(doc_id),
        answer = match &answer {
            FragmentMessage::Have { .. } => "have",
            FragmentMessage::Gone { .. } => "gone",
            _ => "unknown",
        },
        "fragment door answered"
    );
    answer
}

async fn answer_inner(
    state: &AppState,
    author_hex: &str,
    doc_id: &[u8; 16],
) -> FragmentMessage {
    match from_held_chain(state, author_hex, doc_id).await {
        Ok(Some(answer)) => return answer,
        Ok(None) => {}
        Err(e) => {
            tracing::debug!(author = %author_hex, error = ?e, "fragment lookup failed");
            return FragmentMessage::Unknown;
        }
    }
    // The memo, and it outranks our own copy of the words (reordered 2026-08-13). **A tombstone
    // is final for its document id** - `documents::retracted_doc_ids` states the model, and the
    // recourse for a typo is delete-and-repost under a NEW id - so a fragment sitting beside a
    // tombstone is not a choice between two sources, it is a contradiction, and the tombstone is
    // the half that cannot have arrived from someone who had not heard.
    //
    // The memo answers with the PROOF it stored when it heard - the author's own signed
    // retraction, relayed exactly as the author's signed header is: an honest post office either
    // way, unable to alter a byte of either. This is what lets `Gone` cross a node that never
    // held the author's chain and still be verified at the far end.
    //
    // This used to be checked last, on the argument that a re-published document "(new id, but
    // the same author deleting and reposting)" must not be shadowed by an old tombstone. That
    // argument refutes itself: a new id has a different tombstone key and could never have been
    // shadowed. What the order actually bought was a node that had heard a takedown, and kept
    // serving the post to everyone one hop further out (`cascade.cjs`, *a document that was
    // buried stays buried*).
    match crate::fragments::tomb_proof(&state.node_db, author_hex, doc_id).await {
        Ok(Some((entry, auth_path))) => return FragmentMessage::Gone { entry, auth_path },
        Ok(None) => {}
        Err(e) => {
            // Never relay on a failed tombstone read: `Unknown` sends the asker elsewhere, which
            // is recoverable, while `Have` would hand out words we cannot currently vouch for.
            tracing::debug!(author = %author_hex, error = ?e, "tombstone lookup failed");
            return FragmentMessage::Unknown;
        }
    }
    // Our own fragment ledger, so a fragment can be relayed one more hop by a node that never
    // held the author either.
    if let Ok(Some((entry, auth_path))) =
        crate::fragments::relayable(&state.node_db, author_hex, doc_id).await
    {
        return FragmentMessage::Have { entry, auth_path };
    }
    FragmentMessage::Unknown
}

/// The answer from our own copy of the author's chain, if we hold one.
async fn from_held_chain(
    state: &AppState,
    author_hex: &str,
    doc_id: &[u8; 16],
) -> Result<Option<FragmentMessage>> {
    let Some(db) = state.user_dbs.get(author_hex).await? else {
        return Ok(None);
    };
    // A chain held ONLY speculatively is invisible to this door (2026-08-21, found by
    // cascade.cjs the day the speculative pass landed). Two reasons, one rule
    // (`speculative::speculative_only` carries the argument): this shelf's authority is the
    // machinery keeping it current, which a hunch-held mirror does not have - the stale
    // mirror answered "Unknown" for documents whose fragments this node actually held, and
    // served yesterday's version of edited ones - and speculative mirrors serve nobody
    // (PROJECT_PLAN's Discovery invariants): the sync door's wanted gate already refuses them, and a door
    // that answered from the quiet pile would let any peer probe out what this node
    // speculates about. Falling through leaves the tombstone and fragment shelves to
    // answer, exactly as they did before the mirror existed.
    if crate::speculative::speculative_only(state, author_hex).await? {
        return Ok(None);
    }
    // `public_doc_ids` already filters retractions, so absence here IS the withdrawal signal -
    // the same chokepoint the feed's own retraction sweep reconciles against, which is what
    // keeps "gone from the shelf" and "gone from a share" from being two different judgments.
    let live = crate::record::documents::public_doc_ids(&db).await?;
    let doc_hex = hex::encode(doc_id);
    if !live.contains(&doc_hex) {
        // We hold this author, and the document is not on their shelf. `Gone` needs their
        // signed retraction in hand - the proof travels with the answer - and everything else
        // off-shelf is `Unknown`: never published, or a shelf presenting nothing under
        // equivocation quarantine. The old shape ("off the shelf but ever published = Gone",
        // bare) told fragment askers a quarantined document was DELETED, which finality would
        // have made permanent for everyone downstream of them.
        return Ok(Some(
            match crate::record::documents::retraction_proof(&db, author_hex, doc_id).await? {
                Some((entry, auth_path)) => FragmentMessage::Gone { entry, auth_path },
                None => FragmentMessage::Unknown,
            },
        ));
    }
    let Some(entry) = crate::record::documents::public_header_entry(&db, doc_id).await? else {
        return Ok(None);
    };
    let auth_path = crate::record::documents::auth_path_for(&db, author_hex, &entry).await?;
    Ok(Some(FragmentMessage::Have {
        entry: entry.bytes().to_vec(),
        auth_path,
    }))
}

// ---------------------------------------------------------------------------------------------
// The asker

/// What came of asking one origin for one document.
#[derive(Debug)]
pub enum Fetched {
    /// Verified, and the author's own words. The fourth field is WHO SERVED IT - the endpoint
    /// that actually answered, `None` when the answer came from this node's own shelf. Carried
    /// so intake can remember the deliverer as a heal candidate (`fragments::note_deliverer`):
    /// the 2026-08-23 cascade diagnosis found a reader whose whole candidate ledger named only
    /// a dark sharer while the node that physically delivered the header - provably alive,
    /// provably holding - was remembered nowhere.
    Have(Box<VerifiedFragment>, Vec<u8>, Vec<Vec<u8>>, Option<String>),
    /// The author withdrew it - verified, and the author's own retraction. Drop what we hold,
    /// and keep these bytes: they are what `entomb` stores and the tombstone door serves, so
    /// the proof outlives the words at every hop.
    Gone { entry: Vec<u8>, auth_path: Vec<Vec<u8>> },
    /// This origin cannot help. Nothing has been learned about the document itself.
    Unknown,
}

/// Ask one origin for one document.
///
/// Tries the origin's known endpoints in turn and stops at the first that answers anything -
/// including `Unknown`, which is an answer. Only silence moves on to the next.
/// Ask the AUTHOR first, then whoever shared it.
///
/// **Star and tree, in that order** (settled 2026-08-11). The author's own node is the fastest
/// and most authoritative answer there is - it knows immediately whether the document lives,
/// what its current version is, and it costs one small round trip on this ALPN rather than a
/// chain subscription. That was the piece the first design missed: reachability and syncing were
/// conflated, so "I need to know if this is still alive" bought "I need their whole history".
///
/// When the author cannot be reached - offline, gone, or simply never discoverable from here -
/// the origin answers instead. It holds the content, and having revalidated on its own schedule
/// it eventually holds the knowledge of any edit or deletion too. That is the tree, and it is
/// what makes a share survive its author going dark, what makes deletion travel to any depth,
/// and what makes `relayable` and the tombstone load-bearing rather than decorative.
///
/// Authority where it is reachable, resilience where it is not.
/// Which lane revalidation takes, test-overridable at runtime.
///
/// The fast lane (author first) is production's shape; the tree alone is the fallback's. Both
/// must stay exercised, and they cannot be without a switch: with the author reachable every
/// reader takes the shortcut and the relay path stays green without ever running - and with the
/// boot env pinning tree-only, the shortcut is the path that rots instead. So the boot env sets
/// the default (`RINGTOME_TEST_TREE_ONLY`, harness-wide) and a LOCAL_TEST endpoint
/// (`/test/revalidation`) overrides it per node at runtime, which is what lets one suite run the
/// same cascade through both lanes.
///
/// 0 = follow the boot env; 1 = force tree-only; 2 = force the fast lane; 3 = no per-document
/// revalidation at all ("none" - LOCAL_TEST only, `/test/revalidation`). Mode 3 exists for one
/// test shape: proving a death arrived by the CURSOR and not the queue, which needs the queue
/// provably parked. The reap is untouched by it.
pub static REVALIDATION_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub(crate) fn tree_only() -> bool {
    match REVALIDATION_MODE.load(std::sync::atomic::Ordering::Relaxed) {
        1 => true,
        2 => false,
        _ => {
            std::env::var("RINGTOME_LOCAL_TEST").is_ok()
                && std::env::var("RINGTOME_TEST_TREE_ONLY").is_ok()
        }
    }
}

pub async fn revalidate(
    state: &AppState,
    origin_root: &str,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> Fetched {
    if REVALIDATION_MODE.load(std::sync::atomic::Ordering::Relaxed) == 3 {
        return Fetched::Unknown; // the queue is parked; only the reap moves anything
    }
    let author_hex = hex::encode(author);
    if !tree_only() {
        // The author is not asked about their own document through a relay: if we ARE the
        // author's node, or we hold their chain, `answer_for` already knows and no dial happens.
        match fetch(state, &author_hex, author, doc_id).await {
            Fetched::Unknown => {}
            answered => return answered,
        }
    }
    if origin_root != author_hex {
        match fetch(state, origin_root, author, doc_id).await {
            Fetched::Unknown => {}
            answered => return answered,
        }
    }
    // The ledger walk (2026-08-15): the row remembers ONE origin - first server wins - while
    // `feed_shares` knows every sharer a local reader follows who stands behind this exact
    // document. Any of them can carry an edit or a death as well as the recorded origin can;
    // asking them when the origin is silent is what makes virality make a document HARDER to
    // lose, not merely more seen. Introducer-first, politeness-capped, and still only ever
    // relationships this node's own users created.
    let sharers = crate::fanout::sharers_of_doc(&state.node_db, &author_hex, &hex::encode(doc_id))
        .await
        .unwrap_or_default();
    let mut walked = 0;
    for sharer in sharers {
        if sharer == author_hex || sharer == origin_root {
            continue;
        }
        if walked >= SHARER_WALK_CAP {
            break;
        }
        walked += 1;
        match fetch(state, &sharer, author, doc_id).await {
            Fetched::Unknown => {}
            answered => return answered,
        }
    }
    // The cohort, last (2026-08-15): every rung above names the DOCUMENT's own machinery -
    // author, recorded origin, the byline ledger's sharers - and all of it can be dark for
    // good while a sibling node of one of our own personas still holds the fragment whole.
    // Endpoint-addressed rather than root-addressed, because the sibling is not a persona in
    // this document's tree; it is our own household, reached by the addresses the ceremony
    // already bound.
    for endpoint in crate::net::sync::cohort_endpoints(state)
        .await
        .unwrap_or_default()
    {
        let asked =
            tokio::time::timeout(FETCH_TIMEOUT, ask(state, &endpoint, author, doc_id)).await;
        match asked {
            Ok(Ok(Fetched::Unknown)) => {}
            Ok(Ok(answered)) => return answered,
            Ok(Err(e)) => {
                tracing::debug!(cohort = %endpoint, error = ?e, "cohort fragment ask failed")
            }
            Err(_) => tracing::debug!(cohort = %endpoint, "cohort fragment ask timed out"),
        }
    }
    Fetched::Unknown
}

/// Fallback sharers dialed per revalidation after the author and the recorded origin both
/// answered nothing. A politeness bound, not a correctness one: the next beat resumes, and
/// the introducer-first order means the walk tries the longest-standing sharers first.
const SHARER_WALK_CAP: usize = 3;

pub async fn fetch(
    state: &AppState,
    origin_root: &str,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> Fetched {
    // Housemates: the origin is one of ours, so the answer is a function call rather than a
    // connection. `net::deliver` does the same, for the same reason - iroh has no cause to make
    // a self-dial work, and the judgment is identical either way.
    if crate::identity::is_agented(&state.node_db, origin_root)
        .await
        .unwrap_or(false)
    {
        return match answer_for(state, author, doc_id).await {
            FragmentMessage::Have { entry, auth_path } => {
                match verify_fragment(*author, *doc_id, &entry, &auth_path) {
                    Ok(v) => Fetched::Have(Box::new(v), entry, auth_path, None),
                    Err(e) => {
                        tracing::warn!(error = ?e, "our own fragment failed its own proof");
                        Fetched::Unknown
                    }
                }
            }
            FragmentMessage::Gone { entry, auth_path } => {
                // Our own stored proof still passes through the verifier - the mirror of "our
                // own fragment failed its own proof" above, and for the same reason: a row
                // corrupted on disk must not act, however it got here.
                match ringtome_proto::fragment::verify_retraction(*author, *doc_id, &entry, &auth_path) {
                    Ok(()) => Fetched::Gone { entry, auth_path },
                    Err(e) => {
                        tracing::warn!(error = ?e, "our own tombstone failed its own proof");
                        Fetched::Unknown
                    }
                }
            }
            _ => Fetched::Unknown,
        };
    }

    for candidate in crate::net::deliver::candidates(state, origin_root).await {
        let endpoint_id =
            crate::idface::leaf_via_to_endpoint(state, origin_root, &candidate).await;
        let asked = tokio::time::timeout(
            FETCH_TIMEOUT,
            ask(state, &endpoint_id, author, doc_id),
        )
        .await;
        match asked {
            Ok(Ok(answer)) => return answer,
            Ok(Err(e)) => {
                tracing::debug!(origin = %origin_root, error = ?e, "fragment fetch failed")
            }
            Err(_) => tracing::debug!(origin = %origin_root, "fragment fetch timed out"),
        }
    }
    Fetched::Unknown
}

/// Ask one peer for a page of its death log, verifying every proof at this edge before a byte
/// of it is believed - per proof, against the AUTHOR each names, because a log mixes authors
/// and the origin relaying it vouches for none of them. A proof that fails drops loudly and the
/// rest of the page stands: refusing a whole page over one garbled row would let it dam every
/// real death behind it, and the per-document sweep remains the backstop for whatever was lost.
///
/// Returns the verified proofs, the cursor to resume from, and the RAW page length - the caller
/// needs the third to tell "drained" from "a page of skips", or it would stop paging early.
pub async fn fetch_deaths(
    state: &AppState,
    origin_root: &str,
    since: u64,
) -> Option<(Vec<ringtome_proto::fragment::DeathProof>, u64, usize)> {
    for candidate in crate::net::deliver::candidates(state, origin_root).await {
        let endpoint_id =
            crate::idface::leaf_via_to_endpoint(state, origin_root, &candidate).await;
        let asked = tokio::time::timeout(
            FETCH_TIMEOUT,
            ask_deaths(state, &endpoint_id, since),
        )
        .await;
        match asked {
            Ok(Ok(answer)) => return Some(answer),
            Ok(Err(e)) => {
                tracing::debug!(origin = %origin_root, error = ?e, "death cursor ask failed")
            }
            Err(_) => tracing::debug!(origin = %origin_root, "death cursor ask timed out"),
        }
    }
    None
}

/// The death-cursor ask, endpoint-addressed - the reap's cohort rung (2026-08-15). A sibling
/// node is not a persona in any fragment's tree, so `fetch_deaths`' root-to-candidates
/// resolution has nothing to resolve; the reap keys its cursor by the endpoint instead and
/// dials it directly. Same wire, same per-proof verification at the same edge.
pub async fn fetch_deaths_at(
    state: &AppState,
    endpoint_id: &str,
    since: u64,
) -> Option<(Vec<ringtome_proto::fragment::DeathProof>, u64, usize)> {
    match tokio::time::timeout(FETCH_TIMEOUT, ask_deaths(state, endpoint_id, since)).await {
        Ok(Ok(answer)) => Some(answer),
        Ok(Err(e)) => {
            tracing::debug!(cohort = %endpoint_id, error = ?e, "cohort death ask failed");
            None
        }
        Err(_) => {
            tracing::debug!(cohort = %endpoint_id, "cohort death ask timed out");
            None
        }
    }
}

/// Ask an author's door for a page of their post's reply index, verifying every proof at
/// this edge before a claim is believed - `verify_reply` binds each entry to the exact
/// parent asked about, so a lying door can withhold but never re-parent. Returns the
/// verified proofs (with each reply's identity and stamp, read from inside the signature)
/// and the door's new cursor.
pub async fn fetch_replies(
    state: &AppState,
    parent_author: &[u8; 32],
    parent_doc: &[u8; 16],
    since: u64,
) -> Option<(Vec<(ringtome_proto::fragment::ReplyProof, [u8; 16], i64)>, u64)> {
    let author_hex = hex::encode(parent_author);
    for candidate in crate::net::deliver::candidates(state, &author_hex).await {
        let endpoint_id = crate::idface::leaf_via_to_endpoint(state, &author_hex, &candidate).await;
        let asked = tokio::time::timeout(
            FETCH_TIMEOUT,
            ask_replies(state, &endpoint_id, parent_author, parent_doc, since),
        )
        .await;
        match asked {
            Ok(Ok(answer)) => return Some(answer),
            Ok(Err(e)) => {
                tracing::debug!(author = %author_hex, error = ?e, "reply index ask failed")
            }
            Err(_) => tracing::debug!(author = %author_hex, "reply index ask timed out"),
        }
    }
    None
}

async fn ask_replies(
    state: &AppState,
    endpoint_id: &str,
    parent_author: &[u8; 32],
    parent_doc: &[u8; 16],
    since: u64,
) -> Result<(Vec<(ringtome_proto::fragment::ReplyProof, [u8; 16], i64)>, u64)> {
    let addr = crate::net::sync::dial_addr(state, endpoint_id).await?;
    let conn = crate::net::p2p::dial(&state.unplugged, &state.endpoint, addr, FRAGMENT_ALPN)
        .await
        .map_err(|e| anyhow!("dialing {endpoint_id} for the reply index: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.context("opening fragment stream")?;
    write_frame(
        &mut send,
        &FragmentMessage::WantReplies {
            author: *parent_author,
            doc_id: *parent_doc,
            since,
        },
    )
    .await?;
    send.finish().ok();
    let answer = read_frame(&mut recv).await?;
    conn.close(0u8.into(), b"done");
    let Some(FragmentMessage::Replies { proofs, cursor }) = answer else {
        return Err(anyhow!("unexpected answer to a reply index ask: {answer:?}"));
    };
    let verified = proofs
        .into_iter()
        .filter_map(|p| {
            match ringtome_proto::fragment::verify_reply(
                p.replier,
                *parent_author,
                *parent_doc,
                &p.entry,
                &p.auth_path,
            ) {
                Ok((doc, stamp)) => Some((p, doc, stamp)),
                Err(e) => {
                    tracing::warn!(replier = %hex::encode(p.replier), error = ?e,
                        "a reply in the index failed its own proof - skipped");
                    None
                }
            }
        })
        .collect();
    Ok((verified, cursor))
}

async fn ask_deaths(
    state: &AppState,
    endpoint_id: &str,
    since: u64,
) -> Result<(Vec<ringtome_proto::fragment::DeathProof>, u64, usize)> {
    let addr = crate::net::sync::dial_addr(state, endpoint_id).await?;
    let conn = crate::net::p2p::dial(&state.unplugged, &state.endpoint, addr, FRAGMENT_ALPN)
        .await
        .map_err(|e| anyhow!("dialing {endpoint_id} for the death log: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.context("opening fragment stream")?;
    write_frame(&mut send, &FragmentMessage::WantDeaths { since }).await?;
    send.finish().ok();
    let answer = read_frame(&mut recv).await?;
    conn.close(0u8.into(), b"done");
    let Some(FragmentMessage::Deaths { proofs, cursor }) = answer else {
        return Err(anyhow!("unexpected answer to a death cursor ask: {answer:?}"));
    };
    let raw = proofs.len();
    let verified = proofs
        .into_iter()
        .filter(|p| {
            match ringtome_proto::fragment::verify_retraction(
                p.author,
                p.doc_id,
                &p.entry,
                &p.auth_path,
            ) {
                Ok(()) => true,
                Err(e) => {
                    tracing::warn!(
                        author = %hex::encode(p.author), doc = %hex::encode(p.doc_id),
                        error = ?e,
                        "a death in the log failed its own proof - skipped"
                    );
                    false
                }
            }
        })
        .collect();
    Ok((verified, cursor, raw))
}

async fn ask(
    state: &AppState,
    endpoint_id: &str,
    author: &[u8; 32],
    doc_id: &[u8; 16],
) -> Result<Fetched> {
    let addr = crate::net::sync::dial_addr(state, endpoint_id).await?;
    let conn = crate::net::p2p::dial(&state.unplugged, &state.endpoint, addr, FRAGMENT_ALPN)
        .await
        .map_err(|e| anyhow!("dialing {endpoint_id} for a fragment: {e}"))?;
    let (mut send, mut recv) = conn.open_bi().await.context("opening fragment stream")?;
    write_frame(
        &mut send,
        &FragmentMessage::Want {
            author: *author,
            doc_id: *doc_id,
        },
    )
    .await?;
    send.finish().ok();
    let answer = read_frame(&mut recv).await?;
    conn.close(0u8.into(), b"done");
    match answer {
        Some(FragmentMessage::Have { entry, auth_path }) => {
            // **Verified here, at the edge, before a byte of it is believed.** A relay handing
            // us a signed entry is an honest post office; a relay handing us a forged one must
            // get nothing for the trouble.
            let verified = verify_fragment(*author, *doc_id, &entry, &auth_path)
                .map_err(|e| anyhow!("a fragment failed its own proof: {e}"))?;
            Ok(Fetched::Have(
                Box::new(verified),
                entry,
                auth_path,
                Some(endpoint_id.to_string()),
            ))
        }
        Some(FragmentMessage::Gone { entry, auth_path }) => {
            // The same edge, the darker direction - and the erring side is chosen by what each
            // failure costs. Believing a forged `Have` shows a reader words the author never
            // signed; believing a forged `Gone` PERMANENTLY buries a live document, because a
            // tombstone is final. So an unprovable `Gone` earns the same treatment as an
            // unprovable `Have`: an error, the next candidate gets asked, and a node that
            // cannot prove its claim moves nothing. Silence preserves - hearsay is silence.
            ringtome_proto::fragment::verify_retraction(*author, *doc_id, &entry, &auth_path)
                .map_err(|e| anyhow!("a deletion failed its own proof: {e}"))?;
            Ok(Fetched::Gone { entry, auth_path })
        }
        Some(FragmentMessage::Unknown) => Ok(Fetched::Unknown),
        other => Err(anyhow!("unexpected answer to a fragment request: {other:?}")),
    }
}
