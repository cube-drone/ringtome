// Wordaga, the game (apps/games.js; Curtis, 2026-11-14): guess the day's word, with dice.
//
// A game is a run of cycles. A cycle rolls every die you own; you spend the dice on abilities
// that buy facts about the word, and when the last die is spent you get a guess - or give it up
// for two apostrophes. A guess is right or wrong and says nothing else. Wrong, or given up, and
// the next cycle begins. The score is the cycle you got
// it in, and lower is better. Apostrophes are the game's own money: earned from dice, spent on
// the dearer abilities, kept from cycle to cycle, gone when the game is.
//
// Everything here is a pure step from one state to the next, and the state is plain data, so a
// game half played can be kept and picked up again. The randomness is two counters inside the
// state, seeded from the day: everyone who plays a day's game the same way sees the same dice.
// One counter rolls dice and the other picks letters, so a letter picked never moves a die.

export const START_DICE = 4;
export const MOST_DICE = 7;
/// The most dice a hand holds in one cycle, with the temporary ones a daily special lends.
export const MOST_HAND = 9;
/// The fewest dice a player may be left owning: a die is destroyed only above this.
export const FEWEST_DICE = 3;
/// What three of a kind may win at the day's gamble: this, or nothing.
export const GAMBLE_PAYS = 20;
/// What dice that total ten ask for on top, to test a consonant.
export const TEN_PRICE = 2;
/// What dice must total, at least, to test a vowel for nothing (Curtis, 2026-11-23: at 18 the
/// same dice bought a vowel as money, so "let's make that 12").
export const VOWEL_TOTAL = 12;
/// What a pair asks for on top of its dice to test a consonant, in apostrophes.
export const PRICE = 6;
/// What a pair asks for on top of its dice to buy the first extra die. Each die after costs one
/// more than the last: 2, then 3, then 4.
export const FIRST_DIE_PRICE = 2;
/// What testing a vowel costs with no dice at all: the one thing apostrophes buy by themselves.
export const VOWEL_PRICE = 9;
/// What a run asks for on top of its dice, to test a consonant.
export const RUN_PRICE = 2;
/// What throwing dice that total seven again costs.
export const SEVEN = 1;
/// Par (Curtis, 2026-11-21: "6 is kind of 'par' for this game"): a cycle's guess is `under` for
/// the first six cycles, `par` for the two after, and `over` from the ninth on.
export const PAR = 6;
export const PAR_GRACE = 2;
/// Where the cycle numbered `cycle` (from 1) stands against par.
export const standing = (cycle) =>
    cycle <= PAR ? 'under' : cycle <= PAR + PAR_GRACE ? 'par' : 'over';

/// What giving up a cycle's guess pays, in apostrophes (`pass`).
export const PASS_PAYS = 2;
/// A cycle passed, as it stands among the misses: no word at all, which no guess can be. The
/// page writes it as "skip" (apps/games.js), so the list still counts the cycles gone by.
export const SKIPPED = '';

export const VOWELS = 'aeiou';
/// The consonants a pair tests: the ones a word seldom has.
export const UNLIKELY = 'qzywpxbkvj';
export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const isVowel = (letter) => VOWELS.includes(letter);

const SALT_DICE = 0x64696365; // "dice"
const SALT_LETTERS = 0x6c657474; // "lett"
const SALT_SPECIALS = 0x73706563; // "spec"

/// One step of mulberry32 with its state held outside: the next state, and a number in [0, 1).
/// Written out here: this copy is part of what makes one day's dice the same for everyone.
function step(a) {
    const next = (a + 0x6d2b79f5) >>> 0;
    let t = next;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return [next, ((t ^ (t >>> 14)) >>> 0) / 4294967296];
}

/// Roll `n` dice off the state's dice counter: the new counter, and the pips.
function roll(counter, n) {
    const pips = [];
    for (let i = 0; i < n; i++) {
        let r;
        [counter, r] = step(counter);
        pips.push(1 + Math.floor(r * 6));
    }
    return [counter, pips];
}

/// A die in the hand: its pips, whether it is spent, and which throw put it there - the throws of a
/// game are numbered from 1, so the page can tell the dice just thrown from the ones that lay still.
const thrownDie = (thrown) => (pips) => ({ pips, spent: false, thrown });
/// A die thrown again where it lies: one lent for the cycle (`temp`) is still lent.
const rethrown = (die, thrown, pips) =>
    die.temp ? { ...thrownDie(thrown)(pips), temp: true } : thrownDie(thrown)(pips);
/// The number the next throw takes.
const nextThrow = (state) => (state.throws ?? 0) + 1;

/// A new game of `word`. Two games with one seed and one word roll the same dice. `specials` are
/// the daily specials it may play (`dailySpecials`): none, unless the page deals them in.
export function newGame(word, seed, specials = []) {
    const [dice, pips] = roll((Math.imul(seed, 0x9e3779b1) ^ SALT_DICE) >>> 0, START_DICE);
    return {
        word: word.toLowerCase(),
        dice,
        letters: (Math.imul(seed, 0x85ebca6b) ^ SALT_LETTERS) >>> 0,
        cycle: 1,
        count: START_DICE,
        hand: pips.map(thrownDie(1)),
        throws: 1,
        apostrophes: 0,
        // What is known of each letter tried: 'in' or 'out'.
        known: {},
        // Blanks the player may still turn over, bought with four or five of a kind (`reveal`).
        reveals: 0,
        misses: [],
        won: false,
        // The daily specials in play (`SPECIALS`), and what one of them has added to a skip's pay.
        specials: [...specials],
        passBonus: 0,
        // What a special has told of the word as a whole: `{ vowels?, repeats? }`.
        facts: {},
        // What the last move did, for the page to say: `{ ability, letter?, hit?, gained? }`.
        last: null,
    };
}

/// The word as the player sees it: each letter, or null where it is not placed yet.
export const shown = (state) =>
    [...state.word].map((letter) => (state.known[letter] === 'in' ? letter : null));

/// True once every die is spent: the cycle has come to its guess.
export const guessing = (state) => !state.won && state.hand.every((d) => d.spent);

/// Exactly `n` dice, all showing the same.
const kind = (n) => (pips) => pips.length === n && pips.every((p) => p === pips[0]);
const sum = (pips) => pips.reduce((a, b) => a + b, 0);
/// A run: three dice, each one more than the last.
const run = (pips) => {
    const s = [...pips].sort((a, b) => a - b);
    return s.length === 3 && s[1] === s[0] + 1 && s[2] === s[1] + 1;
};
const CONSONANTS = [...LETTERS].filter((l) => !isVowel(l)).join('');
/// A run of four: four dice, each one more than the last.
const runOfFour = (pips) => {
    const s = [...pips].sort((a, b) => a - b);
    return s.length === 4 && s.every((p, i) => i === 0 || p === s[i - 1] + 1);
};
/// One die showing `n`, and a pair of them.
const one = (n) => (pips) => pips.length === 1 && pips[0] === n;
const pairOf = (n) => (pips) => pips.length === 2 && pips[0] === n && pips[1] === n;

/// The abilities, in the order the page lists them: by how rare the dice they ask for are - any
/// dice, a 1, a total of 7, a pair, a run of three, then three, four, five and six of a kind - with
/// the one that asks for no dice last. `dice` says whether the picked dice will do;
/// `price` is in apostrophes, a number or what the state makes it (read it with `priceOf`); `target` is what the player must point at before the move is made:
/// 'dice' (any number of the others), or a letter out of `among`; `keeps` marks the ones that change the picked dice and do
/// not spend them.
export const ABILITIES = [
    { id: 'earn', dice: (p) => p.length >= 1 },
    { id: 'reroll', dice: (p) => p.length === 1, target: 'dice' },
    { id: 'rule-out', dice: (p) => p.length === 1 && p[0] === 1 },
    { id: 'seven', dice: (p) => p.length > 1 && sum(p) === 7, price: SEVEN, keeps: true },
    { id: 'unlikely', dice: kind(2), target: 'letter', among: UNLIKELY },
    {
        id: 'buy-die',
        dice: kind(2),
        price: (state) => FIRST_DIE_PRICE + Math.max(0, state.count - START_DICE),
    },
    { id: 'consonant-pair', dice: kind(2), price: PRICE, target: 'letter', among: CONSONANTS },
    { id: 'consonant-run', dice: run, price: RUN_PRICE, target: 'letter', among: CONSONANTS },
    { id: 'test-vowel', dice: kind(3), target: 'letter', among: VOWELS },
    { id: 'reveal-one', dice: kind(4) },
    { id: 'reveal-three', dice: kind(5) },
    { id: 'win', dice: kind(6) },
    {
        id: 'vowel-paid',
        dice: (p) => p.length === 0,
        price: VOWEL_PRICE,
        target: 'letter',
        among: VOWELS,
    },
];

/// The daily specials (Curtis, 2026-11-23: "two daily 'wildcard' abilities ... available for every
/// game today, including pickup games"): abilities shaped as the ones above are, of which a day
/// deals two (`dailySpecials`). A game plays only the ones it was dealt (`state.specials`).
///
/// A pair that spells its own number tests a letter of that number's name - `among` is the name's
/// letters, each once.
export const SPECIALS = [
    // A run of four is a die, free: thrown into this cycle and kept, as a bought one is.
    { id: 'run-die', dice: runOfFour },
    // A 2 lends two dice for this cycle only, while the hand has room (`MOST_HAND`).
    { id: 'temp-dice', dice: one(2) },
    // A 3 makes every skip from here on pay one more.
    { id: 'pass-bonus', dice: one(3) },
    // Three of a kind, staked: `GAMBLE_PAYS` or nothing, on the turn of a coin.
    { id: 'gamble', dice: kind(3) },
    { id: 'name-one', dice: pairOf(1), target: 'letter', among: 'one' },
    { id: 'name-two', dice: pairOf(2), target: 'letter', among: 'two' },
    { id: 'name-three', dice: pairOf(3), target: 'letter', among: 'thre' },
    { id: 'name-four', dice: pairOf(4), target: 'letter', among: 'four' },
    { id: 'name-five', dice: pairOf(5), target: 'letter', among: 'five' },
    { id: 'name-six', dice: pairOf(6), target: 'letter', among: 'six' },
    {
        id: 'consonant-ten',
        dice: (p) => p.length > 1 && sum(p) === 10,
        price: TEN_PRICE,
        target: 'letter',
        among: CONSONANTS,
    },
    { id: 'vowel-total', dice: (p) => sum(p) >= VOWEL_TOTAL, target: 'letter', among: VOWELS },
    // A pair of twos turns every other die in the hand to a six.
    { id: 'all-sixes', dice: pairOf(2) },
    // A 5 says how many of the word's letters are vowels; a 4, whether any letter is in it twice.
    { id: 'count-vowels', dice: one(5) },
    { id: 'has-repeats', dice: one(4) },
    // A 2 nudges another die up or down by one; `target` is `{ die, by }`.
    { id: 'nudge', dice: one(2), target: 'die' },
    // A 6 is split into two 3s: itself and one more, lent for the cycle as `temp-dice` lends.
    { id: 'split', dice: one(6), keeps: true },
    // A die given up for good rules out a vowel, while more than `FEWEST_DICE` are owned (Curtis,
    // 2026-11-23: turning over a blank was "too powerful" - with a die bought to be destroyed it
    // was a pair and a little money for a letter, every cycle).
    { id: 'destroy-die', dice: (p) => p.length === 1 },
];

/// The day's specials: two of `SPECIALS`, the same for everyone, by the day's number
/// (pure/wordaga.js `wordagaDay`).
export function dailySpecials(day, n = 2) {
    let counter = (Math.imul(day, 0x9e3779b1) ^ SALT_SPECIALS) >>> 0;
    const left = SPECIALS.map((a) => a.id);
    const out = [];
    while (out.length < n && left.length > 0) {
        let r;
        [counter, r] = step(counter);
        out.push(left.splice(Math.floor(r * left.length), 1)[0]);
    }
    return out;
}

const special = (id) => SPECIALS.find((a) => a.id === id);
const ability = (id) => ABILITIES.find((a) => a.id === id) ?? special(id);

/// The abilities a game may play, in the order the page lists them: the day's specials it was
/// dealt, then the rest.
export const abilitiesOf = (state) => [
    ...SPECIALS.filter((a) => (state.specials ?? []).includes(a.id)),
    ...ABILITIES,
];

/// What giving up a cycle's guess pays as the game stands: `PASS_PAYS`, and one more for each 3
/// spent on it.
export const passPays = (state) => PASS_PAYS + (state.passBonus ?? 0);

/// What `id` costs as the game stands, in apostrophes: 0 for an ability that is free. Only a die's
/// price moves.
export function priceOf(state, id) {
    const price = ability(id)?.price ?? 0;
    return typeof price === 'function' ? price(state) : price;
}

/// What a die earns when cashed: one apostrophe for a 1 or 2, two for a 3 or 4, three for a 5 or 6.
export const earns = (pips) => Math.ceil(pips / 2);

/// The letters an ability may still be pointed at: its own, less the ones already known.
export const targets = (state, id) =>
    [...(ability(id)?.among ?? '')].filter((letter) => !state.known[letter]);

/// The letters "rule out" may draw from: not in the word, and not known yet.
const absent = (state) => [...LETTERS].filter((l) => !state.word.includes(l) && !state.known[l]);

/// Whether `id` can be played with the dice at `picked` (indexes into the hand). The target, where
/// one is needed, is not asked about here: this is what lights a button.
export function can(state, id, picked) {
    const a = ability(id);
    if (!a || state.won) return false;
    // A special is played only by a game that was dealt it.
    if (special(id) && !(state.specials ?? []).includes(id)) return false;
    if (new Set(picked).size !== picked.length) return false;
    if (picked.some((i) => !state.hand[i] || state.hand[i].spent)) return false;
    if (!a.dice(picked.map((i) => state.hand[i].pips))) return false;
    if (priceOf(state, id) > state.apostrophes) return false;
    if (a.target === 'letter' && targets(state, id).length === 0) return false;
    switch (id) {
        case 'reroll':
            return state.hand.some((d, i) => !d.spent && i !== picked[0]);
        case 'rule-out':
            return absent(state).length > 0;
        case 'buy-die':
        case 'run-die':
            return state.count < MOST_DICE;
        case 'temp-dice':
        case 'split':
            return state.hand.length < MOST_HAND;
        case 'count-vowels':
            return (state.facts ?? {}).vowels === undefined;
        case 'has-repeats':
            return (state.facts ?? {}).repeats === undefined;
        case 'nudge':
            // Another die to nudge.
            return state.hand.some((d, i) => !d.spent && i !== picked[0]);
        case 'all-sixes':
            return state.hand.some((d, i) => !d.spent && !picked.includes(i));
        case 'destroy-die':
            // One of the player's own, and never the last few: a die lent for the cycle is not
            // theirs to give up. And only while a vowel is left to rule out.
            return (
                state.count > FEWEST_DICE &&
                !state.hand[picked[0]].temp &&
                absent(state).some(isVowel)
            );
        default:
            return true;
    }
}

/// A word with every letter placed is a word got: nobody is made to type what they can read. The
/// game is won in the cycle it happened in, and reveals still owed are dropped.
const settled = (next) =>
    shown(next).every((letter) => letter !== null) ? { ...next, won: true, reveals: 0 } : next;

/// Play an ability: `picked` are the dice spent on it, `target` the dice it is pointed at (their indexes) or the letter it is
/// pointed at. The state after, or null if the move is not allowed.
export function play(state, id, picked, target) {
    if (!can(state, id, picked)) return null;
    const a = ability(id);
    const next = {
        ...state,
        hand: state.hand.map((d, i) =>
            picked.includes(i) && !a.keeps ? { ...d, spent: true } : d,
        ),
        apostrophes: state.apostrophes - priceOf(state, id),
        known: { ...state.known },
        last: { ability: id },
    };
    const learn = (letter) => {
        const hit = state.word.includes(letter);
        next.known[letter] = hit ? 'in' : 'out';
        next.last = { ability: id, letter, hit };
    };
    switch (id) {
        case 'earn': {
            // Any number of dice at once, each paying its own.
            const gained = sum(picked.map((d) => earns(state.hand[d].pips)));
            next.apostrophes += gained;
            next.last.gained = gained;
            break;
        }
        case 'reroll': {
            // One die pays for any number of the others to be thrown again. They are thrown in
            // the hand's order, whatever order they were pointed at in.
            const again = Array.isArray(target) ? [...new Set(target)].sort((a, b) => a - b) : [];
            if (again.length === 0) return null;
            if (again.some((i) => !state.hand[i] || state.hand[i].spent || i === picked[0]))
                return null;
            const [counter, pips] = roll(state.dice, again.length);
            next.dice = counter;
            next.throws = nextThrow(state);
            again.forEach((i, n) => (next.hand[i] = rethrown(state.hand[i], next.throws, pips[n])));
            break;
        }
        case 'reveal-one':
        case 'reveal-three':
            // The blanks are chosen afterwards, one at a time (`reveal`).
            next.reveals = (state.reveals ?? 0) + (id === 'reveal-one' ? 1 : 3);
            break;
        case 'win':
            // Six of a kind is the word itself.
            for (const letter of state.word) next.known[letter] = 'in';
            next.won = true;
            break;
        case 'seven': {
            // These dice are thrown again, not spent.
            const [counter, pips] = roll(state.dice, picked.length);
            next.dice = counter;
            next.throws = nextThrow(state);
            picked.forEach(
                (i, n) => (next.hand[i] = rethrown(state.hand[i], next.throws, pips[n])),
            );
            break;
        }
        case 'rule-out': {
            const pool = absent(state);
            const [counter, r] = step(state.letters);
            next.letters = counter;
            learn(pool[Math.floor(r * pool.length)]);
            break;
        }
        case 'temp-dice': {
            // Two more dice for this cycle, or as many as the hand has room for: the next cycle
            // throws only the dice owned.
            const lent = Math.min(2, MOST_HAND - state.hand.length);
            const [counter, pips] = roll(state.dice, lent);
            next.dice = counter;
            next.throws = nextThrow(state);
            for (const p of pips) next.hand.push({ ...thrownDie(next.throws)(p), temp: true });
            break;
        }
        case 'pass-bonus':
            next.passBonus = (state.passBonus ?? 0) + 1;
            break;
        case 'count-vowels': {
            const vowels = [...state.word].filter(isVowel).length;
            next.facts = { ...(state.facts ?? {}), vowels };
            next.last.count = vowels;
            break;
        }
        case 'has-repeats': {
            const repeats = new Set(state.word).size < state.word.length;
            next.facts = { ...(state.facts ?? {}), repeats };
            next.last.repeats = repeats;
            break;
        }
        case 'nudge': {
            // One other die, one pip up or down, and never past a die's faces.
            const { die, by } = target ?? {};
            const at = state.hand[die];
            if (!at || at.spent || die === picked[0] || (by !== 1 && by !== -1)) return null;
            if (at.pips + by < 1 || at.pips + by > 6) return null;
            next.throws = nextThrow(state);
            next.hand[die] = rethrown(at, next.throws, at.pips + by);
            break;
        }
        case 'split': {
            // The 6 lies as a 3, and a second 3 beside it for this cycle only: the next cycle
            // throws the dice owned, which a split does not add to.
            next.throws = nextThrow(state);
            next.hand[picked[0]] = rethrown(state.hand[picked[0]], next.throws, 3);
            next.hand.push({ ...thrownDie(next.throws)(3), temp: true });
            break;
        }
        case 'gamble': {
            // A coin off the letters' counter, so it never moves a die.
            const [counter, r] = step(state.letters);
            next.letters = counter;
            const gained = r < 0.5 ? GAMBLE_PAYS : 0;
            next.apostrophes += gained;
            next.last.gained = gained;
            break;
        }
        case 'all-sixes':
            // Every other die still to be spent shows a six, as if thrown that way.
            next.throws = nextThrow(state);
            next.hand = next.hand.map((d, i) =>
                d.spent || picked.includes(i) ? d : rethrown(d, next.throws, 6),
            );
            break;
        case 'destroy-die': {
            // The die is gone from every cycle after this one, and a vowel the word lacks is
            // ruled out: picked off the letters' counter, as "rule out" picks its letter.
            next.count = state.count - 1;
            const pool = absent(state).filter(isVowel);
            const [counter, r] = step(state.letters);
            next.letters = counter;
            learn(pool[Math.floor(r * pool.length)]);
            break;
        }
        case 'run-die':
        case 'buy-die': {
            // The new die is rolled into this cycle's hand, and into every cycle after.
            const [counter, [pips]] = roll(state.dice, 1);
            next.dice = counter;
            next.count = state.count + 1;
            next.throws = nextThrow(state);
            next.hand.push(thrownDie(next.throws)(pips));
            break;
        }
        default:
            // The tests: a letter of the player's choosing.
            if (!targets(state, id).includes(target)) return null;
            learn(target);
    }
    return settled(next);
}

/// Turn over the blank at `slot`, with a reveal four or five of a kind bought. The letter is placed wherever
/// it stands in the word, as any hit is. Reveals nobody has a blank left for are dropped. The
/// state after, or null if none is owed or the place is not a blank.
export function reveal(state, slot) {
    if (state.won || !((state.reveals ?? 0) > 0) || shown(state)[slot] !== null) return null;
    const letter = state.word[slot];
    const next = {
        ...state,
        known: { ...state.known, [letter]: 'in' },
        reveals: state.reveals - 1,
        last: { ability: 'reveal', letter, hit: true },
    };
    return settled(next);
}

/// What a guess is held to: letters only, in one case.
const tidy = (text) => text.toLowerCase().replace(/[^a-z]/g, '');

/// Guess the word, once the dice are spent: one guess a cycle. Right wins the game; wrong rolls
/// the next cycle. The state after, or null if it is not time to guess or
/// nothing was said.
export function guess(state, text) {
    const said = tidy(text);
    if (!guessing(state) || !said) return null;
    if (said === state.word) {
        const known = { ...state.known };
        for (const letter of state.word) known[letter] = 'in';
        return { ...state, known, won: true, last: { ability: 'guess', hit: true } };
    }
    return nextCycle({
        ...state,
        misses: [...state.misses, said],
        last: { ability: 'guess', hit: false, said },
    });
}

/// The cycle after this one: every die owned, thrown.
function nextCycle(state) {
    const [dice, pips] = roll(state.dice, state.count);
    return {
        ...state,
        dice,
        cycle: state.cycle + 1,
        hand: pips.map(thrownDie(nextThrow(state))),
        throws: nextThrow(state),
    };
}

/// Give up the cycle's guess for `PASS_PAYS` apostrophes (Curtis, 2026-11-21: "early guesses at
/// the word are mostly worthless: there's not enough data to make any meaningful inferences").
/// The cycle is still spent - the next begins, and the score counts it as it counts a miss - and
/// it stands among the misses as `SKIPPED`, so the list is still one entry a cycle gone by. The state after, or null if it is not time to guess.
export function pass(state) {
    if (!guessing(state)) return null;
    return nextCycle({
        ...state,
        misses: [...state.misses, SKIPPED],
        apostrophes: state.apostrophes + passPays(state),
        last: { ability: 'pass', gained: passPays(state) },
    });
}
