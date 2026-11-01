// Pictures' thumbnails, many at a time (Curtis, 2026-11-01: scrolled briskly, a long list of
// pictures out-asked the browser - six requests at once to a host, a round trip each, some 75
// thumbnails a second where a scroll uncovers 190). A row asks `thumbFor` once it comes near
// (lookahead.js); everything asked in the same frame is answered together - first from this
// browser's kept table (mirror/thumbcache.js) in one read, then the rest from the node in one
// `POST /docs/thumbs` per THUMBS_BATCH - and what the node sends is kept, so the next visit asks
// it for nothing. A recent few hundred are also held in memory, so a row scrolled back to shows its
// picture in the frame it draws.
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { api } from './net.js';
import { cachedThumbs, rememberThumbs } from './mirror/thumbcache.js';
import { useNear } from './lookahead.js';

/// The most one request asks for: the node's own limit (`THUMBS_MAX`, identity/routes.rs).
export const THUMBS_BATCH = 100;
/// How many data URLs are held in memory, most recently asked kept longest.
const HELD_MAX = 600;

const held = new Map(); // `root|doc_id:head` -> data URL, in order of use
const asked = new Map(); // `root|doc_id:head` -> { docId, head, waiters: [fn] }
let flushing = false;

const heldKey = (root, docId, head) => `${root}|${docId}:${head}`;

function hold(key, url) {
    held.delete(key);
    held.set(key, url);
    if (held.size > HELD_MAX) held.delete(held.keys().next().value);
}

/// A thumbnail already in memory, or undefined.
export function heldThumb(root, docId, head) {
    const key = heldKey(root, docId, head);
    const url = held.get(key);
    if (url) hold(key, url);
    return url;
}

/// A document's thumbnail as a data URL, or null when the node has none for it (yet). Asked in the
/// same frame as others, it's fetched with them.
export function thumbFor(root, docId, head) {
    const key = heldKey(root, docId, head);
    const url = held.get(key);
    if (url) return Promise.resolve(url);
    return new Promise((resolve) => {
        const want = asked.get(key) || { root, docId, head, waiters: [] };
        want.waiters.push(resolve);
        asked.set(key, want);
        if (!flushing) {
            flushing = true;
            requestAnimationFrame(flush);
        }
    });
}

async function flush() {
    flushing = false;
    const wants = [...asked.values()];
    asked.clear();
    const byRoot = new Map();
    for (const w of wants) byRoot.set(w.root, [...(byRoot.get(w.root) || []), w]);
    await Promise.all([...byRoot].map(([root, list]) => answer(root, list)));
}

async function answer(root, wants) {
    const settle = (w, url) => {
        if (url) hold(heldKey(root, w.docId, w.head), url);
        for (const fn of w.waiters) fn(url || null);
    };
    const kept = await cachedThumbs(
        root,
        wants.map((w) => `${w.docId}:${w.head}`),
    );
    const rest = [];
    for (const w of wants) {
        const url = kept.get(`${w.docId}:${w.head}`);
        if (url) settle(w, url);
        else rest.push(w);
    }
    for (let i = 0; i < rest.length; i += THUMBS_BATCH) {
        const some = rest.slice(i, i + THUMBS_BATCH);
        let sent = { thumbs: [] };
        try {
            sent = await api(`/api/identity/${root}/docs/thumbs`, {
                method: 'POST',
                body: JSON.stringify({ ids: some.map((w) => w.docId) }),
            });
        } catch {
            /* none this time: the rows show no picture, and ask again when drawn afresh */
        }
        const got = new Map(
            (sent.thumbs || []).map((t) => [t.doc_id, `data:${t.type};base64,${t.data}`]),
        );
        const fresh = [];
        for (const w of some) {
            const url = got.get(w.docId);
            if (url) fresh.push({ docId: w.docId, head: w.head, url });
            settle(w, url);
        }
        rememberThumbs(root, fresh);
    }
}

/// A document's thumbnail, once its row is near (lookahead.js; the row carries `data-lookahead`):
/// at once when it's held in memory, else as the batch it joins is answered. Nothing at all where
/// the node has none - no broken-image glyph. Its other props are the img's.
export const ThumbImg = ({ root, docId, head, ...rest }) => {
    const [url, setUrl] = useState(() => heldThumb(root, docId, head) || null);
    const [none, setNone] = useState(false);
    const ref = useRef(null);
    const near = useNear(ref, !!url);
    useEffect(() => {
        const now = heldThumb(root, docId, head);
        setUrl(now || null);
        setNone(false);
    }, [root, docId, head]);
    useEffect(() => {
        if (!near || url || none) return undefined;
        let live = true;
        thumbFor(root, docId, head).then((got) => {
            if (!live) return;
            if (got) setUrl(got);
            else setNone(true);
        });
        return () => {
            live = false;
        };
    }, [near, url, none, root, docId, head]);
    if (none) return null;
    return h('img', { ref, src: url || undefined, decoding: 'async', alt: '', ...rest });
};
