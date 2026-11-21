/*
    A pie's arithmetic (js/pure/pie.js): each part's wedge of the circle.
*/
const assert = require('node:assert');

let wedges;
before(async () => {
    ({ wedges } = await import('../../../js/pure/pie.js'));
});

describe('a pie', () => {
    it('gives each part its share of the circle, in order, and nothing to an empty part', () => {
        assert.deepEqual(wedges([1, 0, 1, 2]), [
            { from: 0, to: 0.25 },
            null,
            { from: 0.25, to: 0.5 },
            { from: 0.5, to: 1 },
        ]);
    });

    it('gives one part alone the whole circle', () => {
        assert.deepEqual(wedges([0, 7]), [null, { from: 0, to: 1 }]);
    });

    it('draws nothing when nothing has anything', () => {
        assert.deepEqual(wedges([0, 0]), [null, null]);
        assert.deepEqual(wedges([-3, undefined]), [null, null]);
        assert.deepEqual(wedges(undefined), []);
    });
});
