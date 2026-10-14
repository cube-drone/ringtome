// A cassette's look (Curtis, 2026-10-13): on top of its colours, the things a real cassette's label
// carries, chosen by chance - an "A" or "B" side in a square, the tape's length ("C-90", "90"),
// "HORSE STEREO" on its band, a block of colour, diagonal stripes growing wider, where the title and
// the artist are written, and the lines to write them on. The chance is seeded by the song's key,
// so a song always comes on the same cassette. Pure, so the vectors (integration/test/pure/amp.cjs)
// can hold it to that; player.js draws it.

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
///   - `lines`: the lines to write on - `one`, `ruled` (several, faint) or `none`.
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
    };
}
