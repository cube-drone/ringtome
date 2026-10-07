//! Body tags, kept (Curtis, 2026-10-07: "a server-side in-memory key-value ... keeping track of
//! dirty flags for etags: if there's no evidence an etag has changed, we can skip the SQL
//! interaction entirely"). A browser revalidates a document's body at every use, and answering
//! "not modified" meant finding the document's head first - opening the store, catching the fold
//! up, reading the head's row. This keeps each asked-about document's tag in memory, so a
//! revalidation with nothing new under it is answered from here: no SQL, no keys, no disk.
//!
//! What can make a kept tag wrong, and what says so - each at its own grain:
//!
//! - **An entry nobody has folded yet.** The fold is lazy, so an entry that arrived (by sync, by
//!   a save on another computer) leaves `doc_heads` behind until something reads. A persona's
//!   tags stand only while its `entries` write count (`db::writes_to`) is where it was when a
//!   fold last completed (`folded_at`); past it, the request takes the long way, which folds.
//! - **The fold changing a document.** `documents::refresh_doc_heads` - the one writer of a
//!   document's head row - calls `changed` with exactly the documents it rewrote, AFTER writing
//!   them. Each document carries a version; a tag computed against an older version is refused
//!   at `keep`, so a computation that raced a fold can't put a stale tag back. Every other
//!   document's tag stands.
//! - **The whole view rebuilt** (`documents::clear_view`): `cleared` drops the persona's tags and
//!   refuses anything stamped before it.
//!
//! A stamp is taken before the long way reads anything (`stamp`), and carried to `keep`.
//! In memory only, and bounded: past `TAGS_MAX` documents everything is dropped and refilled by
//! use, and anything stamped before that is refused.
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

/// A private body's tag: which version is served (its head entry), and its bytes' hash (the ETag).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BodyTag {
    pub head: [u8; 32],
    pub file_hash: [u8; 32],
}

#[derive(Default)]
struct Doc {
    version: u64,
    tag: Option<BodyTag>,
}

#[derive(Default)]
struct Persona {
    /// The persona's `entries` count stamped before the latest fold that completed.
    folded_at: Option<u64>,
    /// How many times the whole view was cleared.
    cleared: u64,
    docs: HashMap<[u8; 16], Doc>,
}

#[derive(Default)]
struct Tags {
    /// How many times everything was dropped for size.
    emptied: u64,
    count: usize,
    personas: HashMap<String, Persona>,
}

static TAGS: LazyLock<Mutex<Tags>> = LazyLock::new(|| Mutex::new(Tags::default()));

/// The most documents kept across every persona (a few hundred bytes each).
pub const TAGS_MAX: usize = 200_000;

/// What the long way carries from before it reads to `keep`.
#[derive(Clone, Copy, Debug)]
pub struct Stamp {
    entries: u64,
    version: u64,
    cleared: u64,
    emptied: u64,
}

fn lock() -> std::sync::MutexGuard<'static, Tags> {
    TAGS.lock().expect("body tags poisoned")
}

/// The kept tag for a persona's document, when nothing has moved under it.
pub fn kept(root: &str, doc: &[u8; 16]) -> Option<BodyTag> {
    let entries = crate::db::writes_to(root, "entries");
    let tags = lock();
    let persona = tags.personas.get(root)?;
    if persona.folded_at != Some(entries) {
        return None;
    }
    persona.docs.get(doc)?.tag
}

/// Stamp a document before the long way reads it. Takes the document's place in the map, so a
/// fold that rewrites it while the long way runs is seen at `keep`.
pub fn stamp(root: &str, doc: &[u8; 16]) -> Stamp {
    let entries = crate::db::writes_to(root, "entries");
    let mut tags = lock();
    if tags.count >= TAGS_MAX {
        tags.personas.clear();
        tags.count = 0;
        tags.emptied += 1;
    }
    let emptied = tags.emptied;
    let mut added = false;
    let persona = tags.personas.entry(root.to_string()).or_default();
    let cleared = persona.cleared;
    let version = persona
        .docs
        .entry(*doc)
        .or_insert_with(|| {
            added = true;
            Doc::default()
        })
        .version;
    if added {
        tags.count += 1;
    }
    Stamp { entries, version, cleared, emptied }
}

/// Keep what the long way found, which folded first: the tag, if the document hasn't been
/// rewritten since `stamp`; and the persona's fold mark, which only ever rises.
pub fn keep(root: &str, doc: &[u8; 16], stamp: Stamp, tag: BodyTag) {
    let mut tags = lock();
    if tags.emptied != stamp.emptied {
        return;
    }
    let Some(persona) = tags.personas.get_mut(root) else { return };
    if persona.cleared != stamp.cleared {
        return;
    }
    if persona.folded_at.is_none_or(|at| at < stamp.entries) {
        persona.folded_at = Some(stamp.entries);
    }
    if let Some(d) = persona.docs.get_mut(doc) {
        if d.version == stamp.version {
            d.tag = Some(tag);
        }
    }
}

/// The fold rewrote these documents' head rows - call AFTER the rows are written.
pub fn changed<'a>(root: Option<&str>, docs: impl IntoIterator<Item = &'a [u8; 16]>) {
    let Some(root) = root else { return };
    let mut tags = lock();
    let Some(persona) = tags.personas.get_mut(root) else { return };
    for doc in docs {
        if let Some(d) = persona.docs.get_mut(doc) {
            d.version += 1;
            d.tag = None;
        }
    }
}

/// The persona's whole document view was dropped.
pub fn cleared(root: Option<&str>) {
    let Some(root) = root else { return };
    let mut tags = lock();
    let dropped = match tags.personas.get_mut(root) {
        Some(persona) => {
            persona.cleared += 1;
            persona.folded_at = None;
            std::mem::take(&mut persona.docs).len()
        }
        None => 0,
    };
    tags.count -= dropped;
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAG: BodyTag = BodyTag { head: [1; 32], file_hash: [2; 32] };
    const NEWER: BodyTag = BodyTag { head: [3; 32], file_hash: [4; 32] };

    /// Each test its own persona: the map is the process's.
    fn persona(n: u8) -> String {
        format!("{:064x}", u64::from(n) + 0xbeef_0000)
    }

    #[test]
    fn a_kept_tag_stands_until_something_moves_under_it() {
        let root = persona(1);
        let doc = [7; 16];
        assert_eq!(kept(&root, &doc), None, "nothing kept yet");
        let s = stamp(&root, &doc);
        keep(&root, &doc, s, TAG);
        assert_eq!(kept(&root, &doc), Some(TAG));
        // A rewrite of ANOTHER document leaves this one standing.
        changed(Some(&root), &[[8; 16]]);
        assert_eq!(kept(&root, &doc), Some(TAG));
        // Its own rewrite does not.
        changed(Some(&root), &[doc]);
        assert_eq!(kept(&root, &doc), None);
    }

    #[test]
    fn a_tag_computed_across_a_rewrite_is_refused() {
        let root = persona(2);
        let doc = [7; 16];
        let s = stamp(&root, &doc);
        changed(Some(&root), &[doc]); // the fold rewrote it while the long way ran
        keep(&root, &doc, s, TAG);
        assert_eq!(kept(&root, &doc), None, "the old answer is not kept");
        let s = stamp(&root, &doc);
        keep(&root, &doc, s, NEWER);
        assert_eq!(kept(&root, &doc), Some(NEWER), "the next one is");
    }

    #[test]
    fn a_cleared_view_drops_everything_and_refuses_what_was_in_flight() {
        let root = persona(3);
        let (a, b) = ([1; 16], [2; 16]);
        let s = stamp(&root, &a);
        keep(&root, &a, s, TAG);
        let in_flight = stamp(&root, &b);
        cleared(Some(&root));
        assert_eq!(kept(&root, &a), None);
        keep(&root, &b, in_flight, TAG);
        assert_eq!(kept(&root, &b), None);
    }
}
