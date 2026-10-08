// `:e Title`'s rule (pure/bytitle.js): exact first, then ignoring case, the newest of several.
const assert = require('node:assert');

let noteByTitle;
before(async () => {
    ({ noteByTitle } = await import('../../../js/pure/bytitle.js'));
});

describe('which note :e names', () => {
    const docs = [
        { doc_id: 'a', title: 'Shopping', updated_ms: 1 },
        { doc_id: 'b', title: 'shopping', updated_ms: 9 },
        { doc_id: 'c', title: 'Recipes', updated_ms: 3 },
        { doc_id: 'd', title: 'Recipes ', updated_ms: 7 },
    ];

    it('the exact title wins over a newer one that only matches ignoring case', () => {
        assert.equal(noteByTitle(docs, 'Shopping'), 'a');
        assert.equal(noteByTitle(docs, 'shopping'), 'b');
    });

    it('ignoring case when nothing matches exactly', () => {
        assert.equal(noteByTitle(docs, 'SHOPPING'), 'b', 'the newer of the two');
    });

    it('of several with the same title, the one edited last', () => {
        assert.equal(noteByTitle(docs, 'Recipes'), 'd', 'surrounding spaces are no difference');
    });

    it('nothing by that name, or no name at all, is null', () => {
        assert.equal(noteByTitle(docs, 'Garden'), null);
        assert.equal(noteByTitle(docs, '  '), null);
        assert.equal(noteByTitle(undefined, 'x'), null);
    });
});
