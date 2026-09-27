/*
    The drawing's navigator (node/js/pure/viewport.js): zoom steps and the slider agree and stop at
    their ends; the minimap's red square is the part of the drawing the stage shows; and moving the
    square, or zooming, keeps the point asked for in the middle of the stage.
*/
const assert = require('node:assert');

let v;
before(async () => {
    v = await import('../../../js/pure/viewport.js');
});

// A 400x300 drawing shown at 2x on a 400x300 stage: 800x600, scrolled to its middle.
const zoomed = { scrollLeft: 200, scrollTop: 150, clientWidth: 400, clientHeight: 300, paperLeft: 0, paperTop: 0, paperWidth: 800, paperHeight: 600 };

describe('the navigator', () => {
    it('steps zoom in and out, stops exactly at the ends, and lands on the fit when passing it', () => {
        assert.equal(v.zoomIn(1), 1.5);
        assert.equal(v.zoomOut(1.5), 1);
        assert.equal(v.zoomOut(1), v.MIN_ZOOM, 'a little below fitting');
        assert.equal(v.zoomIn(v.MIN_ZOOM), v.FIT, 'back up to the fit, not past it');
        assert.equal(v.zoomOut(1.2), v.FIT, 'down to the fit, not past it');
        assert.equal(v.zoomIn(6), v.MAX_ZOOM, 'a step past the end lands on it');
        assert.equal(v.clampZoom(0.1), v.MIN_ZOOM);
        assert.equal(v.clampZoom(NaN), v.FIT);
    });

    it('maps the slider evenly in ratio, both ways', () => {
        assert.equal(v.sliderToZoom(0), v.MIN_ZOOM);
        assert.ok(Math.abs(v.sliderToZoom(v.SLIDER_STEPS) - v.MAX_ZOOM) < 1e-9);
        const half = v.sliderToZoom(v.SLIDER_STEPS / 2);
        assert.ok(Math.abs(half / v.MIN_ZOOM - v.MAX_ZOOM / half) < 1e-9, 'the middle is as far in ratio from each end');
        assert.equal(v.sliderToZoom(v.zoomToSlider(v.FIT)), v.FIT, 'the fit is a notch the slider lands on exactly');
        for (const z of [0.75, 1, 1.5, 2, 4, 8]) assert.ok(Math.abs(v.sliderToZoom(v.zoomToSlider(z)) - z) / z < 0.03, `${z}`);
    });

    it('fits the drawing to the stage, keeping its proportions', () => {
        assert.deepEqual(v.fitSize(1000, 600, 800, 600), [800, 600], 'held by the height');
        assert.deepEqual(v.fitSize(400, 600, 800, 600), [400, 300], 'held by the width');
    });

    it("draws the red square over what the stage shows", () => {
        assert.deepEqual(v.visibleFraction(zoomed), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
        const fitted = { ...zoomed, scrollLeft: 0, scrollTop: 0, paperLeft: 50, paperTop: 0, paperWidth: 300, paperHeight: 300 };
        assert.deepEqual(v.visibleFraction(fitted), { x: 0, y: 0, w: 1, h: 1 }, 'the whole drawing, when it fits');
    });

    it('scrolls a point to the middle, as far as the stage can go', () => {
        assert.deepEqual(v.scrollToCentre(zoomed, 0.5, 0.5), { left: 200, top: 150 });
        assert.deepEqual(v.scrollToCentre(zoomed, 0, 1), { left: 0, top: 300 }, 'the corners clamp');
        const c = v.centreOf({ ...zoomed, scrollLeft: 100 });
        assert.deepEqual(v.scrollToCentre({ ...zoomed, scrollLeft: 100 }, c.fx, c.fy), { left: 100, top: 150 }, 'centreOf and scrollToCentre agree');
    });
});
