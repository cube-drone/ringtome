// The `prefs` table's owner: every local-only UI preference in the mirror, its key vocabulary,
// and the three ways to read one. STYLE.md's "a table has one owner" rule - no other module names
// `prefs`, the same way no other module writes raw SQL against a Rust-side table.
//
// It earned an owner: five files were building keys by hand and taking them apart again with
// `split(':')[2]` and `slice(5)` (a magic number for `'seal:'.length`), and the value domains -
// '1'/'0' here, 'open'/'locked' there, a pixel count somewhere else - were written down nowhere.
// Each family below states its own domain, which is the documentation that was missing.
//
// Prefs are local, durable, and live across the tabs of one browser (Dexie's liveQuery observes
// IndexedDB cross-tab), never synced to the node. That is the right weight for "this column is
// tucked away" or "this page is closed": a personal, per-device gesture, not a document fact.
// They share the mirror's lifetime, so "forget this browser" (logout) forgets them too - the
// right posture for a table that records which documents you touch. Incidental working state that
// is NOT a choice stays out: the per-document cursor lives in a module Map in doc/editor.js, because
// two tabs on one document would clobber each other's caret and a stale one is just noise.
import { useState, useEffect, useMemo } from 'preact/hooks';

import { openMirror, useLive } from '../mirror.js';

// --- the key vocabulary ---
// Families are `<prefix>:<member>` (some scoped by app first); a read hands back the member as
// its map key, so nothing downstream slices strings. Singletons are whole keys.

/// Column tuck state, per app: is this column minimized to a rail? Domain: '1' | '0'.
export const tuckKey = (appId, col) => `col:${appId}:${col}`;
export const tuckPrefix = (appId) => `col:${appId}:`;

/// Column widths, per app. Domain: a CSS pixel count as a decimal string.
export const widthKey = (appId, col) => `colw:${appId}:${col}`;
export const widthPrefix = (appId) => `colw:${appId}:`;

/// Tree section folds, by taxonomy id. Domain: '1' (folded) | '0'.
export const foldKey = (taxonomyId) => `wikifold:${taxonomyId}`;
export const FOLD_PREFIX = 'wikifold:';

/// Journal seal overrides, by doc id. Domain: 'open' | 'locked'; ABSENT means "follow the day",
/// which is why this family is read as a map of what's present, never as a set of flags.
export const sealKey = (docId) => `seal:${docId}`;
export const SEAL_PREFIX = 'seal:';

/// A document's remembered editor view mode. Domain: a key of doc/editor.js's `MODES`.
export const viewModeKey = (docId) => `mode:${docId}`;

/// The journal's page font. Domain: a `FONTS` id from apps/journal.js.
export const JOURNAL_FONT = 'journal:font';

// --- reading ---

/**
 * A whole family, live: a Map of member (the key past `prefix`) to its stored value.
 * `undefined` until the first result, exactly like `useLive` - a caller that must not judge
 * before the prefs land (the tree's reveal-the-selection pass) tests for it.
 */
export function usePrefMap(root, prefix) {
    const rows = useLive(
        () => openMirror(root).prefs.where('key').startsWith(prefix).toArray(),
        [root, prefix]
    );
    return useMemo(
        () => (rows === undefined ? undefined : new Map(rows.map((r) => [r.key.slice(prefix.length), r.value]))),
        [rows, prefix]
    );
}

/// The members of a '1'/'0' family that are ON, as a Set. Safe on the loading `undefined`, so a
/// caller for whom "not loaded yet" and "none set" mean the same thing needs no guard.
export const flagsOf = (map) =>
    new Set([...(map || new Map())].filter(([, value]) => value === '1').map(([member]) => member));

/**
 * One singleton pref, live, with the click landing instantly: returns `[value, set]`, where
 * `value` is a local optimistic pick until the write echoes back through the live query and then
 * the stored value again - so a change made in another tab can take over afterwards, and no
 * interaction waits on a Dexie round-trip.
 *
 * Read as `.where('key').equals(key)` rather than the more obvious `.get(key)`: the equals-form
 * re-fires reliably under liveQuery (field-found in the journal's font picker, 2026-07-28) and
 * this hook is the one place that has to know it.
 */
export function usePref(root, key, fallback) {
    const rows = useLive(
        () => openMirror(root).prefs.where('key').equals(key).toArray(),
        [root, key]
    );
    const stored = rows && rows[0] && rows[0].value;
    const [pick, setPick] = useState(null);
    useEffect(() => {
        if (pick && stored === pick) setPick(null); // echo arrived: defer to the stream again
    }, [stored, pick]);
    const set = (value) => {
        setPick(value);
        setPref(root, key, value);
    };
    return [pick || stored || fallback, set];
}

/// One pref, once - for a surface that hydrates a local buffer instead of following the value
/// (doc/editor.js's view mode: a pick that beats the read must win, so it reads rather than watches).
/// Resolves to the stored string, or null if unset or unreadable.
export async function readPref(root, key) {
    try {
        const row = await openMirror(root).prefs.get(key);
        return (row && row.value) || null;
    } catch {
        return null; // a mirror that can't answer just means the default stands
    }
}

// --- writing ---
// Fire-and-forget by design: every pref is a preference, so a failed write costs the user a
// re-click, never data. Nothing here awaits, so a click never blocks on IndexedDB.

/// Store one pref.
export function setPref(root, key, value) {
    openMirror(root).prefs.put({ key, value }).catch(() => {});
}

/// Store one '1'/'0' flag.
export function setFlag(root, key, on) {
    setPref(root, key, on ? '1' : '0');
}
