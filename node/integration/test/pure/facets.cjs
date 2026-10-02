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

describe('every chip cycles the same three ways (2026-10-01)', () => {
    let cyclePick, pickState, cycleMe, meParam;
    before(async () => {
        ({ cyclePick, pickState, cycleMe, meParam } = await import('../../../js/pure/facets.js'));
    });
    it('left alone, then only, then left out, then left alone again', () => {
        const none = { tags: [], notTags: [] };
        const once = cyclePick(none, 'tags', 'art');
        assert.deepEqual([once.tags, once.notTags], [['art'], []]);
        assert.equal(pickState(once, 'tags', 'art'), 'only');
        const twice = cyclePick(once, 'tags', 'art');
        assert.deepEqual([twice.tags, twice.notTags], [[], ['art']]);
        assert.equal(pickState(twice, 'tags', 'art'), 'out');
        const thrice = cyclePick(twice, 'tags', 'art');
        assert.deepEqual([thrice.tags, thrice.notTags], [[], []]);
        assert.equal(pickState(thrice, 'tags', 'art'), null);
    });
    it('a chip cycles alone - its row-mates keep where they stand', () => {
        const picks = cyclePick(cyclePick({ kinds: ['book'] }, 'kinds', 'reply'), 'kinds', 'reply');
        assert.deepEqual(picks.kinds, ['book']);
        assert.deepEqual(picks.notKinds, ['reply']);
    });
    it('"me" too: among the rest, only mine, left out - and an old unpick still reads as left out', () => {
        assert.equal(cycleMe(undefined), 'only');
        assert.equal(cycleMe('only'), false);
        assert.equal(cycleMe(false), undefined);
        assert.deepEqual([meParam(undefined), meParam('only'), meParam(false)], [null, 'only', '0']);
    });
});

describe('the size and media rows (2026-10-02)', () => {
    let tagRows, tagFamily, SIZE_TAGS, MEDIA_TAGS;
    before(async () => {
        ({ tagRows, tagFamily, SIZE_TAGS, MEDIA_TAGS } = await import('../../../js/pure/facets.js'));
    });

    it('splits the tag row three ways, sizes and media in their own order', () => {
        const counted = [
            { value: 'bread', count: 9 },
            { value: 'image', count: 7 },
            { value: 'long', count: 5 },
            { value: 'micro', count: 4 },
            { value: 'audio', count: 1 },
        ];
        const rows = tagRows(counted);
        assert.deepEqual(rows.size.map((f) => f.value), ['micro', 'long'], 'smallest first, whatever the counts');
        assert.deepEqual(rows.media.map((f) => f.value), ['audio', 'image']);
        assert.deepEqual(rows.tags.map((f) => f.value), ['bread']);
        assert.deepEqual(tagRows(null), { size: [], media: [], tags: [] }, 'nothing counted, every row empty');
    });

    it('is the node\'s families exactly - its implicit tags, sizes and media', () => {
        const fs = require('node:fs');
        const rust = fs.readFileSync(require('node:path').join(__dirname, '../../../src/search.rs'), 'utf8');
        const list = (name) => JSON.parse(rust.match(new RegExp(`pub const ${name}: \\[&str; \\d+\\] = (\\[[^\\]]*\\]);`))[1]);
        assert.deepEqual(SIZE_TAGS, list('SIZE_TAGS'));
        assert.deepEqual(MEDIA_TAGS, list('MEDIA_TAGS'));
        assert.equal(tagFamily('bread'), 'tags');
    });
});

describe('how many lines a row opens onto (2026-10-02)', () => {
    let wrapLines;
    before(async () => {
        ({ wrapLines } = await import('../../../js/pure/facets.js'));
    });

    it('counts the wrap the way the row will draw it', () => {
        assert.equal(wrapLines([], 100, 200, 5), 1, 'nothing: one line');
        assert.equal(wrapLines([40, 40], 100, 200, 5), 1, 'two fit the first line beside the label');
        assert.equal(wrapLines([40, 40, 40], 100, 200, 5), 2, 'the third wraps');
        assert.equal(wrapLines([40, 40, 60, 60, 60], 100, 200, 5), 2, 'later lines are wider: three fit the second');
        assert.equal(wrapLines(Array(30).fill(60), 100, 200, 5), 11, 'a long tail is many lines');
        assert.equal(wrapLines([150], 100, 200, 5), 1, 'one chip too wide still takes the line it starts');
    });
});
