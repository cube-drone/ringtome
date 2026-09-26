/*
    The drawing app's colour picker (node/js/pure/colour.js): hex, RGB and HSV, and the hue ring
    with its HSV triangle. The promise worth pinning is that the triangle is a two-way mapping - every
    colour has one point and every point one colour - so a round trip through it lands where it
    started; and that a drag leaving the triangle slides along its edge.
*/
const assert = require('node:assert');

let c;
before(async () => {
    c = await import('../../../js/pure/colour.js');
});

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

describe('colour', () => {
    it('reads and writes hex, in the lowercase form strokes store', () => {
        assert.deepEqual(c.hexToRgb('#8A4B1F'), [0x8a, 0x4b, 0x1f]);
        assert.deepEqual(c.hexToRgb('fff'), [255, 255, 255], 'the short form');
        assert.equal(c.hexToRgb('#12345'), null);
        assert.equal(c.hexToRgb('red'), null);
        assert.equal(c.rgbToHex([138, 75, 31]), '#8a4b1f');
        assert.equal(c.rgbToHex([300, -4, 127.6]), '#ff0080', 'clamped and rounded');
    });

    it('goes to HSV and back without drifting', () => {
        for (const hex of ['#8a4b1f', '#1f9e90', '#7a1f6e', '#000000', '#ffffff', '#808080', '#ff0000', '#00ff00', '#0000ff']) {
            assert.equal(c.rgbToHex(c.hsvToRgb(c.rgbToHsv(c.hexToRgb(hex)))), hex, hex);
        }
        const red = c.rgbToHsv([255, 0, 0]);
        assert.ok(near(red.h, 0) && near(red.s, 1) && near(red.v, 1));
        assert.ok(near(c.rgbToHsv([0, 0, 255]).h, 240));
    });

    it("puts the triangle's corners at the hue, white and black", () => {
        const corners = c.triangleCorners(90, 100, 100, 50);
        assert.ok(near(corners.hue[0], 100) && near(corners.hue[1], 150), 'the hue corner points at the hue');
        const at = (p) => c.pointToSv(p, corners);
        assert.deepEqual([at(corners.hue).s, at(corners.hue).v].map((n) => +n.toFixed(6)), [1, 1], 'the pure hue');
        assert.deepEqual([at(corners.white).s, at(corners.white).v].map((n) => +n.toFixed(6)), [0, 1], 'white');
        assert.ok(near(at(corners.black).v, 0), 'black');
    });

    it('maps every colour to one point and back again', () => {
        for (const h of [0, 47, 200, 333]) {
            const corners = c.triangleCorners(h, 80, 80, 60);
            for (const s of [0.1, 0.5, 0.9, 1]) {
                for (const v of [0.2, 0.6, 1]) {
                    const back = c.pointToSv(c.svToPoint({ s, v }, corners), corners);
                    assert.ok(near(back.s, s, 1e-9) && near(back.v, v, 1e-9), `h=${h} s=${s} v=${v} -> ${JSON.stringify(back)}`);
                }
            }
        }
    });

    it('slides a point outside the triangle onto its nearest edge', () => {
        const corners = c.triangleCorners(0, 0, 0, 10);
        const inside = [1, 1];
        assert.deepEqual(c.clampToTriangle(inside, corners), inside, 'inside stays put');
        const far = c.clampToTriangle([100, 0], corners);
        assert.ok(near(far[0], corners.hue[0]) && near(far[1], corners.hue[1]), 'past the hue corner is the hue corner');
        const sv = c.pointToSv([100, 0], corners);
        assert.ok(near(sv.s, 1) && near(sv.v, 1));
    });

    it('reads a hue off the ring, clockwise from the right', () => {
        assert.ok(near(c.hueAt(10, 0, 0, 0), 0));
        assert.ok(near(c.hueAt(0, 10, 0, 0), 90), 'down the screen is a quarter turn');
        assert.ok(near(c.hueAt(-10, 0, 0, 0), 180));
        assert.ok(c.onRing(0, 45, 0, 0, 40, 50) && !c.onRing(0, 30, 0, 0, 40, 50));
    });
});
