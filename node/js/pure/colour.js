// Colour, as the drawing app's picker needs it (doc/colourpicker.js): hex <-> RGB <-> HSV, and the
// geometry of a hue ring with an HSV triangle inside it - the GIMP / Krita picker. Value in, value
// out; the picker paints and listens, this decides.
//
// The triangle's three corners are the pure hue, white and black. A point inside it is a mix of the
// three, with weights (a, b, c) summing to 1, and the mix's colour is a*hue + b*white:
//
//   max channel = a + b          -> value      v = a + b
//   min channel = b              -> saturation s = (max - min) / max = a / (a + b)
//
// so a = s*v, b = v*(1 - s), c = 1 - v. Every HSV colour has exactly one point, every point one
// colour, in both directions - which is what makes dragging feel continuous. The triangle turns with
// the hue: its hue corner always points at the hue's place on the ring.

// ---------------------------------------------------------------------------------------------
// Hex, RGB, HSV (channels 0..255, h in degrees 0..360, s and v 0..1)

/// `#rrggbb` (any case, with or without `#`, or the three-digit short form) to [r, g, b], or null.
export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec((hex || '').trim());
    if (!m) return null;
    const digits = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16));
}

/// [r, g, b] to lowercase `#rrggbb` - the form a drawing's strokes store (pure/drawing.js).
export function rgbToHex([r, g, b]) {
    const two = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    return `#${two(r)}${two(g)}${two(b)}`;
}

export function rgbToHsv([r, g, b]) {
    const [R, G, B] = [r / 255, g / 255, b / 255];
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === R) h = 60 * (((G - B) / d) % 6);
        else if (max === G) h = 60 * ((B - R) / d + 2);
        else h = 60 * ((R - G) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToRgb({ h, s, v }) {
    const c = v * s;
    const hh = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = v - c;
    const [r, g, b] =
        hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// ---------------------------------------------------------------------------------------------
// The ring and the triangle, around a centre (cx, cy): the ring between `inner` and `outer`, the
// triangle inscribed in the ring's hole (its corners on the circle of radius `inner`).
//
// Angles are measured like a clock face turned the way screens turn: 0 degrees points right, and
// angles grow clockwise because screen y grows downward.

/// The triangle's corners for a hue: the hue corner at the hue's angle, then white and black at
/// 120 degrees on either side.
export function triangleCorners(h, cx, cy, radius) {
    const at = (deg) => {
        const rad = (deg * Math.PI) / 180;
        return [cx + radius * Math.cos(rad), cy + radius * Math.sin(rad)];
    };
    return { hue: at(h), white: at(h + 120), black: at(h + 240) };
}

/// Where a point lies on the ring, as a hue in degrees.
export function hueAt(x, y, cx, cy) {
    const deg = (Math.atan2(y - cy, x - cx) * 180) / Math.PI;
    return (deg + 360) % 360;
}

/// Is the point within the ring's band?
export function onRing(x, y, cx, cy, inner, outer) {
    const d = Math.hypot(x - cx, y - cy);
    return d >= inner && d <= outer;
}

/// Saturation and value to the point in the triangle that shows them.
export function svToPoint({ s, v }, corners) {
    const a = s * v;
    const b = v * (1 - s);
    const c = 1 - v;
    return [
        a * corners.hue[0] + b * corners.white[0] + c * corners.black[0],
        a * corners.hue[1] + b * corners.white[1] + c * corners.black[1],
    ];
}

function barycentric([px, py], { hue: A, white: B, black: C }) {
    const det = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
    const a = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / det;
    const b = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / det;
    return [a, b, 1 - a - b];
}

function nearestOnSegment([px, py], [x1, y1], [x2, y2]) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return [x1 + t * dx, y1 + t * dy];
}

/// The nearest point of the triangle to (x, y): the point itself when inside, else the nearest
/// point on its edge - so a drag that leaves the triangle slides along its border.
export function clampToTriangle(point, corners) {
    const [a, b, c] = barycentric(point, corners);
    if (a >= 0 && b >= 0 && c >= 0) return point;
    const { hue, white, black } = corners;
    let best = null;
    for (const [p, q] of [[hue, white], [white, black], [black, hue]]) {
        const n = nearestOnSegment(point, p, q);
        const d = Math.hypot(n[0] - point[0], n[1] - point[1]);
        if (!best || d < best.d) best = { n, d };
    }
    return best.n;
}

/// The point (clamped into the triangle) to the saturation and value it shows. At the black corner
/// saturation is anything; it reads as 0.
export function pointToSv(point, corners) {
    const [a, b] = barycentric(clampToTriangle(point, corners), corners);
    const A = Math.max(0, a);
    const B = Math.max(0, b);
    const v = Math.min(1, A + B);
    return { s: v === 0 ? 0 : Math.min(1, A / v), v };
}
