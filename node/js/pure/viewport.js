// The drawing's navigator (Curtis, 2026-09-27): zoom, and where the stage is looking. Value in,
// value out; the surface (doc/navigator.js) measures the stage and scrolls it.
//
// Zoom is how big the drawing is shown against the size that just fits the stage: 1 fits, 2 is
// twice that and the stage scrolls, 0.75 leaves a margin round it. It belongs to the view, not the drawing - never in the body,
// never synced: two people looking at one horse each look where they like.
//
// A view is the stage as the browser reports it - its scroll position and inner size - and where
// the drawing sits inside it (`paperLeft`/`paperTop`: centred while smaller than the stage, 0 once it
// overflows), all in CSS pixels:
//   { scrollLeft, scrollTop, clientWidth, clientHeight, paperLeft, paperTop, paperWidth, paperHeight }

/// A little smaller than fitting (Curtis, 2026-09-27: "a little bit of zoom out wouldn't hurt"),
/// up to eight times it.
export const MIN_ZOOM = 0.75;
export const MAX_ZOOM = 8;
/// The size that just fits the stage.
export const FIT = 1;
/// A zoom button's step: half again bigger, or two-thirds the size.
export const ZOOM_STEP = 1.5;
/// The zoom slider's range: 0 is MIN_ZOOM, SLIDER_STEPS is MAX_ZOOM, evenly spaced in ratio - so
/// each notch is the same step in, whether at 1x or 6x.
export const SLIDER_STEPS = 100;

export const clampZoom = (z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(z) ? z : FIT));
/// A step in or out - landing exactly on the ends rather than a hair short of them, and on the fit
/// when a step would pass over it.
export const zoomIn = (z) => {
    const next = z * ZOOM_STEP;
    if (z < FIT && next > FIT) return FIT;
    return clampZoom(next > MAX_ZOOM / 1.01 ? MAX_ZOOM : next);
};
export const zoomOut = (z) => {
    const next = z / ZOOM_STEP;
    if (z > FIT && next < FIT) return FIT;
    return clampZoom(next < MIN_ZOOM * 1.01 ? MIN_ZOOM : next);
};

const SPAN = Math.log(MAX_ZOOM / MIN_ZOOM);
export const zoomToSlider = (z) => Math.round((SLIDER_STEPS * Math.log(clampZoom(z) / MIN_ZOOM)) / SPAN);
/// ...snapping to the fit within a notch of it, so the slider can find it.
export const sliderToZoom = (v) => {
    const z = clampZoom(MIN_ZOOM * Math.exp((v / SLIDER_STEPS) * SPAN));
    return Math.abs(Math.log(z / FIT)) < SPAN / SLIDER_STEPS ? FIT : z;
};

/// The drawing's size that just fits a stage of `stageWidth` x `stageHeight`, keeping its
/// proportions.
export function fitSize(stageWidth, stageHeight, width, height) {
    const s = Math.max(0, Math.min(stageWidth / width, stageHeight / height));
    return [width * s, height * s];
}

const clamp01 = (n) => Math.max(0, Math.min(1, n));

/// The part of the drawing the stage shows, as fractions of it: { x, y, w, h }, each 0..1 - the
/// minimap's red square.
export function visibleFraction(v) {
    const x0 = clamp01((v.scrollLeft - v.paperLeft) / v.paperWidth);
    const y0 = clamp01((v.scrollTop - v.paperTop) / v.paperHeight);
    const x1 = clamp01((v.scrollLeft + v.clientWidth - v.paperLeft) / v.paperWidth);
    const y1 = clamp01((v.scrollTop + v.clientHeight - v.paperTop) / v.paperHeight);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/// The scroll that puts the drawing's point (fx, fy) - fractions of it - in the middle of the
/// stage, as far as the stage can scroll: { left, top }.
export function scrollToCentre(v, fx, fy) {
    const maxLeft = Math.max(0, v.paperLeft * 2 + v.paperWidth - v.clientWidth);
    const maxTop = Math.max(0, v.paperTop * 2 + v.paperHeight - v.clientHeight);
    return {
        left: Math.max(0, Math.min(maxLeft, v.paperLeft + fx * v.paperWidth - v.clientWidth / 2)),
        top: Math.max(0, Math.min(maxTop, v.paperTop + fy * v.paperHeight - v.clientHeight / 2)),
    };
}

/// The drawing's point at the middle of the stage, as fractions - what a zoom keeps still.
export function centreOf(v) {
    return {
        fx: clamp01((v.scrollLeft + v.clientWidth / 2 - v.paperLeft) / v.paperWidth),
        fy: clamp01((v.scrollTop + v.clientHeight / 2 - v.paperTop) / v.paperHeight),
    };
}
