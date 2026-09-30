const assert = require('node:assert');

let facetSlice, togglePick, FACET_TOP, fitCount;
before(async () => {
    ({ facetSlice, togglePick, FACET_TOP, fitCount } = await import('../../../js/pure/facets.js'));
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

describe('how many facet chips fit one line (2026-09-30)', () => {
    it('shows every chip when they all fit, with no room kept for "more"', () => {
        // 3 x 50 + 2 gaps of 5 = 160
        assert.equal(fitCount([50, 50, 50], 160, 80, 5), 3);
    });

    it('keeps room for "more" once they do not, and fits what it can beside it', () => {
        // 159 is a pixel short of all three: room less "more" (80) and its gap (5) is 74 - one chip
        assert.equal(fitCount([50, 50, 50], 159, 80, 5), 1);
        // wide: 800 across, twenty chips of 60 - 800 - 85 = 715 holds 11 (11 x 60 + 10 x 5 = 710)
        assert.equal(fitCount(Array(20).fill(60), 800, 80, 5), 11);
    });

    it('never shows fewer than one, however tight', () => {
        assert.equal(fitCount([200, 50], 100, 80, 5), 1);
        assert.equal(fitCount([], 100, 80, 5), 0);
    });
});
