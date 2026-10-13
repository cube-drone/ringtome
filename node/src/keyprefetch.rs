//! Keys asked for early (Curtis, 2026-09-29: "it'll make 'trusted only' posts work more reliably
//! network wide, not just for chat rooms").
//!
//! A trusted-only post travels as ciphertext and its key is released on demand, after a trust
//! check only the author's node can make (their contact tags are private). Until now the demand
//! was the READ: a sealed post that arrived while its author's node was up, and was opened a day
//! later while it was down, could not be opened at all - the body sat on this node, and the one
//! node that could hand over its key was dark. So this pass asks at ARRIVAL: every trusted-only
//! post in a reader's feed here that the reader holds no key for is asked about in the
//! background, the same ask the body door makes, from the same places (the post's sharer on the
//! onward hop, then the author's nodes). A key granted is remembered for that reader exactly as a
//! read would remember it; a refusal is remembered as the door remembers one; an author who
//! doesn't answer is asked again later, never hammered.
//!
//! A follower mostly had this already, by accident: folding an author's chain opens their sealed
//! labels, and that asks for the key on behalf of every follower hosted here (notifications.rs).
//! What only this pass reaches: a sealed post shared in by somebody the reader follows (the onward
//! hop - the author may never have heard of the reader), a reply sealed under its parent, a post
//! with no sealed label to open, and any first ask that found the author's node away.
//!
//! Bounded: the newest rows only, a handful of asks per pass, and each (key, reader) at most once
//! per `RETRY` while it goes unanswered.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::AppState;

/// How far back into the feeds a pass looks, newest arrival first.
const ROWS: i64 = 200;
/// Asks per pass: each may wait out a dial, so a pass stays short and the next one continues.
const ASKS: usize = 16;
/// How long an unanswered ask rests before it is tried again.
const RETRY: Duration = Duration::from_secs(10 * 60);

/// One reader's claim on one key: `(holder, key doc, reader)`, hex.
type Slot = (String, String, String);

/// Each slot's last unanswered ask.
static TRIED: LazyLock<Mutex<HashMap<Slot, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Rows already opened for their reader, with the key tables' write counts when found so
/// (plans/CACHE.md, Stage 4): a pass re-checked all two hundred every thirty seconds - a header
/// read in the author's database and three node.db statements a row, ~800 a pass - to learn,
/// nearly always, that nothing had changed. A row stands settled while `post_keys` and
/// `post_key_grants` do: a key or grant removed moves them, and the row is checked again.
static SETTLED: LazyLock<Mutex<HashMap<SealedRow, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Whose key opens a sealed post - `(holder, key doc)` - by `(author, post)`: from the post's
/// header, which never changes once it's held.
static SEALED_BY: LazyLock<Mutex<HashMap<KeyRef, KeyRef>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A feed row: `(reader, author, post)`, hex.
type SealedRow = (String, String, String);
/// A post or its key: `(author or holder hex, doc)`.
type KeyRef = (String, [u8; 16]);

/// The most rows either keeps before starting over.
const KEPT_MAX: usize = 50_000;

/// One pass: ask for the keys the feeds' sealed posts are missing.
pub async fn prefetch_pass(state: AppState) -> anyhow::Result<()> {
    let rows = crate::fanout::sealed_rows(&state.node_db, ROWS).await?;
    let mut asked = 0usize;
    // The key tables' write counts: a row settled under them stays settled while they stand.
    let keys_at = {
        let k = state.node_db.writes_key();
        crate::db::writes_to(k, "post_keys") + crate::db::writes_to(k, "post_key_grants")
    };
    for (reader, author, doc_hex, via) in rows {
        if asked >= ASKS {
            break;
        }
        let row = (reader.clone(), author.clone(), doc_hex.clone());
        if SETTLED.lock().expect("settled poisoned").get(&row) == Some(&keys_at) {
            continue;
        }
        let Ok(doc) = <[u8; 16]>::try_from(hex::decode(&doc_hex).unwrap_or_default().as_slice())
        else {
            continue;
        };
        // Whose key opens it: the post's own, or - a reply sealed under its parent - the parent's.
        // From its header, which never changes once held: remembered (`SEALED_BY`).
        let known =
            SEALED_BY.lock().expect("sealed-by poisoned").get(&(author.clone(), doc)).cloned();
        let (holder, key_doc) = match known {
            Some(found) => found,
            None => match crate::fragments::card_header(&state, &author, &doc).await {
                Some(header) => {
                    let found = match header.seal_of {
                        Some((holder, key_doc)) => (hex::encode(holder), key_doc),
                        None => (author.clone(), doc),
                    };
                    let mut by = SEALED_BY.lock().expect("sealed-by poisoned");
                    if by.len() >= KEPT_MAX {
                        by.clear();
                    }
                    by.insert((author.clone(), doc), found.clone());
                    found
                }
                None => (author.clone(), doc),
            },
        };
        if holder == reader {
            continue; // the reader's own seal
        }
        let key_doc_hex = hex::encode(key_doc);
        let db = &state.node_db;
        if crate::postkeys::granted(db, &holder, &key_doc_hex, &reader).await.unwrap_or(false)
            && crate::postkeys::lookup(db, &holder, &key_doc_hex).await.ok().flatten().is_some()
        {
            let mut settled = SETTLED.lock().expect("settled poisoned");
            if settled.len() >= KEPT_MAX {
                settled.clear();
            }
            settled.insert(row, keys_at);
            continue; // already opened for this reader
        }
        if crate::postkeys::refused(db, &holder, &key_doc_hex, &reader).await.unwrap_or(false) {
            continue; // the author's node said no, lately; the door asks again when read
        }
        let slot = (holder.clone(), key_doc_hex.clone(), reader.clone());
        if TRIED.lock().expect("tried poisoned").get(&slot).is_some_and(|at| at.elapsed() < RETRY) {
            continue;
        }
        asked += 1;
        let got = crate::idface::key_for(&state, &holder, &key_doc, &reader, via.as_deref()).await;
        let mut tried = TRIED.lock().expect("tried poisoned");
        if got.is_some() {
            tried.remove(&slot);
        } else {
            tried.insert(slot, Instant::now());
        }
    }
    if asked > 0 {
        tracing::debug!(asked, "sealed posts' keys asked for ahead of reading");
    }
    Ok(())
}
