/*
    The transform tool (node/js/pure/transform.js): a press takes hold of a corner, an edge, the
    inside or the outside of the frame; each drag makes one matrix - a corner slants (its opposite
    corner still), an edge scales across (its opposite edge still), inside moves, outside rotates -
    and shift makes each "perfect": whole scaling from an edge or a corner, rotation in 15-degree
    steps. And the matrix, stored as a transform entry, is what the layer is painted through.
*/
const assert = require('node:assert');

let x, d;
before(async () => {
    x = await import('../../../js/pure/transform.js');
    d = await import('../../../js/pure/drawing.js');
});

const frame = () => [[100, 100], [300, 100], [300, 200], [100, 200]];
const near = (a, b) => a.every((n, i) => Math.abs(n - b[i]) < 1e-9);
const nearFrame = (got, want) => got.every((p, i) => near(p, want[i]));
const after = (m) => x.frameThrough(m, frame());

describe('the transform tool', () => {
    it('takes hold of a corner, an edge, the inside or the outside', () => {
        assert.deepEqual(x.gripAt(frame(), [302, 98], 5), { kind: 'corner', i: 1 });
        assert.deepEqual(x.gripAt(frame(), [200, 203], 5), { kind: 'edge', i: 2 });
        assert.deepEqual(x.gripAt(frame(), [98, 150], 5), { kind: 'edge', i: 3 });
        assert.deepEqual(x.gripAt(frame(), [200, 150], 5), { kind: 'inside' });
        assert.deepEqual(x.gripAt(frame(), [400, 150], 5), { kind: 'outside' });
    });

    it('slants from a corner: the corner goes where it is dragged, the opposite corner stays, the frame stays a parallelogram', () => {
        const m = x.gestureMatrix(frame(), { kind: 'corner', i: 1 }, [300, 100], [340, 80]);
        const f = after(m);
        assert.ok(near(f[1], [340, 80]), 'the dragged corner');
        assert.ok(near(f[3], [100, 200]), 'the opposite corner');
        assert.ok(near(f[0], [140, 100]), 'sideways leans the top edge');
        assert.ok(near(f[2], [300, 180]), 'up leans the right edge');
        assert.ok(near([f[1][0] - f[0][0], f[1][1] - f[0][1]], [f[2][0] - f[3][0], f[2][1] - f[3][1]]), 'opposite sides still parallel and equal');
    });

    it('scales across from an edge, and evenly with shift', () => {
        const wider = after(x.gestureMatrix(frame(), { kind: 'edge', i: 1 }, [300, 150], [400, 170]));
        assert.ok(nearFrame(wider, [[100, 100], [400, 100], [400, 200], [100, 200]]), 'only across; the left edge stays');
        const even = after(x.gestureMatrix(frame(), { kind: 'edge', i: 1 }, [300, 150], [400, 150], true));
        assert.ok(nearFrame(even, [[100, 75], [400, 75], [400, 225], [100, 225]]), 'shift: the whole, about the left edge');
        const taller = after(x.gestureMatrix(frame(), { kind: 'edge', i: 0 }, [200, 100], [200, 50]));
        assert.ok(nearFrame(taller, [[100, 50], [300, 50], [300, 200], [100, 200]]), 'the top edge, the bottom still');
    });

    it('scales the whole from a corner with shift, about the opposite corner', () => {
        const m = x.gestureMatrix(frame(), { kind: 'corner', i: 2 }, [300, 200], [500, 300], true);
        assert.ok(nearFrame(after(m), [[100, 100], [500, 100], [500, 300], [100, 300]]));
    });

    it('moves from inside, and rotates from outside - in 15-degree steps with shift', () => {
        assert.deepEqual(x.gestureMatrix(frame(), { kind: 'inside' }, [200, 150], [210, 140]), [1, 0, 0, 1, 10, -10]);
        // From due right of the middle (200, 150) to a hair past 40 degrees round.
        const to = [200 + 100 * Math.cos(0.7), 150 + 100 * Math.sin(0.7)];
        const free = x.gestureMatrix(frame(), { kind: 'outside' }, [300, 150], to);
        assert.ok(Math.abs(Math.atan2(free[1], free[0]) - 0.7) < 1e-9, 'free: exactly as far as dragged');
        const snapped = x.gestureMatrix(frame(), { kind: 'outside' }, [300, 150], to, true);
        assert.ok(Math.abs(Math.atan2(snapped[1], snapped[0]) - (45 * Math.PI) / 180) < 1e-9, 'shift: to the nearest 15 degrees');
        assert.ok(near(x.frameThrough(snapped, [[200, 150]])[0], [200, 150]), 'about the middle');
    });

    it('is one entry, painted through by everything before it on the layer', () => {
        const stroke = { id: 'b000000000000001', t: 1, tool: 'brush', color: '#000000', size: 4, points: [10, 0] };
        const turn = { id: 'b000000000000002', t: 2, tool: 'transform', m: d.toFixed([0, 1, -1, 0, 0, 0]) };
        const later = { id: 'b000000000000003', t: 3, tool: 'brush', color: '#000000', size: 4, points: [10, 0] };
        const body = d.readBody(d.writeBody({ strokes: [stroke, turn, later], undone: [] }));
        assert.deepEqual(body.strokes[1], { id: 'b000000000000002', t: 2, tool: 'transform', m: [0, 1000000, -1000000, 0, 0, 0] });
        const { each } = d.matricesOf(d.strokesOn(body, d.BASE_LAYER));
        assert.ok(near(d.apply(each[0], [10, 0]), [0, 10]), 'the stroke before it turns');
        assert.ok(near(d.apply(each[2], [10, 0]), [10, 0]), 'the stroke after it does not');
    });

    it('finds the box round what a layer has painted', () => {
        const data = new Uint8ClampedArray(10 * 8 * 4);
        data[(3 * 10 + 2) * 4 + 3] = 255;
        data[(5 * 10 + 6) * 4 + 3] = 1;
        assert.deepEqual(x.paintedBox(data, 10, 8, 2), [1, 1.5, 3.5, 3]);
        assert.equal(x.paintedBox(new Uint8ClampedArray(16), 2, 2, 1), null);
    });
});

describe('the crop box', () => {
    const box = [100, 100, 300, 200];
    const canvas = [800, 600];

    it('moves a corner or an edge by itself', () => {
        assert.deepEqual(x.dragBox(box, { kind: 'corner', i: 2 }, [300, 200], [350, 260], canvas), [100, 100, 350, 260]);
        assert.deepEqual(x.dragBox(box, { kind: 'corner', i: 0 }, [100, 100], [90, 120], canvas), [90, 120, 300, 200]);
        assert.deepEqual(x.dragBox(box, { kind: 'edge', i: 3 }, [100, 150], [40, 170], canvas), [40, 100, 300, 200], 'the left edge, across only');
    });

    it('moves the whole box from inside, keeping its size and the canvas round it', () => {
        assert.deepEqual(x.dragBox(box, { kind: 'inside' }, [200, 150], [230, 140], canvas), [130, 90, 330, 190]);
        assert.deepEqual(x.dragBox(box, { kind: 'inside' }, [200, 150], [2000, -900], canvas), [600, 0, 800, 100], 'stops at the edge, same size');
    });

    it('draws a fresh box from outside, and turns an inside-out box the right way round', () => {
        assert.deepEqual(x.dragBox(box, { kind: 'new' }, [500, 400], [450, 300], canvas), [450, 300, 500, 400]);
        assert.deepEqual(x.dragBox(box, { kind: 'edge', i: 1 }, [300, 150], [20, 150], canvas), [20, 100, 100, 200], 'the right edge dragged past the left');
        assert.deepEqual(x.dragBox(box, { kind: 'corner', i: 2 }, [300, 200], [900, 700], canvas), [100, 100, 800, 600], 'never past the canvas');
    });
});

describe('a box whose shape is fixed (set as profile, set as banner)', () => {
    const canvas = [800, 600];
    const shape = (b) => (b[2] - b[0]) / (b[3] - b[1]);

    it('is laid down as large as fits the middle of the canvas, centred', () => {
        assert.deepEqual(x.fitBox(1, canvas), [160, 60, 640, 540]);
        assert.deepEqual(x.fitBox(3.2, canvas), [80, 200, 720, 400]);
    });

    it('grows from a corner by whichever way the pointer went further, holding the opposite corner', () => {
        const box = [100, 100, 300, 200]; // 2 to 1
        assert.deepEqual(x.dragBoxAt(box, { kind: 'corner', i: 2 }, [300, 200], [340, 260], canvas, 2), [100, 100, 420, 260]);
        assert.deepEqual(x.dragBoxAt(box, { kind: 'corner', i: 0 }, [100, 100], [80, 100], canvas, 2), [80, 90, 300, 200]);
    });

    it('grows from an edge about its middle, holding the opposite edge', () => {
        const box = [100, 100, 300, 200];
        assert.deepEqual(x.dragBoxAt(box, { kind: 'edge', i: 1 }, [300, 150], [340, 150], canvas, 2), [100, 90, 340, 210]);
        assert.deepEqual(x.dragBoxAt(box, { kind: 'edge', i: 0 }, [200, 100], [200, 80], canvas, 2), [80, 80, 320, 200]);
    });

    it('stays inside the canvas and the right way round, shrinking rather than changing shape', () => {
        const box = [100, 100, 300, 200];
        const out = x.dragBoxAt(box, { kind: 'corner', i: 2 }, [300, 200], [2000, 2000], canvas, 2);
        assert.deepEqual(out, [100, 100, 800, 450]);
        const crushed = x.dragBoxAt(box, { kind: 'corner', i: 2 }, [300, 200], [-500, -500], canvas, 2);
        assert.deepEqual(crushed, [100, 100, 108, 104], 'a sliver, never inside out');
        const drawn = x.dragBoxAt(box, { kind: 'new' }, [700, 500], [600, 480], canvas, 3.2);
        assert.deepEqual(drawn, [600, 468.75, 700, 500], 'up and left from where it began');
        assert.equal(shape(x.dragBoxAt(box, { kind: 'edge', i: 2 }, [200, 200], [200, 590], canvas, 2)), 2);
        assert.deepEqual(x.dragBoxAt(box, { kind: 'inside' }, [200, 150], [230, 140], canvas, 2), [130, 90, 330, 190], 'the inside moves it, as a crop');
    });
});

describe('cropping', () => {
    const brush = (id, t, pts, extra = {}) => ({ id, t, tool: 'brush', color: '#000000', size: 4, points: d.encodePoints(pts), ...extra });

    it('cuts the canvas down, and shifts every layer that came before it', () => {
        let body = d.addLayer(d.blankDrawing(), 'aaaaaaaaaaaaaaa2', 1);
        body = d.addStroke(body, brush('b000000000000001', 2, [[300, 200]]));
        body = d.addStroke(body, brush('b000000000000002', 3, [[400, 250]], { layer: 'aaaaaaaaaaaaaaa2' }));
        const crop = d.cropEntry(body, [500.4, 350, 250, 150], { id: 'c000000000000003', t: 4 });
        assert.deepEqual(crop, { id: 'c000000000000003', t: 4, tool: 'crop', points: [250, 150, 500, 350] }, 'rounded, the right way round');
        body = d.addStroke(body, crop);
        assert.deepEqual(d.sizeOf(body), [250, 200]);
        assert.deepEqual([body.width, body.height], [800, 600], "the body's own size is the canvas it began as");
        for (const layer of [d.BASE_LAYER, 'aaaaaaaaaaaaaaa2']) {
            const ops = d.effectiveOps(body, layer);
            const at = d.matricesOf(ops).each[ops.findIndex((o) => o.tool === 'brush')];
            assert.deepEqual(d.apply(at, [300, 200]), [50, 50], `on ${layer}`);
        }
        assert.ok(!d.layersOf(body).some((l) => l.id === d.BASE_LAYER && l.n !== 1), 'a crop is on no layer');
        assert.deepEqual(d.sizeOf(d.undo(body)), [800, 600], 'undo gives the whole canvas back');
    });

    it('crops again inside the last crop, and refuses a crop that cuts nothing or everything', () => {
        let body = d.addStroke(d.blankDrawing(), d.cropEntry(d.blankDrawing(), [100, 100, 500, 400], { id: 'c000000000000001', t: 1 }));
        assert.equal(d.cropEntry(body, [0, 0, 400, 300], { id: 'c000000000000002', t: 2 }), null, 'the whole canvas as it stands');
        assert.equal(d.cropEntry(body, [50, 50, 50, 90], { id: 'c000000000000002', t: 2 }), null, 'nothing');
        body = d.addStroke(body, d.cropEntry(body, [-20, 10, 200, 999], { id: 'c000000000000002', t: 2 }));
        assert.deepEqual(d.sizeOf(body), [200, 290], 'kept inside the canvas as it stood');
    });

    it('lays a pour before a crop over the canvas it found', () => {
        const pour = { id: 'e000000000000001', t: 1, tool: 'bucket', color: '#1f9e90', points: [5, 5], reach: 5000 };
        let body = d.addStroke(d.blankDrawing(), pour);
        body = d.addStroke(body, d.cropEntry(body, [0, 0, 100, 100], { id: 'c000000000000002', t: 2 }));
        const ops = d.effectiveOps(body, d.BASE_LAYER);
        assert.deepEqual(d.sizeAfter(body, ops.slice(0, ops.findIndex((o) => o.tool === 'bucket'))), [800, 600]);
    });
});
