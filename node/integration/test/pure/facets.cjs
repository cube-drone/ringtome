const assert = require('node:assert');

let facetSlice, togglePick, FACET_TOP;
before(async () => {
    ({ facetSlice, togglePick, FACET_TOP } = await import('../../../js/pure/facets.js'));
});

describe('the facet strip folds each list to its top few (2026-09-07)', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ value: `t${i}`, count: 10 - i }));
    it('shows the top few and counts the rest; expanded shows all', () => {
        const folded = facetSlice(items, [], false);
        assert.equal(folded.shown.length, FACET_TOP);
        assert.equal(folded.hidden, 10 - FACET_TOP);
        assert.deepEqual(facetSlice(items, [], true), { shown: items, hidden: 0 });
        assert.deepEqual(facetSlice(items.slice(0, 3), [], false), { shown: items.slice(0, 3), hidden: 0 }, 'a short list never folds');
    });
    it('a picked value past the fold still shows - what narrows the page is never hidden', () => {
        const { shown, hidden } = facetSlice(items, ['t9'], false);
        assert.ok(shown.some((f) => f.value === 't9'));
        assert.equal(hidden, 10 - FACET_TOP - 1);
    });
    it('toggling adds and removes a pick', () => {
        assert.deepEqual(togglePick([], 'a'), ['a']);
        assert.deepEqual(togglePick(['a', 'b'], 'a'), ['b']);
    });
});
