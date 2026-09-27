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
