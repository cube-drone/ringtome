const assert = require('node:assert');

// Optimistic doc rows (2026-10-01): a write's effect stated ahead of the stream, settled by it.
let o;
before(async () => {
    o = await import('../../../js/pure/optimistic.js');
});

// A stand-in for the mirror's Dexie handle: just the docs table calls the engine makes.
const fakeDb = (rows = []) => {
    const m = new Map(rows.map((r) => [r.doc_id, r]));
    return {
        m,
        docs: {
            get: async (id) => m.get(id),
            put: async (r) => void m.set(r.doc_id, r),
            delete: async (id) => void m.delete(id),
            filter: (fn) => ({ toArray: async () => [...m.values()].filter(fn) }),
        },
    };
};
let n = 0;
const root = () => `root${++n}`; // each claim its own persona, so no hold leaks between them
const frame = (db, r, rows) => {
    const sent = new Map(rows.map((x) => [x.doc_id, x]));
    for (const x of rows) db.m.set(x.doc_id, x); // what apply() put down first
    return o.reassertHeld(r, db.docs, (id) => sent.has(id), (id) => sent.get(id));
};
const pin = (r) => r && { ...r, pinned: true };
const pinned = (r) => !!r && r.pinned === true;

describe('optimistic doc rows (2026-10-01)', () => {
    it('shows the write at once, marked with the server row it covers', async () => {
        const db = fakeDb([{ doc_id: 'a', pinned: false, title: 't' }]);
        await o.holdDoc(db, root(), 'a', pin, pinned);
        const row = db.m.get('a');
        assert.equal(row.pinned, true);
        assert.deepEqual(row._optimistic.base, { doc_id: 'a', pinned: false, title: 't' });
    });

    it('a frame from before the write is overlaid again; the frame that agrees releases it', async () => {
        const r = root();
        const db = fakeDb([{ doc_id: 'a', pinned: false, title: 't' }]);
        await o.holdDoc(db, r, 'a', pin, pinned);
        await frame(db, r, [{ doc_id: 'a', pinned: false, title: 'renamed elsewhere' }]);
        assert.equal(db.m.get('a').pinned, true, 'still shown pinned');
        assert.equal(db.m.get('a').title, 'renamed elsewhere', 'over the newer server row');
        await frame(db, r, [{ doc_id: 'a', pinned: true, title: 'renamed elsewhere' }]);
        assert.deepEqual(db.m.get('a'), { doc_id: 'a', pinned: true, title: 'renamed elsewhere' }, "the server's row, unmarked");
        await frame(db, r, [{ doc_id: 'a', pinned: false, title: 'unpinned later' }]);
        assert.equal(db.m.get('a').pinned, false, 'released: later frames are the server, plainly');
    });

    it('a frame that never names the doc leaves the overlay alone', async () => {
        const r = root();
        const db = fakeDb([{ doc_id: 'a', pinned: false }, { doc_id: 'b' }]);
        await o.holdDoc(db, r, 'a', pin, pinned);
        await frame(db, r, [{ doc_id: 'b', title: 'other' }]);
        assert.equal(db.m.get('a').pinned, true);
    });

    it('a failed write puts the server row back and says why', async () => {
        const db = fakeDb([{ doc_id: 'a', pinned: false }]);
        await assert.rejects(
            o.optimisticDoc(db, root(), 'a', pin, pinned, async () => {
                throw new Error('refused');
            }),
            /refused/
        );
        assert.deepEqual(db.m.get('a'), { doc_id: 'a', pinned: false });
    });

    it('a delete is gone at once, back on failure, and settled by the frame that drops it', async () => {
        const r = root();
        const db = fakeDb([{ doc_id: 'a' }]);
        const hold = await o.holdDoc(db, r, 'a', () => null, (x) => !x);
        assert.equal(db.m.has('a'), false);
        await hold.revert();
        assert.deepEqual(db.m.get('a'), { doc_id: 'a' }, 'reverted');
        await o.holdDoc(db, r, 'a', () => null, (x) => !x);
        db.m.delete('a');
        await o.reassertHeld(r, db.docs, () => true, () => undefined);
        assert.equal(db.m.has('a'), false);
    });

    it('a new note opens filed before the stream has it, and settles only once it is filed', async () => {
        const r = root();
        const db = fakeDb();
        await o.holdNewDoc(db, r, { doc_id: 'n', version: 'v1' }, { title: 'untitled', format: 'marquee', bucket: 'notes' });
        assert.deepEqual([db.m.get('n').head, db.m.get('n').buckets], ['v1', ['notes']]);
        await frame(db, r, [{ doc_id: 'n', head: 'v1', buckets: [] }]);
        assert.deepEqual(db.m.get('n').buckets, ['notes'], 'created but not yet filed: still shown filed');
        await frame(db, r, [{ doc_id: 'n', head: 'v1', buckets: ['notes'] }]);
        assert.equal(db.m.get('n')._optimistic, undefined, 'filed: the server row');
    });

    it('a page closed mid-write leaves marked rows the next start puts back', async () => {
        const db = fakeDb([
            { doc_id: 'p', pinned: true, _optimistic: { base: { doc_id: 'p', pinned: false } } },
            { doc_id: 'n', title: 'untitled', _optimistic: { base: null } },
            { doc_id: 'q', title: 'plain' },
        ]);
        await o.healOptimistic(db, root());
        assert.deepEqual(db.m.get('p'), { doc_id: 'p', pinned: false });
        assert.equal(db.m.has('n'), false, 'a create never echoed is gone');
        assert.deepEqual(db.m.get('q'), { doc_id: 'q', title: 'plain' });
    });
});
