// OPTIMISTIC ROWS (Curtis, 2026-10-01: "the model of 'do something, then wait for the server to
// respond to show it' is going to be a worse UI experience than updating the local state and then
// reconciling it when the server catches up"). A write states its effect on the mirror's `docs` row
// at once - every reader of the mirror sees it, with nothing of theirs changed - and the stream then
// settles it:
//
//   - each frame that carries the doc: if the server's row already says what the write said
//     (`settled`), the overlay is done and the row is the server's; if not - a frame built before
//     the write landed - the overlay is laid back over the server's newer row (`make` of it);
//   - the request fails: the server's last row comes back, and the caller says why;
//   - no echo within HOLD_MS of the start: the overlay goes, and the server's row stands. The mirror
//     is never the truth; this only keeps it ahead of the stream for a moment;
//   - a page closed mid-write leaves a marked row behind (`_optimistic` holds the server's row it
//     covers): the next start puts that back (`healOptimistic`), and the stream says the rest.
//
// The doc rows only, today: the table a click most often waits on (a new note, a publish, a
// delete, a pin, a title). The engine takes the mirror's handle (`db`) rather than opening it:
// mirror.js owns the handle, and hands callers `holdDoc`, `optimisticDoc` and `holdNewDoc` with it
// bound - so the import graph keeps one direction.

const HOLD_MS = 120_000;

/// The overlays in flight, per persona: doc_id -> { make, settled, base, timer }.
const held = new Map();
const holdsOf = (root) => {
    let m = held.get(root);
    if (!m) held.set(root, (m = new Map()));
    return m;
};

/// A row as the server sent it: the marker stripped off.
const bare = (row) => {
    if (!row || !row._optimistic) return row;
    const { _optimistic: _, ...rest } = row;
    return rest;
};

/// Lay `make(base)` over the doc - its row put marked, or the row deleted when `make` says null.
async function lay(table, docId, make, base) {
    const next = make(base);
    if (next) await table.put({ ...next, doc_id: docId, _optimistic: { base: base || null } });
    else await table.delete(docId);
}

/// Put the server's row back: the overlay withdrawn.
async function restore(table, docId, base) {
    if (base) await table.put(base);
    else await table.delete(docId);
}

/// State a write's effect on one doc row now. `make(serverRow | undefined)` is the row the write
/// will leave (null for gone); `settled(serverRow | undefined)` says whether the server's row has
/// caught up. Returns `{ revert }` - call it if the write failed.
export async function holdDoc(db, root, docId, make, settled) {
    const holds = holdsOf(root);
    const previous = holds.get(docId);
    const base = previous ? previous.base : bare(await db.docs.get(docId));
    if (previous) clearTimeout(previous.timer);
    const entry = { make, settled, base };
    entry.timer = setTimeout(() => {
        if (holds.get(docId) !== entry) return;
        holds.delete(docId);
        restore(db.docs, docId, entry.base).catch(() => {});
    }, HOLD_MS);
    // Node's timers keep a process alive (the vectors run there); a browser's are plain numbers.
    if (entry.timer && entry.timer.unref) entry.timer.unref();
    holds.set(docId, entry);
    await lay(db.docs, docId, make, base);
    return {
        revert: async () => {
            if (holds.get(docId) !== entry) return;
            clearTimeout(entry.timer);
            holds.delete(docId);
            await restore(db.docs, docId, entry.base);
        },
    };
}

/// `holdDoc` around a request: the effect shown now, withdrawn if `request()` throws (which it
/// rethrows, for the caller to say why). Resolves to the request's answer.
export async function optimisticDoc(db, root, docId, make, settled, request) {
    const hold = await holdDoc(db, root, docId, make, settled);
    try {
        return await request();
    } catch (e) {
        await hold.revert();
        throw e;
    }
}

/// Inside the mirror's apply transaction, after a frame's rows land: each held doc the frame
/// touched either settles or is laid again over the newer server row. `touched(docId)` says
/// whether the frame carried that doc; `serverRow(docId)` is what it carried (undefined: gone).
export async function reassertHeld(root, table, touched, serverRow) {
    const holds = held.get(root);
    if (!holds || holds.size === 0) return;
    for (const [docId, entry] of holds) {
        if (!touched(docId)) continue;
        const server = serverRow(docId);
        if (entry.settled(server)) {
            clearTimeout(entry.timer);
            holds.delete(docId);
            continue;
        }
        entry.base = server;
        await lay(table, docId, entry.make, server);
    }
}

/// At start: rows a closed page left marked go back to the server's, before anything reads them.
export async function healOptimistic(db, root) {
    const holds = holdsOf(root);
    const orphans = await db.docs.filter((r) => !!r._optimistic && !holds.has(r.doc_id)).toArray();
    for (const r of orphans) await restore(db.docs, r.doc_id, r._optimistic.base);
}

/// A document just created (its `made`: `{ doc_id, version }`), stated whole until the stream
/// brings it - filed in `bucket`, so the page it opens on knows which app it belongs to. Settled
/// only once the server's row carries that bucket too: the create and the filing are two writes,
/// and a frame between them would show the note unfiled for a beat.
export function holdNewDoc(db, root, made, { title, format, bucket }) {
    const now = Date.now();
    const fresh = {
        doc_id: made.doc_id,
        title,
        head: made.version,
        format,
        media: null,
        heads: 1,
        diverged: false,
        updated_ms: now,
        created_ms: now,
        tags: [],
        fields: {},
        buckets: bucket ? [bucket] : [],
        pinned: false,
    };
    return holdDoc(
        db,
        root,
        made.doc_id,
        (server) => (server ? { ...server, buckets: [...new Set([...(server.buckets || []), ...fresh.buckets])] } : fresh),
        (server) => !!server && (!bucket || (server.buckets || []).includes(bucket))
    );
}
