// Drawing thumbnails, kept (Curtis, 2026-09-27: booting the Drawing app repainted every drawing's
// thumbnail from its whole history - fills and all - on every load). The `drawthumbs` table's
// owner, as prefs.js owns `prefs`: one small picture per drawing, painted once per VERSION of it
// and kept in this browser, so a reload repaints nothing that has not changed. Since 2026-11-01 it
// keeps pictures' thumbnails too, as the node sent them in a batch (thumbs.js) - the table's name
// is a storage key, and stays.
//
// Keyed `doc_id:head`, so a drawing that moves on - an edit here, a sync from elsewhere - simply
// misses and is painted afresh, and keeping the new one drops the drawing's older ones. Bounded:
// past THUMB_CACHE_MAX the least recently used go, so a long art career costs a few megabytes, not
// a disk. Derived data only - never synced, never on a chain; losing it costs a repaint.
import { openMirror } from '../mirror.js';

/// The most thumbnails kept, per persona per browser - a few KB each, so some 35MB at most.
export const THUMB_CACHE_MAX = 5000;

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

/// The newest kept thumbnail for a drawing at whatever version was painted last, or null: what a
/// recent drawing's tile shows (mirror/recents.js), which knows the drawing but not its head.
export async function latestThumb(root, docId) {
    try {
        const kept = await openMirror(root).drawthumbs.where('doc_id').equals(docId).toArray();
        kept.sort((a, b) => (b.used || 0) - (a.used || 0));
        return kept.length ? kept[0].url : null;
    } catch {
        return null;
    }
}

/// Many kept thumbnails at once (thumbs.js): `doc_id:head` keys to data URLs, for the ones kept.
export async function cachedThumbs(root, keys) {
    const out = new Map();
    try {
        const table = openMirror(root).drawthumbs;
        const hits = (await table.bulkGet(keys)).filter(Boolean);
        for (const hit of hits) out.set(hit.key, hit.url);
        const now = Date.now();
        if (hits.length) table.bulkPut(hits.map((h) => ({ ...h, used: now }))).catch(() => {});
    } catch {
        /* a miss: fetched again */
    }
    return out;
}

/// Keep many fetched thumbnails at once, `[{ docId, head, url }]`, dropping each document's older
/// versions and, past the bound, the least recently used of the rest.
export async function rememberThumbs(root, kept) {
    if (!kept.length) return;
    try {
        const table = openMirror(root).drawthumbs;
        const keys = new Set(kept.map((k) => `${k.docId}:${k.head}`));
        await table
            .where('doc_id')
            .anyOf(kept.map((k) => k.docId))
            .and((r) => !keys.has(r.key))
            .delete();
        const now = Date.now();
        await table.bulkPut(
            kept.map((k) => ({
                key: `${k.docId}:${k.head}`,
                doc_id: k.docId,
                url: k.url,
                used: now,
            })),
        );
        const over = (await table.count()) - THUMB_CACHE_MAX;
        if (over > 0) await table.orderBy('used').limit(over).delete();
    } catch {
        /* a cache that fails to write is just a fetch later */
    }
}
