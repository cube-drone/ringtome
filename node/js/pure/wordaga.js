// Wordaga's word of the day (apps/games.js; Curtis, 2026-11-13): one word, the same for everyone
// on the network, changing at @000 - midnight in Biel, the corner clock's day (pure/swatch.js).
//
// Nobody hands the word out: every copy of the app works it out from the date alone, so this
// arithmetic is an agreement between every install there will ever be. Change the mixing, the
// salt or the order of the list and two people stop seeing the same word. The goldens in
// integration/test/pure/wordaga.cjs pin it.
//
// It is random enough to feel random, and no more: anyone can work out every word from now until
// the end of time, and that is fine. The list is walked in a shuffled order, a fresh shuffle each
// time through, so no word comes back until every other has had its day.
//
// The list is the app's standard one (pure/words.js) unless another is handed in - the game may
// get a list of its own in a later build.
import { WORDS } from './words.js';

const DAY_MS = 86_400_000;
/// Biel Mean Time is UTC+1, with no summer time, ever.
const BIEL_MS = 3_600_000;
/// Keeps Wordaga's shuffles its own, should anything else ever shuffle by day number.
const SALT = 0x77617264; // "ward"

/// The day's number: whole Biel days since 1970. It turns over at @000.
export const wordagaDay = (ms) => Math.floor((ms + BIEL_MS) / DAY_MS);

/// How long until the day turns over, in milliseconds: never 0, a whole day at @000 itself.
export const untilNextWord = (ms) => DAY_MS - ((((ms + BIEL_MS) % DAY_MS) + DAY_MS) % DAY_MS);

/// mulberry32, written out here and not borrowed: this copy is part of the agreement above.
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const orders = new Map();

/// The order one pass through a list of `n` words takes: the indexes 0..n, shuffled by the pass's
/// number. Kept, since a pass lasts years.
function orderOf(pass, n) {
    const key = `${pass}:${n}`;
    let order = orders.get(key);
    if (!order) {
        const next = random(Math.imul(pass, 0x9e3779b1) ^ SALT);
        order = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
            const j = Math.floor(next() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }
        orders.set(key, order);
    }
    return order;
}

/// The word for the day `ms` falls in.
export function wordOfDay(ms, words = WORDS) {
    const n = words.length;
    if (!n) return '';
    const day = wordagaDay(ms);
    const pass = Math.floor(day / n);
    const place = ((day % n) + n) % n;
    return words[orderOf(pass, n)[place]];
}
