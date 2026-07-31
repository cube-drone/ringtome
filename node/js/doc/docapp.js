// What makes something a documents app: its documents, which one is open, where it resumes, and
// how you walk between them. TurboNotes/Recipes (apps/notes.js) and the Wikibook (apps/wiki.js)
// both ran this spine, in ~80 lines of plumbing that had drifted into two slightly different
// copies - one of them missing the unbucketed catch-all. The renders stay in the apps, which is
// the point: they are honestly different surfaces over the same skeleton.
//
// Two hooks, in that order, because the second needs what the first returns: an app computes its
// own document ORDER out of `docs` (the list's time order, or the tree read as a book), so the
// order cannot be an input to the spine - it is an output of the app.
import { useState, useEffect, useRef } from 'preact/hooks';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from '../mirror.js';
import { bucketHolds } from '../pure/apps.js';
import { useSlugDocId, useCozyAddress } from './address.js';

// The document each app last had open, keyed `${root}:${app.id}`. In-memory on purpose: a session
// convenience, like a scroll position, forgotten on reload - the same weight as the shell's
// last-open BUCKET memory and the editor's per-document caret.
const lastDocMemory = new Map();

/**
 * The spine. Returns the app's live documents, the open document and how to change it, and the
 * tree-reload bump.
 *
 * - `selected` lives in the URL (`/home/<app>/<doc_id>`), not local state, so back/forward and deep
 *   links just work; a non-hex segment is a cozy slug, resolved in place without redirecting, and a
 *   hex URL dresses itself in the document's cozy address (doc/address.js).
 * - RESUME is a one-time, on-open jump: entering the app with nothing selected returns you to the
 *   document you last had open, if the current notebook still holds it. Deliberately going back to
 *   the list later never bounces you in again (the `restored` ref), and the redirect REPLACES
 *   history so Back still exits to the launcher. It waits for the mirror before deciding, by which
 *   point the shell has restored the remembered bucket - so membership is judged against the right
 *   notebook.
 * - `bumpTree` exists because deleting a document never touches the taxonomy roster, so the tree
 *   pane has no way to notice on its own.
 */
export function useDocApp(root, app, docId, bucket) {
    const loc = useLocation();
    const docs = useLive(() => openMirror(root).docs.toArray(), [root]);

    const selected = useSlugDocId(root, app.id, docId);
    const select = (id) => loc.route(id ? `/home/${app.id}/${id}` : `/home/${app.id}`);
    // The everything-view's URLs stay in their own /all namespace, never re-dressed into a
    // cozy bucket address: one document shows in many places, but an /all link must keep
    // meaning "the everything-view", not whichever official home the re-dress would pick.
    useCozyAddress(root, app.everything ? null : selected, bucket);

    const restored = useRef(false);
    useEffect(() => {
        if (selected) lastDocMemory.set(`${root}:${app.id}`, selected);
    }, [selected, root, app.id]);
    useEffect(() => {
        if (restored.current || !docs) return; // wait for the mirror, then decide exactly once
        restored.current = true;
        if (selected) return; // already on a document - nothing to restore
        const last = lastDocMemory.get(`${root}:${app.id}`);
        if (last && docs.some((d) => d.doc_id === last && bucketHolds(d, app, bucket))) {
            loc.route(`/home/${app.id}/${last}`, true);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docs, selected]);

    const [treeReload, setTreeReload] = useState(0);
    return { docs, selected, select, treeReload, bumpTree: () => setTreeReload((k) => k + 1) };
}

/**
 * Walking between documents: the prev/next pair the chips render, plus the arrow keys. Null when
 * there is nowhere to go - fewer than two documents, or the open one isn't in this order.
 *
 * @param order  the doc_ids to walk, in reading order (the list's time order, or the tree as a book)
 * @param tips   `{ prev, next }` tooltips - what "previous" MEANS differs per order, so the app says
 */
export function useDocNav(order, selected, select, tips = {}) {
    const ids = order || [];
    const at = selected ? ids.indexOf(selected) : -1;
    const nav =
        at !== -1 && ids.length > 1
            ? {
                  prev: at > 0 ? ids[at - 1] : null,
                  next: at < ids.length - 1 ? ids[at + 1] : null,
                  go: select,
                  prevTip: tips.prev || 'the previous document',
                  nextTip: tips.next || 'the next document',
              }
            : null;
    useArrowNav(nav, ids, selected, select);
    return nav;
}

/// Left/right ARROW KEYS walk the prev/next order - but only while the keyboard is FREE: no input,
/// textarea, select, or editor focused, no modifier held. While typing, arrows move the caret, never
/// the page. With no document selected, right opens the order's first document and left its last -
/// the book falls open at either cover.
export function useArrowNav(nav, order, selected, select) {
    useEffect(() => {
        const onKey = (e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
            const t = e.target;
            const tag = t && t.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (t && t.closest && t.closest('.cm-editor, [contenteditable="true"]')) return;
            if (selected) {
                if (!nav) return;
                const to = e.key === 'ArrowLeft' ? nav.prev : nav.next;
                if (to) {
                    e.preventDefault();
                    nav.go(to);
                }
            } else if (order && order.length) {
                e.preventDefault();
                select(e.key === 'ArrowRight' ? order[0] : order[order.length - 1]);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [nav, order, selected, select]);
}
