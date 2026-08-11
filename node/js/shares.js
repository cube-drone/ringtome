// What this persona currently shares, as one answer per page rather than one per card.
//
// A share button has to know whether YOU have already shared this post, and the truth lives on
// the chain - `GET /api/identity/<root>/rebroadcasts`. Two shapes were available and both are
// wrong for this:
//
//   * ask per card - forty posts on screen means forty requests for one small list;
//   * put a `shared` flag on every feed item - which fixes the feed and leaves the persona
//     page's identical card (posts.js renders the same PostEntry) still guessing.
//
// So: one fetch per persona per page, held in module scope, with a subscription so the cards
// re-render when it lands or when one of them changes it. The list is small by construction -
// it is what you have chosen to pass along, not a history of anything.
//
// NOT the mirror. The mirror is stream-fed from the node's view rows and this is not one of
// them; a table there would be a second source of truth that nothing keeps current. When
// rebroadcasts eventually join the live cache, this file becomes a `useLive` and the callers
// do not change.
import { useState, useEffect } from 'preact/hooks';

import { api } from './net.js';

/// root -> Set of "author:doc_id"
const held = new Map();
/// root -> the in-flight load, so twenty cards mounting at once make one request.
const loading = new Map();
const listeners = new Set();

const keyOf = (author, docId) => `${author}:${docId}`;

function announce() {
    for (const fn of listeners) fn();
}

async function load(root) {
    if (held.has(root)) return;
    if (loading.has(root)) return loading.get(root);
    const pending = api(`/api/identity/${root}/rebroadcasts`)
        .then((res) => {
            held.set(root, new Set((res.items || []).map((i) => keyOf(i.author, i.doc_id))));
        })
        .catch(() => {
            // An empty set, not a retry loop: the button then reads "share", which is the
            // honest default when we cannot tell - and pressing it is idempotent anyway,
            // because the chain write is LWW per (author, doc).
            held.set(root, new Set());
        })
        .finally(() => {
            loading.delete(root);
            announce();
        });
    loading.set(root, pending);
    return pending;
}

/// Whether `root` currently shares this document, and a way to say it changed.
///
/// Returns `null` while the answer is unknown, so a card can render "share" without claiming
/// the post is unshared - the two are different, and a button that flickers from "shared" to
/// "share" and back on every page load is how a reader stops trusting it.
export function useShared(root, author, docId) {
    const [, bump] = useState(0);
    useEffect(() => {
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (root) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    if (!root || !held.has(root)) return null;
    return held.get(root).has(keyOf(author, docId));
}

/// Record a share (or its withdrawal) locally, so every card showing this post agrees at once
/// without waiting for a round trip.
export function markShared(root, author, docId, shared) {
    const set = held.get(root);
    if (!set) return;
    if (shared) set.add(keyOf(author, docId));
    else set.delete(keyOf(author, docId));
    announce();
}
