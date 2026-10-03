/*
    The paint bucket (node/js/pure/pour.js): a pour spreads from where it was dropped, as far as its
    reach, and stops at the lines on its layer as they stood when it was poured - worked out from the
    body alone, so every computer paints the same fill. And the pour is an entry in the history like
    any stroke (pure/drawing.js): kept exactly, undone the same way.
*/
const assert = require('node:assert');

let p, d;
before(async () => {
    p = await import('../../../js/pure/pour.js');
    d = await import('../../../js/pure/drawing.js');
});

const W = 800;
const H = 600;
const line = (id, t, pts, size = 4, extra = {}) => ({
    id,
    t,
    tool: 'brush',
    color: '#000000',
    size,
    points: d.encodePoints(pts),
    ...extra,
});
const box = (id, t, [x0, y0, x1, y1]) =>
    line(id, t, [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
    ]);
const pour = (id, t, x, y, reach = 5000) => ({
    id,
    t,
    tool: 'bucket',
    color: '#1f9e90',
    points: [x, y],
    reach,
});
const covered = (runs) => {
    let n = 0;
    for (let k = 0; k < runs.length; k += 3) n += runs[k + 2] - runs[k + 1] + 1;
    return n;
};
const has = (runs, x, y) => {
    for (let k = 0; k < runs.length; k += 3)
        if (runs[k] === y && runs[k + 1] <= x && x <= runs[k + 2]) return true;
    return false;
};

describe('pouring', () => {
    it('fills inside a closed line and stops at it', () => {
        const ops = [
            box('b000000000000001', 1, [100, 100, 300, 300]),
            pour('e000000000000001', 2, 200, 200),
        ];
        const runs = p.pourRuns(ops, 1, W, H);
        // A size-4 line's core is 1.5 either side of it: cells 98..101 are wall, 102..297 inside.
        assert.equal(covered(runs), 196 * 196);
        assert.ok(has(runs, 102, 102) && !has(runs, 101, 200) && !has(runs, 350, 200));
    });

    it('spreads only as far as its reach, as a rough circle', () => {
        const runs = p.pourRuns([pour('e000000000000001', 1, 400, 300, 50)], 0, W, H);
        assert.ok(
            has(runs, 450, 300) && !has(runs, 451, 300),
            'straight across: exactly the reach',
        );
        assert.ok(
            has(runs, 435, 335) && !has(runs, 440, 340),
            'diagonally: about the reach, not a square corner',
        );
        assert.deepEqual(
            p.pourRuns([pour('e000000000000001', 1, 400, 300, 0)], 0, W, H),
            [300, 400, 400],
            'no reach is the drop alone',
        );
    });

    it('cannot slip between the pixels of a thin diagonal line', () => {
        const diagonal = line(
            'b000000000000001',
            1,
            [
                [0, 0],
                [600, 600],
            ],
            1,
        );
        const runs = p.pourRuns([diagonal, pour('e000000000000001', 2, 500, 100)], 1, W, H);
        assert.ok(!has(runs, 100, 500), 'the far side of the line stays dry');
        assert.ok(has(runs, 700, 100));
    });

    it('never steps diagonally between two walls that touch only at their corners', () => {
        // A staircase of single cells, joined corner to corner - what a line a pixel wide would be
        // if its own thickness did not already close it.
        const walls = new Uint8Array(10 * 10);
        for (let i = 0; i < 10; i++) walls[i * 10 + i] = 1;
        const dist = p.pourField(walls, 10, 10, 8, 1);
        assert.equal(dist[1 * 10 + 8] >= 0, true);
        assert.equal(dist[8 * 10 + 1], -1, 'below the staircase stays dry');
    });

    it('meets the lines where they stood when it was poured: grabs before it count, strokes after it do not', () => {
        const drawn = box('b000000000000001', 1, [100, 100, 300, 300]);
        const moved = { id: 'd000000000000002', t: 2, tool: 'move', dx: 300, dy: 0 };
        // Poured where the box was before the grab: it has gone from there, so the pour runs free.
        const ops = [
            drawn,
            moved,
            pour('e000000000000003', 3, 200, 200),
            line('b000000000000004', 4, [
                [0, 50],
                [800, 50],
            ]),
        ];
        assert.ok(
            covered(p.pourRuns(ops, 2, W, H)) > 400000,
            'the box moved away; the line after the pour is no wall',
        );
        // Poured inside the box where it now is: held in.
        assert.equal(
            covered(p.pourRuns([drawn, moved, pour('e000000000000003', 3, 500, 200)], 2, W, H)),
            196 * 196,
        );
    });

    it('leaks through a gap an eraser opened, and never out of a line it was dropped on', () => {
        const drawn = box('b000000000000001', 1, [100, 100, 300, 300]);
        const gap = {
            id: 'b000000000000002',
            t: 2,
            tool: 'eraser',
            size: 20,
            points: d.encodePoints([[300, 200]]),
        };
        assert.ok(
            covered(p.pourRuns([drawn, gap, pour('e000000000000003', 3, 200, 200)], 2, W, H)) >
                400000,
        );
        assert.deepEqual(
            p.pourRuns([drawn, pour('e000000000000003', 3, 100, 200)], 1, W, H),
            [],
            'dropped on the line itself',
        );
    });

    it('is an entry like a stroke: kept exactly, merged by the union, undone', () => {
        const poured = d.addStroke(
            d.addStroke(d.blankDrawing(), box('b000000000000001', 1, [1, 1, 9, 9])),
            pour('e000000000000002', 2, 5, 5, 12),
        );
        const back = d.readBody(d.writeBody(poured));
        assert.deepEqual(back.strokes[1], {
            id: 'e000000000000002',
            t: 2,
            tool: 'bucket',
            color: '#1f9e90',
            points: [5, 5],
            reach: 12,
        });
        assert.deepEqual(
            d.recentColours(back),
            ['#1f9e90'],
            "a pour's colour is one of the drawing's colours",
        );
        assert.equal(d.undo(back).strokes.length, 1, 'undo takes the pour back first');
    });
});

describe('pouring into shapes', () => {
    const shape = (tool, box, size = 4) => ({
        id: 'b000000000000001',
        t: 1,
        tool,
        color: '#000000',
        size,
        points: box,
    });

    it('fills a rectangle exactly, square to its corners', () => {
        const runs = p.pourRuns(
            [shape('rect', [100, 100, 300, 200]), pour('e000000000000002', 2, 200, 150)],
            1,
            W,
            H,
        );
        // The 4-wide outline's core is 1.5 either side: 98..101 and 198..201 are wall.
        assert.equal(covered(runs), 196 * 96);
        assert.ok(has(runs, 102, 102) && has(runs, 297, 197), 'right into the corners');
        const outside = p.pourRuns(
            [shape('rect', [100, 100, 300, 200]), pour('e000000000000002', 2, 50, 50)],
            1,
            W,
            H,
        );
        assert.ok(
            has(outside, 97, 97) && !has(outside, 98, 98),
            'and the outside meets the square corner - a rounded one would leave (98, 98) open',
        );
    });

    it('fills an ellipse and nothing outside it', () => {
        const runs = p.pourRuns(
            [shape('ellipse', [200, 100, 600, 500]), pour('e000000000000002', 2, 400, 300)],
            1,
            W,
            H,
        );
        const area = Math.PI * 198 * 198;
        assert.ok(
            Math.abs(covered(runs) - area) / area < 0.01,
            `about the circle inside the line: ${covered(runs)} vs ${Math.round(area)}`,
        );
        assert.ok(!has(runs, 205, 105), 'the box corner is outside');
    });

    it('treats a dragged line as the brush stroke it is', () => {
        const d2 = d.shapeEntry('line', [0, 300], [800, 300], {
            id: 'b000000000000001',
            t: 1,
            color: '#000000',
            size: 4,
        });
        const runs = p.pourRuns([d2, pour('e000000000000002', 2, 400, 100)], 1, W, H);
        assert.ok(has(runs, 400, 297) && !has(runs, 400, 303), 'held above the line');
    });
});
