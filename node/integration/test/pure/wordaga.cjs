/*
    Wordaga's word of the day (Curtis, 2026-11-13). Nobody hands the word out: every install works
    it out from the date, so the arithmetic is an agreement between all of them, and these words
    are that agreement written down. A change that moves one of them has split the network into
    people guessing different words.
*/
const assert = require('node:assert');

let wordOfDay, wordagaDay, untilNextWord, WORDS;
before(async () => {
    ({ wordOfDay, wordagaDay, untilNextWord } = await import('../../../js/pure/wordaga.js'));
    ({ WORDS } = await import('../../../js/pure/words.js'));
});

// A UTC instant, spelled out, so nothing here depends on the machine's own zone.
const at = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo, d, h, mi, s);
const DAY = 86_400_000;

describe("Wordaga's word of the day", () => {
    it('is these words on these days, for everyone, for good', () => {
        assert.equal(wordOfDay(at(2026, 10, 13, 12)), 'half');
        assert.equal(wordOfDay(at(2026, 10, 14, 12)), 'neon');
        assert.equal(wordOfDay(at(2026, 10, 15, 12)), 'hull');
        assert.equal(wordOfDay(at(2030, 0, 1)), 'cycle');
        assert.equal(wordOfDay(at(1970, 0, 1)), 'stole');
        assert.deepEqual(
            Array.from({ length: 7 }, (_, i) => wordOfDay(at(2026, 10, 16, 12) + i * DAY)),
            ['lift', 'april', 'tutu', 'speak', 'glue', 'visor', 'vest'],
        );
    });

    it('changes at @000, midnight in Biel, which is 23:00 UTC all year', () => {
        assert.equal(wordOfDay(at(2026, 10, 13, 22, 59, 59)), 'half');
        assert.equal(wordOfDay(at(2026, 10, 13, 23)), 'neon');
        assert.equal(
            wordagaDay(at(2026, 10, 13, 23)) - wordagaDay(at(2026, 10, 13, 22, 59, 59)),
            1,
        );
        // No summer time in Biel Mean Time: July turns over at 23:00 UTC too.
        assert.notEqual(wordOfDay(at(2026, 6, 1, 22, 59, 59)), wordOfDay(at(2026, 6, 1, 23)));
        assert.equal(wordOfDay(at(2026, 6, 1, 23)), wordOfDay(at(2026, 6, 2, 22, 59, 59)));
    });

    it('says how long until the next one', () => {
        assert.equal(untilNextWord(at(2026, 10, 13, 22, 59, 59)), 1000);
        assert.equal(
            untilNextWord(at(2026, 10, 13, 23)),
            DAY,
            'a whole day at @000, never nothing',
        );
    });

    it('gives every word its day before any comes back', () => {
        const n = WORDS.length;
        const start = Math.ceil(wordagaDay(at(2026, 10, 13)) / n) * n; // the next pass's first day
        const pass = Array.from({ length: n }, (_, i) => wordOfDay((start + i) * DAY));
        assert.equal(new Set(pass).size, n);
        const next = Array.from({ length: n }, (_, i) => wordOfDay((start + n + i) * DAY));
        assert.equal(new Set(next).size, n);
        assert.notDeepEqual(next, pass, 'each pass is shuffled afresh');
    });

    it('takes another list, should the game get its own', () => {
        const mine = ['oat', 'hay', 'bran'];
        const week = Array.from({ length: 6 }, (_, i) =>
            wordOfDay(at(2026, 10, 13) + i * DAY, mine),
        );
        assert.ok(week.every((w) => mine.includes(w)));
        assert.equal(new Set(week.slice(0, 3)).size + new Set(week.slice(3)).size >= 4, true);
        assert.equal(wordOfDay(at(2026, 10, 13), []), '');
    });
});
