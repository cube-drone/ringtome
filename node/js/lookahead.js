// Look-ahead for pictures in a long scrolling list (Curtis, 2026-11-01: flung through hrseFiles,
// the thumbnails came in as black squares filling in behind the scroll). A list's rows are skipped
// off screen (`content-visibility: auto`), and `loading="lazy"` starts a picture only as its row is
// about to draw - so nothing was fetched ahead of the scroll. `useNear` says when a row is within
// LOOKAHEAD of its scroller's view, so its picture can start then; once near, it stays near (a
// picture fetched is the browser's to keep or drop, as with lazy loading - nothing is unloaded).
//
// A row is watched by its nearest `data-lookahead` element (the row itself, which has a box while
// skipped; anything inside it has none), against its own scroller - a scrolling column clips an
// observer rooted on the window, so a margin given there reaches nothing past the column's edge.
// One observer per scroller, shared by every row in it.
import { useEffect, useState } from 'preact/hooks';

import { scrollerOf } from './edgescroll.js';

/// How far ahead of the view, and behind it, rows count as near: two of the scroller's heights.
export const LOOKAHEAD = '200% 0px';

const watchers = new Map(); // scroller -> { watch: IntersectionObserver, heard: Map<el, Set<fn>> }

function watcherFor(box) {
    let w = watchers.get(box);
    if (w) return w;
    const heard = new Map();
    const watch = new IntersectionObserver(
        (entries) => {
            for (const e of entries) {
                if (!e.isIntersecting) continue;
                for (const fn of [...(heard.get(e.target) || [])]) fn();
            }
        },
        { root: box === document.scrollingElement ? null : box, rootMargin: LOOKAHEAD },
    );
    w = { watch, heard };
    watchers.set(box, w);
    return w;
}

/// Calls `fn` once `el`'s row comes within LOOKAHEAD of its scroller's view; returns the unwatch.
function whenNear(el, fn) {
    const row = el.closest('[data-lookahead]') || el;
    const box = scrollerOf(row.parentElement, { overflowing: false });
    const w = watcherFor(box);
    if (!w.heard.has(row)) {
        w.heard.set(row, new Set());
        w.watch.observe(row);
    }
    const fns = w.heard.get(row);
    let done = false;
    const once = () => {
        if (done) return;
        done = true;
        off();
        fn();
    };
    const off = () => {
        fns.delete(once);
        if (fns.size > 0) return;
        w.heard.delete(row);
        w.watch.unobserve(row);
        if (w.heard.size === 0) {
            w.watch.disconnect();
            watchers.delete(box);
        }
    };
    fns.add(once);
    return off;
}

/// Whether the element in `ref` has come within LOOKAHEAD of its scroller's view - true from then
/// on. `skip` (already have what it's for) watches nothing.
export function useNear(ref, skip = false) {
    const [near, setNear] = useState(false);
    useEffect(() => {
        if (near || skip) return undefined;
        const el = ref.current;
        if (!el || typeof IntersectionObserver === 'undefined') {
            setNear(true);
            return undefined;
        }
        return whenNear(el, () => setNear(true));
    }, [near, skip]); // eslint-disable-line react-hooks/exhaustive-deps
    return near;
}
