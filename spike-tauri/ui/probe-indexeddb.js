// The IndexedDB probe: does the Dexie mirror work in THIS webview?
//
// It exercises the real thing rather than a toy - the schema below is copied from
// node/js/mirror.js and the access patterns are the ones the live cache actually performs
// (clear-and-replace per kind inside one rw transaction for a snapshot; bulkPut/bulkDelete for
// deltas; liveQuery for reactivity). A probe that passed on a simpler schema would tell us
// nothing, because the parts historically broken on WebKit are the ones we lean on hardest:
// multi-store transactions, change observation, and Blob round-trips.
//
// Ordering is load-bearing: the reload check reads a marker written by the PREVIOUS run, so it
// must run before anything destructive.

import Dexie, { liveQuery } from './vendor/dexie.mjs';

// Verbatim from js/mirror.js's openMirror(). If that drifts, this drifts with it or the spike
// is measuring a fiction.
const SCHEMA = {
    kv: 'key',
    profile: 'field',
    docs: 'doc_id',
    taxonomies: 'taxonomy_id',
    search: 'doc_id',
    buckets: 'name',
    contacts: 'root',
    prefs: 'key',
    docdetails: 'doc_id',
    trees: 'taxonomy_id',
};

const DB_NAME = 'spike-mirror-probe';
const MARKER_KEY = 'spike:reload-marker';

// Sized to a persona that is busy but not absurd: the 3-node test-data run that found the
// open-database thrash used 150 personas, and a single persona with a few thousand documents is
// the shape a heavy user reaches.
const DOC_COUNT = 2000;
// The document cap is 10MB (RINGTOME_MAX_DOCUMENT_BYTES), so a body near that is the realistic
// worst case for the doccache, and Blob-in-IndexedDB is a classic WebKit sore spot.
const BLOB_BYTES = 8 * 1024 * 1024;

function docRow(i) {
    return {
        doc_id: `doc-${i}`,
        title: `Document number ${i}`,
        app: i % 3 === 0 ? 'notes' : i % 3 === 1 ? 'journal' : 'wiki',
        head: `hash-${i}-${'a'.repeat(24)}`,
        updated_at_ms: 1_770_000_000_000 + i * 1000,
        claimed_date: '2026-08-11',
        body_preview: `Body preview for document ${i}. `.repeat(6),
    };
}

function searchRow(i) {
    return { doc_id: `doc-${i}`, tokens: `token${i} alpha beta gamma delta epsilon`.split(' ') };
}

function patternedBytes(n) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    return bytes;
}

function checkPattern(bytes, n) {
    if (bytes.length !== n) return `length ${bytes.length} !== ${n}`;
    for (const i of [0, 1, 1023, 65_536, n - 1]) {
        const expected = (i * 31 + 7) & 0xff;
        if (bytes[i] !== expected) return `byte ${i} is ${bytes[i]}, expected ${expected}`;
    }
    return null;
}

// `informational` steps report a fact about the engine and CANNOT fail the run. The flag exists
// because the first version of this file did not have it: the storage-posture step was documented
// as "informational, never a failure" and then implemented with a throw, so a WebKitGTK box with no
// `navigator.storage` reported the whole mirror as FAIL while every load-bearing row passed
// (field-found 2026-08-11, Ubuntu 26.04). A category that lives only in a comment is not a category.
async function step(name, fn, { informational = false } = {}) {
    const started = performance.now();
    try {
        const detail = await fn();
        return {
            name,
            ok: true,
            informational,
            detail: detail ?? '',
            ms: Math.round(performance.now() - started),
        };
    } catch (err) {
        return {
            name,
            ok: false,
            informational,
            detail: `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
            ms: Math.round(performance.now() - started),
        };
    }
}

export async function runIndexedDbProbe({ onStep }) {
    const results = [];
    const record = async (name, fn, opts) => {
        const r = await step(name, fn, opts);
        results.push(r);
        onStep?.(r);
        return r;
    };

    let db = null;

    await record('IndexedDB present', async () => {
        if (!('indexedDB' in globalThis)) throw new Error('window.indexedDB is undefined');
        return `Dexie ${Dexie.semVer}`;
    });

    await record('open + declare schema', async () => {
        db = new Dexie(DB_NAME);
        db.version(1).stores(SCHEMA);
        await db.open();
        return `${Object.keys(SCHEMA).length} stores`;
    });

    // BEFORE anything destructive: did the previous run's data survive a reload?
    await record('persistence across reload', async () => {
        const marker = await db.kv.get(MARKER_KEY);
        if (!marker) {
            return 'no marker yet — press "Reload window" and re-run to test this';
        }
        const docs = await db.docs.count();
        if (docs !== marker.docs) {
            throw new Error(`marker recorded ${marker.docs} docs, found ${docs}`);
        }
        const blob = await db.docdetails.get('doc-blob');
        if (!blob) throw new Error('marker present but the cached body vanished');
        const bytes = new Uint8Array(await blob.body.arrayBuffer());
        const bad = checkPattern(bytes, BLOB_BYTES);
        if (bad) throw new Error(`body survived but corrupted: ${bad}`);
        const ageMs = Date.now() - marker.written_at_ms;
        return `survived: ${docs} docs + ${BLOB_BYTES} byte body intact after ${Math.round(ageMs / 1000)}s`;
    });

    await record('snapshot apply (clear+bulkPut, one rw txn, 7 stores)', async () => {
        const docs = Array.from({ length: DOC_COUNT }, (_, i) => docRow(i));
        const search = Array.from({ length: DOC_COUNT }, (_, i) => searchRow(i));
        await db.transaction(
            'rw',
            db.kv,
            db.profile,
            db.docs,
            db.taxonomies,
            db.search,
            db.buckets,
            db.contacts,
            async () => {
                await db.profile.clear();
                await db.profile.bulkPut([
                    { field: 'display_name', value: 'Spike Persona' },
                    { field: 'bio', value: 'exists only to be written and deleted' },
                ]);
                await db.docs.clear();
                await db.docs.bulkPut(docs);
                await db.search.clear();
                await db.search.bulkPut(search);
                await db.taxonomies.clear();
                await db.taxonomies.bulkPut([{ taxonomy_id: 'tax-1', name: 'Everything' }]);
                await db.buckets.clear();
                await db.buckets.bulkPut([{ name: 'notes', app: 'notes', members: DOC_COUNT }]);
                await db.contacts.clear();
                await db.contacts.bulkPut([{ root: 'root-abc', trust: 'known', interest: 3 }]);
            },
        );
        const count = await db.docs.count();
        if (count !== DOC_COUNT) throw new Error(`wrote ${DOC_COUNT} docs, read back ${count}`);
        return `${DOC_COUNT} docs + ${DOC_COUNT} search rows`;
    });

    await record('delta apply (50 rounds of bulkPut + bulkDelete)', async () => {
        for (let round = 0; round < 50; round += 1) {
            const changed = Array.from({ length: 10 }, (_, i) => {
                const row = docRow(round * 10 + i);
                row.title = `${row.title} (revised ${round})`;
                return row;
            });
            const removed = [`doc-${1000 + round}`];
            await db.transaction('rw', db.docs, async () => {
                await db.docs.bulkPut(changed);
                await db.docs.bulkDelete(removed);
            });
        }
        const count = await db.docs.count();
        if (count !== DOC_COUNT - 50) {
            throw new Error(`expected ${DOC_COUNT - 50} docs after 50 deletions, found ${count}`);
        }
        return `${count} docs remain`;
    });

    // The one that matters most: useLive() in js/mirror.js is the whole reactivity story, and it
    // rests on Dexie's change observation rather than on storage.
    await record('liveQuery fires on write', async () => {
        const seen = [];
        let resolveFirst;
        const first = new Promise((r) => {
            resolveFirst = r;
        });
        const sub = liveQuery(() => db.docs.count()).subscribe({
            next: (v) => {
                seen.push(v);
                resolveFirst?.();
            },
            error: (e) => {
                throw e;
            },
        });
        try {
            await Promise.race([
                first,
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('no initial emission within 4s')), 4000),
                ),
            ]);
            const before = seen[seen.length - 1];
            await db.docs.put(docRow(999_999));
            const grew = await Promise.race([
                (async () => {
                    for (let i = 0; i < 80; i += 1) {
                        if (seen[seen.length - 1] === before + 1) return true;
                        await new Promise((r) => setTimeout(r, 50));
                    }
                    return false;
                })(),
                new Promise((r) => setTimeout(() => r(false), 5000)),
            ]);
            if (!grew) {
                throw new Error(
                    `subscriber never saw ${before + 1} (emissions: ${JSON.stringify(seen.slice(-5))})`,
                );
            }
            return `${seen.length} emissions, reacted to the write`;
        } finally {
            sub.unsubscribe();
        }
    });

    await record(`Blob round-trip (${(BLOB_BYTES / 1024 / 1024).toFixed(0)}MB, doccache shape)`, async () => {
        const bytes = patternedBytes(BLOB_BYTES);
        await db.docdetails.put({ doc_id: 'doc-blob', body: new Blob([bytes]), head: 'hash-blob' });
        const row = await db.docdetails.get('doc-blob');
        if (!row) throw new Error('row vanished immediately after put');
        if (!(row.body instanceof Blob)) throw new Error(`body came back as ${typeof row.body}`);
        const bad = checkPattern(new Uint8Array(await row.body.arrayBuffer()), BLOB_BYTES);
        if (bad) throw new Error(bad);
        return 'Blob stored and read back byte-identical';
    });

    await record('ArrayBuffer round-trip (same size)', async () => {
        const bytes = patternedBytes(BLOB_BYTES);
        await db.trees.put({ taxonomy_id: 'tax-buffer', body: bytes.buffer });
        const row = await db.trees.get('tax-buffer');
        const bad = checkPattern(new Uint8Array(row.body), BLOB_BYTES);
        if (bad) throw new Error(bad);
        return 'ArrayBuffer stored and read back byte-identical';
    });

    // Informational by construction (see `step`): an engine that refuses persistence - or omits
    // StorageManager entirely, as WebKitGTK 2.52.3 does - still runs the mirror. The mirror is
    // disposable and any doubt sends a full snapshot, so eviction is a cost, never a break. This
    // step therefore reports and never throws.
    await record(
        'storage quota + persistence posture',
        async () => {
            if (!navigator.storage) {
                return 'navigator.storage absent — no quota signal, and persistence cannot be requested; the mirror is fully evictable here';
            }
            const estimate = navigator.storage.estimate
                ? await navigator.storage.estimate()
                : { quota: null, usage: null };
            const alreadyPersisted = navigator.storage.persisted
                ? await navigator.storage.persisted()
                : 'unsupported';
            let granted = 'unsupported';
            if (navigator.storage.persist) {
                try {
                    granted = await navigator.storage.persist();
                } catch {
                    granted = 'threw';
                }
            }
            const quota = estimate.quota ? `${(estimate.quota / 1024 / 1024).toFixed(0)}MB quota` : 'quota unknown';
            const usage = estimate.usage ? `${(estimate.usage / 1024 / 1024).toFixed(1)}MB used` : 'usage unknown';
            return `${quota}, ${usage}, persisted=${alreadyPersisted}, persist()=${granted}`;
        },
        { informational: true },
    );

    await record('write reload marker', async () => {
        const docs = await db.docs.count();
        await db.kv.put({ key: MARKER_KEY, docs, written_at_ms: Date.now() });
        return `marker at ${docs} docs — reload and re-run to prove persistence`;
    });

    // Informational steps are excluded from the verdict on purpose - they describe the engine, they
    // do not grade it.
    const failed = results.filter((r) => !r.ok && !r.informational);
    const pending = results.find(
        (r) => r.name === 'persistence across reload' && r.detail.startsWith('no marker'),
    );

    return {
        results,
        verdict: failed.length === 0 ? (pending ? 'PASS (reload check pending)' : 'PASS') : 'FAIL',
        summary:
            failed.length === 0
                ? 'the mirror works in this webview'
                : `${failed.length} failing: ${failed.map((f) => f.name).join(', ')}`,
    };
}

/// The "forget this browser" obligation, and the probe's own cleanup. Separate button: a run that
/// deleted the database at the end could never test persistence across a reload.
export async function forgetProbeDatabase() {
    await Dexie.delete(DB_NAME);
    return `deleted ${DB_NAME}`;
}
