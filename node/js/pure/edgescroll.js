// Edge scrolling while dragging (Curtis, 2026-11-01): hold a drag near the top or bottom of a list
// long enough to scroll, and the list scrolls under it - faster the nearer the edge. This module
// is the speed rule; edgescroll.js drives a scroller with it. It imports nothing, so the rule is
// tested without a browser (integration/test/pure/edgescroll.cjs).

/// How deep the zone at each edge is (px), and at most a fifth of the scroller's height.
export const EDGE_ZONE = 56;
/// The fastest scroll, at the edge itself and past it (px per frame).
export const EDGE_TOP_SPEED = 18;

/// How far to scroll this frame (px, negative is up) for a pointer at `y` over a scroller spanning
/// `top`..`bottom` on screen. Zero outside the edge zones; past an edge (over a header above the
/// list, say) is full speed, until a zone's depth beyond it.
export function edgeSpeed(y, top, bottom) {
    const zone = Math.min(EDGE_ZONE, (bottom - top) / 5);
    if (!(zone > 0) || y < top - zone || y > bottom + zone) return 0;
    const ramp = (into) =>
        Math.round(EDGE_TOP_SPEED * Math.min(1, Math.max(0, 1 - into / zone)) ** 2);
    if (y < top + zone) return -Math.max(1, ramp(y - top));
    if (y > bottom - zone) return Math.max(1, ramp(bottom - y));
    return 0;
}
