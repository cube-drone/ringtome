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

/// Toggle one value in a pick list, returning the new list.
export function togglePick(picked, value) {
    const list = picked || [];
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
