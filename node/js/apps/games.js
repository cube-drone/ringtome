// hrseGames (Curtis, 2026-11-13): games to play. The app is a list of them, laid out as Settings
// lists its pages (persona.js `SettingsList`), and each game is a page of its own beneath it:
// `/ringtome/games/<game>`. One game so far, Wordaga, whose rules are pure/wordagagame.js.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { Icons } from '../icons.js';
import { gamesHref } from '../links.js';
import { t } from '../i18n.js';
import { playSound, preloadSounds, setSoundOn, useSoundOn } from '../sound.js';
import { wordOfDay, wordagaDay, untilNextWord } from '../pure/wordaga.js';
import {
    ABILITIES,
    LETTERS,
    UNLIKELY,
    can,
    guess,
    guessing,
    newGame,
    play,
    priceOf,
    reveal,
    shown,
    targets,
} from '../pure/wordagagame.js';
import { WORDS } from '../pure/words.js';

const html = htm.bind(h);

/// The games, in the order the list shows them: the page's name under `/ringtome/games/`, the
/// glyph, and what the row says. Functions, so the words are read in the reader's language.
const GAMES = [
    {
        id: 'wordaga',
        icon: Icons.wordaga,
        name: () => t('games.wordaga', 'Wordaga'),
        blurb: () => t('games.wordaga-blurb', "guess today's word, with dice!"),
    },
];

export const GamesApp = () => html`<div class="persona-page">
    <div class="persona-page-head">
        <h1 class="persona-page-title">${t('games.title', 'games')}</h1>
    </div>
    <nav class="persona-menu">
        ${GAMES.map(
            (game) => html`<a key=${game.id} class="persona-menu-item" href=${gamesHref(game.id)}>
                <span class="persona-menu-icon"><${game.icon} /></span>
                <span class="persona-menu-label">
                    <strong>${game.name()}</strong>
                    <small>${game.blurb()}</small>
                </span>
            </a>`,
        )}
    </nav>
</div>`;

/// The day's number (pure/wordaga.js), kept current: a page left open over @000 turns to the next
/// word by itself.
const useWordagaDay = () => {
    const [day, setDay] = useState(() => wordagaDay(Date.now()));
    useEffect(() => {
        // A hair past the turn, so a timer that fires early still lands in the new day.
        const timer = setTimeout(
            () => setDay(wordagaDay(Date.now())),
            untilNextWord(Date.now()) + 50,
        );
        return () => clearTimeout(timer);
    }, [day]);
    return day;
};

/// What each ability is called, and what it asks for, in the order pure/wordagagame.js lists them.
const ABILITY_WORDS = {
    earn: () => [
        t('games.ability-earn', 'take money'),
        t('games.needs-earn', 'any dice: a 1-2 pays one, a 3-4 pays two, a 5-6 pays three'),
    ],
    reroll: () => [
        t('games.ability-reroll-many', 'roll other dice again'),
        t('games.needs-die-many', 'any die, spent to roll as many of the others as you like'),
    ],
    'rule-out': () => [
        t('games.ability-rule-out', 'rule out a letter'),
        t('games.needs-one', 'a 1'),
    ],
    seven: () => [
        t('games.ability-seven-paid', 'roll these again'),
        t('games.needs-seven-paid', 'dice that total 7: the dice are not spent'),
    ],
    unlikely: () => [
        t('games.ability-unlikely', 'test an unlikely consonant'),
        t('games.needs-pair-unlikely', 'a pair: {letters}', {
            letters: [...UNLIKELY].join(' ').toUpperCase(),
        }),
    ],
    'buy-die': () => [
        t('games.ability-buy-die', 'buy another die'),
        t('games.needs-pair-paid', 'a pair'),
    ],
    'consonant-run': () => [
        t('games.ability-consonant', 'test a consonant'),
        t('games.needs-run-paid', 'a run of three'),
    ],
    'consonant-pair': () => [
        t('games.ability-consonant', 'test a consonant'),
        t('games.needs-pair-paid', 'a pair'),
    ],
    'reveal-one': () => [
        t('games.ability-reveal-one', 'reveal a blank of your choosing'),
        t('games.needs-four', 'four of a kind'),
    ],
    'reveal-three': () => [
        t('games.ability-reveal-three', 'reveal three blanks of your choosing'),
        t('games.needs-five', 'five of a kind'),
    ],
    win: () => [t('games.ability-win', 'win'), t('games.needs-six', 'six of a kind')],
    'test-vowel': () => [
        t('games.ability-test-vowel', 'test a vowel'),
        t('games.needs-three', 'three of a kind'),
    ],
    'vowel-paid': () => [
        t('games.ability-test-vowel', 'test a vowel'),
        t('games.needs-paid-only', 'no dice'),
    ],
};

/// What the last move did, in a sentence.
const lastWords = (last) => {
    if (!last) return t('games.wordaga-start', 'pick dice, then pick what to spend them on.');
    const letter = last.letter?.toUpperCase();
    if (last.ability === 'win') return t('games.won-by-six', 'six of a kind: the word is yours.');
    if (last.ability === 'reveal-one' || last.ability === 'reveal-three')
        return t('games.reveal-bought', 'pick a blank in the word to reveal.');
    if (last.ability === 'guess')
        return last.hit
            ? t('games.guess-right', 'that is the word!')
            : t('games.guess-wrong', '"{said}" is not the word.', { said: last.said });
    if (letter)
        return last.hit
            ? t('games.letter-in', '{letter} is in the word.', { letter })
            : t('games.letter-out', '{letter} is not in the word.', { letter });
    if (last.ability === 'earn') return t('games.earned', 'money taken: {n}.', { n: last.gained });
    if (last.ability === 'buy-die') return t('games.bought-die', 'a new die, yours to keep.');
    return t('games.rolled-again', 'rolled again.');
};

/// A die as a cube: six faces standing in real space, the browser doing the perspective. Where each
/// face stands on the cube, and the turn of the whole cube that brings each to the front.
const FACE_AT = {
    1: '',
    2: 'rotateY(90deg)',
    3: 'rotateX(90deg)',
    4: 'rotateX(-90deg)',
    5: 'rotateY(-90deg)',
    6: 'rotateY(180deg)',
};
const TURN_TO = { 1: [0, 0], 2: [0, -90], 3: [-90, 0], 4: [90, 0], 5: [0, 90], 6: [0, 180] };
const turned = ([x, y]) => `rotateX(${x}deg) rotateY(${y}deg)`;
/// Which of a face's nine places hold a pip, row by row.
const PIPS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
};
const NINE = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/// The dice each ability takes, drawn on its card: a number is a die-shaped hole holding that many
/// faint pips (0 is any die), anything else is a sign set between the holes. `=` between holes says
/// the dice match; the run's pips are one example of three in a row.
const same = (n) => Array.from({ length: n * 2 - 1 }, (_, i) => (i % 2 ? '=' : 0));
const WANTS = {
    earn: [0],
    reroll: [0],
    'rule-out': [1],
    seven: [0, '+', 0, '= 7'],
    unlikely: same(2),
    'buy-die': same(2),
    'consonant-pair': same(2),
    'consonant-run': [2, 3, 4],
    'test-vowel': same(3),
    'reveal-one': same(4),
    'reveal-three': same(5),
    win: same(6),
};

/// Whether an ability's dice are too many to draw at full size on half the board's width: more
/// than three holes.
const isWide = (id) =>
    !!WANTS[id] && WANTS[id].filter((want) => typeof want === 'number').length > 3;

/// That picture: for the eye only - the line under it says the same in words.
const Wants = ({ id }) =>
    WANTS[id] &&
    html`<span class="wordaga-wants" aria-hidden="true">
        ${WANTS[id].map((want, i) =>
            typeof want === 'number'
                ? html`<span key=${i} class="wordaga-hole">
                      ${NINE.map((place) =>
                          want && PIPS[want].includes(place)
                              ? html`<i key=${place} class="wordaga-hole-pip"></i>`
                              : html`<i key=${place}></i>`,
                      )}
                  </span>`
                : html`<span key=${i} class="wordaga-sign">${want}</span>`,
        )}
    </span>`;

/// What a throw sounds like (sound.js): several dice at once, or one die alone.
const DICE_SOUNDS = ['dice-throw-1', 'dice-throw-2', 'dice-throw-3'];
const DIE_SOUNDS = ['die-throw-1', 'die-throw-2', 'die-throw-3', 'die-throw-4'];
/// A die picked up, and an ability's card put down.
const GRAB_SOUNDS = ['dice-grab-1', 'dice-grab-2'];
const CARD_SOUNDS = ['card-place-1', 'card-place-2', 'card-place-3', 'card-place-4'];

/// One die in the bar. It rests with its number to the front; when a throw newer than `quiet` puts
/// it there it tumbles to that number - the number was settled before it moved, the tumble is only
/// the telling. A whole hand thrown spills in from the left, one die after another; a die thrown
/// again where it lies (`lone`) hops. The turns and the pace vary from die to die, by the throw's
/// number and the die's place, so a game drawn again tumbles the same.
const Die = ({ die, index, lone, quiet, state, disabled, pressed, onClick }) => {
    const button = useRef(null);
    const cube = useRef(null);
    useLayoutEffect(() => {
        if (!(die.thrown > quiet) || !cube.current?.animate) return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const [x, y] = TURN_TO[die.pips];
        const mix = (die.thrown * 7 + index * 13) % 6;
        const from = [x + 360 * (1 + (mix % 2)), y - 360 * (1 + ((mix >> 1) % 3))];
        const timing = {
            duration: 620 + mix * 40,
            delay: lone ? 0 : index * 55,
            easing: 'cubic-bezier(0.15, 0.6, 0.25, 1)',
            fill: 'backwards',
        };
        cube.current.animate([{ transform: turned(from) }, { transform: turned([x, y]) }], timing);
        button.current.animate(
            lone
                ? [
                      { transform: 'translateY(0)' },
                      { transform: 'translateY(-0.45rem)', offset: 0.35 },
                      { transform: 'translateY(0)' },
                  ]
                : [
                      { transform: 'translateX(-24rem)' },
                      { transform: 'translateX(0.4rem)', offset: 0.75 },
                      { transform: 'translateX(0)' },
                  ],
            timing,
        );
        // Only a new throw tumbles: the pips, the place and the rest are read as they stand then.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [die.thrown]);
    return html`<button
        ref=${button}
        type="button"
        class=${state ? `wordaga-die ${state}` : 'wordaga-die'}
        disabled=${disabled}
        aria-pressed=${pressed}
        aria-label=${t('games.die-showing', 'a die showing {n}', { n: die.pips })}
        onClick=${onClick}
    >
        <span class="wordaga-die-seat" aria-hidden="true">
            <span ref=${cube} class="wordaga-cube" style=${`transform: ${turned(TURN_TO[die.pips])}`}>
                ${[1, 2, 3, 4, 5, 6].map(
                    (face) =>
                        html`<span
                            key=${face}
                            class="wordaga-face"
                            style=${`transform: ${FACE_AT[face]} translateZ(var(--half))`}
                        >
                            ${NINE.map((place) =>
                                PIPS[face].includes(place)
                                    ? html`<i key=${place} class="wordaga-pip"></i>`
                                    : html`<i key=${place}></i>`,
                            )}
                        </span>`,
                )}
            </span>
        </span>
    </button>`;
};

/// Today's game, kept on this device so a refresh picks it up where it was, and so the day's game
/// is played once. A kept game for another day, or another word, is nobody's.
const KEPT = 'wordaga-today';
const keptGame = (day, word) => {
    try {
        const kept = JSON.parse(localStorage.getItem(KEPT));
        return kept && kept.day === day && kept.game?.word === word ? kept.game : null;
    } catch {
        return null;
    }
};
const keepGame = (day, game) => {
    try {
        localStorage.setItem(KEPT, JSON.stringify({ day, game }));
    } catch {
        /* no storage, or full: the game lives for the page */
    }
};

/// One game on the table. `day` is set for the day's own game, which is kept; a pick-up game has
/// none and lives for the page.
const Board = ({ word, seed, day }) => {
    // A game picked up from storage lies as it was left: only throws after `quiet` tumble.
    const [start] = useState(() => {
        const kept = day !== undefined && keptGame(day, word);
        return { game: kept || newGame(word, seed), quiet: kept ? (kept.throws ?? 0) : 0 };
    });
    const [game, setGame] = useState(start.game);
    // The dice picked to spend, and the ability waiting to be pointed at something.
    const [picked, setPicked] = useState([]);
    const [pending, setPending] = useState(null);
    // The dice marked to be rolled again, while 'reroll' is pending.
    const [marked, setMarked] = useState([]);
    const [said, setSaid] = useState('');
    const sound = useSoundOn();

    useEffect(
        () => preloadSounds([...DICE_SOUNDS, ...DIE_SOUNDS, ...GRAB_SOUNDS, ...CARD_SOUNDS]),
        [],
    );
    // A throw is heard as it is seen: only one newer than `quiet`, and by how many dice it threw.
    useEffect(() => {
        if (!(game.throws > start.quiet)) return;
        const thrown = game.hand.filter((die) => die.thrown === game.throws).length;
        playSound(thrown > 1 ? DICE_SOUNDS : DIE_SOUNDS);
        // Only a new throw sounds: the hand is read as it stands then.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [game.throws]);

    const move = (next) => {
        if (!next) return;
        setGame(next);
        if (day !== undefined) keepGame(day, next);
        setPicked([]);
        setMarked([]);
        setPending(null);
    };
    const onDie = (i) => {
        // A die taken up is heard; one put back is not.
        if (!(pending === 'reroll' ? marked : picked).includes(i)) playSound(GRAB_SOUNDS);
        // While a die is paying for a reroll, a tap marks another to be rolled again.
        if (pending === 'reroll')
            return setMarked((now) => (now.includes(i) ? now.filter((m) => m !== i) : [...now, i]));
        setPending(null);
        setPicked((now) => (now.includes(i) ? now.filter((p) => p !== i) : [...now, i]));
    };
    const onAbility = (a) => {
        setMarked([]);
        const next = a.target ? null : play(game, a.id, picked);
        // The card is heard, unless it throws dice: then the throw is the sound.
        if (a.target || (next && next.throws === game.throws)) playSound(CARD_SOUNDS);
        if (a.target) setPending(pending === a.id ? null : a.id);
        else move(next);
    };
    const onGuess = (e) => {
        e.preventDefault();
        const next = guess(game, said);
        if (next) setSaid('');
        move(next);
    };

    const open = pending && pending !== 'reroll' ? targets(game, pending) : [];
    const atGuess = guessing(game);
    const owed = game.won ? 0 : (game.reveals ?? 0);
    return html`<div class="wordaga">
        <p class="wordaga-stats">
            <span>${t('games.cycle-n', 'cycle {n}', { n: game.cycle })}</span>
            <span
                class="wordaga-money"
                role="img"
                aria-label=${t('games.money-n', 'money: {n}', { n: game.apostrophes })}
            >
                <${Icons.money} /> ${game.apostrophes}
            </span>
            <button
                type="button"
                class="wordaga-sound"
                aria-pressed=${sound}
                aria-label=${t('games.sound', 'sound')}
                title=${sound ? t('games.sound-is-on', 'sound is on') : t('games.sound-is-off', 'sound is off')}
                onClick=${() => setSoundOn(!sound)}
            >
                <${sound ? Icons.speaker : Icons.speakerOff} />
            </button>
        </p>
        <p class="wordaga-word" aria-label=${t('games.the-word', 'the word')}>
            ${shown(game).map((letter, i) =>
                letter === null && owed > 0
                    ? html`<button
                              key=${i}
                              type="button"
                              class="wordaga-slot open"
                              aria-label=${t('games.reveal-this', 'reveal this letter')}
                              onClick=${() => move(reveal(game, i))}
                          ></button>`
                    : html`<span key=${i} class="wordaga-slot">${letter ?? ''}</span>`,
            )}
        </p>
        <div class="wordaga-letters">
            ${[...LETTERS].map(
                (letter) =>
                    html`<button
                        key=${letter}
                        type="button"
                        class=${`wordaga-letter ${game.known[letter] ?? ''}`.trim()}
                        disabled=${!open.includes(letter)}
                        onClick=${() => move(play(game, pending, picked, letter))}
                    >
                        ${letter}
                    </button>`,
            )}
        </div>
        <p class="wordaga-last" role="status">${lastWords(game.last)}</p>
        ${
            game.won
                ? html`<p class="wordaga-won">
                      ${
                          game.cycle === 1
                              ? t('games.won-in-one', 'you got it in one cycle.')
                              : t('games.won-in-n', 'you got it in {n} cycles.', { n: game.cycle })
                      }
                  </p>`
                : html`<div class="wordaga-dice">
                          ${game.hand.map(
                              (die, i) =>
                                  html`<${Die}
                                      key=${i}
                                      die=${die}
                                      index=${i}
                                      lone=${game.hand.some((other) => other.thrown !== die.thrown)}
                                      quiet=${start.quiet}
                                      state=${picked.includes(i) ? 'picked' : marked.includes(i) ? 'marked' : ''}
                                      disabled=${die.spent || (pending === 'reroll' && picked.includes(i))}
                                      pressed=${picked.includes(i) || marked.includes(i)}
                                      onClick=${() => onDie(i)}
                                  />`,
                          )}
                      </div>
                      ${
                          atGuess &&
                          html`<form class="wordaga-guess" onSubmit=${onGuess}>
                              <input
                                  class="wordaga-guess-input"
                                  type="text"
                                  autocomplete="off"
                                  autocapitalize="none"
                                  spellcheck=${false}
                                  aria-label=${t('games.your-guess', 'your guess')}
                                  placeholder=${t('games.your-guess', 'your guess')}
                                  value=${said}
                                  onInput=${(e) => setSaid(e.target.value)}
                              />
                              <button class="wordaga-go" type="submit" disabled=${!said.trim()}>
                                  ${t('games.guess', 'guess')}
                              </button>
                          </form>`
                      }
                      ${
                          owed > 0 &&
                          html`<p class="wordaga-prompt">
                              ${t(
                                  'games.reveals-owed',
                                  'pick a blank in the word to reveal ({n} to pick).',
                                  {
                                      n: owed,
                                  },
                              )}
                          </p>`
                      }
                      ${
                          pending &&
                          html`<p class="wordaga-prompt">
                              ${
                                  pending === 'reroll'
                                      ? t('games.pick-dice', 'now pick the dice to roll again.')
                                      : t('games.pick-a-letter', 'now pick a letter.')
                              }
                              ${
                                  pending === 'reroll' &&
                                  html` <button
                                      class="wordaga-go"
                                      type="button"
                                      disabled=${marked.length === 0}
                                      onClick=${() => move(play(game, 'reroll', picked, marked))}
                                  >
                                      ${t('games.roll-them', 'roll')}
                                  </button>`
                              }
                          </p>`
                      }
                      <div class="wordaga-abilities">
                          ${ABILITIES.map((a) => {
                              const [name, needs] = ABILITY_WORDS[a.id]();
                              const price = priceOf(game, a.id);
                              return html`<button
                                  key=${a.id}
                                  type="button"
                                  class=${[
                                      'wordaga-ability',
                                      isWide(a.id) && 'wide',
                                      pending === a.id && 'picked',
                                  ]
                                      .filter(Boolean)
                                      .join(' ')}
                                  disabled=${!can(game, a.id, picked)}
                                  onClick=${() => onAbility(a)}
                              >
                                  ${
                                      price > 0 &&
                                      html`<span
                                          class=${
                                              game.apostrophes >= price
                                                  ? 'wordaga-price lit'
                                                  : 'wordaga-price'
                                          }
                                          role="img"
                                          aria-label=${t('games.costs-n', 'costs {n}', { n: price })}
                                      >
                                          <${Icons.money} /> ${price}
                                      </span>`
                                  }
                                  <${Wants} id=${a.id} />
                                  <strong>${name}</strong>
                                  <small>${needs}</small>
                              </button>`;
                          })}
                      </div>`
        }
        ${
            game.misses.length > 0 &&
            html`<p class="wordaga-note">
                ${t('games.not-the-word', 'not the word: {words}', { words: game.misses.join(', ') })}
            </p>`
        }
    </div>`;
};

/// Wordaga: the day's game, the same word and the same dice for everyone, and for now a pick-up
/// game beside it - any word, any dice, counted nowhere - to try the rules on.
export const Wordaga = () => {
    const day = useWordagaDay();
    const [pickup, setPickup] = useState(null);
    const deal = () =>
        setPickup({
            word: WORDS[Math.floor(Math.random() * WORDS.length)],
            seed: Math.floor(Math.random() * 0x100000000),
        });
    return html`<div class="persona-page">
        <div class="persona-page-head">
            <h1 class="persona-page-title">${t('games.wordaga', 'Wordaga')}</h1>
        </div>
        ${
            pickup
                ? html`<${Board} key=${`pickup-${pickup.seed}`} word=${pickup.word} seed=${pickup.seed} />`
                : html`<${Board} key=${`day-${day}`} word=${wordOfDay(Date.now())} seed=${day} day=${day} />`
        }
        <p class="wordaga-note">
            ${
                pickup
                    ? t('games.pickup-note', "a pick-up game: any word, and it doesn't count.")
                    : t('games.changes-at-0', 'a new word every day at @000')
            }
        </p>
        <p class="wordaga-more">
            <button class="wordaga-go" type="button" onClick=${deal}>
                ${
                    pickup
                        ? t('games.another-pickup', 'another pick-up game')
                        : t('games.play-pickup', 'play a pick-up game')
                }
            </button>
            ${
                pickup &&
                html`<button class="wordaga-go" type="button" onClick=${() => setPickup(null)}>
                    ${t('games.back-to-today', "back to today's game")}
                </button>`
            }
        </p>
    </div>`;
};
