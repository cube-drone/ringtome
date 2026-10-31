// The picture viewer's arithmetic (Curtis, 2026-10-30: a picture a phone shrinks to fit a post or a
// chat line opens full size, to pinch and pan around). Value in, value out; zoomview.js measures
// the screen and the fingers.
//
// A box is the screen the picture is shown on, `{ width, height }`; a picture is its natural size,
// `{ width, height }`. A view is where the picture sits in the box: `{ scale, x, y }` - drawn at
// `scale` times its natural size, its top-left corner at `x`, `y` from the box's, in CSS pixels.

/// Four times the picture's own pixels is as close as anyone needs to look.
export const MAX_SCALE = 4;

/// The scale that fits the whole picture in the box, never past its own size: a small picture stays
/// small rather than blurring up.
export const fitScale = (box, pic) => Math.min(1, box.width / pic.width, box.height / pic.height);

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/// The view kept to what makes sense: no smaller than the fit, no bigger than MAX_SCALE, centred on
/// an axis where the picture is narrower than the box, and with no gap at an edge where it's wider.
export function settle(box, pic, view) {
    const fit = fitScale(box, pic);
    const scale = clamp(view.scale, fit, Math.max(fit, MAX_SCALE));
    const w = pic.width * scale;
    const h = pic.height * scale;
    return {
        scale,
        x: w <= box.width ? (box.width - w) / 2 : clamp(view.x, box.width - w, 0),
        y: h <= box.height ? (box.height - h) / 2 : clamp(view.y, box.height - h, 0),
    };
}

/// The whole picture, fitted and centred: where the viewer opens.
export const fitted = (box, pic) => settle(box, pic, { scale: fitScale(box, pic), x: 0, y: 0 });

/// The view at a new scale, keeping the picture's point under the box spot `px`, `py` where it was -
/// a wheel turn or a double tap, zooming at the pointer.
export function zoomAt(box, pic, view, scale, px, py) {
    const k = scale / view.scale;
    return settle(box, pic, { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k });
}

const mid = (pts) => ({
    x: pts.reduce((s, p) => s + p.x, 0) / pts.length,
    y: pts.reduce((s, p) => s + p.y, 0) / pts.length,
});
const spread = (pts) => (pts.length < 2 ? 0 : Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y));

/// A gesture's view: the fingers were at `from` when the view was `start`, and are at `to` now (the
/// same fingers in the same order, one or two). The picture's point under the fingers' middle stays
/// under it, and two fingers spreading or closing scale it by how far apart they are - one finger
/// drags, two pinch and drag at once.
export function gesture(box, pic, start, from, to) {
    const a = spread(from);
    const b = spread(to);
    const scale = a > 0 && b > 0 ? start.scale * (b / a) : start.scale;
    const m0 = mid(from);
    const m1 = mid(to);
    const k = scale / start.scale;
    return settle(box, pic, {
        scale,
        x: m1.x - (m0.x - start.x) * k,
        y: m1.y - (m0.y - start.y) * k,
    });
}

/// A double tap: back to the fit when zoomed in, else in to the picture's own pixels at the tap - or
/// twice the fit, for a picture whose own pixels are hardly bigger than fitting.
export function doubleTap(box, pic, view, px, py) {
    const fit = fitScale(box, pic);
    if (view.scale > fit * 1.01) return fitted(box, pic);
    return zoomAt(box, pic, view, Math.min(MAX_SCALE, Math.max(1, fit * 2)), px, py);
}

/// Whether a picture on the page is shown smaller than its own pixels - the ones worth opening. A
/// couple of pixels' slack, for the rounding of a fractional layout.
export const shrunk = (natural, shown) =>
    natural.width > shown.width + 2 || natural.height > shown.height + 2;
