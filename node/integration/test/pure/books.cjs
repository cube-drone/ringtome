const assert = require('node:assert');

let bookModes, isBookBucket, hiddenSetOf, hiddenDocsOf, pageStanding, bookLedger, bookFacts, parseBook;
before(async () => {
    ({ bookModes, isBookBucket, hiddenSetOf, hiddenDocsOf, pageStanding, bookLedger, bookFacts, parseBook } = await import('../../../js/pure/books.js'));
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
