const assert = require('node:assert');

let bookModes, isBookBucket, hiddenSetOf, hiddenDocsOf, pageStanding, bookLedger, bookFacts, parseBook, readingOrder, neighbours, titlePageOf;
before(async () => {
    ({ bookModes, isBookBucket, hiddenSetOf, hiddenDocsOf, pageStanding, bookLedger, bookFacts, parseBook, readingOrder, neighbours, titlePageOf } = await import('../../../js/pure/books.js'));
});

describe('books: the private bookkeeping (BOOKS.md slice 1)', () => {
    it('reads the switch and the hidden marks off kv rows', () => {
        const modes = bookModes([{ key: 'grimoire', value: '{"mode":"book"}' }, { key: 'junk', value: 'not json' }, { key: 'off', value: '{}' }]);
        assert.deepEqual(modes, { grimoire: 'book' });
        assert.equal(isBookBucket(modes, 'grimoire'), true);
        assert.equal(isBookBucket(modes, 'off'), false);
        assert.equal(isBookBucket(modes, null), false);
        const hidden = hiddenSetOf([{ key: 'doc:a', value: 'yes' }, { key: 'sec:s1', value: 'yes' }, { key: 'doc:b', value: '' }]);
        assert.deepEqual([...hidden].sort(), ['doc:a', 'sec:s1']);
    });

    it('a hidden section hides every page beneath it, stubs and cycles included', () => {
        const tree = {
            taxonomy_id: 'root', title: 'wiki:g', members: [
                { doc_id: 'p1', doc: {} },
                { doc_id: 's1', taxonomy: { taxonomy_id: 's1', title: 'ch1', members: [
                    { doc_id: 'p2', doc: {} },
                    { doc_id: 's2', taxonomy: { taxonomy_id: 's2', title: 'ch1.1', members: [{ doc_id: 'p3', doc: {} }] } },
                ] } },
                { doc_id: 's1', taxonomy: { taxonomy_id: 's1', title: 'ch1' } }, // a stub: seen already
                { doc_id: 'p4', doc: {} },
            ],
        };
        const hidden = new Set(['sec:s1', 'doc:p4']);
        assert.deepEqual([...hiddenDocsOf(tree, hidden)].sort(), ['p2', 'p3', 'p4']);
        assert.deepEqual([...hiddenDocsOf(null, hidden)], []);
    });

    it('the ledger: hidden, new, changed, current', () => {
        const rows = [
            { doc_id: 'p1', head: 'v1', fields: {} },
            { doc_id: 'p2', head: 'v9', fields: { published_version: 'v2' } },
            { doc_id: 'p3', head: 'v3', fields: { published_version: 'v3' } },
            { doc_id: 'p4', head: 'v4', fields: { published_version: 'v4' } },
        ];
        const ledger = bookLedger(rows, new Set(['p4']), new Set());
        assert.deepEqual(Object.fromEntries(Object.entries(ledger).map(([k, v]) => [k, v.map((r) => r.doc_id)])), {
            hidden: ['p4'], new: ['p1'], changed: ['p2'], current: ['p3'],
        });
        assert.equal(pageStanding({ doc_id: 'x', head: 'v', fields: {} }, new Set(), new Set(['doc:x'])), 'hidden', 'a direct mark hides too');
        assert.equal(pageStanding(null), 'new');
    });
});

describe('books: the payload (BOOKS.md slice 2)', () => {
    it('keeps every fact the rollout writes, and reads a book payload back, counting its pages', () => {
        const facts = bookFacts([{ key: 'g', value: '{"mode":"book","published_as_book":"abc"}' }, { key: 'x', value: 'nope' }]);
        assert.deepEqual(facts, { g: { mode: 'book', published_as_book: 'abc' } });
        const book = parseBook('{"title":"grimoire","sections":[{"title":"part one","pages":[{"post":"p1","title":"one"}],"sections":[{"title":"deeper","pages":[{"post":"p2","title":"two"}],"sections":[]}]}],"pages":[{"post":"p3","title":"three"}]}');
        assert.equal(book.title, 'grimoire');
        assert.equal(book.count, 3);
        assert.equal(book.sections[0].sections[0].pages[0].post, 'p2');
        assert.equal(parseBook('not json'), null);
        assert.equal(parseBook('[]'), null);
    });
});

describe('books: reading order (BOOKS.md slice 4)', () => {
    let book;
    before(() => { book = parseBook('{"title":"g","sections":[{"title":"part one","pages":[{"post":"p1","title":"one"},{"post":"p2","title":"two"}],"sections":[{"title":"deeper","pages":[{"post":"p3","title":"three"}],"sections":[]}]}],"pages":[{"post":"p0","title":"loose"}]}'); });
    it('walks top-level pages first, then sections depth-first, each page with its trail', () => {
        assert.deepEqual(readingOrder(book).map((p) => [p.post, p.trail.join('/')]), [['p0', ''], ['p1', 'part one'], ['p2', 'part one'], ['p3', 'part one/deeper']]);
        assert.deepEqual(readingOrder(null), []);
    });
    it('knows a page\'s neighbours, and that a stranger has none', () => {
        const n = neighbours(book, 'p2');
        assert.equal(n.index, 2);
        assert.equal(n.prev.post, 'p1');
        assert.equal(n.next.post, 'p3');
        assert.equal(neighbours(book, 'p0').prev, null);
        assert.equal(neighbours(book, 'p3').next, null);
        assert.equal(neighbours(book, 'nope').index, -1);
    });
});

describe('books: the title page (BOOKS.md ruling 11)', () => {
    it('is the first page in reading order over the private tree, hidden skipped, else the first loose page', () => {
        const docs = [{ doc_id: 'p1' }, { doc_id: 'p2' }, { doc_id: 'p3' }, { doc_id: 'z' }];
        const tree = { taxonomy_id: 'root', members: [
            { doc_id: 'p1', doc: {} },
            { doc_id: 's', taxonomy: { taxonomy_id: 's', members: [{ doc_id: 'p2', doc: {} }] } },
        ] };
        assert.equal(titlePageOf(tree, docs, new Set()), 'p1');
        assert.equal(titlePageOf(tree, docs, new Set(['doc:p1'])), 'p3', 'a hidden top page yields to the first UNFILED page, before any section - the rollout and the reader agree');
        assert.equal(titlePageOf(tree, [{ doc_id: 'p1' }, { doc_id: 'p2' }], new Set(['doc:p1'])), 'p2', 'with nothing unfiled, the first section page');
        assert.equal(titlePageOf(null, docs, new Set()), 'p1', 'no tree: the first page by id');
        assert.equal(titlePageOf(null, [{ doc_id: 'z' }], new Set(['doc:z'])), null);
        assert.equal(parseBook('{"title":"t","cover":{"post":"c","title":"Cover"},"sections":[],"pages":[]}').cover.title, 'Cover');
    });
});
