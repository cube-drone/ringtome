/*
    A drawing's body (DRAWING.md, node/js/pure/drawing.js): strokes stored as delta-coded integers,
    undo as a recorded removal, and the merge - both sets of strokes, minus both sets of undone, in
    one order. The merge's promises are invariants, so they are tested as invariants: it does not
    matter which way round two versions are merged, merging a version with itself changes nothing,
    and no merge brings back a stroke somebody undid.
*/
const assert = require('node:assert');

let d;
before(async () => {
    d = await import('../../../js/pure/drawing.js');
});

let counter = 0;
const stroke = (t, extra = {}) => ({
    id: (++counter).toString(16).padStart(16, '0'),
    t,
    tool: 'brush',
    color: '#8a4b1f',
    size: 8,
    points: [10, 10, 2, 3],
    ...extra,
});

describe('a drawing', () => {
    it('stores points as whole-unit steps, and reads them back', () => {
        const pts = [[10.4, 20.6], [12, 21], [12, 21], [15, 19]];
        const enc = d.encodePoints(pts);
        assert.deepEqual(enc, [10, 21, 2, 0, 3, -2], 'rounded, delta-coded, the repeat dropped');
        assert.deepEqual(d.decodePoints(enc), [[10, 21], [12, 21], [15, 19]]);
        assert.deepEqual(d.encodePoints([[5, 5], [5, 5]]), [5, 5], 'a dab keeps its one point');
        assert.deepEqual(d.decodePoints([1, 2, 3]), [[1, 2]], 'a stray trailing number is ignored');
    });

    it('undoes stroke by stroke back to a blank canvas, remembering each', () => {
        let body = d.blankDrawing();
        const a = stroke(1), b = stroke(2), c = stroke(3);
        for (const s of [c, a, b]) body = d.addStroke(body, s);
        assert.deepEqual(body.strokes.map((s) => s.id), [a.id, b.id, c.id], 'kept in the order they were drawn');
        body = d.undo(body);
        assert.deepEqual(body.strokes.map((s) => s.id), [a.id, b.id]);
        assert.deepEqual(body.undone, [c.id]);
        body = d.undo(d.undo(body));
        assert.deepEqual(body.strokes, []);
        assert.deepEqual(body.undone, [c.id, b.id, a.id]);
        assert.strictEqual(d.undo(body), body, 'nothing left to undo is no change');
    });

    it('merges two histories into both sets of strokes, in the order they were drawn', () => {
        const base = d.addStroke(d.blankDrawing(), stroke(1));
        const mine = d.addStroke(base, stroke(5));
        const theirs = d.addStroke(d.addStroke(base, stroke(3)), stroke(7));
        const merged = d.mergeBodies(mine, theirs);
        assert.deepEqual(merged.strokes.map((s) => s.t), [1, 3, 5, 7]);
    });

    it("never brings back a stroke somebody undid, whichever version still has it", () => {
        const s1 = stroke(1), s2 = stroke(2);
        const both = d.addStroke(d.addStroke(d.blankDrawing(), s1), s2);
        const undoneHere = d.undo(both); // s2 undone on this device
        const merged = d.mergeBodies(both, undoneHere);
        assert.deepEqual(merged.strokes.map((s) => s.id), [s1.id]);
        assert.deepEqual(merged.undone, [s2.id]);
    });

    it('merges the same way round either way, and a version with itself is itself', () => {
        const a = d.undo(d.addStroke(d.addStroke(d.blankDrawing(), stroke(1)), stroke(4)));
        const b = d.addStroke(d.addStroke(d.blankDrawing(), stroke(2)), stroke(3));
        const c = d.addStroke(b, stroke(0));
        assert.deepEqual(d.writeBody(d.mergeBodies(a, b)), d.writeBody(d.mergeBodies(b, a)), 'commutative');
        assert.deepEqual(
            d.writeBody(d.mergeBodies(d.mergeBodies(a, b), c)),
            d.writeBody(d.mergeBodies(a, d.mergeBodies(b, c))),
            'associative'
        );
        assert.deepEqual(d.writeBody(d.mergeBodies(a, a)), d.writeBody(a), 'idempotent');
    });

    it('reads anything without throwing, keeping only strokes it can paint', () => {
        assert.deepEqual(d.readBody('not json').strokes, []);
        assert.deepEqual(d.readBody(null).strokes, []);
        const good = stroke(1);
        const body = d.readBody({
            strokes: [
                good,
                { ...stroke(2), tool: 'laser' },
                { ...stroke(3), points: [1.5, 2] },
                { ...stroke(4), color: 'red' },
                { ...stroke(5), id: 'not-hex' },
                { ...stroke(6), size: 12.5 },
                { ...stroke(7), tool: 'eraser', color: undefined },
                { ...good, color: '#000000' },
            ],
        });
        assert.deepEqual(body.strokes.map((s) => s.tool), ['brush', 'eraser'], 'only what can be painted, exactly');
        assert.equal(body.strokes[0].color, good.color, 'the first stroke of an id wins');
        assert.equal(body.width, d.CANVAS_WIDTH);
    });

    it('writes the same drawing as the same bytes, whatever order it was built in', () => {
        const s1 = stroke(1), s2 = stroke(2);
        const one = d.addStroke(d.addStroke(d.blankDrawing(), s1), s2);
        const two = d.addStroke(d.addStroke(d.blankDrawing(), s2), s1);
        assert.equal(d.writeBody(one), d.writeBody(two));
        assert.deepEqual(d.readBody(d.writeBody(one)), d.readBody(one), 'and reads back what it wrote');
    });

    it('mints distinct 64-bit ids', () => {
        const ids = new Set(Array.from({ length: 200 }, () => d.strokeId()));
        assert.equal(ids.size, 200);
        assert.match(d.strokeId(() => [1, 255]), /^00000001000000ff$/);
    });
});

// The conformance boundary with the node (node/src/drawing.rs): the browser writes bodies, the node
// merges them, and both must produce these exact bytes (spec/test-vectors/drawing-v1.json).
describe('a drawing, as the shared vectors say', () => {
    const vectors = require('../../../../spec/test-vectors/drawing-v1.json');

    it('writes every canonical case byte for byte', () => {
        assert.ok(vectors.canonical.length >= 5);
        for (const c of vectors.canonical) assert.equal(d.writeBody(c.input), c.written, c.name);
    });

    it('merges every case byte for byte, in either order', () => {
        for (const c of vectors.merge) {
            assert.equal(d.writeBody(d.mergeBodies(...c.bodies)), c.merged, c.name);
            assert.equal(d.writeBody(d.mergeBodies(...[...c.bodies].reverse())), c.merged, `${c.name} (reversed)`);
        }
    });
});

// The swatch row under the picker (Curtis, 2026-09-26): white and black, then the last ten colours
// this drawing's strokes used.
describe("a drawing's recent colours", () => {
    const at = (t, color, tool = 'brush') => ({ id: t.toString(16).padStart(16, '0'), t, tool, color, size: 4, points: [1, 1] });

    it('are its strokes\' colours, newest first, each once, never white or black', () => {
        let body = d.blankDrawing();
        for (const s of [at(1, '#aa0000'), at(2, '#00aa00'), at(3, '#ffffff'), at(4, '#aa0000'), at(5, '#000000'), at(6, '#0000aa')]) {
            body = d.addStroke(body, s);
        }
        assert.deepEqual(d.recentColours(body), ['#0000aa', '#aa0000', '#00aa00']);
        assert.deepEqual(d.FIXED_COLOURS, ['#ffffff', '#000000']);
    });

    it('stop at ten, skip the eraser, and forget an undone stroke\'s colour', () => {
        let body = d.blankDrawing();
        for (let i = 1; i <= 12; i++) body = d.addStroke(body, at(i, `#0000${(i * 16).toString(16).padStart(2, '0')}`));
        body = d.addStroke(body, { ...at(13, undefined, 'eraser') });
        const ten = d.recentColours(body);
        assert.equal(ten.length, 10);
        assert.equal(ten[0], '#0000c0', 'the eraser has no colour to offer');
        assert.equal(d.recentColours(d.undo(d.undo(body)))[0], '#0000b0', 'an undone stroke takes its colour with it');
        assert.deepEqual(d.recentColours(d.blankDrawing()), []);
    });
});

// Pressure (Curtis, 2026-09-26): a pen stroke keeps one 0..100 per point; a mouse stroke keeps none.
describe('a pen stroke', () => {
    it('keeps a pressure for every point it keeps, in step even when a repeat is dropped', () => {
        const { points, pressure } = d.encodeSamples([[10, 10, 0.2], [12, 11, 0.5], [12, 11, 0.9], [15, 11, 1.4]]);
        assert.deepEqual(points, [10, 10, 2, 1, 3, 0]);
        assert.deepEqual(pressure, [20, 50, 100], 'the repeat left with its pressure; full is 100');
    });

    it('takes a pen\'s pressure smoothed, so a shaky hand draws a steady line (2026-09-28)', () => {
        assert.equal(d.smoothPressure(null, 0.4), 0.4, 'the first sample is the pen\'s own word');
        const step = d.smoothPressure(0.5, 1);
        assert.ok(step > 0.5 && step < 1, 'a press moves the line part of the way, not all of it');
        // Jitter around a steady grip: the running pressure wobbles far less than the pen did.
        let p = null;
        const raw = [0.5, 0.62, 0.41, 0.6, 0.39, 0.61, 0.4, 0.59];
        const kept = raw.map((r) => (p = d.smoothPressure(p, r)));
        const swing = (xs) => Math.max(...xs.slice(3)) - Math.min(...xs.slice(3));
        assert.ok(swing(kept) < swing(raw) / 2, `steadier: ${swing(kept).toFixed(3)} against ${swing(raw).toFixed(3)}`);
        // ...and a real change of grip still arrives within a handful of samples.
        p = 0.2;
        for (let i = 0; i < 8; i++) p = d.smoothPressure(p, 0.9);
        assert.ok(p > 0.85, `a deliberate press lands: ${p.toFixed(3)}`);
    });

    it('has no pressure when drawn with a mouse, or when any sample lacks one', () => {
        assert.equal(d.encodeSamples([[1, 1], [2, 2]]).pressure, null);
        assert.equal(d.encodeSamples([[1, 1, 0.5], [2, 2]]).pressure, null);
        assert.deepEqual(d.encodeSamples([[4, 4]]).points, [4, 4], 'a dab');
    });

    it('is never thinner than a hair, and full width at full pressure', () => {
        assert.equal(d.pressureWidth(100), 1);
        assert.ok(Math.abs(d.pressureWidth(0) - 0.15) < 1e-9);
        assert.ok(d.pressureWidth(50) > d.pressureWidth(10));
        assert.equal(d.pressureWidth(500), 1, 'clamped');
    });
});

// Layers (Curtis, 2026-09-26): a stack of transparent slices, each hideable, each with an opacity.
describe('layers', () => {
    const L2 = 'aaaaaaaaaaaaaaa2';
    const L3 = 'aaaaaaaaaaaaaaa3';

    it('are one base layer until there are more, and a drawing with none writes no layers at all', () => {
        const blank = d.blankDrawing();
        assert.deepEqual(d.layersOf(blank).map((l) => [l.id, l.n, l.z, l.opacity, l.hidden]), [[d.BASE_LAYER, 1, 0, 100, false]]);
        assert.ok(!d.writeBody(blank).includes('layers'), 'the same bytes as before layers');
        const onBase = d.addStroke(blank, { id: 'b000000000000001', t: 1, layer: d.BASE_LAYER, tool: 'brush', color: '#123456', size: 3, points: [1, 1] });
        assert.ok(!d.writeBody(onBase).includes('"layer"'), 'a base-layer stroke names no layer');
    });

    it('add on top, change, and move - renumbering only what moved', () => {
        let body = d.addLayer(d.blankDrawing(), L2, 10);
        body = d.addLayer(body, L3, 11);
        assert.deepEqual(d.layersOf(body).map((l) => [l.id, l.n, l.z]), [[d.BASE_LAYER, 1, 0], [L2, 2, 1], [L3, 3, 2]]);
        body = d.setLayer(body, L2, { hidden: true, opacity: 40 }, 12);
        const l2 = d.layersOf(body).find((l) => l.id === L2);
        assert.deepEqual([l2.hidden, l2.opacity, l2.t], [true, 40, 12]);
        body = d.moveLayer(body, L3, 1, 13);
        assert.deepEqual(d.layersOf(body).map((l) => l.id), [d.BASE_LAYER, L3, L2], 'the top two swapped');
        assert.ok(!body.layers.some((l) => l.id === d.BASE_LAYER), 'the base layer did not move, so nothing was written for it');
        body = d.moveLayer(body, L2, 0, 14);
        assert.deepEqual(d.layersOf(body).map((l) => l.id), [L2, d.BASE_LAYER, L3], 'the top layer to the bottom');
        body = d.readBody(d.writeBody(body));
        assert.deepEqual(d.layersOf(body).map((l) => l.id), [L2, d.BASE_LAYER, L3], 'and it all survives a save');
    });

    it('keep their own strokes', () => {
        let body = d.addLayer(d.blankDrawing(), L2, 1);
        body = d.addStroke(body, { id: 'b000000000000001', t: 2, tool: 'brush', color: '#123456', size: 3, points: [1, 1] });
        body = d.addStroke(body, { id: 'b000000000000002', t: 3, layer: L2, tool: 'brush', color: '#123456', size: 3, points: [1, 1] });
        assert.deepEqual(d.strokesOn(body, d.BASE_LAYER).map((s) => s.id), ['b000000000000001']);
        assert.deepEqual(d.strokesOn(body, L2).map((s) => s.id), ['b000000000000002']);
    });

    it('merge: every layer kept, and the later change to a layer wins, whichever way round', () => {
        const base = d.addLayer(d.blankDrawing(), L2, 10);
        const here = d.setLayer(base, L2, { hidden: true }, 20);
        const there = d.addLayer(d.setLayer(base, L2, { opacity: 30 }, 15), L3, 16);
        const one = d.writeBody(d.mergeBodies(here, there));
        assert.equal(one, d.writeBody(d.mergeBodies(there, here)), 'commutative');
        const merged = d.readBody(one);
        const l2 = d.layersOf(merged).find((l) => l.id === L2);
        assert.deepEqual([l2.hidden, l2.opacity], [true, 100], 'the later change (hide, at 20) wins over the earlier (opacity, at 15)');
        assert.ok(d.layersOf(merged).some((l) => l.id === L3), 'a layer only one side made is kept');
    });

    it('drop an entry that cannot be read, and keep the rest', () => {
        const body = d.readBody({
            layers: [
                { id: L2, n: 2, z: 1, opacity: 50, hidden: false, t: 1 },
                { id: L3, n: 3, z: 2, opacity: 150, hidden: false, t: 1 },
                { id: 'nope', n: 2, z: 1, opacity: 50, hidden: false, t: 1 },
                { id: L3, n: 3, z: 2, opacity: 50, hidden: 'no', t: 1 },
            ],
            strokes: [],
        });
        assert.deepEqual(body.layers.map((l) => l.id), [L2]);
    });
});

// Grabbing (Curtis, 2026-09-26): a move is an entry in the history, so it merges and undoes like a
// stroke, and shifts what was drawn on its layer before it.
describe('grabbing a layer', () => {
    const brush = (id, t) => ({ id, t, tool: 'brush', color: '#123456', size: 3, points: [1, 1] });
    const move = (id, t, dx, dy) => ({ id, t, tool: 'move', dx, dy });

    it('shifts what came before it, and not what came after', () => {
        const ops = [brush('a000000000000001', 1), move('b000000000000002', 2, 10, 0), brush('c000000000000003', 3), move('d000000000000004', 4, 0, 5)];
        const { each, total } = d.offsetsOf(ops);
        assert.deepEqual(each[0], [10, 5], 'the first stroke moves with both grabs');
        assert.deepEqual(each[2], [0, 5], 'the second only with the grab after it');
        assert.deepEqual(total, [10, 5], "and the layer's own fill moves with all of them");
    });

    it('undoes like a stroke', () => {
        let body = d.addStroke(d.addStroke(d.blankDrawing(), brush('a000000000000001', 1)), move('b000000000000002', 2, 10, 0));
        body = d.undo(body);
        assert.deepEqual(body.strokes.map((s) => s.tool), ['brush'], 'the grab came off');
        assert.deepEqual(body.undone, ['b000000000000002']);
    });

    it('merges two computers grabbing at once into both grabs, whichever way round', () => {
        const base = d.addStroke(d.blankDrawing(), brush('a000000000000001', 1));
        const here = d.addStroke(base, move('b000000000000002', 5, 10, 0));
        const there = d.addStroke(base, move('c000000000000003', 6, 0, -20));
        const merged = d.mergeBodies(here, there);
        assert.equal(d.writeBody(merged), d.writeBody(d.mergeBodies(there, here)));
        assert.deepEqual(d.offsetsOf(d.strokesOn(merged, d.BASE_LAYER)).total, [10, -20], 'both moves stand');
    });
});

// Deleting and duplicating layers (Curtis, 2026-09-26): entries again, so union-merged and undoable.
describe('deleting and duplicating layers', () => {
    const L2 = 'aaaaaaaaaaaaaaa2';
    const L3 = 'aaaaaaaaaaaaaaa3';
    const brush = (id, t, layer) => ({ id, t, ...(layer ? { layer } : {}), tool: 'brush', color: '#123456', size: 3, points: [1, 1] });

    it('a delete throws the layer away, and undo brings it back whole', () => {
        let body = d.addLayer(d.blankDrawing(), L2, 1);
        body = d.addStroke(body, brush('b000000000000001', 2, L2));
        body = d.deleteLayer(body, L2, 'c000000000000002', 3);
        assert.deepEqual(d.layersOf(body).map((l) => l.id), [d.BASE_LAYER], 'gone');
        body = d.undo(body);
        assert.deepEqual(d.layersOf(body).map((l) => l.id), [d.BASE_LAYER, L2], 'back');
        assert.equal(d.strokesOn(body, L2).length, 1, 'with its strokes');
        assert.deepEqual(d.layersOf(d.deleteLayer(d.blankDrawing(), d.BASE_LAYER, 'c000000000000003', 1)), [], 'even the base layer can go');
    });

    it('a delete merges as a union: deleted on one computer, drawn on at another, it stays deleted', () => {
        const base = d.addLayer(d.blankDrawing(), L2, 1);
        const here = d.deleteLayer(base, L2, 'c000000000000002', 5);
        const there = d.addStroke(base, brush('b000000000000001', 6, L2));
        const merged = d.mergeBodies(here, there);
        assert.equal(d.writeBody(merged), d.writeBody(d.mergeBodies(there, here)));
        assert.ok(!d.layersOf(merged).some((l) => l.id === L2));
        const brushes = (b) => d.strokesOn(b, L2).filter((s) => s.tool === 'brush').length;
        assert.equal(brushes(merged), 1, 'the stroke drawn there is kept, hidden with its layer');
        assert.equal(brushes(d.undo(merged)), 0, 'undo takes the newest entry - that stroke - first');
    });

    it('a duplicate sits just above its source and paints the source as it stood', () => {
        let body = d.addLayer(d.blankDrawing(), L2, 1);
        body = d.addLayer(body, 'aaaaaaaaaaaaaaa9', 1);
        body = d.addStroke(body, brush('b000000000000001', 2, L2));
        body = d.setLayer(body, L2, { opacity: 40, name: 'mane' }, 3);
        body = d.duplicateLayer(body, L2, L3, 'c000000000000002', 4);
        body = d.addStroke(body, brush('b000000000000003', 5, L2)); // after the copy: the source's alone
        assert.deepEqual(d.layersOf(body).map((l) => l.id), [d.BASE_LAYER, L2, L3, 'aaaaaaaaaaaaaaa9'], 'right above its source');
        assert.equal(d.layersOf(body).find((l) => l.id === L3).opacity, 40, 'with its opacity');
        assert.equal(d.layersOf(body).find((l) => l.id === L3).name, 'mane', 'and its name');
        assert.deepEqual(d.effectiveOps(body, L3).map((o) => o.id), ['b000000000000001'], 'the source as it stood at the copy');
        assert.deepEqual(d.effectiveOps(body, L2).map((o) => o.id), ['b000000000000001', 'b000000000000003']);
        assert.deepEqual(d.effectiveOps(d.undo(d.undo(body)), L3), [], 'undo takes the copied content back');
    });

    it("a copy of the base layer carries its white fill, and a grab after the copy moves the copy's content", () => {
        let body = d.addStroke(d.blankDrawing(), brush('b000000000000001', 1));
        body = d.duplicateLayer(body, d.BASE_LAYER, L2, 'c000000000000002', 2);
        body = d.addStroke(body, { id: 'd000000000000004', t: 3, layer: L2, tool: 'move', dx: 7, dy: 0 });
        const ops = d.effectiveOps(body, L2);
        assert.deepEqual(ops.map((o) => o.tool), ['fill', 'brush', 'move']);
        assert.deepEqual(d.offsetsOf(ops).each.slice(0, 2), [[7, 0], [7, 0]], 'fill and stroke both moved');
        assert.deepEqual(d.offsetsOf(d.effectiveOps(body, d.BASE_LAYER)).total, [0, 0], 'the source never moved');
    });
});

describe('naming a layer', () => {
    const L2 = 'aaaaaaaaaaaaaaa2';

    it('keeps a name, trimmed, and clearing it goes back to the number', () => {
        let body = d.addLayer(d.blankDrawing(), L2, 1);
        body = d.setLayer(body, L2, { name: '  the mane  ' }, 2);
        assert.equal(d.layersOf(body).find((l) => l.id === L2).name, 'the mane');
        assert.equal(d.layersOf(d.readBody(d.writeBody(body))).find((l) => l.id === L2).name, 'the mane', 'written and read back');
        body = d.setLayer(body, L2, { name: '   ' }, 3);
        assert.ok(!('name' in d.layersOf(body).find((l) => l.id === L2)), 'blank clears it');
    });

    it('refuses a name that cannot be kept, changing nothing', () => {
        const body = d.addLayer(d.blankDrawing(), L2, 1);
        for (const bad of ['tab\there', 'x'.repeat(121), '\uD800 lone']) {
            assert.equal(d.setLayer(body, L2, { name: bad }, 2), body, JSON.stringify(bad));
        }
        assert.ok(d.isLayerName('é'.repeat(60)) && !d.isLayerName('é'.repeat(61)), 'the limit is UTF-8 bytes');
    });

    it('breaks a same-moment rename tie by UTF-8 bytes, whichever way round', () => {
        const base = d.addLayer(d.blankDrawing(), L2, 1);
        const a = d.setLayer(base, L2, { name: '\uFF5E' }, 9);
        const b = d.setLayer(base, L2, { name: '🐴' }, 9);
        const ab = d.mergeBodies(a, b);
        assert.equal(d.writeBody(ab), d.writeBody(d.mergeBodies(b, a)));
        assert.equal(d.layersOf(ab).find((l) => l.id === L2).name, '🐴', 'four UTF-8 bytes from F0 outrank EF - though UTF-16 says otherwise');
    });
});

describe('adding an image', () => {
    const PIC = '0123456789abcdef0123456789abcdef';
    const L = 'aaaaaaaaaaaaaaa7';

    it('places a picture centred, shrunk to fit and never grown', () => {
        assert.deepEqual(d.placeImage(1600, 900), { x: 0, y: 75, w: 800, h: 450 });
        assert.deepEqual(d.placeImage(300, 1200), { x: 325, y: 0, w: 150, h: 600 });
        assert.deepEqual(d.placeImage(40, 20), { x: 380, y: 290, w: 40, h: 20 }, 'a small picture keeps its size');
    });

    it('goes on a new layer at the top, named for the picture, and undo takes it back', () => {
        let body = d.addLayer(d.blankDrawing(), 'aaaaaaaaaaaaaaa2', 1);
        body = d.addImage(body, { doc: PIC, width: 640, height: 480, title: 'a grey horse' }, L, 'f000000000000001', 5);
        const top = d.layersOf(body).at(-1);
        assert.deepEqual([top.id, top.name], [L, 'a grey horse']);
        assert.deepEqual(d.readBody(d.writeBody(body)).strokes.at(-1), { id: 'f000000000000001', t: 5, layer: L, tool: 'image', points: [80, 60], doc: PIC, w: 640, h: 480 });
        assert.deepEqual(d.imagesOf(body), [PIC]);
        assert.deepEqual(d.imagesOf(d.undo(body)), [], 'undo takes the picture back');
    });

    it('names the layer from a title only as far as a name can go', () => {
        const long = d.addImage(d.blankDrawing(), { doc: PIC, width: 10, height: 10, title: 'tab\there ' + '🐴'.repeat(40) }, L, 'f000000000000001', 5);
        const name = d.layersOf(long).at(-1).name;
        assert.ok(name.startsWith('tab here ') && d.isLayerName(name), 'control characters out, cut to fit, whole characters');
        const blank = d.addImage(d.blankDrawing(), { doc: PIC, width: 10, height: 10, title: '' }, L, 'f000000000000001', 5);
        assert.ok(!('name' in d.layersOf(blank).at(-1)), 'no title, no name');
    });

    it('moves with a grab and copies with its layer, like a stroke', () => {
        let body = d.addImage(d.blankDrawing(), { doc: PIC, width: 10, height: 10, title: 'x' }, L, 'f000000000000001', 5);
        body = d.addStroke(body, { id: 'd000000000000002', t: 6, layer: L, tool: 'move', dx: 5, dy: 0 });
        const ops = d.effectiveOps(body, L);
        assert.deepEqual([ops[0].tool, d.offsetsOf(ops).each[0]], ['image', [5, 0]]);
        body = d.duplicateLayer(body, L, 'aaaaaaaaaaaaaaa8', 'c000000000000003', 7);
        assert.equal(d.effectiveOps(body, 'aaaaaaaaaaaaaaa8')[0].tool, 'image');
    });
});

describe('shapes', () => {
    const base = { id: 'f200000000000001', t: 3, layer: 'aaaaaaaaaaaaaaa2', color: '#1f9e90', size: 6 };

    it('a line is a round-ended brush stroke of two points', () => {
        const line = d.shapeEntry('line', [10.4, 20], [110, 70.6], base);
        assert.deepEqual(line, { ...base, tool: 'brush', points: [10, 20, 100, 51] });
        assert.deepEqual(d.readBody(d.writeBody(d.addStroke(d.blankDrawing(), line))).strokes[0], line, 'kept as any stroke is');
    });

    it('a rectangle or an ellipse keeps its box, corners in order whichever way it was dragged', () => {
        assert.deepEqual(d.shapeEntry('rect', [300, 50], [100, 250], base).points, [100, 50, 300, 250]);
        const ellipse = d.shapeEntry('ellipse', [5, 5], [1, 9], { ...base, layer: d.BASE_LAYER });
        assert.deepEqual(ellipse, { id: base.id, t: 3, tool: 'ellipse', color: '#1f9e90', size: 6, points: [1, 5, 5, 9] }, 'the base layer unwritten');
        assert.deepEqual(d.recentColours(d.addStroke(d.blankDrawing(), ellipse)), ['#1f9e90'], "a shape's colour is one of the drawing's colours");
    });

    it('a drag that went nowhere makes nothing', () => {
        assert.equal(d.shapeEntry('rect', [5.2, 5], [4.9, 5.4], base), null);
    });
});

describe('dropping a dragged layer', () => {
    // Bottom to top: base, a, b, c.
    const stack = () => {
        let body = d.blankDrawing();
        for (const id of ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc']) body = d.addLayer(body, id, 1);
        return body;
    };
    const ids = (body) => d.layersOf(body).map((l) => l.id[0]);
    const drop = (body, moving, target, above) => {
        const index = d.dropIndex(body, moving, target, above);
        return index === null ? null : ids(d.moveLayer(body, moving, index, 2));
    };

    it('lands just above or just below the layer it is dropped on', () => {
        assert.deepEqual(drop(stack(), 'aaaaaaaaaaaaaaaa', 'cccccccccccccccc', true), ['0', 'b', 'c', 'a'], 'above the top');
        assert.deepEqual(drop(stack(), 'aaaaaaaaaaaaaaaa', 'cccccccccccccccc', false), ['0', 'b', 'a', 'c'], 'below the top');
        assert.deepEqual(drop(stack(), 'cccccccccccccccc', d.BASE_LAYER, false), ['c', '0', 'a', 'b'], 'under even the base');
    });

    it('shows no line where the drop would change nothing', () => {
        assert.equal(d.dropIndex(stack(), 'bbbbbbbbbbbbbbbb', 'bbbbbbbbbbbbbbbb', true), null, 'on itself');
        assert.equal(d.dropIndex(stack(), 'bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa', true), null, 'just above the one under it');
        assert.equal(d.dropIndex(stack(), 'bbbbbbbbbbbbbbbb', 'cccccccccccccccc', false), null, 'just below the one over it');
    });
});

describe('text layers', () => {
    const T = 'aaaaaaaaaaaaaaa7';
    const style = { x: 400.4, y: 99.6, font: 'press-start', size: 40, color: '#1f9e90', align: 'center' };

    it('is a new layer at the top holding one text, words and all editable', () => {
        let body = d.addTextLayer(d.blankDrawing(), T, style, 5);
        assert.equal(d.layersOf(body).at(-1).id, T);
        assert.deepEqual(d.textOf(body, T), { layer: T, t: 5, text: '', font: 'press-start', size: 40, color: '#1f9e90', align: 'center', x: 400, y: 100 });
        body = d.setText(body, T, { text: 'a horse\nof course', align: 'right' }, 6);
        const back = d.readBody(d.writeBody(body));
        assert.deepEqual([d.textOf(back, T).text, d.textOf(back, T).align, d.textOf(back, T).t], ['a horse\nof course', 'right', 6]);
        assert.equal(d.setText(body, T, { text: 'tab\there' }, 7), body, 'words the body cannot keep change nothing');
        assert.equal(d.setText(body, T, { size: 401 }, 7), body);
        assert.equal(d.setText(body, d.BASE_LAYER, { text: 'x' }, 7), body, 'only a text layer takes words');
    });

    it('can land holding words already, but never words the body could not keep', () => {
        assert.equal(d.textOf(d.addTextLayer(d.blankDrawing(), T, { ...style, text: 'horse' }, 5), T).text, 'horse');
        assert.equal(d.textOf(d.addTextLayer(d.blankDrawing(), T, { ...style, text: 'tab\there' }, 5), T).text, '');
    });

    it('paints its words first, so every grab and transform after carries them', () => {
        let body = d.addTextLayer(d.blankDrawing(), T, style, 5);
        body = d.setText(body, T, { text: 'hi' }, 6);
        body = d.addStroke(body, { id: 'd000000000000001', t: 7, layer: T, tool: 'move', dx: 10, dy: 0 });
        const ops = d.effectiveOps(body, T);
        assert.deepEqual([ops[0].tool, ops[0].text, d.offsetsOf(ops).each[0]], ['text', 'hi', [10, 0]]);
        body = d.setText(body, T, { text: 'hello' }, 8);
        assert.deepEqual(d.offsetsOf(d.effectiveOps(body, T)).each[0], [10, 0], 'edited after the grab, still grabbed');
    });

    it('is copied with its layer, and gone with it', () => {
        let body = d.setText(d.addTextLayer(d.blankDrawing(), T, style, 5), T, { text: 'hi' }, 6);
        body = d.duplicateLayer(body, T, 'aaaaaaaaaaaaaaa8', 'c000000000000001', 7);
        assert.equal(d.textOf(body, 'aaaaaaaaaaaaaaa8').text, 'hi');
        assert.equal(d.effectiveOps(body, 'aaaaaaaaaaaaaaa8').filter((o) => o.tool === 'text').length, 1, 'painted once - its own, not the copied one too');
        body = d.deleteLayer(body, T, 'c000000000000002', 8);
        assert.equal(d.textOf(body, T), null);
    });
});

describe('the downloaded picture', () => {
    it('is named for the drawing, less what a file system refuses', () => {
        assert.equal(d.pictureFileName('a horse'), 'a horse.png');
        assert.equal(d.pictureFileName('  grey/brown: "horse"?\t'), 'grey brown horse.png');
        assert.equal(d.pictureFileName('...hidden'), 'hidden.png', 'never a dotfile');
        assert.equal(d.pictureFileName(''), 'drawing.png');
        assert.equal(d.pictureFileName('///'), 'drawing.png');
        assert.equal(d.pictureFileName('x'.repeat(300)).length, 104);
    });
});
