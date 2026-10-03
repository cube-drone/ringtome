// Drawing thumbnails, kept (Curtis, 2026-09-27: booting the Drawing app repainted every drawing's
// thumbnail from its whole history - fills and all - on every load). The `drawthumbs` table's
// owner, as prefs.js owns `prefs`: one small picture per drawing, painted once per VERSION of it
// and kept in this browser, so a reload repaints nothing that has not changed.
//
// Keyed `doc_id:head`, so a drawing that moves on - an edit here, a sync from elsewhere - simply
// misses and is painted afresh, and keeping the new one drops the drawing's older ones. Bounded:
// past THUMB_CACHE_MAX the least recently used go, so a long art career costs a few megabytes, not
// a disk. Derived data only - never synced, never on a chain; losing it costs a repaint.
import { openMirror } from '../mirror.js';

/// The most thumbnails kept, per persona per browser - a few KB each.
export const THUMB_CACHE_MAX = 3000;

/// The kept thumbnail (a data URL) for a drawing at a version, or null.
export async function cachedThumb(root, docId, head) {
    try {
        const table = openMirror(root).drawthumbs;
        const hit = await table.get(`${docId}:${head}`);
        if (!hit) return null;
        table.update(hit.key, { used: Date.now() }).catch(() => {}); // recently used: kept longest
        return hit.url;
    } catch {
        return null;
    }
}

/// Keep a freshly painted thumbnail, dropping the drawing's older versions and, past the bound, the
/// least recently used of the rest.
export async function rememberThumb(root, docId, head, url) {
    try {
        const table = openMirror(root).drawthumbs;
        const key = `${docId}:${head}`;
        await table
            .where('doc_id')
            .equals(docId)
            .and((r) => r.key !== key)
            .delete();
        await table.put({ key, doc_id: docId, url, used: Date.now() });
        const over = (await table.count()) - THUMB_CACHE_MAX;
        if (over > 0) await table.orderBy('used').limit(over).delete();
    } catch {
        /* a cache that fails to write is just a repaint later */
    }
}
