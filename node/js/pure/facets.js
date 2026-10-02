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

/// The tag families, each its own row (Curtis, 2026-10-02): a post's size and its media, in their
/// own orders, apart from the ordinary tags. The node's `search::SIZE_TAGS` and `MEDIA_TAGS` -
/// it widens picks within a family and narrows across them, so the rows mean what they look like.
export const SIZE_TAGS = ['micro', 'short', 'medium', 'long'];
export const MEDIA_TAGS = ['audio', 'image', 'video'];

/// Which family a tag is: 'size', 'media', or 'tags' for the ordinary ones.
export const tagFamily = (tag) => (SIZE_TAGS.includes(tag) ? 'size' : MEDIA_TAGS.includes(tag) ? 'media' : 'tags');

/// The tag row split three ways: `{ size, media, tags }`, sizes and media in their fixed order
/// (smallest first, then a-z), the ordinary tags as the node counted them.
export function tagRows(tags) {
    const all = tags || [];
    const inOrder = (order) => order.map((v) => all.find((f) => f.value === v)).filter(Boolean);
    return { size: inOrder(SIZE_TAGS), media: inOrder(MEDIA_TAGS), tags: all.filter((f) => tagFamily(f.value) === 'tags') };
}

/// How many lines a row's chips would wrap onto if it opened (Curtis, 2026-10-02: "more" should open
/// a search box only "if the next row would take up more than two or three lines, otherwise it
/// isn't contributing much beyond what simply displaying the full list would"): `widths` each
/// chip's, `firstRoom` the first line's room once its label is placed, `room` every later line's.
export function wrapLines(widths, firstRoom, room, gap) {
    let lines = 1;
    let left = firstRoom;
    let used = 0;
    for (const w of widths) {
        const need = (used ? gap : 0) + w;
        if (used && need > left) {
            lines += 1;
            left = room;
            used = 0;
        }
        left -= used ? gap + w : w;
        used += 1;
    }
    return lines;
}

/// The most lines "more" opens in place; past it, it opens a search box over the list instead.
export const OPEN_LINES = 3;

/// Toggle one value in a pick list, returning the new list.
export function togglePick(picked, value) {
    const list = picked || [];
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/// Every chip on the strip is three-state (Curtis, 2026-10-01): left alone, "only", "leave out".
/// A row's "only" picks live in its own list (`kinds`, `buckets`, `tags` - kept as they were, so
/// picks remembered from before still read) and its left-out ones beside it, here.
export const LEFT_OUT = { kinds: 'notKinds', buckets: 'notBuckets', tags: 'notTags' };

/// Where one value of a row stands: 'only', 'out', or null for left alone.
export function pickState(picks, row, value) {
    if (((picks && picks[row]) || []).includes(value)) return 'only';
    if (((picks && picks[LEFT_OUT[row]]) || []).includes(value)) return 'out';
    return null;
}

/// One click on a chip: left alone -> only -> leave out -> left alone. Returns the next picks.
export function cyclePick(picks, row, value) {
    const only = (picks[row] || []).filter((v) => v !== value);
    const out = (picks[LEFT_OUT[row]] || []).filter((v) => v !== value);
    const state = pickState(picks, row, value);
    if (state === null) only.push(value);
    if (state === 'only') out.push(value);
    return { ...picks, [row]: only, [LEFT_OUT[row]]: out };
}

/// The "me" chip's same three states, as `picks.me`: undefined (your posts among the rest),
/// 'only' (nothing else), false (left out - and what earlier picks remembered as unpicked).
export function cycleMe(me) {
    if (me === 'only') return false;
    if (me === false) return undefined;
    return 'only';
}

/// The `me=` the node reads for `picks.me` (fanout.rs `Own`), or null for the default.
export const meParam = (me) => (me === 'only' ? 'only' : me === false ? '0' : null);
