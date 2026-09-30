// hrseBank™ (HORSE_BASED_CURRENCIES.md, slice 2; Curtis 2026-09-29): the persona's horse capital -
// the balance in the broken-number notation, what each kind of earning has paid, and the ledger,
// every line saying what earned it. The node keeps the ledger (bank.rs); this reads it.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { t } from '../i18n.js';
import { PersonChip } from '../person.js';
import { formatHorseBucks } from '../pure/horsebucks.js';
import { groupLedger } from '../pure/ledger.js';

const html = htm.bind(h);

/// What each kind of line was for, in the ledger's words.
const KINDS = {
    words: () => t('apps.bank.kind-words', 'words written'),
    strokes: () => t('apps.bank.kind-strokes', 'strokes drawn'),
    image: () => t('apps.bank.kind-image', 'pictures uploaded'),
    publication: () => t('apps.bank.kind-publication', 'publications'),
    heartbeat: () => t('apps.bank.kind-heartbeat', 'days of use'),
    chat: () => t('apps.bank.kind-chat', 'chat lines'),
    reaction: () => t('apps.bank.kind-reaction', 'reactions given in chat'),
    reacted: () => t('apps.bank.kind-reacted', 'reactions received in chat'),
    post_reaction: () => t('apps.bank.kind-post-reaction', 'reactions given to posts'),
    post_reacted: () => t('apps.bank.kind-post-reacted', 'reactions received on posts'),
    follow: () => t('apps.bank.kind-follow', 'people followed'),
    followed: () => t('apps.bank.kind-followed', 'people following you'),
};

/// One grouped row (pure/ledger.js), in words: a run's count, its document, its emoji, its people.
const RowWords = ({ row, current }) => {
    const title = row.title ? html`<em>${row.title}</em>` : t('apps.bank.untitled', 'something untitled');
    const people = row.people.map((root) => html`<${PersonChip} key=${root} root=${root} current=${current} size="mini" />`);
    const many = row.count > 1;
    switch (row.kind) {
        case 'words':
            return html`${t('apps.bank.wrote-n-words-in', 'wrote {n} new words in', { n: row.n })} ${title}${many ? t('apps.bank.over-n-saves', ' · {count} saves', { count: row.count }) : ''}`;
        case 'strokes':
            return html`${t('apps.bank.drew-n-strokes-in', 'drew {n} new strokes in', { n: row.n })} ${title}${many ? t('apps.bank.over-n-saves', ' · {count} saves', { count: row.count }) : ''}`;
        case 'image':
            return many ? t('apps.bank.uploaded-n-pictures', 'uploaded {count} pictures', { count: row.count }) : html`${t('apps.bank.uploaded', 'uploaded')} ${title}`;
        case 'publication':
            return html`${t('apps.bank.published', 'published')} ${title}`;
        case 'heartbeat':
            return t('apps.bank.used-the-app-on', 'used the app on {date}', { date: row.source });
        case 'chat':
            return many ? t('apps.bank.said-n-things', 'said {count} things in rooms', { count: row.count }) : t('apps.bank.said-something-in-a-room', 'said something in a room');
        case 'reaction':
            return many ? t('apps.bank.reacted-to-n-lines', 'reacted to {count} lines in rooms', { count: row.count }) : t('apps.bank.reacted-in-a-room', 'reacted to a line in a room');
        case 'reacted':
            return html`${people} ${many ? t('apps.bank.reacted-to-your-lines', 'reacted to your lines {count} times', { count: row.count }) : t('apps.bank.reacted-to-your-line', 'reacted to your line')}`;
        case 'post_reaction':
            return many
                ? t('apps.bank.reacted-to-posts', 'reacted {emoji} to posts', { emoji: row.emoji.join('') })
                : t('apps.bank.reacted-to-a-post', 'reacted {emoji} to a post', { emoji: row.emoji.join('') });
        case 'post_reacted':
            return html`${people} ${t('apps.bank.reacted-to-your-posts', 'reacted {emoji} to your posts', { emoji: row.emoji.join('') })}`;
        case 'follow':
            return html`${t('apps.bank.followed', 'followed')} ${people}`;
        case 'followed':
            return html`${people} ${t('apps.bank.followed-you', 'followed you')}`;
        default:
            return row.kind;
    }
};

/// A month's name, as the reader's locale says it (the month itself is UTC, as the node counts).
const monthName = (month) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });

/// One month of the ledger: a row saying its size and total, opening onto its grouped lines.
const Month = ({ month, lines, open, onToggle, current }) => html`<li class="bank-month">
    <button class=${open ? 'bank-month-head open' : 'bank-month-head'} type="button" aria-expanded=${open} onClick=${onToggle}>
        <span class="bank-month-name">${monthName(month.month)}</span>
        <span class="bank-month-count">${t('apps.bank.n-lines', '{n} lines', { n: month.lines })}</span>
        <span class="bank-line-amount">+${formatHorseBucks(month.pennies)}</span>
    </button>
    ${open &&
    (lines
        ? html`<ul class="bank-lines">
              ${groupLedger(lines).map(
                  (row) => html`<li class="bank-line" key=${row.key + row.at_ms}>
                      <span class="bank-line-what"><${RowWords} row=${row} current=${current} /></span>
                      <span class="bank-line-when">${new Date(row.at_ms).toLocaleDateString()}</span>
                      <span class="bank-line-amount">+${formatHorseBucks(row.pennies)}</span>
                  </li>`
              )}
          </ul>`
        : html`<p class="null-sub">${t('apps.bank.counting', 'counting…')}</p>`)}
</li>`;

export const BankApp = ({ current }) => {
    const root = current && current.root;
    const [bank, setBank] = useState(null);
    const [error, setError] = useState(null);
    // Each month's lines, once fetched; the newest arrives with the first answer.
    const [lines, setLines] = useState({});
    const [open, setOpen] = useState(new Set());
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/bank`)
            .then((b) => {
                if (!live) return;
                setBank(b);
                if (b.month) {
                    setLines({ [b.month]: b.lines });
                    setOpen(new Set([b.month]));
                }
            })
            .catch((e) => live && setError(e.message || String(e)));
        return () => {
            live = false;
        };
    }, [root]);
    const toggle = (month) => {
        const next = new Set(open);
        if (next.has(month)) next.delete(month);
        else {
            next.add(month);
            if (!lines[month]) {
                api(`/api/identity/${root}/bank?month=${month}`)
                    .then((b) => setLines((l) => ({ ...l, [month]: b.lines })))
                    .catch((e) => setError(e.message || String(e)));
            }
        }
        setOpen(next);
    };
    if (error) return html`<div class="bank"><p class="form-error">${error}</p></div>`;
    if (!bank) return html`<div class="bank"><p class="null-sub">${t('apps.bank.counting', 'counting…')}</p></div>`;
    const kinds = Object.entries(bank.by_kind || {}).filter(([, p]) => p !== '0');
    const months = bank.months || [];
    return html`<div class="bank">
        <p class="bank-balance">${formatHorseBucks(bank.balance)}</p>
        ${kinds.length > 0 &&
        html`<table class="bank-kinds">
            <tbody>
                ${kinds.map(
                    ([kind, pennies]) => html`<tr key=${kind}>
                        <th>${(KINDS[kind] || (() => kind))()}</th>
                        <td>${formatHorseBucks(pennies)}</td>
                    </tr>`
                )}
            </tbody>
        </table>`}
        <hr class="bank-rule" />
        ${months.length === 0
            ? html`<p class="null-sub">${t('apps.bank.nothing-yet', 'nothing earned yet - write something, draw something, say something.')}</p>`
            : html`<ul class="bank-months">
                  ${months.map(
                      (m) => html`<${Month}
                          key=${m.month}
                          month=${m}
                          lines=${lines[m.month]}
                          open=${open.has(m.month)}
                          onToggle=${() => toggle(m.month)}
                          current=${current}
                      />`
                  )}
              </ul>`}
    </div>`;
};
