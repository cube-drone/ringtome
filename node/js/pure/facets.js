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
export const tagFamily = (tag) =>
    SIZE_TAGS.includes(tag) ? 'size' : MEDIA_TAGS.includes(tag) ? 'media' : 'tags';

/// The tag row split three ways: `{ size, media, tags }`, sizes and media in their fixed order
/// (smallest first, then a-z), the ordinary tags as the node counted them.
export function tagRows(tags) {
    const all = tags || [];
    const inOrder = (order) => order.map((v) => all.find((f) => f.value === v)).filter(Boolean);
    return {
        size: inOrder(SIZE_TAGS),
        media: inOrder(MEDIA_TAGS),
        tags: all.filter((f) => tagFamily(f.value) === 'tags'),
    };
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
export const LEFT_OUT = {
    kinds: 'notKinds',
    buckets: 'notBuckets',
    tags: 'notTags',
    authors: 'notAuthors',
    groups: 'notGroups',
};

/// The picks' words in an address (Curtis, 2026-10-11: "just my books" as a link someone can hand
/// on), named as the node's own doors name them (postsearch.js `narrowParams`): `kind=book`,
/// `not_tag=nsfw`, `author=<root>`. "me" is the reader's own feed's, and never in an address.
const URL_ROWS = [
    ['kinds', 'kind'],
    ['buckets', 'bucket'],
    ['tags', 'tag'],
    ['authors', 'author'],
    ['groups', 'group'],
];
const URL_KEYS = new Set(URL_ROWS.flatMap(([, key]) => [key, `not_${key}`]));

/// The picks an address's query names, or null when it names none.
export function picksFromQuery(search) {
    const params = new URLSearchParams(search || '');
    const picks = {};
    let any = false;
    for (const [row, key] of URL_ROWS) {
        picks[row] = params.getAll(key).filter(Boolean);
        picks[LEFT_OUT[row]] = params.getAll(`not_${key}`).filter(Boolean);
        any = any || picks[row].length > 0 || picks[LEFT_OUT[row]].length > 0;
    }
    return any ? picks : null;
}

/// `search` (an address's query, `?` or not) with its picks replaced by `picks`' - every other
/// parameter kept as it was. Answers the query with its `?`, or '' when nothing is left.
export function queryWithPicks(search, picks) {
    const params = new URLSearchParams(search || '');
    for (const key of URL_KEYS) params.delete(key);
    for (const [row, key] of URL_ROWS) {
        for (const v of (picks && picks[row]) || []) params.append(key, v);
        for (const v of (picks && picks[LEFT_OUT[row]]) || []) params.append(`not_${key}`, v);
    }
    const q = params.toString();
    return q ? `?${q}` : '';
}

/// A folder's picks (plans/WEB_ADDRESSES.md, ruling 7): a notebook's folder is the person's page
/// narrowed to the notebook, so the page starts from `base` - picks the address doesn't spell out -
/// and the address carries only what's picked beyond it. `withBase` is the page's picks from an
/// address's; `keepsBase`, whether picks still hold the folder (unpicking its notebook leaves the
/// folder for the person's page); `beyondBase`, what the address says while it does.
const rowsOf = (picks, row) => (picks && picks[row]) || [];
export function withBase(base, picks) {
    const out = {};
    for (const row of [...Object.keys(LEFT_OUT), ...Object.values(LEFT_OUT)]) {
        out[row] = [...new Set([...rowsOf(base, row), ...rowsOf(picks, row)])];
    }
    if (picks && picks.me !== undefined) out.me = picks.me;
    return out;
}
export const keepsBase = (base, picks) =>
    Object.keys(LEFT_OUT).every((row) =>
        rowsOf(base, row).every((v) => rowsOf(picks, row).includes(v)),
    );
export function beyondBase(base, picks) {
    const out = { ...picks };
    for (const row of Object.keys(LEFT_OUT)) {
        out[row] = rowsOf(picks, row).filter((v) => !rowsOf(base, row).includes(v));
    }
    return out;
}

/// The fewest posts a notebook needs to be a chip on the strip (Curtis, 2026-10-11: "a lot of
/// 1-item buckets (books)"): a book is a notebook of its own, and each one's pages made a chip of
/// one. A picked one stays whatever its count, so it can be clicked back.
export const BUCKET_FLOOR = 2;

/// The bucket row's chips: those at the floor or over it.
export const bucketChips = (counted) => (counted || []).filter((f) => f.count >= BUCKET_FLOOR);

/// The authors row's chips (2026-10-11), the most prolific first as the node counts them - less
/// `self`, whose own chip is "me". Shown only when there is a choice: two authors or more, or one
/// picked.
export function authorChips(counted, self = null) {
    return (counted || []).filter((f) => f.value !== self);
}

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
