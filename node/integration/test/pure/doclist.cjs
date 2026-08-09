// Which documents a documents app shows, and in what order. The filters stack in a deliberate order
// and each one has an edge that matters: a null `hits` means "not searching" while an EMPTY set means
// "no results" (opposite things), tags AND rather than OR, and the sort has to be stable or the list
// reshuffles under the pointer on every mirror tick.
const assert = require('node:assert');

let orderDocs, tagCounts, byPinnedThenClaimed, nextSearchKind, appForStyle, DEFAULT_STYLE;
before(async () => {
    ({ orderDocs, tagCounts, byPinnedThenClaimed, nextSearchKind } = await import('../../../js/pure/doclist.js'));
    ({ appForStyle, DEFAULT_STYLE } = await import('../../../js/pure/apps.js'));
});

const id = (n) => String(n).padStart(2, '0').repeat(16);
const doc = (n, over = {}) => ({
    doc_id: id(n), title: `doc ${n}`, buckets: ['journal'], updated_ms: 1000 * n, ...over,
});
const journal = () => appForStyle('journal');
const ids = (list) => list.map((d) => d.doc_id.slice(0, 2));

describe('orderDocs', () => {
    it('shows only what this app s notebook holds', () => {
        const docs = [doc(1), doc(2, { buckets: ['other'] }), doc(3)];
        assert.deepEqual(ids(orderDocs(docs, { app: journal(), bucket: 'journal' })), ['03', '01']);
    });

    it('treats a null hits as NO FILTER and an empty set as NO RESULTS', () => {
        const docs = [doc(1), doc(2)];
        const opts = { app: journal(), bucket: 'journal' };
        assert.equal(orderDocs(docs, { ...opts, hits: null }).length, 2);
        assert.equal(orderDocs(docs, { ...opts, hits: new Set() }).length, 0);
        assert.equal(orderDocs(docs, opts).length, 2); // absent behaves like null
    });

    it('ANDs the tag filters - a document must carry every one', () => {
        const docs = [
            doc(1, { tags: ['quick', 'vegan'] }),
            doc(2, { tags: ['quick'] }),
            doc(3, { tags: [] }),
        ];
        const opts = { app: journal(), bucket: 'journal' };
        assert.deepEqual(ids(orderDocs(docs, { ...opts, tags: ['quick'] })), ['02', '01']);
        assert.deepEqual(ids(orderDocs(docs, { ...opts, tags: ['quick', 'vegan'] })), ['01']);
        assert.deepEqual(ids(orderDocs(docs, { ...opts, tags: ['nope'] })), []);
    });

    it('stacks scope, then search, then tags', () => {
        const docs = [
            doc(1, { tags: ['x'] }),
            doc(2, { tags: ['x'] }),
            doc(3, { buckets: ['other'], tags: ['x'] }),
        ];
        const out = orderDocs(docs, {
            app: journal(), bucket: 'journal', hits: new Set([id(1), id(3)]), tags: ['x'],
        });
        assert.deepEqual(ids(out), ['01']); // 2 fails search, 3 fails scope
    });

    it('is safe on no documents at all', () => {
        assert.deepEqual(orderDocs(undefined, {}), []);
        assert.deepEqual(orderDocs([], {}), []);
    });

    it('the kind dial: docs vs media, and unknown kinds mean everything', () => {
        const mixed = [doc(1), doc(2, { media: { has_thumb: true } }), doc(3)];
        assert.deepEqual(ids(orderDocs(mixed, { app: journal(), bucket: 'journal', kind: 'docs' })), ['03', '01']);
        assert.deepEqual(ids(orderDocs(mixed, { app: journal(), bucket: 'journal', kind: 'media' })), ['02']);
        assert.equal(orderDocs(mixed, { app: journal(), bucket: 'journal', kind: 'all' }).length, 3);
        assert.equal(orderDocs(mixed, { app: journal(), bucket: 'journal' }).length, 3, 'absent = all');
        assert.equal(orderDocs(mixed, { app: journal(), bucket: 'journal', kind: 'someday' }).length, 3,
            'an unknown kind never empties the list');
    });

    it('the kind dial rotates all -> docs -> media -> all', () => {
        assert.equal(nextSearchKind('all'), 'docs');
        assert.equal(nextSearchKind('docs'), 'media');
        assert.equal(nextSearchKind('media'), 'all');
    });
});

describe('byPinnedThenClaimed', () => {
    const sorted = (docs) => ids(docs.slice().sort(byPinnedThenClaimed));

    it('floats pinned documents above everything', () => {
        assert.deepEqual(sorted([doc(1), doc(2), doc(3, { pinned: true })]), ['03', '02', '01']);
    });

    it('orders the rest newest-updated first', () => {
        assert.deepEqual(sorted([doc(1), doc(3), doc(2)]), ['03', '02', '01']);
    });

    it('lets a CLAIMED date override the real stamp', () => {
        // doc 1 was updated first but claims 2030; it files itself at the top.
        const claimed = doc(1, { fields: { display_date: '2030-01-01' } });
        assert.deepEqual(sorted([claimed, doc(2), doc(3)]), ['01', '03', '02']);
    });

    it('breaks a tie on id, so the order never reshuffles between renders', () => {
        const a = doc(1, { updated_ms: 500 });
        const b = doc(2, { updated_ms: 500 });
        assert.deepEqual(sorted([a, b]), sorted([b, a]));
    });

    it('sorts pinned documents among themselves by date, not arbitrarily', () => {
        const out = sorted([doc(1, { pinned: true }), doc(3, { pinned: true }), doc(2)]);
        assert.deepEqual(out, ['03', '01', '02']);
    });
});

describe('tagCounts', () => {
    it('counts every tag, most-used first', () => {
        const docs = [{ tags: ['a', 'b'] }, { tags: ['b'] }, { tags: ['b', 'c'] }];
        assert.deepEqual(tagCounts(docs), [['b', 3], ['a', 1], ['c', 1]]);
    });

    it('breaks a count tie alphabetically', () => {
        assert.deepEqual(tagCounts([{ tags: ['z'] }, { tags: ['a'] }]), [['a', 1], ['z', 1]]);
    });

    it('is safe on documents with no tags, and on nothing', () => {
        assert.deepEqual(tagCounts([{}, { tags: [] }]), []);
        assert.deepEqual(tagCounts(undefined), []);
    });
});
