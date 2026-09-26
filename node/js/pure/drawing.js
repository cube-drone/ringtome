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
/// The base layer's fill - the white every drawing starts on (Curtis, 2026-09-26: "every image starts
/// as an all-white canvas"). It is the base LAYER's, not paper under everything: hide, fade or erase
/// the base layer and the transparency floor shows (doc/drawing.js).
export const BACKGROUND = '#ffffff';

export const BODY_VERSION = 1;

/// A drawing with nothing on it.
export function blankDrawing() {
    return { v: BODY_VERSION, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, background: BACKGROUND, layers: [], strokes: [], undone: [] };
}

// ---------------------------------------------------------------------------------------------
// Points: delta-coded integers, [x0, y0, dx1, dy1, dx2, dy2, ...]

/// A pen's pressure, as a stroke stores it: a whole number from 0 (the lightest touch) to 100 (full).
export const MAX_PRESSURE = 100;

/// Samples as the pointer gave them - [x, y] from a mouse or finger, [x, y, pressure 0..1] from a
/// pen - to the stored form: `points` delta-coded as `encodePoints` makes them, and `pressure` one
/// whole 0..100 per KEPT point (a repeated position is dropped with its pressure, so the two lists
/// stay in step), or null when any sample has no pressure - a mouse stroke is one width throughout.
export function encodeSamples(samples) {
    const pen = samples.length > 0 && samples.every((s) => Number.isFinite(s[2]));
    const points = [];
    const pressure = [];
    let px = 0;
    let py = 0;
    for (let i = 0; i < samples.length; i++) {
        const x = Math.round(samples[i][0]);
        const y = Math.round(samples[i][1]);
        if (i === 0) {
            points.push(x, y);
        } else if (x !== px || y !== py) {
            points.push(x - px, y - py);
        } else {
            continue;
        }
        if (pen) pressure.push(Math.max(0, Math.min(MAX_PRESSURE, Math.round(samples[i][2] * MAX_PRESSURE))));
        px = x;
        py = y;
    }
    return { points, pressure: pen ? pressure : null };
}

/// How wide a stroke is at a pressure, as a share of its `size` (its width at full pressure). Never
/// nothing: the lightest touch still leaves a line.
export function pressureWidth(pressure) {
    return 0.15 + 0.85 * (Math.max(0, Math.min(MAX_PRESSURE, pressure)) / MAX_PRESSURE);
}

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
/// A layer's opacity: a whole percent.
export const MAX_OPACITY = 100;
/// The layer every drawing starts with, and the one a stroke with no `layer` is on.
export const BASE_LAYER = '0000000000000000';
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
    // Layers: one entry per id, the latest change winning (`layerWins`), kept in id order.
    const byId = new Map();
    for (const l of Array.isArray(parsed.layers) ? parsed.layers : []) {
        const layer = asLayer(l);
        if (!layer) continue;
        const held = byId.get(layer.id);
        if (!held || layerWins(layer, held)) byId.set(layer.id, layer);
    }
    const layers = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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
        layers,
        strokes,
        undone,
    };
}

/// A layer entry as the body keeps it, or null: exactly its fields, every one checked.
function asLayer(l) {
    if (!l || typeof l !== 'object') return null;
    if (typeof l.id !== 'string' || !HEX16.test(l.id)) return null;
    if (!Number.isSafeInteger(l.n) || l.n < 1) return null;
    if (!Number.isSafeInteger(l.z)) return null;
    if (!Number.isSafeInteger(l.opacity) || l.opacity < 0 || l.opacity > MAX_OPACITY) return null;
    if (typeof l.hidden !== 'boolean') return null;
    if (!Number.isSafeInteger(l.t) || l.t < 0) return null;
    return { id: l.id, n: l.n, z: l.z, opacity: l.opacity, hidden: l.hidden, t: l.t };
}

/// Of two entries for one layer, does `a` win? The later change (`t`); on a tie, the larger of
/// (z, opacity, hidden, n) - any total order would do, so long as every computer uses this one.
function layerWins(a, b) {
    const key = (l) => [l.t, l.z, l.opacity, l.hidden ? 1 : 0, l.n];
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return false;
}

/// A stroke as the body keeps it, or null when it cannot be painted: only the fields a stroke has,
/// every one checked.
function asStroke(s) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.id !== 'string' || !HEX16.test(s.id)) return null;
    if (!Number.isSafeInteger(s.t) || s.t < 0) return null;
    // Which layer it is on: absent means the base layer, and is how the base layer is written.
    const onLayer = typeof s.layer === 'string' && HEX16.test(s.layer) && s.layer !== BASE_LAYER ? { layer: s.layer } : {};
    // A grab (`move`): the whole layer shifted by (dx, dy) - everything on it drawn before this.
    // An entry in the history like a stroke, so it merges by the same union and undoes the same way.
    if (s.tool === 'move') {
        if (!Number.isSafeInteger(s.dx) || !Number.isSafeInteger(s.dy)) return null;
        return { id: s.id, t: s.t, ...onLayer, tool: 'move', dx: s.dx, dy: s.dy };
    }
    if (s.tool !== 'brush' && s.tool !== 'eraser') return null;
    if (!Number.isSafeInteger(s.size) || s.size < 1 || s.size > MAX_SIZE) return null;
    if (!Array.isArray(s.points) || s.points.length < 2 || !s.points.every(Number.isSafeInteger)) return null;
    // A pen's pressure: one whole 0..100 per point. A list that does not fit its points is dropped,
    // not the stroke - the stroke still paints, one width throughout.
    const pressure =
        Array.isArray(s.pressure) &&
        s.pressure.length === Math.floor(s.points.length / 2) &&
        s.pressure.every((p) => Number.isSafeInteger(p) && p >= 0 && p <= MAX_PRESSURE)
            ? { pressure: s.pressure }
            : {};
    if (s.tool === 'eraser') return { id: s.id, t: s.t, ...onLayer, tool: 'eraser', size: s.size, points: s.points, ...pressure };
    if (typeof s.color !== 'string' || !COLOUR.test(s.color)) return null;
    return { id: s.id, t: s.t, ...onLayer, tool: 'brush', color: s.color, size: s.size, points: s.points, ...pressure };
}

/// Did `raw` parse to a body at all (a JSON object), rather than falling back to a blank one?
function readable(raw) {
    let parsed = raw;
    if (typeof raw === 'string') {
        try {
            parsed = JSON.parse(raw);
        } catch {
            return false;
        }
    }
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
}

/// The canvas settings a merge keeps, whatever order the versions came in: only readable versions
/// have a say (an unreadable one is a blank drawing, and its defaults are not a choice anybody
/// made), and among them the least of (width, height, background) - they agree in practice, since
/// nothing changes them yet; this only has to be the same answer on every computer. Found
/// 2026-09-26: taking the FIRST version's settings made merging a readable version with an
/// unreadable one depend on which came first.
function mergedCanvas(bodies) {
    const candidates = bodies.filter(readable).map(readBody);
    if (!candidates.length) return blankDrawing();
    return candidates.reduce((best, b) =>
        b.width < best.width ||
        (b.width === best.width && (b.height < best.height || (b.height === best.height && b.background < best.background)))
            ? b
            : best
    );
}

/// The merge of any number of versions of one drawing: every stroke of any of them, minus every
/// stroke any of them undid, in the one order. Commutative and idempotent - merging A with B is
/// merging B with A, and merging A with itself is A - so every device reaches the same drawing.
export function mergeBodies(...bodies) {
    const read = bodies.map(readBody);
    if (!read.length) return blankDrawing();
    const canvas = mergedCanvas(bodies);
    const undone = new Set(read.flatMap((b) => b.undone));
    const layers = new Map();
    for (const layer of read.flatMap((b) => b.layers)) {
        const held = layers.get(layer.id);
        if (!held || layerWins(layer, held)) layers.set(layer.id, layer);
    }
    const strokes = new Map();
    for (const body of read) {
        for (const stroke of body.strokes) {
            if (!undone.has(stroke.id) && !strokes.has(stroke.id)) strokes.set(stroke.id, stroke);
        }
    }
    return {
        v: BODY_VERSION,
        width: canvas.width,
        height: canvas.height,
        background: canvas.background,
        layers: [...layers.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        strokes: [...strokes.values()].sort(strokeOrder),
        undone: [...undone].sort(),
    };
}

/// The body as it is saved: compact JSON, fields in a fixed order, so the same drawing is the same
/// bytes (the no-op save bounce compares bodies).
export function writeBody(body) {
    const b = readBody(body);
    // `layers` is written only when there are any, so a drawing with none is the same bytes it was
    // before layers existed.
    return JSON.stringify({
        v: b.v,
        width: b.width,
        height: b.height,
        background: b.background,
        ...(b.layers.length ? { layers: b.layers } : {}),
        strokes: b.strokes, // readBody already made each one exactly its fields, in order
        undone: [...b.undone].sort(),
    });
}

/// The swatches the tools column always offers, whatever the drawing: white and black.
export const FIXED_COLOURS = ['#ffffff', '#000000'];

/// The colours this drawing's brush strokes used, newest first, each once, at most `count` - and
/// never white or black, which the swatch row always offers anyway. Read off the strokes
/// themselves, so the list is the drawing's own: it follows the drawing to every computer and
/// survives a reload with nothing else stored, and an undone stroke's colour leaves with it.
export function recentColours(drawing, count = 10) {
    const fixed = new Set(FIXED_COLOURS);
    const seen = new Set();
    const out = [];
    for (let i = drawing.strokes.length - 1; i >= 0 && out.length < count; i--) {
        const colour = drawing.strokes[i].color;
        if (!colour || fixed.has(colour) || seen.has(colour)) continue;
        seen.add(colour);
        out.push(colour);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Layers (Curtis, 2026-09-26): transparent slices, stacked, each hideable and with its own opacity.
//
// A layer is an entry in `layers` - id, `n` (its number, for "layer 2"), `z` (its place in the
// stack), opacity, hidden, and `t` (when it last changed, which is how a merge picks between two
// computers' versions of it). A drawing with no entries has one layer, the base layer, fully
// opaque and shown - so every drawing made before layers is a one-layer drawing, unchanged. An
// entry is written only once a layer is made or changed.

const DEFAULT_BASE = { id: BASE_LAYER, n: 1, z: 0, opacity: MAX_OPACITY, hidden: false, t: 0 };

/// Every layer, bottom of the stack first: the entries, the base layer, and any layer a stroke is
/// on that has no entry of its own (from a version not merged yet), at its defaults.
export function layersOf(drawing) {
    const layers = new Map([[BASE_LAYER, DEFAULT_BASE]]);
    for (const s of drawing.strokes) {
        const id = s.layer || BASE_LAYER;
        if (!layers.has(id)) layers.set(id, { id, n: 1, z: 0, opacity: MAX_OPACITY, hidden: false, t: 0 });
    }
    for (const l of drawing.layers || []) layers.set(l.id, l);
    return [...layers.values()].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/// The strokes on one layer, in painting order.
export function strokesOn(drawing, layerId) {
    return drawing.strokes.filter((s) => (s.layer || BASE_LAYER) === layerId);
}

function upsertLayer(drawing, entry) {
    return { ...drawing, layers: [...(drawing.layers || []).filter((l) => l.id !== entry.id), entry] };
}

/// A new layer on top of the stack, numbered one past the highest.
export function addLayer(drawing, id, now) {
    const all = layersOf(drawing);
    const z = Math.max(...all.map((l) => l.z)) + 1;
    const n = Math.max(...all.map((l) => l.n)) + 1;
    return upsertLayer(drawing, { id, n, z, opacity: MAX_OPACITY, hidden: false, t: now });
}

/// Change a layer's `hidden` or `opacity`.
export function setLayer(drawing, id, change, now) {
    const current = layersOf(drawing).find((l) => l.id === id);
    if (!current) return drawing;
    const next = { ...current, t: now };
    if (typeof change.hidden === 'boolean') next.hidden = change.hidden;
    if (Number.isFinite(change.opacity)) next.opacity = Math.max(0, Math.min(MAX_OPACITY, Math.round(change.opacity)));
    return upsertLayer(drawing, next);
}

/// Move a layer to `index` in the stack (0 the bottom). Every layer is renumbered to its place, and
/// only those whose place changed are touched.
export function moveLayer(drawing, id, index, now) {
    const order = layersOf(drawing);
    const from = order.findIndex((l) => l.id === id);
    if (from < 0) return drawing;
    const [moved] = order.splice(from, 1);
    order.splice(Math.max(0, Math.min(order.length, index)), 0, moved);
    let out = drawing;
    order.forEach((l, z) => {
        if (l.z !== z) out = upsertLayer(out, { ...l, z, t: now });
    });
    return out;
}

// ---------------------------------------------------------------------------------------------
// Grabbing (Curtis, 2026-09-26): the grab tool moves a whole layer, and must merge as trivially as a
// stroke does. So a grab is not a setting on the layer (two computers moving one layer at once would
// have one move win and one vanish) and not a rewrite of the layer's strokes (the same stroke id
// with two sets of points is a real conflict). It is an entry in the history, `{ tool: 'move', dx,
// dy }`: unioned by id like any stroke, so concurrent moves both apply - they are additions, and
// additions commute - and undone like any stroke. A move shifts what was drawn on its layer before
// it, in the one `(t, id)` order; what is drawn after lands where it was drawn.

/// The shift each of a layer's entries is painted with - the sum of every move AFTER it on the
/// layer - and the layer's whole shift (the base layer's fill moves by that: it was there first).
/// `ops` are one layer's entries, in painting order.
export function offsetsOf(ops) {
    const each = new Array(ops.length);
    let dx = 0;
    let dy = 0;
    for (let i = ops.length - 1; i >= 0; i--) {
        each[i] = [dx, dy];
        if (ops[i].tool === 'move') {
            dx += ops[i].dx;
            dy += ops[i].dy;
        }
    }
    return { each, total: [dx, dy] };
}
