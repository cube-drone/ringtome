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
import { groupFeeds } from './pure/groups.js';

/// root -> Set of "author:doc_id"
const held = new Map();
/// root -> Map of "author:doc_id" -> Set of the groups it is shared into (plans/GROUPS.md,
/// section 7), from the same answer.
const heldIn = new Map();
/// root -> the groups a share could go to: every group you're a member of, as `groupFeeds` lists
/// them - asked once per page, beside the shares.
const places = new Map();
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
    const pending = Promise.all([
        api(`/api/identity/${root}/rebroadcasts`),
        api(`/api/identity/${root}/groups`).catch(() => []),
    ])
        .then(([res, groups]) => {
            held.set(root, new Set((res.items || []).map((i) => keyOf(i.author, i.doc_id))));
            const into = new Map();
            for (const g of res.groups || []) {
                const key = keyOf(g.author, g.doc_id);
                if (!into.has(key)) into.set(key, new Set());
                into.get(key).add(g.group);
            }
            heldIn.set(root, into);
            places.set(root, groupFeeds(groups));
        })
        .catch(() => {
            // An empty set, not a retry loop: the button then reads "share", which is the
            // honest default when we cannot tell - and pressing it is idempotent anyway,
            // because the chain write is LWW per (author, doc).
            held.set(root, new Set());
            heldIn.set(root, new Map());
            places.set(root, []);
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

/// Where `root` shares this document beyond everyone - the groups it is in - and where else it
/// could: `{ into: Set of group ids, groups: [{group, name}] }`, or `null` while unknown. A post
/// of a group's own is never offered back to it (`except`).
export function useSharedIn(root, author, docId, except = null) {
    const [, bump] = useState(0);
    useEffect(() => {
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (root) load(root);
        return () => listeners.delete(fn);
    }, [root]);
    if (!root || !heldIn.has(root)) return null;
    return {
        into: heldIn.get(root).get(keyOf(author, docId)) || new Set(),
        groups: (places.get(root) || []).filter((g) => g.group !== except),
    };
}

/// Record a share into a group (or its withdrawal) locally, as `markShared` does for everyone.
export function markSharedIn(root, author, docId, group, shared) {
    const into = heldIn.get(root);
    if (!into) return;
    const key = keyOf(author, docId);
    if (!into.has(key)) into.set(key, new Set());
    if (shared) into.get(key).add(group);
    else into.get(key).delete(group);
    announce();
}
