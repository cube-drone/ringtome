// The transform tool (Curtis, 2026-09-27): rotate, scale and slant the whole current layer by
// dragging its frame. Value in, value out: the surface (doc/drawing.js) draws the frame, listens,
// and records what these return as one `transform` entry per drag (pure/drawing.js).
//
// The frame is four corners, top-left, top-right, bottom-right, bottom-left - a rectangle round the
// layer's content at first, a parallelogram once slanted. Where a drag begins decides what it does:
//
//   a corner   slants: sideways, the edge along the top or bottom leans; up or down, the side edge
//              does - the opposite corner stays put, the frame stays a parallelogram, and the
//              layer stays sharp (it is redrawn through the matrix, never warped as a picture).
//              With shift: scales the whole, about the opposite corner.
//   an edge    scales across it, the opposite edge staying put. With shift: the whole, evenly.
//   inside     moves.
//   outside    rotates about the frame's middle. With shift: in steps of 15 degrees.
//
// Every gesture is worked out in the frame's own coordinates - the unit square, (0,0) its top-left
// corner, (1,1) its bottom-right - so a slanted frame scales along its own slant.
import { compose, apply } from './drawing.js';

/// The rotation step with shift held.
export const ROTATE_STEP = Math.PI / 12;

/// A box [left, top, right, bottom] as a frame.
export const frameOf = ([l, t, r, b]) => [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
];

/// A frame through a matrix.
export const frameThrough = (m, frame) => frame.map((p) => apply(m, p));

export function invert([a, b, c, d, e, f]) {
    const det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/// The matrix taking the unit square to the frame.
function basisOf([p0, p1, , p3]) {
    return [p1[0] - p0[0], p1[1] - p0[1], p3[0] - p0[0], p3[1] - p0[1], p0[0], p0[1]];
}

const about = ([x, y], m) => compose([1, 0, 0, 1, x, y], compose(m, [1, 0, 0, 1, -x, -y]));
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function toSegment(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const k =
        len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return dist2(p, [a[0] + k * dx, a[1] + k * dy]);
}

/// What a press at `p` takes hold of, `reach` canvas units being close enough: `{ kind: 'corner',
/// i }` (i the corner, 0 top-left clockwise), `{ kind: 'edge', i }` (edge i runs from corner i to
/// the next: 0 top, 1 right, 2 bottom, 3 left), `{ kind: 'inside' }` or `{ kind: 'outside' }`.
/// Corners win over edges, edges over the inside.
export function gripAt(frame, p, reach) {
    const r2 = reach * reach;
    for (let i = 0; i < 4; i++) if (dist2(p, frame[i]) <= r2) return { kind: 'corner', i };
    for (let i = 0; i < 4; i++)
        if (toSegment(p, frame[i], frame[(i + 1) % 4]) <= r2) return { kind: 'edge', i };
    const [u, v] = apply(invert(basisOf(frame)), p);
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? { kind: 'inside' } : { kind: 'outside' };
}

/// The corners' places in the unit square.
const UNIT = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
];

/// Never scale through nothing: a drag that would collapse the layer stops just short of it.
const nonZero = (s) => (Math.abs(s) < 0.01 ? (s < 0 ? -0.01 : 0.01) : s);

/// The matrix a drag makes, in canvas units: `grip` from `gripAt`, the pointer `from` where it was
/// pressed `to` where it is now, `perfect` while shift is held.
export function gestureMatrix(frame, grip, from, to, perfect = false) {
    const basis = basisOf(frame);
    const local = invert(basis);
    const inFrame = (m) => compose(basis, compose(m, local));
    const [fu, fv] = apply(local, from);
    const [tu, tv] = apply(local, to);
    const du = tu - fu;
    const dv = tv - fv;

    if (grip.kind === 'inside') return [1, 0, 0, 1, to[0] - from[0], to[1] - from[1]];

    if (grip.kind === 'outside') {
        const c = [(frame[0][0] + frame[2][0]) / 2, (frame[0][1] + frame[2][1]) / 2];
        let angle =
            Math.atan2(to[1] - c[1], to[0] - c[0]) - Math.atan2(from[1] - c[1], from[0] - c[0]);
        if (perfect) angle = Math.round(angle / ROTATE_STEP) * ROTATE_STEP;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        return about(c, [cos, sin, -sin, cos, 0, 0]);
    }

    if (grip.kind === 'edge') {
        // How far the grabbed edge moved across the frame, as a scale about the opposite edge.
        const across = grip.i % 2 === 1; // the right and left edges scale across u; top and bottom, v
        const far = grip.i === 1 || grip.i === 2; // the right and bottom edges are at 1, the others at 0
        const s = nonZero(1 + (far ? 1 : -1) * (across ? du : dv));
        const anchorU = across ? (far ? 0 : 1) : 0.5;
        const anchorV = across ? 0.5 : far ? 0 : 1;
        const scale = perfect
            ? [s, 0, 0, s, 0, 0]
            : across
              ? [s, 0, 0, 1, 0, 0]
              : [1, 0, 0, s, 0, 0];
        return inFrame(about([anchorU, anchorV], scale));
    }

    // A corner.
    const [cu, cv] = UNIT[grip.i];
    if (perfect) {
        // Scale the whole about the opposite corner, by how far along the diagonal the corner came.
        const corner = frame[grip.i];
        const opposite = frame[(grip.i + 2) % 4];
        const target = [to[0] + corner[0] - from[0], to[1] + corner[1] - from[1]];
        const d = [corner[0] - opposite[0], corner[1] - opposite[1]];
        const s = nonZero(
            ((target[0] - opposite[0]) * d[0] + (target[1] - opposite[1]) * d[1]) /
                (d[0] * d[0] + d[1] * d[1]),
        );
        return about(opposite, [s, 0, 0, s, 0, 0]);
    }
    // Slant: the edge through the corner along u leans by du, the edge through it along v by dv.
    // In the unit square, x' = x + du * (cv ? y : 1 - y) and y' = y + dv * (cu ? x : 1 - x).
    return inFrame([1, cu ? dv : -dv, cv ? du : -du, 1, cv ? 0 : du, cu ? 0 : dv]);
}

/// The box round everything painted on a layer: the canvas's pixels (`data`, RGBA, `width` x
/// `height`) where anything is, in the drawing's units (`backing` pixels to a unit). Null when the
/// layer is empty.
export function paintedBox(data, width, height, backing) {
    let l = width;
    let t = height;
    let r = -1;
    let b = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] === 0) continue;
            if (x < l) l = x;
            if (x > r) r = x;
            if (y < t) t = y;
            if (y > b) b = y;
        }
    }
    return r < 0 ? null : [l / backing, t / backing, (r + 1) / backing, (b + 1) / backing];
}

/// The crop tool's box (Curtis, 2026-09-27) as a drag leaves it: `box` [left, top, right, bottom]
/// in canvas units, `grip` from `gripAt` on its frame (or `{ kind: 'new' }` for a drag begun
/// outside it, which draws a fresh box), the pointer `from` -> `to`, and the canvas `[width,
/// height]` it must stay inside. A corner moves itself, an edge itself, the inside moves the whole
/// box without changing its size; a box dragged inside out is put right way round.
export function dragBox(box, grip, from, to, [width, height]) {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const clampX = (x) => Math.max(0, Math.min(width, x));
    const clampY = (y) => Math.max(0, Math.min(height, y));
    let [l, t, r, b] = box;
    if (grip.kind === 'new') {
        [l, t, r, b] = [from[0], from[1], to[0], to[1]];
    } else if (grip.kind === 'inside') {
        const mx = Math.max(-l, Math.min(width - r, dx));
        const my = Math.max(-t, Math.min(height - b, dy));
        return [l + mx, t + my, r + mx, b + my];
    } else if (grip.kind === 'corner') {
        // Corners clockwise from the top-left: 0 and 3 are on the left, 0 and 1 on the top.
        if (grip.i === 0 || grip.i === 3) l += dx;
        else r += dx;
        if (grip.i === 0 || grip.i === 1) t += dy;
        else b += dy;
    } else if (grip.kind === 'edge') {
        // Edges from the top, clockwise: 0 top, 1 right, 2 bottom, 3 left.
        if (grip.i === 0) t += dy;
        else if (grip.i === 1) r += dx;
        else if (grip.i === 2) b += dy;
        else l += dx;
    }
    return [
        clampX(Math.min(l, r)),
        clampY(Math.min(t, b)),
        clampX(Math.max(l, r)),
        clampY(Math.max(t, b)),
    ];
}

/// The box of a tool whose shape is fixed (Curtis, 2026-09-28: "Set as Profile" and "Set as
/// Banner" - a crop whose aspect can't change): the largest box `ratio` wide to 1 tall that fits
/// in the middle 80% of a `[width, height]` canvas, centred - what the tool lays down when taken up.
export function fitBox(ratio, [width, height]) {
    const w = Math.min(width * 0.8, height * 0.8 * ratio);
    const h = w / ratio;
    const l = (width - w) / 2;
    const t = (height - h) / 2;
    return [l, t, l + w, t + h];
}

/// `dragBox`, keeping the box `ratio` wide to 1 tall. The inside moves it as ever. A corner holds
/// the opposite corner still and the box grows toward the pointer by whichever way it moved
/// further; an edge holds the opposite edge still and the box grows about its middle the other way;
/// a drag begun outside draws a fresh box from where it began. The box never leaves the canvas
/// and never turns inside out: it shrinks to fit instead, and to no less than a sliver.
export function dragBoxAt(box, grip, from, to, [width, height], ratio) {
    if (grip.kind === 'inside') return dragBox(box, grip, from, to, [width, height]);
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const [l, t, r, b] = box;
    // The still point [ax, ay] and which way the box runs from it along each axis: 1 or -1, or 0
    // where the still point is the middle of an edge.
    let ax, ay, sx, sy, w, h;
    if (grip.kind === 'new') {
        [ax, ay] = from;
        sx = dx < 0 ? -1 : 1;
        sy = dy < 0 ? -1 : 1;
        w = Math.max(Math.abs(dx), Math.abs(dy) * ratio);
    } else if (grip.kind === 'corner') {
        // Corners clockwise from the top-left: 0 and 3 are on the left, 0 and 1 on the top.
        const left = grip.i === 0 || grip.i === 3;
        const top = grip.i === 0 || grip.i === 1;
        [ax, sx] = left ? [r, -1] : [l, 1];
        [ay, sy] = top ? [b, -1] : [t, 1];
        w = Math.max(left ? r - l - dx : r - l + dx, (top ? b - t - dy : b - t + dy) * ratio);
    } else {
        // Edges from the top, clockwise: 0 top, 1 right, 2 bottom, 3 left.
        const across = grip.i === 1 || grip.i === 3;
        if (across) {
            [ax, sx] = grip.i === 3 ? [r, -1] : [l, 1];
            [ay, sy] = [(t + b) / 2, 0];
            w = grip.i === 3 ? r - l - dx : r - l + dx;
        } else {
            [ay, sy] = grip.i === 0 ? [b, -1] : [t, 1];
            [ax, sx] = [(l + r) / 2, 0];
            w = (grip.i === 0 ? b - t - dy : b - t + dy) * ratio;
        }
    }
    const room = (a, s, extent) => (s > 0 ? extent - a : s < 0 ? a : 2 * Math.min(a, extent - a));
    w = Math.min(Math.max(w, 8), room(ax, sx, width), room(ay, sy, height) * ratio);
    h = w / ratio;
    const start = (a, s, size) => (s > 0 ? a : s < 0 ? a - size : a - size / 2);
    const x = start(ax, sx, w);
    const y = start(ay, sy, h);
    return [x, y, x + w, y + h];
}
