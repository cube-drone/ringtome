//! The people this node's public posts link to (Curtis, 2026-10-08).
//!
//! A `/ringtome/` link names its target by key, so its card and its click both resolve through
//! THIS node, and what a stranger could reach was only what the node hosts: a front-page post
//! linking someone off-node showed a stranger "(THIS DOCUMENT IS PRIVATE)" and a page saying
//! "that isn't here". The bar is Curtis's, the same one the web links' cards answer to: "if
//! something is on our node it's because someone we trust put it there". So the people the
//! node's public posts link to are admitted to a stranger exactly as a member's visit admits
//! them - fetched as a peek when nothing is held, served and revalidated when it is
//! (idface.rs, `linked_publicly_here` at each door) - and this pass warms the peek cache ahead
//! of the first stranger.
//!
//! A link is not a pin (PROJECT_PLAN, _Links in a public post_: Curtis ruled 2026-10-08): no
//! obligation to keep the linked post, no rebroadcast rules, no cascade. The peek cache holds
//! what it holds by its own rules - the node-wide budget, least recently looked at going first,
//! the unlooked-at expiry - and a stale copy beats nothing when the author doesn't answer.
//!
//! What it reads is the front page's own shelf (nodeshelf.rs): the newest posts and shares, the
//! words a stranger would be shown (the public body door, as a stranger - a sealed post's are
//! ciphertext and name nobody), the first few off-node people each one's links name.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use anyhow::{anyhow, Result};

use crate::AppState;

/// The newest front-page posts read per pass - what a stranger is likely to scroll to.
const SCAN: i64 = 200;
/// The off-node people one post's links may name: a link-stuffed article is one post's worth.
const PER_POST: usize = 10;
/// Warm peeks started per pass - the stampede cap. Each is a fetch from a stranger's node.
const PEEKS_PER_PASS: usize = 3;
/// How long an attempt that found nobody waits before the next: an author asleep is not
/// knocked on every pass.
const RETRY_MS: i64 = 60 * 60 * 1000;
/// A post's words read, at most: a bigger body is media, not words.
const MAX_WORDS: usize = 1024 * 1024;

/// What each post read named, by (author, doc), with the edit it was read at - so an unchanged
/// post is not read again. Kept for the posts still in the window.
type Reads = HashMap<(String, String), (i64, Vec<Linked>)>;
/// One person a link names, as root hex, with the link's own `?via=` hints - where the linker
/// knew them to be reachable, which the warm peek tries first.
type Linked = (String, Vec<String>);
static READS: Mutex<Option<Reads>> = Mutex::new(None);
/// When each warm peek was last tried.
static ATTEMPTS: Mutex<Option<HashMap<String, i64>>> = Mutex::new(None);

/// Forget the attempt stamps, so the next pass tries every unheld person - the test beat's
/// "warm NOW".
pub fn reset_attempt_stamps() {
    *ATTEMPTS.lock().expect("publinks attempts poisoned") = None;
}

/// Does a public post on this node link to this person? The doors' stranger admission.
pub fn linked_publicly_here(state: &AppState, root_hex: &str) -> bool {
    state.publicly_linked.lock().expect("publicly linked poisoned").contains(root_hex)
}

/// One pass: read the front page's newest posts for the people their links name, publish that
/// set to the doors, and peek a few of them this node doesn't hold yet.
pub async fn warm_pass(state: AppState) -> Result<()> {
    let rows = crate::nodeshelf::page(&state.node_db, None, SCAN).await?;
    let hosted: HashSet<String> = crate::identity::hosted_roots(&state.node_db)
        .await
        .map_err(|e| anyhow!("{e}"))?
        .into_iter()
        .collect();
    let mut linked: Vec<Linked> = Vec::new(); // newest post's first, once each
    let mut window: HashSet<(String, String)> = HashSet::new();
    for row in rows {
        if row.format.as_deref() != Some("marquee") {
            continue;
        }
        let key = (row.author_root.clone(), row.doc_id.clone());
        window.insert(key.clone());
        let known = READS
            .lock()
            .expect("publinks reads poisoned")
            .as_ref()
            .and_then(|m| m.get(&key))
            .filter(|(at, _)| *at == row.updated_ms)
            .map(|(_, people)| people.clone());
        let people = match known {
            Some(people) => people,
            None => {
                let people = people_linked(&state, &row.author_root, &row.doc_id).await;
                READS
                    .lock()
                    .expect("publinks reads poisoned")
                    .get_or_insert_with(HashMap::new)
                    .insert(key, (row.updated_ms, people.clone()));
                people
            }
        };
        for (root, via) in people {
            if !hosted.contains(&root) && !linked.iter().any(|(r, _)| *r == root) {
                linked.push((root, via));
            }
        }
    }
    if let Some(reads) = READS.lock().expect("publinks reads poisoned").as_mut() {
        reads.retain(|key, _| window.contains(key));
    }
    *state.publicly_linked.lock().expect("publicly linked poisoned") =
        linked.iter().map(|(root, _)| root.clone()).collect();

    let now = crate::clock::now_ms();
    let mut started = 0;
    for (root, via) in linked {
        if started >= PEEKS_PER_PASS {
            break;
        }
        // Held already: a look at it revalidates behind the answer, as a member's does.
        if state.user_dbs.db_mtime_ms(&root).is_some() {
            continue;
        }
        {
            let mut attempts = ATTEMPTS.lock().expect("publinks attempts poisoned");
            let attempts = attempts.get_or_insert_with(HashMap::new);
            if attempts.get(&root).is_some_and(|at| now - at < RETRY_MS) {
                continue;
            }
            attempts.insert(root.clone(), now);
        }
        started += 1;
        let reached = crate::idface::fetch_foreign(&state, &root, &via).await;
        tracing::info!(root = %root, reached, "warmed a peek for a public link");
    }
    Ok(())
}

/// The off-node people one public post's links name, read from the words a stranger is shown.
async fn people_linked(state: &AppState, author: &str, doc: &str) -> Vec<Linked> {
    let Ok(resp) =
        crate::idface::public_doc_bytes(state, &None, author, doc, false, None, None).await
    else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(bytes) = axum::body::to_bytes(resp.into_body(), MAX_WORDS).await else {
        return Vec::new();
    };
    let words = String::from_utf8_lossy(&bytes);
    let mut people = Vec::new();
    for link in crate::record::bake::doc_links(&words, "") {
        let Some(root) = crate::record::bake::linked_root(&link.to) else { continue };
        if root != author && !people.iter().any(|(r, _)| *r == root) {
            people.push((root, via_of(&link.to)));
            if people.len() >= PER_POST {
                break;
            }
        }
    }
    people
}

/// A link's `?via=` hints, as the doors take them: comma-separated, empties dropped.
fn via_of(target: &str) -> Vec<String> {
    let query = target.split('#').next().unwrap_or("").split_once('?').map_or("", |(_, q)| q);
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("via="))
        .map(|list| {
            list.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_link_s_hints() {
        use super::via_of;
        assert_eq!(via_of("/ringtome/user/x/post/y?via=a,b&bucket=z#top"), vec!["a", "b"]);
        assert_eq!(via_of("https://far.example/ringtome/user/x?bucket=z&via=c"), vec!["c"]);
        assert!(via_of("/ringtome/user/x").is_empty());
        assert!(via_of("/ringtome/user/x?via=").is_empty());
    }
}
