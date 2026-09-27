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
    return { v: BODY_VERSION, width: CANVAS_WIDTH, height: CANVAS_HEIGHT, background: BACKGROUND, layers: [], texts: [], strokes: [], undone: [] };
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
/// The farthest a pour can spread, in canvas units along the paint's path (pure/pour.js). Far more
/// than any canvas needs - a pour into a winding space travels further than straight across.
export const MAX_REACH = 1000000;
/// A transform's matrix is stored in fixed point (Curtis, 2026-09-27): each of its six numbers
/// times MATRIX_ONE, rounded - whole numbers, as everything in a body is - and no larger than
/// MAX_MATRIX either way.
export const MATRIX_ONE = 1000000;
export const MAX_MATRIX = 1000000000000;
/// The largest a placed image can be, either way, in canvas units.
export const MAX_IMAGE_SIZE = 20000;
/// A document id: 16 bytes, hex.
const DOC_ID = /^[0-9a-f]{32}$/;

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
    const texts = foldTexts(Array.isArray(parsed.texts) ? parsed.texts.map(asText).filter(Boolean) : []);
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
        texts,
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
    // A name the layer was given; one that cannot be kept is dropped, and the layer kept, unnamed.
    const name = isLayerName(l.name) ? { name: l.name } : {};
    return { id: l.id, n: l.n, ...name, z: l.z, opacity: l.opacity, hidden: l.hidden, t: l.t };
}

/// The longest layer name, in UTF-8 bytes - counted as the node counts them.
export const MAX_NAME_BYTES = 120;

/// Can this be kept as a layer's name? A non-empty string of at most MAX_NAME_BYTES, with no control
/// characters and no unpaired surrogate. These are exactly the places two JSON implementations could
/// disagree - how a control character is escaped, and a lone surrogate, which JavaScript takes and
/// Rust refuses - so the name is simply not allowed to go there.
export function isLayerName(name) {
    if (typeof name !== 'string' || name.length === 0) return false;
    for (let i = 0; i < name.length; i++) {
        const c = name.charCodeAt(i);
        if (c < 0x20 || c === 0x7f) return false;
    }
    try {
        encodeURIComponent(name); // throws on an unpaired surrogate
    } catch {
        return false;
    }
    return new TextEncoder().encode(name).length <= MAX_NAME_BYTES;
}

/// Compare two strings by their UTF-8 bytes - the order Rust's strings sort in. JavaScript's own `<`
/// compares UTF-16 code units, which orders some pairs differently.
function compareUtf8(a, b) {
    const x = new TextEncoder().encode(a);
    const y = new TextEncoder().encode(b);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
}

/// Of two entries for one layer, does `a` win? The later change (`t`); on a tie, the larger of
/// (z, opacity, hidden, n, name) - any total order would do, so long as every computer uses this one.
function layerWins(a, b) {
    const key = (l) => [l.t, l.z, l.opacity, l.hidden ? 1 : 0, l.n];
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] > kb[i];
    return compareUtf8(a.name || '', b.name || '') > 0;
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
    // A layer thrown away (`delete`), and a layer begun as a copy of another (`copy`, `from` naming
    // it - the base layer spelled out, since `from` is always named). Entries, like a move, so they
    // merge by the union and undo like a stroke (DRAWING.md, "Deleting and duplicating layers").
    if (s.tool === 'delete') return { id: s.id, t: s.t, ...onLayer, tool: 'delete' };
    if (s.tool === 'copy') {
        if (typeof s.from !== 'string' || !HEX16.test(s.from)) return null;
        return { id: s.id, t: s.t, ...onLayer, tool: 'copy', from: s.from };
    }
    // A pour (the paint bucket, Curtis, 2026-09-26): paint dropped at one point - `points` is that
    // point, absolute - spreading `reach` canvas units outward and stopping at the layer's lines.
    // What it covers is worked out from the layer as it stood (pure/pour.js), so it too is an entry
    // merged by the union and undone like a stroke.
    if (s.tool === 'bucket') {
        if (typeof s.color !== 'string' || !COLOUR.test(s.color)) return null;
        if (!Array.isArray(s.points) || s.points.length !== 2 || !s.points.every(Number.isSafeInteger)) return null;
        if (!Number.isSafeInteger(s.reach) || s.reach < 0 || s.reach > MAX_REACH) return null;
        return { id: s.id, t: s.t, ...onLayer, tool: 'bucket', color: s.color, points: s.points, reach: s.reach };
    }
    // An image (Curtis, 2026-09-27): one of the person's own pictures, by its document id, placed
    // with its top-left at `points` and `w` x `h` canvas units big. The pixels stay in the picture's
    // document; the drawing holds the reference, and whoever paints it fetches them (doc/drawing.js).
    if (s.tool === 'image') {
        if (typeof s.doc !== 'string' || !DOC_ID.test(s.doc)) return null;
        if (!Array.isArray(s.points) || s.points.length !== 2 || !s.points.every(Number.isSafeInteger)) return null;
        const side = (n) => Number.isSafeInteger(n) && n >= 1 && n <= MAX_IMAGE_SIZE;
        if (!side(s.w) || !side(s.h)) return null;
        return { id: s.id, t: s.t, ...onLayer, tool: 'image', points: s.points, doc: s.doc, w: s.w, h: s.h };
    }
    // A crop (Curtis, 2026-09-27): the canvas cut down to the box `points` = [left, top, right,
    // bottom], in the canvas as it stood then - on no layer, since it cuts every layer. Everything
    // before it shifts by (-left, -top), as a grab would shift it, and the canvas becomes the box.
    if (s.tool === 'crop') {
        if (!Array.isArray(s.points) || s.points.length !== 4 || !s.points.every(Number.isSafeInteger)) return null;
        const [l, t, r, b] = s.points;
        if (l >= r || t >= b) return null;
        return { id: s.id, t: s.t, tool: 'crop', points: s.points };
    }
    // A transform (Curtis, 2026-09-27): everything before it on its layer passes through the affine
    // matrix `m` = [a, b, c, d, e, f] (x' = a x + c y + e, y' = b x + d y + f, the canvas's own
    // order), each number in fixed point (MATRIX_ONE). A grab is the translation-only case, kept
    // as its own `move` entry.
    if (s.tool === 'transform') {
        if (!Array.isArray(s.m) || s.m.length !== 6) return null;
        if (!s.m.every((n) => Number.isSafeInteger(n) && Math.abs(n) <= MAX_MATRIX)) return null;
        return { id: s.id, t: s.t, ...onLayer, tool: 'transform', m: s.m };
    }
    // A rectangle or an ellipse (Curtis, 2026-09-27): the box it was dragged out in - `points` is
    // two corners, absolute - outlined `size` wide in `color`. A rectangle's corners are sharp. (A
    // line needs no entry of its own: it is a brush stroke of two points, round-ended.)
    if (s.tool === 'rect' || s.tool === 'ellipse') {
        if (typeof s.color !== 'string' || !COLOUR.test(s.color)) return null;
        if (!Number.isSafeInteger(s.size) || s.size < 1 || s.size > MAX_SIZE) return null;
        if (!Array.isArray(s.points) || s.points.length !== 4 || !s.points.every(Number.isSafeInteger)) return null;
        return { id: s.id, t: s.t, ...onLayer, tool: s.tool, color: s.color, size: s.size, points: s.points };
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
        texts: foldTexts(read.flatMap((b) => b.texts)),
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
        // `texts` likewise: a drawing with no text layer is the bytes it always was.
        ...(b.texts.length ? { texts: b.texts } : {}),
        strokes: b.strokes, // readBody already made each one exactly its fields, in order
        undone: [...b.undone].sort(),
    });
}

/// The swatches the tools column always offers, whatever the drawing: white and black.
export const FIXED_COLOURS = ['#ffffff', '#000000'];

/// The colours this drawing's brush strokes and pours used, newest first, each once, at most `count` - and
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
        if (s.tool === 'crop') continue;
        const id = s.layer || BASE_LAYER;
        if (!layers.has(id)) layers.set(id, { id, n: 1, z: 0, opacity: MAX_OPACITY, hidden: false, t: 0 });
    }
    for (const l of drawing.layers || []) layers.set(l.id, l);
    const deleted = deletedLayers(drawing);
    return [...layers.values()]
        .filter((l) => !deleted.has(l.id))
        .sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/// The layers a standing `delete` entry has thrown away. Undo the entry and the layer is back.
export function deletedLayers(drawing) {
    return new Set(drawing.strokes.filter((s) => s.tool === 'delete').map((s) => s.layer || BASE_LAYER));
}

/// The strokes on one layer, in painting order.
export function strokesOn(drawing, layerId) {
    return drawing.strokes.filter((s) => s.tool !== 'crop' && (s.layer || BASE_LAYER) === layerId);
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

/// Change a layer's `hidden`, `opacity` or `name`.
export function setLayer(drawing, id, change, now) {
    const current = layersOf(drawing).find((l) => l.id === id);
    if (!current) return drawing;
    const next = { ...current, t: now };
    if (typeof change.hidden === 'boolean') next.hidden = change.hidden;
    if (Number.isFinite(change.opacity)) next.opacity = Math.max(0, Math.min(MAX_OPACITY, Math.round(change.opacity)));
    // A name (Curtis, 2026-09-26): trimmed; an empty one takes the name away, back to "layer N".
    if (typeof change.name === 'string') {
        const name = change.name.trim();
        if (!name) delete next.name;
        else if (isLayerName(name)) next.name = name;
        else return drawing; // a name the drawing could not keep changes nothing
    }
    return upsertLayer(drawing, next);
}

/// Where a dragged layer lands when dropped just above or just below another (Curtis, 2026-09-27:
/// the stack shows a line there while dragging): the `index` for `moveLayer`, or null when the drop
/// would leave it where it is - on itself, or next to itself on the side it already sits.
export function dropIndex(drawing, movingId, targetId, above) {
    const order = layersOf(drawing);
    const from = order.findIndex((l) => l.id === movingId);
    if (from < 0 || movingId === targetId) return null;
    const rest = order.filter((l) => l.id !== movingId);
    const at = rest.findIndex((l) => l.id === targetId);
    if (at < 0) return null;
    const index = above ? at + 1 : at;
    return index === from ? null : index;
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

// Transforms (Curtis, 2026-09-27) generalise the grab: a `transform` entry passes everything
// before it on its layer through an affine matrix - rotate, scale, slant - as a `move` shifts it.
// Entries still, so they merge by the union; two computers' transforms apply in the one `(t, id)`
// order, so every computer composes them the same way round, though matrices do not commute.
//
// A matrix here is [a, b, c, d, e, f] as the canvas takes it: x' = a x + c y + e, y' = b x + d y + f.

export const IDENTITY = [1, 0, 0, 1, 0, 0];

/// A then B: the matrix that does `b` first, then `a`.
export function compose(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}

/// A point through a matrix.
export function apply(m, [x, y]) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/// A matrix as a transform entry stores it (fixed point, whole numbers), and back.
export const toFixed = (m) => m.map((n) => Math.max(-MAX_MATRIX, Math.min(MAX_MATRIX, Math.round(n * MATRIX_ONE))));
export const fromFixed = (m) => m.map((n) => n / MATRIX_ONE);

/// The matrix an entry applies to what came before it: a move's shift, a transform's matrix, or
/// null for an entry that moves nothing.
function matrixOf(op) {
    if (op.tool === 'move') return [1, 0, 0, 1, op.dx, op.dy];
    if (op.tool === 'crop') return [1, 0, 0, 1, -op.points[0], -op.points[1]];
    if (op.tool === 'transform') return fromFixed(op.m);
    return null;
}

/// The matrix each of a layer's entries is painted through - every move and transform AFTER it on
/// the layer, the earliest applied first - and the layer's whole matrix (the base layer's fill
/// goes through that: it was there first). `ops` are one layer's entries, in painting order.
export function matricesOf(ops) {
    const each = new Array(ops.length);
    let m = IDENTITY;
    for (let i = ops.length - 1; i >= 0; i--) {
        each[i] = m;
        const own = matrixOf(ops[i]);
        if (own) m = compose(m, own);
    }
    return { each, total: m };
}

/// The shift each entry is painted with - `matricesOf`'s translation, which is the whole story
/// while a layer has only been grabbed (moves), and what the grab's tests speak in.
export function offsetsOf(ops) {
    const { each, total } = matricesOf(ops);
    return { each: each.map((m) => [m[4], m[5]]), total: [total[4], total[5]] };
}

// ---------------------------------------------------------------------------------------------
// Deleting and duplicating layers (Curtis, 2026-09-26), as entries - so they merge by the union and
// undo like a stroke, and nothing here can conflict.

/// Throw a layer away: one `delete` entry. It hides the layer and everything on it for as long as
/// it stands; undo takes the entry back, and the layer with it.
export function deleteLayer(drawing, layerId, entryId, now) {
    const entry = { id: entryId, t: now, tool: 'delete' };
    if (layerId !== BASE_LAYER) entry.layer = layerId;
    return addStroke(drawing, entry);
}

/// Duplicate a layer: a new layer just above it, with its opacity and visibility, beginning with a
/// `copy` entry - which paints the source as it stood at that moment (every source entry before it
/// in the one order), not a copy of each stroke under new ids. One entry, so one undo takes the
/// copied content back (the new, empty layer stays until thrown away).
export function duplicateLayer(drawing, sourceId, newLayerId, entryId, now) {
    const source = layersOf(drawing).find((l) => l.id === sourceId);
    if (!source) return drawing;
    let out = addLayer(drawing, newLayerId, now);
    const name = source.name ? { name: source.name } : {};
    out = setLayer(out, newLayerId, { opacity: source.opacity, hidden: source.hidden, ...name }, now);
    // A text layer's copy is a text layer, its words its own from here on.
    const text = textOf(drawing, sourceId);
    if (text) out = upsertText(out, { ...text, layer: newLayerId, t: now });
    const order = layersOf(out).filter((l) => l.id !== newLayerId);
    out = moveLayer(out, newLayerId, order.findIndex((l) => l.id === sourceId) + 1, now);
    return addStroke(out, { id: entryId, t: now, layer: newLayerId, tool: 'copy', from: sourceId });
}

/// What a layer paints, in order: the base layer's white fill first (a `fill` step, which a copy of
/// the base layer carries too), then its entries - with each `copy` replaced by its source's own
/// steps from before it. The fill and the copies are steps like any other, so the grab offsets
/// (`offsetsOf`) apply to them as to strokes.
export function effectiveOps(drawing, layerId, before = null) {
    const out = layerId === BASE_LAYER ? [{ tool: 'fill' }] : [];
    // A text layer's words are its first step, as the base layer's white is - so every grab and
    // transform on the layer carries them, and editing them keeps every one. Not in a copy's
    // expansion: a copy of a text layer has words of its own (`duplicateLayer`).
    const text = before ? null : textOf(drawing, layerId);
    if (text) out.push({ tool: 'text', ...text });
    // Every crop cuts every layer: they join each layer's own entries, in the one order.
    const own = drawing.strokes.filter((s) => s.tool === 'crop' || (s.layer || BASE_LAYER) === layerId);
    for (const op of own) {
        if (before && strokeOrder(op, before) >= 0) break;
        if (op.tool === 'copy') out.push(...effectiveOps(drawing, op.from, op));
        else if (op.tool !== 'delete') out.push(op);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// Images (Curtis, 2026-09-27): a picture from the person's own media, added on a layer of its own
// at the top of the stack - so grab moves it, the eraser cuts it, trash and duplicate take it.

/// Where a picture `width` x `height` pixels lands on a canvas: centred, one pixel to a canvas unit,
/// shrunk (never grown) to fit inside it. { x, y, w, h }, whole canvas units.
export function placeImage(width, height, canvasWidth = CANVAS_WIDTH, canvasHeight = CANVAS_HEIGHT) {
    const scale = Math.min(1, canvasWidth / width, canvasHeight / height);
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    return { x: Math.round((canvasWidth - w) / 2), y: Math.round((canvasHeight - h) / 2), w, h };
}

/// Add a picture on a new layer at the top: `picture` is { doc, width, height, title }. The layer
/// takes the picture's title as its name when that can be a name (cut to fit if long). One change
/// to the body; undo takes the picture back, leaving the empty layer, as a duplicate's undo does.
export function addImage(drawing, picture, layerId, entryId, now) {
    let out = addLayer(drawing, layerId, now);
    const name = layerNameFrom(picture.title);
    if (name) out = setLayer(out, layerId, { name }, now);
    const [cw, ch] = sizeOf(drawing);
    const at = placeImage(picture.width, picture.height, cw, ch);
    const entry = { id: entryId, t: now, layer: layerId, tool: 'image', points: [at.x, at.y], doc: picture.doc, w: at.w, h: at.h };
    return addStroke(out, entry);
}

/// A title as a layer name, or null: control characters become spaces, and a long title is cut
/// at a character boundary to fit MAX_NAME_BYTES.
function layerNameFrom(title) {
    if (typeof title !== 'string') return null;
    let name = title.replace(/\p{Cc}/gu, ' ').trim();
    const chars = [...name];
    while (chars.length && new TextEncoder().encode(chars.join('')).length > MAX_NAME_BYTES) chars.pop();
    name = chars.join('').trim();
    return isLayerName(name) ? name : null;
}

/// The picture documents a drawing refers to, each once.
export function imagesOf(drawing) {
    return [...new Set(drawing.strokes.filter((s) => s.tool === 'image').map((s) => s.doc))];
}

// ---------------------------------------------------------------------------------------------
// Shapes (Curtis, 2026-09-27): a line, a rectangle and an ellipse, each dragged out corner to corner.

/// The box a shape's two corners make, in order: [left, top, right, bottom].
export function shapeBox(points) {
    const [x0, y0, x1, y1] = points;
    return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)];
}

/// The entry a drag from `from` to `to` (drawing units) makes with `tool` - 'line', 'rect' or
/// 'ellipse' - or null when the drag went nowhere. A line is a brush stroke of two points.
export function shapeEntry(tool, from, to, { id, t, layer, color, size }) {
    const [x0, y0, x1, y1] = [from[0], from[1], to[0], to[1]].map(Math.round);
    if (x0 === x1 && y0 === y1) return null;
    const onLayer = layer && layer !== BASE_LAYER ? { layer } : {};
    if (tool === 'line') {
        return { id, t, ...onLayer, tool: 'brush', color, size, points: encodePoints([[x0, y0], [x1, y1]]) };
    }
    const [l, top, r, bottom] = shapeBox([x0, y0, x1, y1]);
    return { id, t, ...onLayer, tool, color, size, points: [l, top, r, bottom] };
}

/// An ellipse's outline as points, for walls (pure/pour.js): QUARTER points a quarter-turn, from the
/// circle's rational parametrisation - ((1 - u^2) / (1 + u^2), 2u / (1 + u^2)) - which needs only
/// adding, multiplying and dividing, so every browser computes the same points (Math.cos and
/// Math.sin are free to differ in their last digit). Closed: the last point is the first.
const QUARTER = 64;
export function ellipseOutline([l, top, r, bottom]) {
    const cx = (l + r) / 2;
    const cy = (top + bottom) / 2;
    const rx = (r - l) / 2;
    const ry = (bottom - top) / 2;
    const quarter = [];
    for (let i = 0; i < QUARTER; i++) {
        const u = i / QUARTER;
        const d = 1 + u * u;
        quarter.push([(1 - u * u) / d, (2 * u) / d]);
    }
    const unit = [
        ...quarter,
        ...quarter.map(([c, s]) => [-s, c]),
        ...quarter.map(([c, s]) => [-c, -s]),
        ...quarter.map(([c, s]) => [s, -c]),
    ];
    unit.push(unit[0]);
    return unit.map(([c, s]) => [cx + rx * c, cy + ry * s]);
}

// ---------------------------------------------------------------------------------------------
// Cropping (Curtis, 2026-09-27): the canvas cut down to a box. A `crop` entry, like every other -
// merged by the union, undone like a stroke (and what it cut away comes back, since nothing is
// ever removed from the history, only left outside the canvas). The body's own `width` and
// `height` stay the canvas the drawing began as; the canvas NOW is that, cut by every crop in turn,
// each box in the canvas as its crop found it. Two computers cropping at once both apply, the
// later on the earlier's result, in the one order - the same on every computer.

/// The canvas after the crops among `ops` (any entries, in painting order), starting from the
/// drawing's own: [width, height].
export function sizeAfter(drawing, ops) {
    let size = [drawing.width, drawing.height];
    for (const op of ops) if (op.tool === 'crop') size = [op.points[2] - op.points[0], op.points[3] - op.points[1]];
    return size;
}

/// The canvas as it stands: [width, height].
export const sizeOf = (drawing) => sizeAfter(drawing, drawing.strokes);

/// The crop entry for cutting the canvas to `box` ([left, top, right, bottom], any numbers):
/// rounded, kept inside the canvas as it stands, or null when that leaves nothing - or leaves
/// the canvas as it was.
export function cropEntry(drawing, box, { id, t }) {
    const [w, h] = sizeOf(drawing);
    const l = Math.max(0, Math.min(w, Math.round(Math.min(box[0], box[2]))));
    const r = Math.max(0, Math.min(w, Math.round(Math.max(box[0], box[2]))));
    const top = Math.max(0, Math.min(h, Math.round(Math.min(box[1], box[3]))));
    const b = Math.max(0, Math.min(h, Math.round(Math.max(box[1], box[3]))));
    if (l >= r || top >= b) return null;
    if (l === 0 && top === 0 && r === w && b === h) return null;
    return { id, t, tool: 'crop', points: [l, top, r, b] };
}

// ---------------------------------------------------------------------------------------------
// Text layers (Curtis, 2026-09-27): a layer holding ONE text - its words, font, size, colour,
// alignment and where it is anchored - and nothing else; every other drawing tool stands aside
// while one is current. Grabs, transforms and crops apply to it as to any layer.
//
// The text is not an entry but a record in the body's `texts`, one per layer, merged as layer
// entries are: the later change wins, whole. Not on the layer entry itself, because a layer entry
// changes whenever the stack is reordered, and a reorder on one computer would otherwise throw away
// words typed on another. Two computers editing one text at the same moment: the later wins, and
// the other's words are gone - the one lossy merge in a drawing, chosen over merging text
// character by character, which would bring text conflicts into a picture.
//
// A text: { layer, t, text, font, size, color, align, x, y } - `(x, y)` is where its first line's
// top meets its alignment (the left end, the middle or the right end), in canvas units.

/// The longest a text can be, in UTF-8 bytes.
export const MAX_TEXT_BYTES = 4000;
export const MIN_TEXT_SIZE = 4;
export const MAX_TEXT_SIZE = 400;
export const TEXT_ALIGNS = ['left', 'center', 'right'];
/// A font as a text stores it: a token from the Marquee font list (`FONTS`, from the Marquee
/// renderer - `sans`, `press-start`, `orbitron`, ...), which is all the page offers. Checked here
/// only for a token's shape, so the body never changes when the list does: a token the page does
/// not know paints in the default, as Marquee itself degrades an unknown font.
const FONT_NAME = /^[a-z0-9-]{1,40}$/;
export const DEFAULT_FONT = 'sans';

/// Can this be a text's words? At most MAX_TEXT_BYTES; no control characters but the line break
/// (the same reason as a layer's name: JSON writers disagree about escaping the rest), and no lone
/// surrogate. Empty is allowed - a text layer just made has no words yet.
export function isTextContent(text) {
    if (typeof text !== 'string') return false;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if ((c < 0x20 && c !== 0x0a) || c === 0x7f) return false;
    }
    try {
        encodeURIComponent(text);
    } catch {
        return false;
    }
    return new TextEncoder().encode(text).length <= MAX_TEXT_BYTES;
}

/// A text record as the body keeps it, or null.
function asText(x) {
    if (!x || typeof x !== 'object') return null;
    if (typeof x.layer !== 'string' || !HEX16.test(x.layer) || x.layer === BASE_LAYER) return null;
    if (!Number.isSafeInteger(x.t) || x.t < 0) return null;
    if (!isTextContent(x.text)) return null;
    if (typeof x.font !== 'string' || !FONT_NAME.test(x.font)) return null;
    if (!Number.isSafeInteger(x.size) || x.size < MIN_TEXT_SIZE || x.size > MAX_TEXT_SIZE) return null;
    if (typeof x.color !== 'string' || !COLOUR.test(x.color)) return null;
    if (!TEXT_ALIGNS.includes(x.align)) return null;
    if (!Number.isSafeInteger(x.x) || !Number.isSafeInteger(x.y)) return null;
    return { layer: x.layer, t: x.t, text: x.text, font: x.font, size: x.size, color: x.color, align: x.align, x: x.x, y: x.y };
}

/// Of two records for one layer's text, does `a` win? The later change; on a tie, any fixed order
/// both languages share - the numbers, then the strings by their UTF-8 bytes.
function textWins(a, b) {
    for (const k of ['t', 'size', 'x', 'y']) if (a[k] !== b[k]) return a[k] > b[k];
    for (const k of ['text', 'font', 'color', 'align']) {
        const c = compareUtf8(a[k], b[k]);
        if (c !== 0) return c > 0;
    }
    return false;
}

function foldTexts(records) {
    const byLayer = new Map();
    for (const r of records) {
        const held = byLayer.get(r.layer);
        if (!held || textWins(r, held)) byLayer.set(r.layer, r);
    }
    return [...byLayer.values()].sort((a, b) => (a.layer < b.layer ? -1 : a.layer > b.layer ? 1 : 0));
}

function upsertText(drawing, record) {
    return { ...drawing, texts: [...(drawing.texts || []).filter((r) => r.layer !== record.layer), record] };
}

/// A layer's text, or null when it is not a text layer (or has been thrown away).
export function textOf(drawing, layerId) {
    const record = (drawing.texts || []).find((r) => r.layer === layerId);
    if (!record || deletedLayers(drawing).has(layerId)) return null;
    return record;
}

/// A new text layer at the top of the stack, its text anchored at (x, y), holding `text` (none, if
/// not given - or if it is words the body could not keep).
export function addTextLayer(drawing, layerId, { x, y, font, size, color, align, text = '' }, now) {
    const out = addLayer(drawing, layerId, now);
    const words = isTextContent(text) ? text : '';
    return upsertText(out, { layer: layerId, t: now, text: words, font, size, color, align, x: Math.round(x), y: Math.round(y) });
}

/// Change a text layer's words, font, size, colour or alignment. A change the body could not keep
/// (words too long, a control character, a size out of range) changes nothing.
export function setText(drawing, layerId, change, now) {
    const held = textOf(drawing, layerId);
    if (!held) return drawing;
    const next = asText({ ...held, ...change, t: now });
    return next ? upsertText(drawing, next) : drawing;
}
