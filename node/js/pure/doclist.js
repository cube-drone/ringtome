// Which documents a documents app shows, and in what order. The filters STACK, and the order they
// stack in is the design: this app's notebook scope, then the search hits, then every active tag -
// so search narrows the current view rather than replacing it with a separate ranked screen, and a
// tag narrows that again.
import { bucketHolds } from './apps.js';
import { claimedMs } from './docdate.js';

/**
 * @param app    the app registry entry, which decides what its bucket holds
 * @param bucket the notebook on screen
 * @param hits   a Set of matching doc_ids, or null for "not searching" - null and an EMPTY set mean
 *               opposite things (no filter vs no results), which is why this isn't a plain array
 * @param tags   active tag filters, ANDed: a document must carry every one
 */
export function orderDocs(docs, { app, bucket, hits, tags } = {}) {
    return (docs || [])
        .filter((d) => bucketHolds(d, app, bucket))
        .filter((d) => !hits || hits.has(d.doc_id))
        .filter((d) => (tags || []).every((t) => (d.tags || []).includes(t)))
        .sort(byPinnedThenClaimed);
}

/// Pinned documents float to the top (a doc-meta flag), then newest by CLAIMED date - a document's
/// own `display_date` if it set one, else its real last-updated stamp, so a note backdated to 2015
/// files itself under 2015 rather than the day it was typed. Ties break on id, descending, only so
/// that the order is stable across renders and computers.
export const byPinnedThenClaimed = (a, b) =>
    (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) ||
    claimedMs(b) - claimedMs(a) ||
    (a.doc_id < b.doc_id ? 1 : -1);

/// The tag cloud: every tag across these documents, most-used first, ties alphabetical. Counted over
/// whatever list it is given - the caller passes the SEARCH results rather than the tag-filtered
/// ones, so the cloud narrows with a query but still shows every tag you could add.
export function tagCounts(docs) {
    const counts = new Map();
    for (const d of docs || []) {
        for (const t of d.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}
