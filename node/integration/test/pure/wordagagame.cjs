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
