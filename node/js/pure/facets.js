// The facet strip's shape (2026-09-07): every bucket and every tag across the whole set,
// sorted by how often they appear, buckets first - and since either list gets insanely
// long in practice, each shows its top few and expands to the rest. Pure: the fold rule
// has a test. A picked value always shows, folded or not, so what narrows the page is
// never hidden behind "more".

export const FACET_TOP = 6;

/// `{ shown, hidden }` for one list: the top `top` by the server's order (plus every picked
/// value), and how many more the fold keeps back.
export function facetSlice(items, picked, expanded, top = FACET_TOP) {
    const all = items || [];
    if (expanded || all.length <= top) return { shown: all, hidden: 0 };
    const chosen = new Set(picked || []);
    const shown = all.filter((f, i) => i < top || chosen.has(f.value));
    return { shown, hidden: all.length - shown.length };
}

/// How many chips fit one line (Curtis, 2026-09-30: "if we have a lot of tags, but also the whole
/// 800px of space, might as well display lots of them. If we have almost no space, we should only
/// display one or two"): `widths` each chip's, in order; `room` the line's width once its label
/// and fixed chips are placed; `more` the "more" button's width; `gap` the space between. All of
/// them when they fit without the button, else as many as fit beside it - never fewer than one.
export function fitCount(widths, room, more, gap) {
    const all = widths.reduce((sum, w, i) => sum + w + (i ? gap : 0), 0);
    if (all <= room) return widths.length;
    const avail = room - more - gap;
    let used = 0;
    let n = 0;
    for (const w of widths) {
        const next = used + (n ? gap : 0) + w;
        if (next > avail) break;
        used = next;
        n++;
    }
    return Math.max(1, n);
}

/// Toggle one value in a pick list, returning the new list.
export function togglePick(picked, value) {
    const list = picked || [];
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
