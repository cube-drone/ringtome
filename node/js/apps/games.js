// hrseGames (Curtis, 2026-11-13): games to play. The app is a list of them, laid out as Settings
// lists its pages (persona.js `SettingsList`), and each game is a page of its own beneath it:
// `/ringtome/games/<game>`. One game so far, Wordaga, whose rules are pure/wordagagame.js.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { Icons } from '../icons.js';
import { gamesHref } from '../links.js';
import { t } from '../i18n.js';
import { wordOfDay, wordagaDay, untilNextWord } from '../pure/wordaga.js';
import {
    ABILITIES,
    LETTERS,
    PRICE,
    SEVEN,
    UNLIKELY,
    can,
    guess,
    guessing,
    newGame,
    play,
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
        t('games.ability-earn', 'take apostrophes'),
        t('games.needs-earn', 'any dice: a 1-2 pays one, a 3-4 pays two, a 5-6 pays three'),
    ],
    reroll: () => [
        t('games.ability-reroll-many', 'roll other dice again'),
        t('games.needs-die-many', 'any die, spent to roll as many of the others as you like'),
    ],
    'rule-out': () => [
        t('games.ability-rule-out', 'rule out a letter'),
        t('games.needs-die', 'any die'),
    ],
    seven: () => [
        t('games.ability-seven-paid', 'roll these again'),
        t(
            'games.needs-seven-paid',
            'dice that total 7, and {price} apostrophe: the dice are not spent',
            {
                price: SEVEN,
            },
        ),
    ],
    unlikely: () => [
        t('games.ability-unlikely', 'test an unlikely consonant'),
        t('games.needs-pair-unlikely', 'a pair: {letters}', {
            letters: [...UNLIKELY].join(' ').toUpperCase(),
        }),
    ],
    'buy-die': () => [
        t('games.ability-buy-die', 'buy another die'),
        t('games.needs-pair-paid', 'a pair and {price} apostrophes', { price: PRICE }),
    ],
    'extra-guess': () => [
        t('games.ability-extra-guess', 'an extra guess this cycle'),
        t('games.needs-run', 'a run of three'),
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
    consonant: () => [
        t('games.ability-consonant', 'test a consonant'),
        t('games.needs-paid', '{price} apostrophes, no dice', { price: PRICE }),
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
    if (last.ability === 'earn')
        return t('games.earned', 'apostrophes taken: {n}.', { n: last.gained });
    if (last.ability === 'buy-die') return t('games.bought-die', 'a new die, yours to keep.');
    if (last.ability === 'extra-guess')
        return t('games.bought-guess', 'one more guess this cycle.');
    return t('games.rolled-again', 'rolled again.');
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
    const [game, setGame] = useState(
        () => (day !== undefined && keptGame(day, word)) || newGame(word, seed),
    );
    // The dice picked to spend, and the ability waiting to be pointed at something.
    const [picked, setPicked] = useState([]);
    const [pending, setPending] = useState(null);
    // The dice marked to be rolled again, while 'reroll' is pending.
    const [marked, setMarked] = useState([]);
    const [said, setSaid] = useState('');

    const move = (next) => {
        if (!next) return;
        setGame(next);
        if (day !== undefined) keepGame(day, next);
        setPicked([]);
        setMarked([]);
        setPending(null);
    };
    const onDie = (i) => {
        // While a die is paying for a reroll, a tap marks another to be rolled again.
        if (pending === 'reroll')
            return setMarked((now) => (now.includes(i) ? now.filter((m) => m !== i) : [...now, i]));
        setPending(null);
        setPicked((now) => (now.includes(i) ? now.filter((p) => p !== i) : [...now, i]));
    };
    const onAbility = (a) => {
        setMarked([]);
        if (a.target) setPending(pending === a.id ? null : a.id);
        else move(play(game, a.id, picked));
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
            <span>${t('games.apostrophes-n', 'apostrophes: {n}', { n: game.apostrophes })}</span>
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
                                  html`<button
                                      key=${i}
                                      type="button"
                                      class=${
                                          picked.includes(i)
                                              ? 'wordaga-die picked'
                                              : marked.includes(i)
                                                ? 'wordaga-die marked'
                                                : 'wordaga-die'
                                      }
                                      disabled=${die.spent || (pending === 'reroll' && picked.includes(i))}
                                      aria-pressed=${picked.includes(i) || marked.includes(i)}
                                      onClick=${() => onDie(i)}
                                  >
                                      ${die.pips}
                                  </button>`,
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
                                  placeholder=${
                                      game.guesses > 1
                                          ? t('games.guesses-left', 'your guess ({n} left)', {
                                                n: game.guesses,
                                            })
                                          : t('games.your-guess', 'your guess')
                                  }
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
                          ${ABILITIES.filter((a) => game.count >= (a.min ?? 0)).map((a) => {
                              const [name, needs] = ABILITY_WORDS[a.id]();
                              return html`<button
                                  key=${a.id}
                                  type="button"
                                  class=${pending === a.id ? 'wordaga-ability picked' : 'wordaga-ability'}
                                  disabled=${!can(game, a.id, picked)}
                                  onClick=${() => onAbility(a)}
                              >
                                  <strong>${name}</strong>
                                  <small>${needs}</small>
                              </button>`;
                          })}
                      </div>`
        }
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
