/*
    Wordaga's rules (Curtis, 2026-11-14): dice spent on abilities, a guess when the last die goes,
    and a score in cycles. The dice come off a counter seeded from the day, so everyone who plays
    a day the same way rolls the same - the first claim pins that.
*/
const assert = require('node:assert');

let G;
before(async () => {
    G = await import('../../../js/pure/wordagagame.js');
});

// A game with the hand set by hand, so a claim can ask for the dice it needs.
const dealt = (word, pips, more = {}) => ({
    ...G.newGame(word, 1),
    hand: pips.map((p) => ({ pips: p, spent: false })),
    count: pips.length,
    ...more,
});
const pips = (state) => state.hand.map((d) => d.pips);

describe("Wordaga's rules", () => {
    it('rolls the same dice for the same seed, for everyone, for good', () => {
        assert.deepEqual(pips(G.newGame('neon', 20771)), pips(G.newGame('hull', 20771)));
        assert.deepEqual(pips(G.newGame('neon', 20771)), [4, 4, 4, 5]);
        assert.deepEqual(pips(G.newGame('neon', 20772)), [6, 1, 3, 4]);
    });

    it('starts with four dice, no apostrophes, and the word blank', () => {
        const g = G.newGame('Neon', 7);
        assert.equal(g.hand.length, 4);
        assert.equal(g.apostrophes, 0);
        assert.deepEqual(G.shown(g), [null, null, null, null]);
        assert.ok(g.hand.every((d) => d.pips >= 1 && d.pips <= 6 && !d.spent));
    });

    it('pays one, two or three apostrophes for a die', () => {
        assert.deepEqual([1, 2, 3, 4, 5, 6].map(G.earns), [1, 1, 2, 2, 3, 3]);
        const g = G.play(dealt('neon', [5, 2, 2, 2]), 'earn', [0]);
        assert.equal(g.apostrophes, 3);
        assert.equal(g.hand[0].spent, true);
        assert.equal(G.play(g, 'earn', [0]), null, 'a spent die is spent');
        // Several at once: a 3, a 5 and a 6 pay 2 + 3 + 3.
        const many = G.play(dealt('neon', [3, 5, 6, 1]), 'earn', [0, 1, 2]);
        assert.equal(many.apostrophes, 8);
        assert.deepEqual(
            many.hand.map((d) => d.spent),
            [true, true, true, false],
        );
    });

    it('spends one die to throw any number of the others again', () => {
        const start = dealt('neon', [1, 2, 3, 4]);
        const g = G.play(start, 'reroll', [0], [2]);
        assert.equal(g.hand[0].spent, true);
        assert.equal(g.hand[2].spent, false);
        assert.deepEqual([pips(g)[1], pips(g)[3]], [2, 4]);
        const all = G.play(start, 'reroll', [0], [3, 1, 2]);
        assert.deepEqual(
            all.hand.map((d) => d.spent),
            [true, false, false, false],
        );
        assert.deepEqual(pips(all), pips(G.play(start, 'reroll', [0], [1, 2, 3])), 'in any order');
        assert.equal(G.play(start, 'reroll', [0], [0]), null, 'not itself');
        assert.equal(G.play(start, 'reroll', [0], []), null, 'not nothing');
        assert.equal(G.can(dealt('neon', [3]), 'reroll', [0]), false, 'nothing to throw');
    });

    it('throws dice that total seven again, for an apostrophe', () => {
        const start = dealt('neon', [1, 2, 4, 6], { apostrophes: 1 });
        assert.equal(G.can(start, 'seven', [0, 3]), true);
        assert.equal(G.can(start, 'seven', [0, 1, 2]), true);
        assert.equal(G.can(start, 'seven', [0, 1]), false);
        assert.equal(G.can({ ...start, apostrophes: 0 }, 'seven', [0, 3]), false, 'not free');
        const g = G.play(start, 'seven', [0, 1, 2]);
        assert.ok(g.hand.every((d) => !d.spent));
        assert.equal(pips(g)[3], 6);
        assert.equal(g.apostrophes, 0);
    });

    it('rules out a letter that is not in the word, of its own choosing, for a 1', () => {
        let g = dealt('neon', Array(22).fill(1));
        for (let i = 0; i < 22; i++) g = G.play(g, 'rule-out', [i]);
        // Twenty-six letters less n, e, o: twenty-three absent, twenty-two now known.
        const out = Object.keys(g.known);
        assert.equal(out.length, 22);
        assert.ok(out.every((l) => g.known[l] === 'out' && !'neo'.includes(l)));
        const hand = dealt('neon', [1, 2, 6]);
        assert.deepEqual(
            [0, 1, 2].map((i) => G.can(hand, 'rule-out', [i])),
            [true, false, false],
            'only a 1 will do',
        );
    });

    it('tests a consonant for a run and two apostrophes, or a pair and six', () => {
        const start = dealt('neon', [2, 3, 4, 4], { apostrophes: 8 });
        assert.equal(G.can({ ...start, apostrophes: 1 }, 'consonant-run', [0, 1, 2]), false);
        assert.equal(G.can(start, 'consonant-run', [0, 2, 3]), false, 'not a run');
        const hit = G.play(start, 'consonant-run', [0, 1, 2], 'n');
        assert.deepEqual(G.shown(hit), ['n', null, null, 'n'], 'every place of the letter');
        assert.equal(hit.apostrophes, 6);
        assert.deepEqual(
            hit.hand.map((d) => d.spent),
            [true, true, true, false],
        );
        assert.equal(G.can({ ...start, apostrophes: 5 }, 'consonant-pair', [2, 3]), false);
        const miss = G.play(start, 'consonant-pair', [2, 3], 't');
        assert.equal(miss.known.t, 'out');
        assert.equal(miss.apostrophes, 2);
        assert.equal(G.play(miss, 'consonant-run', [0, 1, 2], 't'), null, 'not twice');
        assert.equal(G.play(start, 'consonant-run', [0, 1, 2], 'e'), null, 'not a vowel');
        assert.equal(
            G.can({ ...start, apostrophes: 99 }, 'consonant-pair', []),
            false,
            'never for no dice',
        );
    });

    it('tests an unlikely consonant for a pair', () => {
        const start = dealt('jazz', [3, 3, 5, 6]);
        assert.equal(G.can(start, 'unlikely', [0, 2]), false);
        assert.equal(G.play(start, 'unlikely', [0, 1], 't'), null, 'only the unlikely ones');
        const g = G.play(start, 'unlikely', [0, 1], 'z');
        assert.deepEqual(G.shown(g), [null, null, 'z', 'z']);
        assert.deepEqual([...G.UNLIKELY].sort().join(''), 'bjkpqvwxyz');
    });

    it('buys a die for a pair and money, each one more than the last, up to seven', () => {
        const start = dealt('neon', [2, 2, 5, 6], { apostrophes: 2 });
        assert.equal(G.priceOf(start, 'buy-die'), 2);
        assert.equal(G.can({ ...start, apostrophes: 1 }, 'buy-die', [0, 1]), false);
        const g = G.play(start, 'buy-die', [0, 1]);
        assert.equal(g.count, 5);
        assert.equal(g.hand.length, 5);
        assert.equal(g.hand[4].spent, false);
        assert.equal(g.apostrophes, 0);
        assert.equal(G.priceOf(g, 'buy-die'), 3);
        assert.equal(G.priceOf(dealt('neon', [2, 2, 2, 2, 2, 2]), 'buy-die'), 4);
        assert.equal(G.priceOf(start, 'consonant-pair'), G.PRICE);
        assert.equal(G.priceOf(start, 'earn'), 0);
        const full = dealt('neon', [2, 2, 2, 2, 2, 2, 2], { apostrophes: 6 });
        assert.equal(G.can(full, 'buy-die', [0, 1]), false);
    });

    it('tests a vowel for three of a kind', () => {
        const start = dealt('neon', [4, 4, 4, 1]);
        assert.equal(G.can(start, 'test-vowel', [0, 1, 3]), false);
        assert.equal(G.play(start, 'test-vowel', [0, 1, 2], 'a').known.a, 'out');
        assert.deepEqual(G.shown(G.play(start, 'test-vowel', [0, 1, 2], 'e')), [
            null,
            'e',
            null,
            null,
        ]);
        assert.equal(
            G.play(start, 'test-vowel', [0, 1, 2], 't'),
            null,
            'a consonant is not a vowel',
        );
    });

    it('tests a vowel for nine apostrophes and no dice', () => {
        const start = dealt('neon', [1, 2], { apostrophes: 9 });
        assert.equal(G.can({ ...start, apostrophes: 8 }, 'vowel-paid', []), false);
        assert.equal(G.can(start, 'vowel-paid', [0]), false, 'no dice');
        const g = G.play(start, 'vowel-paid', [], 'o');
        assert.deepEqual(G.shown(g), [null, null, 'o', null]);
        assert.equal(g.apostrophes, 0);
        assert.ok(g.hand.every((d) => !d.spent));
        assert.equal(G.play(start, 'vowel-paid', [], 'n'), null, 'not a consonant');
    });

    it('gives one guess when the last die is spent, and then the next cycle', () => {
        let g = dealt('neon', [2, 3, 4, 6]);
        assert.equal(G.guess(g, 'neon'), null, 'not before the dice are spent');
        g = G.play(g, 'earn', [0, 1, 2, 3]);
        assert.equal(G.guessing(g), true);
        g = G.guess(g, 'noon');
        assert.equal(g.cycle, 2);
        assert.equal(g.apostrophes, 8, 'apostrophes carry over');
        assert.deepEqual(g.misses, ['noon']);
        assert.ok(g.hand.length === 4 && g.hand.every((d) => !d.spent));
    });

    it('lets the guess be given up for two apostrophes, and the cycle is spent all the same', () => {
        let g = dealt('neon', [2, 3, 4, 6]);
        assert.equal(G.pass(g), null, 'not before the dice are spent');
        g = G.play(g, 'earn', [0, 1, 2, 3]);
        const passed = G.pass(g);
        assert.equal(passed.apostrophes, g.apostrophes + G.PASS_PAYS);
        assert.equal(G.PASS_PAYS, 2);
        assert.equal(passed.cycle, 2, 'the score counts a cycle passed as it counts a miss');
        assert.deepEqual(passed.misses, [G.SKIPPED], 'a skip stands where a guess would');
        assert.equal(G.SKIPPED, '', 'and is no word a guess could be');
        assert.deepEqual(G.guess(G.play(passed, 'earn', [0, 1, 2, 3]), 'nope').misses, [
            '',
            'nope',
        ]);
        assert.deepEqual(passed.last, { ability: 'pass', gained: 2 });
        assert.ok(passed.hand.length === 4 && passed.hand.every((d) => !d.spent));
        // The same dice as a wrong guess would have thrown: passing moves no die.
        assert.deepEqual(
            passed.hand.map((d) => d.pips),
            G.guess(g, 'nope').hand.map((d) => d.pips),
        );
        assert.equal(G.pass(passed), null, 'one a cycle: the new dice are not spent yet');
        const won = G.guess(G.play(passed, 'earn', [0, 1, 2, 3]), 'neon');
        assert.equal(G.pass(won), null, 'nothing to give up in a game won');
    });

    it('holds six cycles to be par: under through the sixth, par for two more, over after', () => {
        assert.deepEqual([1, 6, 7, 8, 9, 20].map(G.standing), [
            'under',
            'under',
            'par',
            'par',
            'over',
            'over',
        ]);
    });

    it('is won by the word, however it is typed, and scored by the cycle', () => {
        let g = dealt('neon', [1]);
        g = G.guess(G.play(g, 'earn', [0]), 'nope');
        g = G.guess(G.play(g, 'earn', [0]), ' NEON ');
        assert.equal(g.won, true);
        assert.equal(g.cycle, 2);
        assert.deepEqual(G.shown(g), ['n', 'e', 'o', 'n']);
        assert.equal(G.can(g, 'earn', [0]), false);
    });

    it('turns over a blank for four of a kind, and three for five of a kind', () => {
        const start = dealt('speak', [2, 2, 2, 2, 6, 1]);
        assert.equal(G.can(start, 'reveal-one', [0, 1, 2]), false);
        assert.equal(G.reveal(start, 0), null, 'none owed');
        let g = G.play(start, 'reveal-one', [0, 1, 2, 3]);
        assert.equal(g.reveals, 1);
        g = G.reveal(g, 4);
        assert.deepEqual(G.shown(g), [null, null, null, null, 'k']);
        assert.equal(G.reveal(g, 0), null, 'one was all it bought');

        g = G.play(dealt('neon', [3, 3, 3, 3, 3]), 'reveal-three', [0, 1, 2, 3, 4]);
        g = G.reveal(g, 0);
        assert.deepEqual(G.shown(g), ['n', null, null, 'n'], 'every place of the letter');
        assert.equal(G.reveal(g, 3), null, 'not a blank any more');
        g = G.reveal(g, 1);
        g = G.reveal(g, 2);
        assert.deepEqual(G.shown(g), ['n', 'e', 'o', 'n']);
        assert.equal(g.won, true, 'a word all placed is won, without being said');
        g = G.play(dealt('to', [3, 3, 3, 3, 3]), 'reveal-three', [0, 1, 2, 3, 4]);
        // A short word: won when its last blank goes, and the reveal left over is dropped.
        g = G.reveal(G.reveal(g, 0), 1);
        assert.deepEqual([g.won, g.reveals], [true, 0]);
    });

    it('is won when the last letter is placed, by whatever placed it', () => {
        const start = dealt('neon', [1, 1], { apostrophes: 12, known: { e: 'in', o: 'in' } });
        assert.equal(start.won, false);
        const g = G.play(start, 'consonant-pair', [0, 1], 'n');
        assert.equal(g.won, true);
        assert.equal(g.cycle, 1);
        assert.equal(G.play(start, 'consonant-pair', [0, 1], 't').won, false);
    });

    it('is won outright by six of a kind', () => {
        const g = G.play(dealt('neon', [5, 5, 5, 5, 5, 5]), 'win', [0, 1, 2, 3, 4, 5]);
        assert.equal(g.won, true);
        assert.equal(g.cycle, 1);
        assert.deepEqual(G.shown(g), ['n', 'e', 'o', 'n']);
    });

    it('numbers each throw, so the dice just thrown can be told from the rest', () => {
        const start = G.newGame('neon', 3);
        assert.deepEqual(
            start.hand.map((d) => d.thrown),
            [1, 1, 1, 1],
        );
        const again = G.play(start, 'reroll', [0], [1, 3]);
        assert.deepEqual(
            again.hand.map((d) => d.thrown),
            [1, 2, 1, 2],
        );
        const next = G.guess(G.play(again, 'earn', [1, 2, 3]), 'nope');
        assert.deepEqual(
            next.hand.map((d) => d.thrown),
            [3, 3, 3, 3],
        );
        const bought = G.play(dealt('neon', [2, 2], { apostrophes: 4 }), 'buy-die', [0, 1]);
        assert.equal(bought.hand[2].thrown, 2);
    });

    it('keeps a bought die into the next cycle', () => {
        let g = dealt('neon', [2, 2], { apostrophes: 6 });
        g = G.play(g, 'buy-die', [0, 1]);
        g = G.play(g, 'earn', [2]);
        g = G.guess(g, 'nope');
        assert.equal(g.hand.length, 3);
    });
});

/*
    The daily specials (Curtis, 2026-11-23): two of eighteen dealt into every game of a day, a
    pick-up game too. A game plays only the ones it was dealt.
*/
describe("Wordaga's daily specials", () => {
    const withSpecial = (id, word, hand, more = {}) =>
        dealt(word, hand, { specials: [id], ...more });

    it('deals the same two to everyone for a day, out of eighteen, and plays no other', () => {
        assert.equal(G.SPECIALS.length, 18);
        const today = G.dailySpecials(20780);
        assert.equal(today.length, 2);
        assert.notEqual(today[0], today[1]);
        assert.deepEqual(G.dailySpecials(20780), today, 'the same day, the same two');
        assert.ok(today.every((id) => G.SPECIALS.some((a) => a.id === id)));
        // Over a year of days every one comes up.
        const seen = new Set();
        for (let day = 20780; day < 21145; day++)
            for (const id of G.dailySpecials(day)) seen.add(id);
        assert.equal(seen.size, 18);

        const without = dealt('neon', [3, 3, 3]);
        assert.equal(G.can(without, 'gamble', [0, 1, 2]), false, 'not dealt, not played');
        assert.equal(G.play(without, 'gamble', [0, 1, 2]), null);
        const dealtIt = G.newGame('neon', 5, ['gamble']);
        assert.deepEqual(G.abilitiesOf(dealtIt)[0].id, 'gamble', 'the specials lead the list');
        assert.equal(G.abilitiesOf(dealtIt).length, G.ABILITIES.length + 1);
        assert.equal(G.abilitiesOf(G.newGame('neon', 5)).length, G.ABILITIES.length);
    });

    it('a run of four is a die, free and kept, up to seven', () => {
        let g = withSpecial('run-die', 'neon', [3, 5, 4, 6]);
        assert.equal(
            G.can(withSpecial('run-die', 'neon', [1, 2, 3, 5]), 'run-die', [0, 1, 2, 3]),
            false,
        );
        g = G.play(g, 'run-die', [0, 1, 2, 3]);
        assert.equal(g.count, 5);
        assert.equal(g.hand.length, 5);
        assert.equal(g.apostrophes, 0);
        const full = withSpecial('run-die', 'neon', [1, 2, 3, 4, 6, 6, 6]);
        assert.equal(G.can(full, 'run-die', [0, 1, 2, 3]), false, 'seven is the most');
    });

    it('a 2 lends two dice for the cycle, to nine in a hand, and they are gone the next', () => {
        let g = withSpecial('temp-dice', 'neon', [2, 5, 5, 5]);
        assert.equal(G.can(g, 'temp-dice', [1]), false, 'a 2 and nothing else');
        g = G.play(g, 'temp-dice', [0]);
        assert.equal(g.hand.length, 6);
        assert.equal(g.count, 4, 'not owned');
        assert.deepEqual(
            g.hand.map((d) => !!d.temp),
            [false, false, false, false, true, true],
        );
        const next = G.pass(G.play(g, 'earn', [1, 2, 3, 4, 5]));
        assert.equal(next.hand.length, 4, 'the next cycle throws only the dice owned');
        const crowded = withSpecial('temp-dice', 'neon', [2, 1, 1, 1, 1, 1, 1, 1], { count: 7 });
        assert.equal(
            G.play(crowded, 'temp-dice', [0]).hand.length,
            9,
            'one, where two will not fit',
        );
        const full = withSpecial('temp-dice', 'neon', [2, 1, 1, 1, 1, 1, 1, 1, 1], { count: 7 });
        assert.equal(G.can(full, 'temp-dice', [0]), false);
        // A lent die thrown again is still lent.
        const again = G.play(g, 'reroll', [1], [4]);
        assert.equal(again.hand[4].temp, true);
    });

    it('a 3 makes every skip from then on pay one more', () => {
        let g = withSpecial('pass-bonus', 'neon', [3, 3, 1]);
        g = G.play(g, 'pass-bonus', [0]);
        g = G.play(g, 'pass-bonus', [1]);
        assert.equal(G.passPays(g), G.PASS_PAYS + 2);
        g = G.play(g, 'earn', [2]);
        const first = G.pass(g);
        assert.equal(first.apostrophes, 1 + 4);
        const second = G.pass(G.play(first, 'earn', [0, 1, 2]));
        assert.equal(second.last.gained, 4, 'and the cycle after');
    });

    it('three of a kind wins twenty or nothing, and never moves a die', () => {
        const outcomes = new Set();
        for (let seed = 1; seed <= 40; seed++) {
            const g = {
                ...G.newGame('neon', seed, ['gamble']),
                hand: [4, 4, 4].map((p) => ({ pips: p, spent: false })),
            };
            const after = G.play(g, 'gamble', [0, 1, 2]);
            assert.ok([0, G.GAMBLE_PAYS].includes(after.apostrophes));
            assert.equal(after.last.gained, after.apostrophes);
            assert.equal(after.dice, g.dice, 'the coin is off the letters, not the dice');
            outcomes.add(after.apostrophes);
        }
        assert.deepEqual(
            [...outcomes].sort((a, b) => a - b),
            [0, 20],
            'both come up',
        );
    });

    it("a pair that spells its number tests a letter of the number's name", () => {
        const names = {
            one: 'one',
            two: 'two',
            three: 'thre',
            four: 'four',
            five: 'five',
            six: 'six',
        };
        [...Object.entries(names)].forEach(([name, letters], i) => {
            const n = i + 1;
            const id = `name-${name}`;
            const g = withSpecial(id, 'quiz', [n, n, (n % 6) + 1]);
            assert.deepEqual(G.targets(g, id), [...letters], id);
            assert.equal(G.can(g, id, [0, 1]), true);
            assert.equal(G.can(g, id, [0, 2]), false, 'that pair and no other');
            assert.equal(G.play(g, id, [0, 1], 'q'), null, 'only a letter of the name');
            const after = G.play(g, id, [0, 1], letters[0]);
            assert.ok(after.known[letters[0]]);
            assert.equal(after.apostrophes, 0, 'for nothing');
        });
        // Once every letter of the name is known, the pair has nothing left to test.
        const spent = withSpecial('name-six', 'quiz', [6, 6], {
            known: { s: 'out', i: 'in', x: 'out' },
        });
        assert.equal(G.can(spent, 'name-six', [0, 1]), false);
    });

    it('dice that total exactly ten test a consonant for two', () => {
        const g = withSpecial('consonant-ten', 'neon', [4, 6, 1, 2, 3], { apostrophes: 2 });
        assert.equal(G.can(g, 'consonant-ten', [0, 1]), true);
        assert.equal(G.can(g, 'consonant-ten', [0, 2, 3, 4]), true, 'any number of dice');
        assert.equal(G.can(g, 'consonant-ten', [1, 4]), false, 'nine is not ten');
        assert.equal(G.can({ ...g, apostrophes: 1 }, 'consonant-ten', [0, 1]), false);
        const after = G.play(g, 'consonant-ten', [0, 1], 'n');
        assert.equal(after.known.n, 'in');
        assert.equal(after.apostrophes, 0);
        assert.equal(G.play(g, 'consonant-ten', [0, 1], 'e'), null, 'a consonant');
    });

    it('dice that total twelve or more test a vowel', () => {
        assert.equal(G.VOWEL_TOTAL, 12);
        const g = withSpecial('vowel-total', 'neon', [6, 6, 5, 4, 2, 1]);
        assert.equal(G.can(g, 'vowel-total', [0, 1]), true, 'boxcars will do');
        assert.equal(G.can(g, 'vowel-total', [2, 3, 4, 5]), true, 'or any dice that reach it');
        assert.equal(G.can(g, 'vowel-total', [0, 2]), false, 'eleven is not enough');
        assert.equal(G.play(g, 'vowel-total', [0, 1], 'e').known.e, 'in');
        assert.equal(G.play(g, 'vowel-total', [0, 1], 'n'), null, 'a vowel');
    });

    it('a pair of twos turns every other die to a six', () => {
        const g = withSpecial('all-sixes', 'neon', [2, 1, 2, 3, 5], {
            hand: [2, 1, 2, 3, 5].map((p, i) => ({ pips: p, spent: i === 4 })),
        });
        const after = G.play(g, 'all-sixes', [0, 2]);
        assert.deepEqual(pips(after), [2, 6, 2, 6, 5], 'the others still to be spent');
        assert.deepEqual(
            after.hand.map((d) => d.spent),
            [true, false, true, false, true],
        );
        assert.equal(
            G.can(withSpecial('all-sixes', 'neon', [2, 2]), 'all-sixes', [0, 1]),
            false,
            'nothing to turn',
        );
    });

    it('a die destroyed rules out a vowel, and is gone for good - but never below three', () => {
        let g = withSpecial('destroy-die', 'neon', [5, 1, 1, 1]);
        g = G.play(g, 'destroy-die', [0]);
        assert.equal(g.count, 3);
        assert.equal(g.reveals, 0, 'no blank is turned over');
        assert.ok('aiu'.includes(g.last.letter), `a vowel the word lacks: ${g.last.letter}`);
        assert.equal(g.known[g.last.letter], 'out');
        assert.equal(g.last.hit, false);
        assert.equal(G.can(g, 'destroy-die', [1]), false, 'three are kept');
        const next = G.pass(G.play(g, 'earn', [1, 2, 3]));
        assert.equal(next.hand.length, 3, 'and the next cycle throws three');
        // With every vowel the word lacks already known, there is nothing to rule out.
        const told = withSpecial('destroy-die', 'neon', [5, 1, 1, 1], {
            known: { a: 'out', i: 'out', u: 'out' },
        });
        assert.equal(G.can(told, 'destroy-die', [0]), false);
        // A die lent for the cycle is not the player's to destroy.
        const lent = withSpecial('destroy-die', 'neon', [5, 1, 1, 1], {
            hand: [5, 1, 1, 1, 4].map((p, i) => ({ pips: p, spent: false, temp: i === 4 })),
            count: 4,
        });
        assert.equal(G.can(lent, 'destroy-die', [4]), false);
        assert.equal(G.can(lent, 'destroy-die', [0]), true);
    });

    it('a 5 says how many vowels the word has, and a 4 whether a letter repeats - once each', () => {
        let g = withSpecial('count-vowels', 'queue', [5, 5]);
        g = G.play(g, 'count-vowels', [0]);
        assert.equal(g.facts.vowels, 4);
        assert.equal(g.last.count, 4);
        assert.deepEqual(g.known, {}, 'no letter is named');
        assert.equal(G.can(g, 'count-vowels', [1]), false, 'known already');

        const twice = G.play(withSpecial('has-repeats', 'neon', [4]), 'has-repeats', [0]);
        assert.equal(twice.facts.repeats, true);
        const once = G.play(withSpecial('has-repeats', 'quiz', [4, 4]), 'has-repeats', [0]);
        assert.equal(once.facts.repeats, false);
        assert.equal(once.last.repeats, false);
        assert.equal(G.can(once, 'has-repeats', [1]), false);
        // A game kept from before the facts were kept still plays them.
        const old = { ...withSpecial('has-repeats', 'neon', [4]), facts: undefined };
        assert.equal(G.play(old, 'has-repeats', [0]).facts.repeats, true);
    });

    it('a 2 nudges another die up or down by one, and never past its faces', () => {
        const g = withSpecial('nudge', 'neon', [2, 4, 6, 1]);
        assert.deepEqual(pips(G.play(g, 'nudge', [0], { die: 1, by: 1 })), [2, 5, 6, 1]);
        assert.deepEqual(pips(G.play(g, 'nudge', [0], { die: 1, by: -1 })), [2, 3, 6, 1]);
        const after = G.play(g, 'nudge', [0], { die: 1, by: 1 });
        assert.deepEqual(
            after.hand.map((d) => d.spent),
            [true, false, false, false],
            'the 2 is spent, the nudged die is not',
        );
        assert.equal(G.play(g, 'nudge', [0], { die: 2, by: 1 }), null, 'no seven');
        assert.equal(G.play(g, 'nudge', [0], { die: 3, by: -1 }), null, 'no nought');
        assert.equal(G.play(g, 'nudge', [0], { die: 0, by: 1 }), null, 'not itself');
        assert.equal(G.play(g, 'nudge', [0], { die: 1, by: 2 }), null, 'one pip');
        assert.equal(G.play(g, 'nudge', [0]), null, 'pointed at something');
        assert.equal(G.can(withSpecial('nudge', 'neon', [2]), 'nudge', [0]), false, 'another die');
    });

    it('a 6 splits into two 3s, the second for this cycle only', () => {
        let g = withSpecial('split', 'neon', [6, 1, 1, 1]);
        g = G.play(g, 'split', [0]);
        assert.deepEqual(pips(g), [3, 1, 1, 1, 3]);
        assert.deepEqual(
            g.hand.map((d) => [d.spent, !!d.temp]),
            [
                [false, false],
                [false, false],
                [false, false],
                [false, false],
                [false, true],
            ],
            'neither is spent, and the new one is lent',
        );
        assert.equal(g.count, 4, 'not owned');
        const next = G.pass(G.play(g, 'earn', [0, 1, 2, 3, 4]));
        assert.equal(next.hand.length, 4, 'gone the next cycle');
        const full = withSpecial('split', 'neon', [6, 1, 1, 1, 1, 1, 1, 1, 1], { count: 7 });
        assert.equal(G.can(full, 'split', [0]), false, 'no room in the hand');
    });
});
