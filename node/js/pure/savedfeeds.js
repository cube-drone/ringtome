// Saved feeds (Curtis, 2026-10-11): a pile of the feed's filters - its picks, its curiosity, its
// order and its search words (2026-10-12) - kept under a name, to come back to with one press. They live on the persona's private
// chain (`feed_filters`, one register each, keyed by a random id), so they follow the person to
// every computer they're on; a register emptied is one deleted. Pure: what a saved feed is, read
// back, and whether the feed on screen is one.

/// The private register collection the saved feeds live in.
export const SAVED_FEEDS = 'feed_filters';

const ROWS = ['kinds', 'buckets', 'tags', 'authors', 'groups'];
const OUT = ['notKinds', 'notBuckets', 'notTags', 'notAuthors', 'notGroups'];

/// Picks in one canonical shape: every row sorted, empties kept, `me` only when set - so two piles
/// that narrow the same way compare equal however they were picked.
export function canonicalPicks(picks) {
    const p = picks || {};
    const out = {};
    for (const row of [...ROWS, ...OUT]) out[row] = [...(p[row] || [])].sort();
    if (p.me === 'only' || p.me === false) out.me = p.me;
    return out;
}

/// The header's search words as a filter keeps them: trimmed, and none as null.
export const searchWords = (q) => (q && q.trim()) || null;

/// What a saved feed holds, from the feed's settings now.
export const feedSettings = (picks, stop, sort, q = null) => ({
    picks: canonicalPicks(picks),
    stop: stop || null,
    sort: sort || null,
    q: searchWords(q),
});

/// Is the feed on screen `saved`? Picks, curiosity, order and search words alike.
export const sameFeed = (saved, now) =>
    !!saved &&
    !!now &&
    JSON.stringify(canonicalPicks(saved.picks)) === JSON.stringify(canonicalPicks(now.picks)) &&
    (saved.stop || null) === (now.stop || null) &&
    (saved.sort || null) === (now.sort || null) &&
    searchWords(saved.q) === searchWords(now.q);

/// The saved feeds out of the collection's registers (`{key, value}`), by name: what doesn't parse,
/// or was emptied (deleted), is left out.
export function readSaved(values) {
    const out = [];
    for (const { key, value } of values || []) {
        if (!value || !value.trim()) continue;
        try {
            const v = JSON.parse(value);
            if (!v || typeof v.name !== 'string' || !v.name.trim()) continue;
            out.push({
                id: key,
                name: v.name.trim(),
                ...feedSettings(v.picks, v.stop, v.sort, v.q),
            });
        } catch {
            /* not one of ours: passed over */
        }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/// A register's value for a feed saved as `name`.
export const savedValue = (name, settings) => JSON.stringify({ name: name.trim(), ...settings });
