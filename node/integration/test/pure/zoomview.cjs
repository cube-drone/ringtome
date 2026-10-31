/*
    The picture viewer (node/js/pure/zoomview.js): a shrunk picture opens fitted and centred, zooms
    at the pointer, pinches about the fingers' middle, and never shows a gap at an edge it could
    fill or zooms past its limits.
*/
const assert = require('node:assert');

let z;
before(async () => {
    z = await import('../../../js/pure/zoomview.js');
});

// An 800x600 photo on a 400x800 phone screen: fits at half size, 400x300, centred down the middle.
const box = { width: 400, height: 800 };
const pic = { width: 800, height: 600 };

describe('the picture viewer', () => {
    it('opens a picture fitted and centred, and never blows a small one up', () => {
        assert.deepEqual(z.fitted(box, pic), { scale: 0.5, x: 0, y: 250 });
        const small = { width: 100, height: 50 };
        assert.deepEqual(z.fitted(box, small), { scale: 1, x: 150, y: 375 });
    });

    it('zooms at the pointer, keeping the point under it still', () => {
        const v = z.zoomAt(box, pic, z.fitted(box, pic), 1, 100, 400);
        assert.equal(v.scale, 1);
        // The picture point under (100, 400) was (200, 300) in its own pixels; it still is.
        assert.equal((100 - v.x) / v.scale, 200);
        assert.equal((400 - v.y) / v.scale, 300);
    });

    it('stops at the fit and at four times the picture, and leaves no gap at an edge', () => {
        assert.equal(z.zoomAt(box, pic, z.fitted(box, pic), 0.1, 0, 0).scale, 0.5);
        assert.equal(z.zoomAt(box, pic, z.fitted(box, pic), 99, 0, 0).scale, z.MAX_SCALE);
        // Zoomed in and dragged far right: the picture's left edge stops at the box's.
        const v = z.settle(box, pic, { scale: 1, x: 500, y: -100 });
        assert.equal(v.x, 0);
        assert.equal(v.y, 100, 'still narrower than the box top to bottom, so centred');
    });

    it('drags with one finger and pinches with two, about their middle', () => {
        const start = { scale: 1, x: -200, y: 100 };
        const dragged = z.gesture(box, pic, start, [{ x: 200, y: 400 }], [{ x: 250, y: 400 }]);
        assert.deepEqual(dragged, { scale: 1, x: -150, y: 100 });
        const pinched = z.gesture(
            box,
            pic,
            start,
            [
                { x: 150, y: 400 },
                { x: 250, y: 400 },
            ],
            [
                { x: 100, y: 400 },
                { x: 300, y: 400 },
            ],
        );
        assert.equal(pinched.scale, 2);
        // The picture point under the middle (200, 400) - (400, 300) in its own pixels - stays put.
        assert.equal((200 - pinched.x) / pinched.scale, 400);
        assert.equal((400 - pinched.y) / pinched.scale, 300);
    });

    it('double taps in to its own pixels, and back out to the fit', () => {
        const fit = z.fitted(box, pic);
        const close = z.doubleTap(box, pic, fit, 200, 400);
        assert.equal(close.scale, 1);
        assert.deepEqual(z.doubleTap(box, pic, close, 200, 400), fit);
    });

    it('opens only a picture the page shows smaller than its own pixels', () => {
        assert.equal(z.shrunk({ width: 800, height: 600 }, { width: 300, height: 225 }), true);
        assert.equal(z.shrunk({ width: 300, height: 225 }, { width: 300, height: 225 }), false);
        assert.equal(z.shrunk({ width: 301, height: 225 }, { width: 300, height: 225 }), false);
    });
});
