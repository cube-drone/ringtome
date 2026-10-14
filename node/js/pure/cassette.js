// A cassette's look (Curtis, 2026-10-13): on top of its colours, the things a real cassette's label
// carries, chosen by chance - an "A" or "B" side in a square, the tape's length ("C-90", "90"),
// "HORSE STEREO" on its band, a block of colour, diagonal stripes growing wider, where the title and
// the artist are written, the lines to write them on, and the hand they're written in. The chance
// is seeded by the song's key, so a song always comes on the same cassette. Pure, so the vectors
// (integration/test/pure/amp.cjs) can hold it to that; player.js draws it.

import { seededRandom } from './shuffle.js';

/// The cassettes' colours (apps/amp.css): the house's, a dark one, the accent's, the tags' colour.
export const CASSETTE_STYLES = [
    'cassette-style-0',
    'cassette-style-1',
    'cassette-style-2',
    'cassette-style-3',
];

/// What a tape's length can say.
export const TAPE_LENGTHS = ['C-46', 'C-60', 'C-90', '60', '90'];

/// Where the title and the artist are written: the title on the top line and the artist along the
/// foot (`classic`); both centred (`centred`); both on the top lines, one under the other
/// (`stacked`); or both from the left (`left`).
export const LAYOUTS = ['classic', 'centred', 'stacked', 'left'];

/// The hands a label is written in (Curtis, 2026-10-13 - all loaded anyway, fonts.css): each its
/// `cls` on the cassette, how wide its letters run on average (ems, measured in Chrome over
/// mixed-case titles - Caveat's narrow, Major Mono's wide), and its sizes for the title and the
/// artist, chosen so each reads about as large as Caveat's 22 and 15 do.
export const CASSETTE_FONTS = [
    { cls: 'cassette-font-caveat', width: 0.39, title: 22, artist: 15 },
    { cls: 'cassette-font-audiowide', width: 0.66, title: 16, artist: 11 },
    { cls: 'cassette-font-major-mono', width: 0.74, title: 15, artist: 10 },
    { cls: 'cassette-font-atkinson', width: 0.52, title: 17, artist: 12 },
    { cls: 'cassette-font-special-elite', width: 0.55, title: 17, artist: 12 },
    { cls: 'cassette-font-bungee', width: 0.645, title: 16, artist: 11 },
    { cls: 'cassette-font-orbitron', width: 0.66, title: 16, artist: 11 },
    { cls: 'cassette-font-bitcount', width: 0.6, title: 17, artist: 12 },
];

/// The room a label's line has, in the cassette's units: the title's line, and the artist's.
export const LINE_ROOM = { title: 242, artist: 236 };

/// How a line is written in `font`: `{ room, size, least }` for `onLabel` (pure/amp.js) - the
/// letters that fit at its size, and the smallest it may shrink to. A stacked label writes both
/// smaller, to fit two to the top.
export function fontFit(font, part, stacked = false) {
    const size = Math.round(font[part] * (stacked ? 0.92 : 1));
    return {
        room: Math.floor(LINE_ROOM[part] / (font.width * size)),
        size,
        least: Math.max(9, Math.round(size * (part === 'title' ? 0.6 : 0.72))),
    };
}

const hashOf = (key) => {
    let h = 0;
    for (const ch of key || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h;
};

/// A song's cassette, by its key:
///   - `style`: its colours, as before this (2026-10-13) - a song keeps the colour it had;
///   - `side`: `{ letter: 'A' | 'B', at: 'left' | 'right' }`, in a square beside the window, or null;
///   - `length`: one of `TAPE_LENGTHS`, beside the window opposite the side, or null;
///   - `brand`: "HORSE STEREO" on the band, or null;
///   - `block`: a block of colour along the label's `left`, `right` or `top`, or null;
///   - `stripes`: diagonal stripes, growing wider, at the band's end;
///   - `layout`: one of `LAYOUTS`;
///   - `lines`: the lines to write on - `one`, `ruled` (several, faint) or `none`;
///   - `font`: the hand it's written in, one of `CASSETTE_FONTS`.
export function cassetteLook(key) {
    const h = hashOf(key);
    const random = seededRandom(h ^ 0x5eed);
    const pick = (list) => list[Math.floor(random() * list.length)];
    const side =
        random() < 0.65
            ? { letter: random() < 0.75 ? 'A' : 'B', at: random() < 0.5 ? 'left' : 'right' }
            : null;
    return {
        style: CASSETTE_STYLES[h % CASSETTE_STYLES.length],
        side,
        length: random() < 0.6 ? pick(TAPE_LENGTHS) : null,
        brand: random() < 0.4 ? 'HORSE STEREO' : null,
        block: pick([null, null, 'left', 'right', 'top']),
        stripes: random() < 0.45,
        layout: pick(LAYOUTS),
        lines: pick(['one', 'one', 'ruled', 'none']),
        // Last, so every choice before it stays as it was before fonts came.
        font: pick(CASSETTE_FONTS),
    };
}
