// A Wordaga score in the words (Curtis, 2026-11-17): the `:::wordaga ...:::` directive a shared
// score is posted as (pure/wordaga.js `wordagaShareSource`), drawn as the game's own victory panel -
// the attempts, the streak, what it earned, and the word as blanks: how long it is, never what it
// is. A reader who has not yet won today's game is offered their turn at it.
//
// The card lives here, with the other card the words can hold (usercard.js), because the feed's
// card and the game's page both need it and an app may not import another app.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { t } from '../i18n.js';
import { gamesHref } from '../links.js';
import { useAbolished, useTabRoot } from '../unlocks.js';
import { formatHorseBucks } from '../pure/horsebucks.js';
import { wordagaDay, wordagaPays, wordagaPrize, wordagaShared } from '../pure/wordaga.js';
import { standing } from '../pure/wordagagame.js';

const html = htm.bind(h);

// ---- which days this persona has won: read once per persona, told of a win as it happens ----

const won = new Map(); // root -> Set<day>, once the private chain has been read
const asked = new Map(); // root -> the read, in flight or done
const listeners = new Set();

const read = (root) => {
    if (!asked.has(root))
        asked.set(
            root,
            api(`/api/identity/${root}/private/kv/wordaga`)
                .then((r) => {
                    const days = won.get(root) || new Set();
                    for (const { key } of r.values || []) days.add(Number(key));
                    won.set(root, days);
                    listeners.forEach((fn) => fn());
                })
                // Unread: asked again by the next card drawn.
                .catch(() => asked.delete(root)),
        );
};

/// The game's page says a day was won (apps/games.js), so cards on this tab stop offering it.
export function noteWordagaWon(root, day) {
    if (!root) return;
    const days = won.get(root) || new Set();
    days.add(day);
    won.set(root, days);
    listeners.forEach((fn) => fn());
}

/// Whether this persona has won that day: true, false, or null while it is not yet known.
const useWonDay = (root, day) => {
    const [, bump] = useState(0);
    useEffect(() => {
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        if (root) read(root);
        return () => listeners.delete(fn);
    }, [root]);
    const days = root && won.get(root);
    return days ? days.has(day) : null;
};

/// A won panel's colour by the cycle it was won in, against par (pure/wordagagame.js `standing`;
/// Curtis, 2026-11-21): green for six or under, ink for seven or eight, red past that. It colours
/// the panel's line, its heading, the lines under the letters and its button (games.css `--won`) -
/// on the game's own page and on a score shared to the feed alike.
export const WON_CLASS = {
    under: 'wordaga-victory-under',
    par: 'wordaga-victory-par',
    over: 'wordaga-victory-over',
};

/// The streak's multiplier, as this reader's machine writes numbers: 1.3, 37.5.
export const streakTimes = (streak) =>
    ((10 + streak) / 10).toLocaleString(undefined, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
    });

/// The date a day's number names, as this reader's machine writes dates.
export const wordagaDate = (day) =>
    new Date(day * 86_400_000).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });

/// The card: someone's score for a day. The earnings are shown as stated, and the sum behind
/// them only when it is the sum the bank would have paid.
const WordagaCard = ({ score }) => {
    const root = useTabRoot();
    const abolished = useAbolished();
    const today = wordagaDay(Date.now());
    const done = useWonDay(root, today);
    const { day, attempts, streak, earned, length } = score;
    const summed = streak > 0 && earned === wordagaPays(attempts, streak);
    return html`<div class=${`wordaga-victory wordaga-card ${WON_CLASS[standing(attempts)]}`}>
        <div class="wordaga wordaga-victory-in">
            <p class="wordaga-date">
                ${t('doc.wordagacard.wordaga-on', 'Wordaga, {date}', { date: wordagaDate(day) })}
            </p>
            <h3 class="wordaga-won">
                ${
                    attempts === 1
                        ? t('doc.wordagacard.in-one', 'Got it in one attempt!')
                        : t('doc.wordagacard.in-n', 'Got it in {n} attempts!', { n: attempts })
                }
            </h3>
            ${
                streak > 0 &&
                html`<p class="wordaga-streak">
                    ${t('games.n-day-streak', '{n} day streak!', { n: streak })}
                </p>`
            }
            ${
                earned > 0 &&
                !abolished &&
                html`<p class="wordaga-earned">
                    ${
                        summed
                            ? t(
                                  'doc.wordagacard.earned-streak',
                                  'Earned {amount}: {prize} × {times} streak bonus',
                                  {
                                      amount: formatHorseBucks(earned),
                                      prize: formatHorseBucks(wordagaPrize(attempts) * 100),
                                      times: streakTimes(streak),
                                  },
                              )
                            : t('doc.wordagacard.earned', 'Earned {amount}', {
                                  amount: formatHorseBucks(earned),
                              })
                    }
                </p>`
            }
            <p
                class="wordaga-word"
                aria-label=${t('doc.wordagacard.n-letters', 'a word of {n} letters', { n: length })}
            >
                ${Array.from({ length }, (_, i) => html`<span key=${i} class="wordaga-slot"></span>`)}
            </p>
            ${
                day === today &&
                done === false &&
                html`<a class="wordaga-go wordaga-turn" href=${gamesHref('wordaga')}>
                    ${t('doc.wordagacard.my-turn', 'Ok, My Turn')}
                </a>`
            }
        </div>
    </div>`;
};

/// The react renderer's directive hook for a score (usercard.js `marqueeHooks` asks): the card,
/// or null for anything that is not one - which then shows as the plain words inside it.
export function wordagaDirective(attrs) {
    const score = wordagaShared(attrs);
    return score ? html`<${WordagaCard} score=${score} />` : null;
}
