/*
    Wordaga's word of the day (Curtis, 2026-11-13). Nobody hands the word out: every install works
    it out from the date, so the arithmetic is an agreement between all of them, and these words
    are that agreement written down. A change that moves one of them has split the network into
    people guessing different words.
*/
const assert = require('node:assert');

let wordOfDay, wordagaDay, untilNextWord, wordagaPrize, wordagaRecord, wordagaRecords, WORDS;
let wordagaStreak, wordagaPays, wordagaShareSource, wordagaShared;
before(async () => {
    ({ wordOfDay, wordagaDay, untilNextWord, wordagaPrize, wordagaRecord, wordagaRecords } =
        await import('../../../js/pure/wordaga.js'));
    ({ wordagaStreak, wordagaPays, wordagaShareSource, wordagaShared } =
        await import('../../../js/pure/wordaga.js'));
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

    it('pays by the attempts it took', () => {
        const prizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(wordagaPrize);
        assert.deepEqual(prizes, [15000, 10000, 7500, 2500, 1500, 1000, 750, 650, 600, 550]);
        assert.deepEqual(
            [11, 15, 16, 20, 21, 169].map(wordagaPrize),
            [500, 500, 250, 250, 100, 100],
        );
        assert.equal(wordagaPrize(0), 0);
        assert.equal(wordagaPrize(undefined), 0);
    });

    it('keeps a won game as its word, its score and its guesses', () => {
        const guessed = {
            word: 'neon',
            cycle: 3,
            misses: ['nine', 'noon'],
            last: { ability: 'guess', hit: true },
        };
        assert.deepEqual(wordagaRecord(guessed), {
            word: 'neon',
            score: 3,
            guesses: ['nine', 'noon', 'neon'],
        });
        const placed = {
            word: 'neon',
            cycle: 2,
            misses: ['nine'],
            last: { ability: 'test-vowel', hit: true },
        };
        assert.deepEqual(
            wordagaRecord(placed).guesses,
            ['nine'],
            'won by its letters: no last guess',
        );
    });

    it('reads the records back newest first, passing over what is not one', () => {
        const values = [
            { key: '20771', value: JSON.stringify({ word: 'neon', score: 3, guesses: ['nine'] }) },
            { key: '20773', value: JSON.stringify({ word: 'oat', score: 1 }) },
            { key: 'soon', value: JSON.stringify({ word: 'x', score: 1 }) },
            { key: '20772', value: 'not json' },
            { key: '20774', value: JSON.stringify({ word: 'hay' }) },
        ];
        assert.deepEqual(wordagaRecords(values), [
            { day: 20773, word: 'oat', score: 1, guesses: [], timely: false },
            { day: 20771, word: 'neon', score: 3, guesses: ['nine'], timely: false },
        ]);
        assert.deepEqual(wordagaRecords(undefined), []);
    });

    it('counts a record as timely when written on its day or the day after', () => {
        const value = JSON.stringify({ word: 'oat', score: 2 });
        const noon = (day) => day * DAY + DAY / 2;
        const timely = (day, at) =>
            wordagaRecords([{ key: String(day), value, updated_at_ms: at }])[0].timely;
        assert.equal(timely(20773, noon(20773)), true);
        assert.equal(timely(20773, noon(20774)), true);
        assert.equal(timely(20773, noon(20775)), false);
        assert.equal(timely(20773, noon(20772)), false);
    });

    it('writes a shared score as one directive, and reads it back - never the word', () => {
        const score = { day: 20774, attempts: 7, streak: 3, earned: 97500, length: 5 };
        const source = wordagaShareSource(score, 'Wordaga: got it\nin 7 ::: attempts.');
        assert.equal(
            source,
            ':::wordaga day=20774 attempts=7 streak=3 earned=97500 length=5\n' +
                'Wordaga: got it in 7 attempts.\n:::',
        );
        const attrs = { day: '20774', attempts: '7', streak: '3', earned: '97500', length: '5' };
        assert.deepEqual(wordagaShared(attrs), score);
        assert.deepEqual(wordagaShared({ day: '20774', attempts: '1', length: '4' }), {
            day: 20774,
            attempts: 1,
            streak: 0,
            earned: 0,
            length: 4,
        });
        for (const bad of [
            { ...attrs, attempts: '0' },
            { ...attrs, length: '40' },
            { ...attrs, streak: '-1' },
            { ...attrs, earned: '1e9' },
            { ...attrs, day: 'today' },
            {},
            undefined,
        ])
            assert.equal(wordagaShared(bad), null);
    });

    it('counts a streak as the days won straight before, and pays a tenth more per day', () => {
        // The 11th, 12th, 14th, 15th, 16th and 17th won (Curtis, 2026-11-17).
        const records = [11, 12, 14, 15, 16, 17].map((day) => ({ day, timely: true }));
        assert.deepEqual(
            [11, 12, 14, 15, 16, 17, 18, 20].map((day) => wordagaStreak(records, day)),
            [0, 1, 0, 1, 2, 3, 4, 0],
        );
        const late = records.map((r) => (r.day === 15 ? { ...r, timely: false } : r));
        assert.equal(wordagaStreak(late, 17), 1, 'a day filled in late breaks the streak');
        assert.equal(wordagaPays(7, 0), 75000);
        assert.equal(wordagaPays(7, 3), 97500, 'H$ 750 x 1.3');
        assert.equal(wordagaPays(7, 365), 2812500, 'x 37.5');
    });
});
