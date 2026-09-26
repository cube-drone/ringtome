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
