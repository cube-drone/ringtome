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

// ---- the prize, and the record of a day's game (Curtis, 2026-11-16) ----

/// What winning the day's game pays, in whole H$, by the attempts it took. The bank pays it
/// (bank.rs `wordaga_prize` is this table's twin, and the one that counts); this copy is for the
/// page to say.
export function wordagaPrize(attempts) {
    const table = [15000, 10000, 7500, 2500, 1500, 1000, 750, 650, 600, 550];
    if (!(attempts >= 1)) return 0;
    if (attempts <= 10) return table[attempts - 1];
    if (attempts <= 15) return 500;
    if (attempts <= 20) return 250;
    return 100;
}

/// How long a streak a day is on: the days won straight before it, without a gap - so the day
/// after one won day is on a one-day streak. `records` are `wordagaRecords`; only a day recorded
/// in time counts (bank.rs `wordaga_streak` is its twin, and pays by it).
export function wordagaStreak(records, day) {
    const won = new Set((records || []).filter((r) => r.timely).map((r) => r.day));
    let streak = 0;
    while (won.has(day - 1 - streak)) streak += 1;
    return streak;
}

/// What a day won pays, in horsepennies: the prize for its attempts, times 1 + a tenth per day of
/// its streak (bank.rs `wordaga_pays`).
export function wordagaPays(attempts, streak) {
    return wordagaPrize(attempts) * 10 * (10 + (streak || 0));
}

// ---- a score, shared (Curtis, 2026-11-17) ----
//
// A day's score goes to the feed as an ordinary Marquee post whose whole body is one container
// directive: the numbers as its attributes, and inside it a line of plain words for anything that
// draws no card (RSS, a crawler, a search excerpt). It carries the attempts, the streak, what was
// earned and how LONG the word is - never the word or the guesses, which would spoil the day.

export const WORDAGA_DIRECTIVE = 'wordaga';

/// The post's source for one score. `earned` is horsepennies, 0 where nothing was (the bank
/// gone); `line` is the plain words, kept to one line and clear of the fence.
export function wordagaShareSource({ day, attempts, streak, earned, length }, line) {
    const words = String(line || '')
        .replace(/:::/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return [
        `:::${WORDAGA_DIRECTIVE} day=${day} attempts=${attempts} streak=${streak} earned=${earned} length=${length}`,
        words,
        ':::',
    ].join('\n');
}

/// The score a card's attributes carry, or null if they are not one: whole numbers, in range.
/// A post is anyone's to write, so nothing here is trusted further than being drawable.
export function wordagaShared(attrs) {
    const whole = (value, least, most) => {
        const n = Number(value);
        return /^\d{1,9}$/.test(String(value ?? '')) && n >= least && n <= most ? n : null;
    };
    const score = {
        day: whole(attrs?.day, 1, 999_999),
        attempts: whole(attrs?.attempts, 1, 9_999),
        streak: whole(attrs?.streak ?? 0, 0, 99_999),
        earned: whole(attrs?.earned ?? 0, 0, 999_999_999),
        length: whole(attrs?.length, 1, 12),
    };
    return Object.values(score).includes(null) ? null : score;
}

/// The most guesses a record carries: it is one entry on a chain, and an entry has a size.
const MOST_GUESSES = 200;

/// A won game (pure/wordagagame.js) as the record kept of it: the word, the score - the attempts
/// it took - and every word guessed, in order, the right one last if a guess is what won it.
export function wordagaRecord(game) {
    const guesses = [...(game.misses || [])];
    if (game.last?.ability === 'guess' && game.last.hit) guesses.push(game.word);
    return { word: game.word, score: game.cycle, guesses: guesses.slice(-MOST_GUESSES) };
}

/// The records as the private chain gives them (`values` of the `wordaga` register: the day's
/// number -> the record as JSON), newest day first, passing over anything that is not one.
/// `timely` is whether it was recorded on the day it names or the day after: the bank pays only
/// those, and only those make a streak (bank.rs `wordaga_won`).
export function wordagaRecords(values) {
    const out = [];
    for (const { key, value, updated_at_ms: at } of values || []) {
        const day = Number(key);
        let record;
        try {
            record = JSON.parse(value);
        } catch {
            continue;
        }
        if (!Number.isInteger(day) || !record || !(record.score >= 1)) continue;
        out.push({
            day,
            word: typeof record.word === 'string' ? record.word : '',
            score: record.score,
            guesses: Array.isArray(record.guesses) ? record.guesses.map(String) : [],
            timely: Number.isFinite(at) && [day, day + 1].includes(wordagaDay(at)),
        });
    }
    return out.sort((a, b) => b.day - a.day);
}
