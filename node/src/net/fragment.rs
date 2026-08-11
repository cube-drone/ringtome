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

/// Serve one fragment request.
pub async fn serve(conn: Connection, state: AppState) -> Result<()> {
    let (mut send, mut recv) = conn.accept_bi().await.context("accepting fragment stream")?;
    let Some(FragmentMessage::Want { author, doc_id }) = read_frame(&mut recv).await? else {
        return Err(anyhow!("expected a Want"));
    };
    let answer = answer_for(&state, &author, &doc_id).await;
    write_frame(&mut send, &answer).await?;
    send.finish().ok();
    conn.closed().await;
    Ok(())
}

/// What we can honestly say about one document of somebody else's.
///
/// Two shelves, in order. First our own copy of the author's chain - the case where we sync them
/// because one of our people follows them, or because one of our people SHARED them and the pin
/// keeps them current. Then our own fragment ledger, so a fragment can be relayed one more hop
/// by a node that never held the author either.
async fn answer_for(state: &AppState, author: &[u8; 32], doc_id: &[u8; 16]) -> FragmentMessage {
    let author_hex = hex::encode(author);
    let answer = answer_inner(state, &author_hex, doc_id).await;
    tracing::debug!(
        author = %author_hex, doc = %hex::encode(doc_id),
        answer = match &answer {
            FragmentMessage::Have { .. } => "have",
            FragmentMessage::Gone => "gone",
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
    if let Ok(Some((entry, auth_path))) =
        crate::fragments::relayable(&state.node_db, author_hex, doc_id).await
    {
        return FragmentMessage::Have { entry, auth_path };
    }
    // Last, and the reason deletion reaches past two hops: we may have dropped this document
    // without ever holding its author's chain, and the memo is all that is left. Checked AFTER
    // the two "we have it" paths, so a re-published document (new id, but the same author
    // deleting and reposting) is never shadowed by an old tombstone.
    match crate::fragments::entombed(&state.node_db, author_hex, doc_id).await {
        Ok(true) => FragmentMessage::Gone,
        _ => FragmentMessage::Unknown,
    }
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
    // `public_doc_ids` already filters retractions, so absence here IS the withdrawal signal -
    // the same chokepoint the feed's own retraction sweep reconciles against, which is what
    // keeps "gone from the shelf" and "gone from a share" from being two different judgments.
    let live = crate::record::documents::public_doc_ids(&db).await?;
    let doc_hex = hex::encode(doc_id);
    if !live.contains(&doc_hex) {
        // We hold this author. If we hold them and the document is not on their shelf, the
        // honest answer is that it is gone - not that we are ignorant of it.
        let ever = crate::record::documents::public_head(&db, doc_id).await?.is_some();
        return Ok(Some(if ever {
            FragmentMessage::Gone
        } else {
            FragmentMessage::Unknown
        }));
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
    /// Verified, and the author's own words.
    Have(Box<VerifiedFragment>, Vec<u8>, Vec<Vec<u8>>),
    /// The author withdrew it. Drop what we hold.
    Gone,
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
/// 0 = follow the boot env; 1 = force tree-only; 2 = force the fast lane.
pub static REVALIDATION_MODE: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

fn tree_only() -> bool {
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
    let author_hex = hex::encode(author);
    if !tree_only() {
        // The author is not asked about their own document through a relay: if we ARE the
        // author's node, or we hold their chain, `answer_for` already knows and no dial happens.
        match fetch(state, &author_hex, author, doc_id).await {
            Fetched::Unknown => {}
            answered => return answered,
        }
    }
    if origin_root == author_hex {
        return Fetched::Unknown;
    }
    fetch(state, origin_root, author, doc_id).await
}

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
                    Ok(v) => Fetched::Have(Box::new(v), entry, auth_path),
                    Err(e) => {
                        tracing::warn!(error = ?e, "our own fragment failed its own proof");
                        Fetched::Unknown
                    }
                }
            }
            FragmentMessage::Gone => Fetched::Gone,
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
            Ok(Fetched::Have(Box::new(verified), entry, auth_path))
        }
        Some(FragmentMessage::Gone) => Ok(Fetched::Gone),
        Some(FragmentMessage::Unknown) => Ok(Fetched::Unknown),
        other => Err(anyhow!("unexpected answer to a fragment request: {other:?}")),
    }
}
