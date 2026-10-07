// Kept answers (Curtis, 2026-10-07: "places where we should just be keeping things ... for long
// periods of time, and aren't"). Three GET answers the mirror's stream does not carry, kept in this
// browser so the next visit shows something at once and the node's answer replaces it when it
// lands - the owner of the `strangers`, `feedpages` and `floors` tables, as thumbcache.js owns
// `drawthumbs`:
//
//   - `strangers`: the profile of someone with no ledger row (a sharer, a replier, a voice in a
//     room), by root, with when it was fetched. Shown at once; asked again only past
//     PROFILE_FRESH_MS (pure/keep.js) - it is the one of the three that saves the node work.
//   - `feedpages`: a feed road's first page, keyed by the exact address it was asked at, so a
//     different order, window or "me" choice is its own entry.
//   - `floors`: a room's newest page of chat, keyed `root/author/doc`. Always asked again: edits
//     and deletes of older lines would slip past any "only what's newer" question, so the kept
//     page is a first paint, never a substitute.
//
// Derived data only - never synced, never on a chain; losing any of it costs a fetch. Every
// table is bounded: past its limit the least recently used go. A failure to read or write is a
// miss, never an error.
import { openMirror } from '../mirror.js';

/// The most kept, per persona per browser.
export const STRANGERS_MAX = 2000;
export const FEED_PAGES_MAX = 40;
export const FLOORS_MAX = 200;

/// A stranger's kept profile, `{ profile, at }`, or null.
export async function keptStranger(myRoot, root) {
    try {
        return (await openMirror(myRoot).strangers.get(root)) || null;
    } catch {
        return null;
    }
}

/// Keep a stranger's profile as just fetched.
export async function keepStranger(myRoot, root, profile) {
    try {
        const table = openMirror(myRoot).strangers;
        await table.put({ root, profile, at: Date.now() });
        const over = (await table.count()) - STRANGERS_MAX;
        if (over > 0) await table.orderBy('at').limit(over).delete();
    } catch {
        /* a profile not kept is asked again next time */
    }
}

const kept = async (root, name, key) => {
    try {
        const table = openMirror(root)[name];
        const hit = await table.get(key);
        if (!hit) return null;
        table.update(key, { used: Date.now() }).catch(() => {}); // recently used: kept longest
        return hit.value;
    } catch {
        return null;
    }
};

const keep = async (root, name, key, value, max) => {
    try {
        const table = openMirror(root)[name];
        await table.put({ key, value, used: Date.now() });
        const over = (await table.count()) - max;
        if (over > 0) await table.orderBy('used').limit(over).delete();
    } catch {
        /* a page not kept is fetched again next time */
    }
};

/// A feed road's kept first page (`{ items, more, after }`), or null.
export const keptFeedPage = (root, address) => kept(root, 'feedpages', address);
/// Keep a feed road's first page, as the node just answered it.
export const keepFeedPage = (root, address, page) =>
    keep(root, 'feedpages', address, page, FEED_PAGES_MAX);

/// A room's kept newest page of chat, or null.
export const keptFloor = (root, key) => kept(root, 'floors', key);
/// Keep a room's newest page of chat, as the node just answered it.
export const keepFloor = (root, key, page) => keep(root, 'floors', key, page, FLOORS_MAX);
