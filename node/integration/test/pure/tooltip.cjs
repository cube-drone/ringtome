/*
    The house tooltip (node/js/pure/tooltip.js): it waits a moment before showing, but not when the
    pointer has just come from another; and it sits under what it is about, over it when there is no
    room below, and inside the window always.
*/
const assert = require('node:assert');

let tip;
before(async () => {
    tip = await import('../../../js/pure/tooltip.js');
});

describe('the house tooltip', () => {
    it('shows after a short rest - or at once, straight after another', () => {
        assert.equal(tip.tipDelay(10000, -Infinity), tip.SHOW_MS);
        assert.ok(tip.SHOW_MS < 1000, 'quicker than the browser');
        assert.equal(tip.tipDelay(10000, 10000 - 100), 0, 'moving along a row of chips');
        assert.equal(
            tip.tipDelay(10000, 10000 - tip.WARM_MS - 1),
            tip.SHOW_MS,
            'a while later, the rest again',
        );
    });

    it('sits centred over its anchor, clear of the cursor, flipping below and staying inside the window', () => {
        const viewport = { width: 1000, height: 800 };
        const size = { width: 120, height: 30 };
        assert.deepEqual(
            tip.placeTip({ left: 400, right: 440, top: 300, bottom: 320 }, size, viewport),
            { left: 360, top: 264, above: true },
        );
        assert.deepEqual(
            tip.placeTip({ left: 400, right: 440, top: 20, bottom: 40 }, size, viewport),
            { left: 360, top: 46, above: false },
            'no room above: below',
        );
        assert.equal(
            tip.placeTip({ left: 0, right: 20, top: 300, bottom: 320 }, size, viewport).left,
            8,
            'not off the left',
        );
        assert.equal(
            tip.placeTip({ left: 980, right: 1000, top: 300, bottom: 320 }, size, viewport).left,
            872,
            'not off the right',
        );
    });
});
