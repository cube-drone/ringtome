// A pie's arithmetic (pie.js): each part's wedge of the circle, as the turns it runs between.
// hrseAmp's stations drew the first pies (2026-10-13); the Storage page's files by kind are the
// second (2026-11-20), which is when the drawing became one component.

/// Each part's wedge: `{ from, to }` in turns from the top, clockwise, the parts in order and
/// together the whole circle; `null` for a part with nothing in it. No wedges at all when
/// nothing has anything.
export function wedges(parts) {
    const sizes = (parts || []).map((p) => (p > 0 ? p : 0));
    const total = sizes.reduce((a, b) => a + b, 0);
    if (!total) return sizes.map(() => null);
    let at = 0;
    return sizes.map((size) => {
        if (!size) return null;
        const from = at;
        at += size / total;
        return { from, to: Math.min(1, at) };
    });
}
