// A notebook's recently opened documents (Curtis, 2026-11-25: "a third tab, next to 'chronological'
// and 'tree' - 'recent', containing recently opened documents in this notebook, with the most
// recently opened document at the top - just saved in browser memory, not synced anywhere").
//
// Kept as one pref per app and notebook (mirror/prefs.js `recentKey`): the documents' ids, newest
// first, space-separated. A pref because it is exactly what that table is for - a personal,
// per-browser gesture, live across this browser's tabs, never synced, forgotten with the browser at
// logout. Not plans/RECENTS.md's recents, which are what you made (saved, said, published) and sit
// on the dock; these are what you opened, and sit in one notebook's list.

/// How many a notebook remembers. More than a list column shows without scrolling, few enough that
/// the pref stays a short string.
export const RECENT_OPENS_KEPT = 50;

/// The stored list with `docId` opened just now: moved to the front if it was there, added if not,
/// and the oldest let go past the cap. `stored` is the pref's value - a string, or nothing yet.
export function noteOpened(stored, docId, kept = RECENT_OPENS_KEPT) {
    const ids = (stored || '').split(' ').filter((id) => id && id !== docId);
    return [docId, ...ids].slice(0, kept).join(' ');
}

/// The documents in the order they were last opened, newest first: only those `docs` holds - so a
/// document deleted, moved to another notebook, or narrowed away by a search or a tag drops out - and
/// only those opened here at all.
export function recentlyOpened(stored, docs) {
    const byId = new Map((docs || []).map((d) => [d.doc_id, d]));
    return (stored || '')
        .split(' ')
        .filter(Boolean)
        .map((id) => byId.get(id))
        .filter(Boolean);
}
