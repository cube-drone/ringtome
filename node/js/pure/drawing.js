// A drawing's body, and the rules over it (DRAWING.md, "The model"). Value in, value out: no canvas,
// no network - the canvas surface (apps/drawing.js) paints what these return.
//
// The body is the drawing's whole history: every stroke still standing, and the ids of every stroke
// undone. Two versions merge by putting both sets of strokes together, minus both sets of undone;
// the order everybody paints in is `(t, id)`, so every device draws the same picture from the same
// body.
//
// The NODE merges (node/src/drawing.rs, at read time, where text merges); this module writes. The
// two meet at the canonical form - `writeBody` here, `canonical` there - and must agree byte for
// byte, so the same drawing is always the same bytes. `spec/test-vectors/drawing-v1.json` is where
// they are held to it: both sides' tests read it. `mergeBodies` stays here as the reference the
// vectors were first generated from.
//
// What a valid body may hold is deliberately narrow - ids of 16 hex digits, colours of lowercase
// `#rrggbb`, whole numbers everywhere - so the two languages can never disagree about escaping or
// number formatting.

/// The format name a drawing document carries (the version header's `format`).
export const DRAWING_FORMAT = 'drawing';

/// The canvas every drawing is made on, in its own units: points are stored in these, and the
/// display scales to fit. Fixed so a drawing looks the same on every screen.
/// 800 wide because that is the most the node keeps of any picture (media/image.rs, MAIN_BOUND): a
/// drawing flattened into an image loses nothing to a downscale.
export const CANVAS_WIDTH = 800;
export const CANVAS_HEIGHT = 600;
export const BACKGROUND = '#fffefb';

export const BODY_VERSION = 1;

/// A drawing with nothing on it.
export function blankDrawing() {
    return { v: BODY_VERSION, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, background: BACKGROUND, strokes: [], undone: [] };
}

// ---------------------------------------------------------------------------------------------
// Points: delta-coded integers, [x0, y0, dx1, dy1, dx2, dy2, ...]

/// Absolute points [[x, y], ...] (any numbers) to the stored form: rounded to whole canvas units,
/// the first absolute and every later one the step from the one before. A step of zero in both is
/// dropped - it paints nothing - except that a lone point (a dab) keeps itself.
export function encodePoints(points) {
    const out = [];
    let px = 0;
    let py = 0;
    for (let i = 0; i < points.length; i++) {
        const x = Math.round(points[i][0]);
        const y = Math.round(points[i][1]);
        if (i === 0) {
            out.push(x, y);
        } else if (x !== px || y !== py) {
            out.push(x - px, y - py);
        } else {
            continue;
        }
        px = x;
        py = y;
    }
    return out;
}

/// The stored form back to absolute points [[x, y], ...]. An odd trailing number is ignored.
export function decodePoints(encoded) {
    const out = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < (encoded || []).length; i += 2) {
        if (i === 0) {
            x = encoded[0];
            y = encoded[1];
        } else {
            x += encoded[i];
            y += encoded[i + 1];
        }
        out.push([x, y]);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Strokes

/// A stroke id: 64 random bits, hex. `random` is injectable for the tests; the page passes nothing.
export function strokeId(random = () => crypto.getRandomValues(new Uint32Array(2))) {
    const [a, b] = random();
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/// The order every device paints in: when each stroke was drawn, then its id for a tie.
export function strokeOrder(a, b) {
    return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/// A new stroke on the drawing. Returns the new body; the old one is untouched.
export function addStroke(body, stroke) {
    return { ...body, strokes: [...body.strokes, stroke].sort(strokeOrder) };
}

/// Undo: the newest standing stroke comes off, and its id is remembered as undone, so no merge can
/// bring it back. Returns the body unchanged when there is nothing left to undo.
export function undo(body) {
    if (!body.strokes.length) return body;
    const newest = body.strokes[body.strokes.length - 1];
    return { ...body, strokes: body.strokes.slice(0, -1), undone: [...body.undone, newest.id] };
}

// ---------------------------------------------------------------------------------------------
// Reading and merging bodies

const HEX16 = /^[0-9a-f]{16}$/;
const COLOUR = /^#[0-9a-f]{6}$/;
/// The largest brush or eraser, in canvas units.
export const MAX_SIZE = 200;

/// A body as it arrived - from a save, a sync, another version - checked and tidied: unknown
/// fields dropped, strokes that cannot be painted dropped, the order restored, anything undone
/// taken out. Never throws: an unreadable body is a blank drawing, since a drawing that will not
/// open is worse than an empty one the history can still restore.
export function readBody(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return blankDrawing();
        }
    }
    if (!parsed || typeof parsed !== 'object') return blankDrawing();
    const undone = [...new Set(Array.isArray(parsed.undone) ? parsed.undone.filter((id) => typeof id === 'string' && HEX16.test(id)) : [])];
    const gone = new Set(undone);
    const seen = new Set();
    const strokes = [];
    for (const s of Array.isArray(parsed.strokes) ? parsed.strokes : []) {
        const stroke = asStroke(s);
        if (!stroke || gone.has(stroke.id) || seen.has(stroke.id)) continue; // the first of an id wins
        seen.add(stroke.id);
        strokes.push(stroke);
    }
    strokes.sort(strokeOrder);
    const dimension = (n, fallback) => (Number.isSafeInteger(n) && n > 0 ? n : fallback);
    return {
        v: BODY_VERSION,
        width: dimension(parsed.width, CANVAS_WIDTH),
        height: dimension(parsed.height, CANVAS_HEIGHT),
        background: typeof parsed.background === 'string' && COLOUR.test(parsed.background) ? parsed.background : BACKGROUND,
        strokes,
        undone,
    };
}

/// A stroke as the body keeps it, or null when it cannot be painted: only the fields a stroke has,
/// every one checked.
function asStroke(s) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.id !== 'string' || !HEX16.test(s.id)) return null;
    if (!Number.isSafeInteger(s.t) || s.t < 0) return null;
    if (s.tool !== 'brush' && s.tool !== 'eraser') return null;
    if (!Number.isSafeInteger(s.size) || s.size < 1 || s.size > MAX_SIZE) return null;
    if (!Array.isArray(s.points) || s.points.length < 2 || !s.points.every(Number.isSafeInteger)) return null;
    if (s.tool === 'eraser') return { id: s.id, t: s.t, tool: 'eraser', size: s.size, points: s.points };
    if (typeof s.color !== 'string' || !COLOUR.test(s.color)) return null;
    return { id: s.id, t: s.t, tool: 'brush', color: s.color, size: s.size, points: s.points };
}

/// The merge of any number of versions of one drawing: every stroke of any of them, minus every
/// stroke any of them undid, in the one order. Commutative and idempotent - merging A with B is
/// merging B with A, and merging A with itself is A - so every device reaches the same drawing.
/// The canvas settings are the first body's (they cannot differ yet: nothing changes them).
export function mergeBodies(...bodies) {
    const read = bodies.map(readBody);
    if (!read.length) return blankDrawing();
    const undone = new Set(read.flatMap((b) => b.undone));
    const strokes = new Map();
    for (const body of read) {
        for (const stroke of body.strokes) {
            if (!undone.has(stroke.id) && !strokes.has(stroke.id)) strokes.set(stroke.id, stroke);
        }
    }
    return {
        ...read[0],
        strokes: [...strokes.values()].sort(strokeOrder),
        undone: [...undone].sort(),
    };
}

/// The body as it is saved: compact JSON, fields in a fixed order, so the same drawing is the same
/// bytes (the no-op save bounce compares bodies).
export function writeBody(body) {
    const b = readBody(body);
    return JSON.stringify({
        v: b.v,
        width: b.width,
        height: b.height,
        background: b.background,
        strokes: b.strokes, // readBody already made each one exactly its fields, in order
        undone: [...b.undone].sort(),
    });
}
