// The paint bucket (Curtis, 2026-09-26): paint dropped at a point pours outward - further the longer
// it is held - and stops at the lines on its layer. Value in, value out: the surface
// (doc/drawing.js) animates the pour and paints what these return.
//
// A pour is stored as where it was dropped and how far it reached (pure/drawing.js, `bucket`), never
// as the pixels it covered: the pixels are worked out again, here, from the layer as it stood at the
// moment of the pour. So this must give every browser the same answer from the same body - which is
// why it rasterises the lines itself, on the drawing's own grid, with plain arithmetic (no square
// roots, no canvas), rather than reading back what a canvas antialiased.
//
// Two steps:
//
//   walls   - every cell of the drawing's grid that a line covers: the brush strokes before the pour
//             on its layer, where they stood then (the grabs between them and the pour applied), an
//             eraser clearing what it crosses. Only lines are walls - an earlier pour, or the base
//             layer's white, is not something paint stops at.
//   field   - how far the paint travels to reach each open cell from where it was dropped, spreading
//             to the eight neighbours (a straight step 3, a diagonal 4 - a close, whole-number stand-in
//             for real distance, so the pour grows as a rough circle). A diagonal step needs both
//             cells beside it open, so paint cannot slip between two pixels of a thin diagonal line.
//
// The pour covers every cell whose distance is within its reach.

import { decodePoints, pressureWidth, offsetsOf } from './drawing.js';

/// The field's units per canvas unit: a straight step, and a diagonal one.
export const STEP = 3;
export const DIAGONAL = 4;

/// How much of a line's width holds paint back: its core, half a cell in from the edge - the
/// antialiased rim is painted over, so a fill meets its line without a pale seam. Never thinner than
/// this, or a one-unit line would leak.
const MIN_WALL_RADIUS = 0.75;

function stampSegment(walls, width, height, [ax, ay], [bx, by], radius, value) {
    const r = Math.max(radius - 0.5, MIN_WALL_RADIUS);
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            // The cell's centre, against the nearest point of the segment.
            const px = x + 0.5 - ax;
            const py = y + 0.5 - ay;
            const k = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
            const ex = px - k * dx;
            const ey = py - k * dy;
            if (ex * ex + ey * ey <= r2) walls[y * width + x] = value;
        }
    }
}

/// The walls a pour at `ops[upto]` meets: a cell per canvas unit, 1 where a line is. `ops` are one
/// layer's steps in painting order (pure/drawing.js, `effectiveOps`); `upto` may be `ops.length`, for
/// a pour about to be made.
export function wallsOf(ops, upto, width, height) {
    const walls = new Uint8Array(width * height);
    const { each } = offsetsOf(ops);
    const [ox, oy] = upto < ops.length ? each[upto] : [0, 0];
    for (let j = 0; j < upto; j++) {
        const op = ops[j];
        if (op.tool !== 'brush' && op.tool !== 'eraser') continue;
        // Where the stroke stood at the pour: shifted by the grabs between the two.
        const sx = each[j][0] - ox;
        const sy = each[j][1] - oy;
        const points = decodePoints(op.points).map(([x, y]) => [x + sx, y + sy]);
        const radius = (i) => (op.size * (op.pressure ? pressureWidth(op.pressure[i]) : 1)) / 2;
        const value = op.tool === 'brush' ? 1 : 0;
        if (points.length === 1) {
            stampSegment(walls, width, height, points[0], points[0], radius(0), value);
            continue;
        }
        // As the stroke is painted (doc/drawing.js, `paintStroke`): each segment as wide as the
        // average of its two ends.
        for (let i = 1; i < points.length; i++) {
            stampSegment(walls, width, height, points[i - 1], points[i], (radius(i - 1) + radius(i)) / 2, value);
        }
    }
    return walls;
}

/// How far paint dropped at (x, y) travels to each cell, in field units (STEP per canvas unit
/// straight across), -1 where it cannot reach; nothing beyond `limit`. Dropped on a line, it
/// reaches nowhere.
export function pourField(walls, width, height, x, y, limit = Infinity) {
    const dist = new Int32Array(width * height).fill(-1);
    if (x < 0 || y < 0 || x >= width || y >= height) return dist;
    const start = y * width + x;
    if (walls[start]) return dist;
    const open = (cx, cy) => cx >= 0 && cy >= 0 && cx < width && cy < height && !walls[cy * width + cx];
    // Dial's algorithm: the steps are small whole numbers, so a queue per distance does what a
    // priority queue would, in order, and the same order everywhere.
    const queue = [[start]];
    dist[start] = 0;
    for (let d = 0; d < queue.length; d++) {
        const here = queue[d];
        if (!here) continue;
        for (const cell of here) {
            if (dist[cell] !== d) continue;
            const cx = cell % width;
            const cy = (cell - cx) / width;
            for (let ny = -1; ny <= 1; ny++) {
                for (let nx = -1; nx <= 1; nx++) {
                    if (!nx && !ny) continue;
                    if (!open(cx + nx, cy + ny)) continue;
                    const diagonal = nx && ny;
                    if (diagonal && !(open(cx + nx, cy) && open(cx, cy + ny))) continue;
                    const nd = d + (diagonal ? DIAGONAL : STEP);
                    if (nd > limit) continue;
                    const n = (cy + ny) * width + cx + nx;
                    if (dist[n] !== -1 && dist[n] <= nd) continue;
                    dist[n] = nd;
                    (queue[nd] || (queue[nd] = [])).push(n);
                }
            }
        }
        queue[d] = null;
    }
    return dist;
}

/// The cells the pour at `ops[index]` covers, as runs along each row: a flat list of
/// [y, from, to (inclusive), ...] - small to keep, whatever the canvas.
export function pourRuns(ops, index, width, height) {
    const pour = ops[index];
    const walls = wallsOf(ops, index, width, height);
    const dist = pourField(walls, width, height, pour.points[0], pour.points[1], pour.reach * STEP);
    return runsOf(dist, width, height);
}

/// A field's covered cells (distance 0 or more) as row runs, as `pourRuns` gives them.
export function runsOf(dist, width, height, limit = Infinity) {
    const runs = [];
    for (let y = 0; y < height; y++) {
        let from = -1;
        for (let x = 0; x <= width; x++) {
            const d = x < width ? dist[y * width + x] : -1;
            const covered = d >= 0 && d <= limit;
            if (covered && from < 0) from = x;
            else if (!covered && from >= 0) {
                runs.push(y, from, x - 1);
                from = -1;
            }
        }
    }
    return runs;
}
