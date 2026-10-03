// The house tooltip's rules (Curtis, 2026-09-27: every tooltip styled, and quicker than the
// browser's): when one shows, and where. Value in, value out; tooltip.js draws it.

/// How long the pointer rests on something before its tooltip shows, in ms - the browser's own is
/// about a second, and not ours to change, which is why the app draws its own.
export const SHOW_MS = 300;
/// Moving on from one tooltip to the next within this long shows the next at once: running the
/// pointer along a row of chips reads each one, rather than waiting on each.
export const WARM_MS = 700;

/// How long to wait before showing, given when the last tooltip was put away (-Infinity for never).
export function tipDelay(now, hiddenAt) {
    return now - hiddenAt < WARM_MS ? 0 : SHOW_MS;
}

/// Where the tooltip goes: centred over what it is about - the pointer's arrow hangs down from its
/// tip, so a tooltip below sat under the cursor (Curtis, 2026-09-27) - or under it when there is
/// no room above, and never past the window's edges. `anchor` is a DOMRect-like { left, top, right, bottom },
/// `size` { width, height } the tooltip's, `viewport` { width, height }. Returns { left, top,
/// above }, in the same pixels.
export function placeTip(anchor, size, viewport, gap = 6, margin = 8) {
    const centre = (anchor.left + anchor.right) / 2;
    const left = Math.max(
        margin,
        Math.min(viewport.width - size.width - margin, centre - size.width / 2),
    );
    const over = anchor.top - gap - size.height;
    const above = over >= margin;
    return { left, top: above ? over : anchor.bottom + gap, above };
}
