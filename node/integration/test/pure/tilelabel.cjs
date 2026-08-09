// The app tile's name rule: shrink before you cut. The edges that matter are the two thresholds
// (where shrinking starts, where cutting starts) and the invariant between them - a longer name
// must never come out bigger, and nothing may ever exceed the strip's budget.
const assert = require('node:assert');

let tileLabel, TILE_FULL_CHARS, TILE_MIN_SCALE, TILE_MAX_CHARS;
before(async () => {
    ({ tileLabel, TILE_FULL_CHARS, TILE_MIN_SCALE, TILE_MAX_CHARS } = await import(
        '../../../js/pure/tilelabel.js'
    ));
});

const rep = (n) => 'x'.repeat(n);

describe('tileLabel', () => {
    it('leaves a short name entirely alone', () => {
        assert.deepEqual(tileLabel('Feed'), { text: 'Feed', scale: 1 });
        assert.deepEqual(tileLabel('People'), { text: 'People', scale: 1 });
        assert.deepEqual(tileLabel('TurboNotes'), { text: 'TurboNotes', scale: 1 });
    });

    it('holds full size right up to the measured capacity, and shrinks one character later', () => {
        assert.equal(tileLabel(rep(TILE_FULL_CHARS)).scale, 1);
        assert.ok(tileLabel(rep(TILE_FULL_CHARS + 1)).scale < 1);
    });

    it('shows "Lost & Found" WHOLE - the name that started this', () => {
        // 12 characters: one past the old hard cut, which rendered it "LOST & FOUN…".
        const { text, scale } = tileLabel('Lost & Found');
        assert.equal(text, 'Lost & Found');
        assert.ok(scale < 1 && scale > TILE_MIN_SCALE, `shrunk but readable, got ${scale}`);
    });

    it('never cuts a name it can shrink to fit', () => {
        for (let n = 1; n <= TILE_MAX_CHARS; n++) {
            const { text } = tileLabel(rep(n));
            assert.equal(text, rep(n), `${n} characters should survive whole`);
        }
    });

    it('cuts only past the floor, and the cut still fits the budget', () => {
        const { text, scale } = tileLabel(rep(TILE_MAX_CHARS + 1));
        assert.equal(scale, TILE_MIN_SCALE, 'the type has bottomed out');
        assert.ok(text.endsWith('…'));
        assert.equal(text.length, TILE_MAX_CHARS, 'ellipsis included, not on top');
    });

    it('is monotonic: a longer name is never drawn larger', () => {
        let previous = Infinity;
        for (let n = 1; n <= 60; n++) {
            const { scale } = tileLabel(rep(n));
            assert.ok(scale <= previous, `${n} characters grew back to ${scale}`);
            previous = scale;
        }
    });

    it('never goes below the floor, however absurd the name', () => {
        for (const n of [30, 100, 1000]) {
            const { text, scale } = tileLabel(rep(n));
            assert.ok(scale >= TILE_MIN_SCALE);
            assert.ok(text.length <= TILE_MAX_CHARS);
        }
    });

    it('is safe on nothing at all', () => {
        for (const empty of [undefined, null, '', '   ']) {
            assert.deepEqual(tileLabel(empty), { text: '', scale: 1 });
        }
    });

    it('trims, so surrounding space never eats the budget', () => {
        assert.deepEqual(tileLabel('  Feed  '), { text: 'Feed', scale: 1 });
    });
});
