// THE MIRROR: a per-persona Dexie database of the node's view rows, and the live cache that keeps
// it current (PROJECT_PLAN, The Browser Is a View) - fed by a read-only WebSocket. The mirror is
// DISPOSABLE by design - a pure function of the node's stream, never a source of truth: any doubt
// about the cursor and the server sends a full snapshot, which we apply by clear-and-replace.
// Writes never touch this file; they are HTTP POSTs elsewhere (net.js), and their effects arrive
// back down the stream like anyone else's.
//
// This file owns the handle and the stream; `mirror/` holds the tables the stream does NOT feed.
// Three are exceptions that way, all local-only: `prefs` (UI preferences - mirror/prefs.js owns
// its key vocabulary and is the only module that touches the table) and the two fingerprinted
// fetch caches, `docdetails` and `trees` (mirror/doccache.js). A refresh never clears these.
// Still disposable - they share the mirror's lifetime, so "forget this browser" forgets them too,
// which is the right privacy posture for tables that record which documents you touch.
import Dexie, { liveQuery } from 'dexie';
import { useState, useEffect } from 'preact/hooks';

// One Dexie handle per persona per page - the mirror is per-identity ("nothing is ever cached
// for an identity the session doesn't own" starts with them not sharing a database).
const mirrors = new Map();

export function openMirror(root) {
    let db = mirrors.get(root);
    if (!db) {
        db = new Dexie(`ringtome-mirror-${root}`);
        // One version, whole schema - the User-1 rule (STYLE.md) applies to the mirror
        // doubly: no migration ceremony pre-launch anywhere, and this database is disposable
        // besides. (Dexie 4 diffs declared stores and upgrades additively on its own, so
        // even existing mirrors pick up new tables without a version bump.)
        db.version(1).stores({
            kv: 'key',
            profile: 'field',
            docs: 'doc_id',
            taxonomies: 'taxonomy_id',
            search: 'doc_id', // token bags, stream-fed like docs (search runs local)
            buckets: 'name', // the bucket roster: name -> app-type + member count
            prefs: 'key', // local-only, never stream-fed (module doc)
            // Fingerprinted FETCH caches (mirror/doccache.js): GET responses kept beside the streamed
            // rows that vouch for their freshness - docdetails against the doc row's head
            // fingerprint, trees against the taxonomy-roster fingerprint. Local-only, like prefs.
            docdetails: 'doc_id',
            trees: 'taxonomy_id',
        });
        mirrors.set(root, db);
    }
    return db;
}

/// The "forget this browser" obligation: drop the mirror wholesale. Called on logout.
export async function forgetMirror(root) {
    const db = mirrors.get(root);
    if (db) {
        db.close();
        mirrors.delete(root);
    }
    await Dexie.delete(`ringtome-mirror-${root}`).catch(() => {});
}

// Apply one streamed payload. Whole-kind refresh (the v1 shape): each kind present in the
// message replaces its table entirely, inside one transaction with the cursor - so the mirror
// is always a consistent frame, never a half-applied one.
async function apply(db, msg) {
    await db.transaction(
        'rw',
        db.kv,
        db.profile,
        db.docs,
        db.taxonomies,
        db.search,
        db.buckets,
        async () => {
            if (msg.profile) {
                await db.profile.clear();
                await db.profile.bulkPut(msg.profile);
            }
            if (msg.docs) {
                await db.docs.clear();
                await db.docs.bulkPut(msg.docs);
            }
            if (msg.taxonomies) {
                await db.taxonomies.clear();
                await db.taxonomies.bulkPut(msg.taxonomies);
            }
            if (msg.search) {
                await db.search.clear();
                await db.search.bulkPut(msg.search);
            }
            if (msg.buckets) {
                await db.buckets.clear();
                await db.buckets.bulkPut(msg.buckets);
            }
            await db.kv.put({ key: 'cursor', value: msg.cursor });
        }
    );
}

// Open the stream and keep the mirror current until stopped. Reconnects with backoff; every
// (re)connect presents the stored cursor, and the server decides: matching → live, any doubt
// → snapshot. Returns { stop }.
export function startLiveCache(root) {
    const db = openMirror(root);
    const state = { stopped: false, ws: null, retryMs: 1000 };

    const connect = async () => {
        if (state.stopped) return;
        let cursor = null;
        try {
            cursor = (await db.kv.get('cursor'))?.value || null;
        } catch {
            // A broken mirror is a disposable mirror: connect cursorless, take the snapshot.
        }
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const url = `${proto}://${location.host}/api/identity/${root}/stream${
            cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
        }`;
        const ws = new WebSocket(url);
        state.ws = ws;

        ws.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'snapshot' || msg.type === 'update') {
                    await apply(db, msg);
                } else if (msg.type === 'live') {
                    await db.kv.put({ key: 'cursor', value: msg.cursor });
                }
                state.retryMs = 1000; // a healthy message resets the backoff
            } catch (e) {
                console.warn('live cache: bad frame', e);
            }
        };
        ws.onclose = () => {
            if (state.stopped) return;
            setTimeout(connect, state.retryMs);
            state.retryMs = Math.min(state.retryMs * 2, 15000);
        };
        ws.onerror = () => ws.close();
    };

    connect();
    return {
        stop() {
            state.stopped = true;
            if (state.ws) state.ws.close();
        },
    };
}

// Subscribe a component to a Dexie query: re-renders on every mirror change, in every tab
// (Dexie's liveQuery observes IndexedDB cross-tab). `undefined` until the first result.
export function useLive(queryFn, deps) {
    const [value, setValue] = useState(undefined);
    useEffect(() => {
        const sub = liveQuery(queryFn).subscribe({
            next: setValue,
            error: (e) => console.warn('live query error', e),
        });
        return () => sub.unsubscribe();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return value;
}
