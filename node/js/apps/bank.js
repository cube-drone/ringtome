// hrseBank™ (HORSE_BASED_CURRENCIES.md, slice 2; Curtis 2026-09-29): the persona's horse capital -
// the balance in the broken-number notation, what each kind of earning has paid, and the ledger,
// every line saying what earned it. The node keeps the ledger (bank.rs); this reads it.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from '../net.js';
import { t } from '../i18n.js';
import { PersonChip } from '../person.js';
import { Icons } from '../icons.js';
import { useColWidths, useColTucks, PaneHead, Rail } from '../panes.js';
import { contractName, contractFinePrint } from '../contracts.js';
import {
    noteBank,
    refreshUnlocks,
    unlockAbout,
    unlockIcon,
    unlockName,
    unlockWarning,
} from '../unlocks.js';
import { formatHorseBucks } from '../pure/horsebucks.js';
import { groupLedger } from '../pure/ledger.js';
import { formatWhen } from '../pure/when.js';

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
    bond: () => t('apps.bank.kind-bond', 'hrseBonds bought'),
    bond_interest: () => t('apps.bank.kind-bond-interest', 'hrseBond interest'),
    bond_matured: () => t('apps.bank.kind-bond-matured', 'hrseBonds matured'),
    bond_sold: () => t('apps.bank.kind-bond-sold', 'hrseBonds sold'),
    debt_interest: () => t('apps.bank.kind-debt-interest', 'interest on debt'),
    magic_words: () => t('apps.bank.kind-magic-words', 'the magic words'),
    contract: () => t('apps.bank.kind-contract', 'contracts completed'),
    unlock: () => t('apps.bank.kind-unlock', 'unlocks bought'),
};

/// The Contracts column (Curtis, 2026-10-04): goals that pay once - the ones still open, then the
/// ones done. Completion is the node's to judge and record (bank.rs); this lists what it says.
/// A contract's fine print: a very small link, its exact terms on hover (2026-10-04).
const FinePrint = ({ id }) => {
    const fine = contractFinePrint(id);
    if (!fine) return null;
    // A phone can't hover (2026-10-04): under 900px the terms themselves show, in small text, where
    // the label was (apps/bank.css). The hover belongs to the label alone, so terms on show aren't
    // said twice.
    return html`<a class="bank-contract-fine" href=${fine.href} data-settles>
        <span class="bank-contract-fine-label" title=${fine.text}>${t('apps.bank.fine-print', 'fine print')}</span>
        <span class="bank-contract-fine-text">${fine.text}</span>
    </a>`;
};

const Contracts = ({ contracts, owns }) => {
    // An open contract shows once what it needs is owned (UNLOCKS.md, Ruling 2): the column only
    // offers what the player can do. A done one shows whatever is owned - it was done.
    const active = contracts.filter((c) => !c.completed_ms && (c.requires || []).every(owns));
    const done = contracts.filter((c) => c.completed_ms);
    const [top, ...rest] = active;
    const item = (
        c,
    ) => html`<li class=${c.completed_ms ? 'bank-contract bank-contract-done' : 'bank-contract'} key=${c.id}>
        <span class="bank-contract-name">${c.completed_ms ? html`<${Icons.done} /> ` : ''}${contractName(c.id, c.name)}</span>
        <span class="bank-contract-reward">${formatHorseBucks(c.pennies)}</span>
        ${!c.completed_ms && html`<${FinePrint} id=${c.id} />`}
    </li>`;
    return html`<div class="bank-contracts">
        <p class="bank-contracts-head">${t('apps.bank.active-contracts', 'Active Contracts')}</p>
        ${
            /* The top active contract is the special one (Curtis, 2026-10-04): dressed like the
            hrseBond window - heavy border, icon - with the rest listed under it. */ ''
        }
        ${
            top
                ? html`<section class="bank-contract-top">
                  <h3 class="bank-contract-top-name"><${Icons.contract} /> ${contractName(top.id, top.name)}</h3>
                  <span class="bank-contract-top-reward">${formatHorseBucks(top.pennies)}</span>
                  <${FinePrint} id=${top.id} />
              </section>`
                : html`<p class="null-sub">${t('apps.bank.every-contract-done', 'every contract is done - more to come.')}</p>`
        }
        ${rest.length > 0 && html`<ul class="bank-contract-list">${rest.map(item)}</ul>`}
        <hr class="bank-rule" />
        <p class="bank-contracts-head">${t('apps.bank.completed-contracts', 'Completed Contracts')}</p>
        ${
            done.length
                ? html`<ul class="bank-contract-list">${done.map(item)}</ul>`
                : html`<p class="null-sub">${t('apps.bank.none-yet', 'none yet.')}</p>`
        }
    </div>`;
};

/// A line's amount with its own sign: earnings rise, purchases and debt fall.
const signed = (pennies) =>
    String(pennies).startsWith('-') ? formatHorseBucks(pennies) : `+${formatHorseBucks(pennies)}`;

/// One grouped row (pure/ledger.js), in words: a run's count, its document, its emoji, its people.
const RowWords = ({ row, current }) => {
    const title = row.title
        ? html`<em>${row.title}</em>`
        : t('apps.bank.untitled', 'something untitled');
    const people = row.people.map(
        (root) => html`<${PersonChip} key=${root} root=${root} current=${current} size="mini" />`,
    );
    const many = row.count > 1;
    switch (row.kind) {
        case 'words':
            return html`${t('apps.bank.wrote-n-words-in', 'wrote {n} new words in', { n: row.n })} ${title}${many ? t('apps.bank.over-n-saves', ' · {count} saves', { count: row.count }) : ''}`;
        case 'strokes':
            return html`${t('apps.bank.drew-n-strokes-in', 'drew {n} new strokes in', { n: row.n })} ${title}${many ? t('apps.bank.over-n-saves', ' · {count} saves', { count: row.count }) : ''}`;
        case 'image':
            return many
                ? t('apps.bank.uploaded-n-pictures', 'uploaded {count} pictures', {
                      count: row.count,
                  })
                : html`${t('apps.bank.uploaded', 'uploaded')} ${title}`;
        case 'publication':
            return html`${t('apps.bank.published', 'published')} ${title}`;
        case 'heartbeat':
            return t('apps.bank.used-the-app-on', 'used the app on {date}', { date: row.source });
        case 'chat':
            return many
                ? t('apps.bank.said-n-things', 'said {count} things in rooms', { count: row.count })
                : t('apps.bank.said-something-in-a-room', 'said something in a room');
        case 'reaction':
            return many
                ? t('apps.bank.reacted-to-n-lines', 'reacted to {count} lines in rooms', {
                      count: row.count,
                  })
                : t('apps.bank.reacted-in-a-room', 'reacted to a line in a room');
        case 'reacted':
            return html`${people} ${many ? t('apps.bank.reacted-to-your-lines', 'reacted to your lines {count} times', { count: row.count }) : t('apps.bank.reacted-to-your-line', 'reacted to your line')}`;
        case 'post_reaction':
            return many
                ? t('apps.bank.reacted-to-posts', 'reacted {emoji} to posts', {
                      emoji: row.emoji.join(''),
                  })
                : t('apps.bank.reacted-to-a-post', 'reacted {emoji} to a post', {
                      emoji: row.emoji.join(''),
                  });
        case 'post_reacted':
            return html`${people} ${t('apps.bank.reacted-to-your-posts', 'reacted {emoji} to your posts', { emoji: row.emoji.join('') })}`;
        case 'follow':
            return html`${t('apps.bank.followed', 'followed')} ${people}`;
        case 'followed':
            return html`${people} ${t('apps.bank.followed-you', 'followed you')}`;
        case 'bond':
            return many
                ? t('apps.bank.bought-n-horsebonds', 'bought {count} hrseBonds', {
                      count: row.count,
                  })
                : t('apps.bank.bought-a-horsebond', 'bought a hrseBond');
        case 'bond_interest':
            return many
                ? t('apps.bank.n-horsebonds-paid', '{count} hrseBonds paid their interest', {
                      count: row.count,
                  })
                : t('apps.bank.a-horsebond-paid', 'a hrseBond paid its interest');
        case 'bond_matured':
            return t('apps.bank.a-horsebond-matured', 'a hrseBond matured, and returned its price');
        case 'bond_sold':
            return many
                ? t('apps.bank.sold-n-hrsebonds', 'sold {count} hrseBonds', { count: row.count })
                : t('apps.bank.sold-a-hrsebond', 'sold a hrseBond');
        case 'debt_interest':
            return t('apps.bank.interest-on-debt', 'interest on your debt, at 2% a day');
        case 'magic_words':
            return t('apps.bank.used-the-magic-words', 'used the magic words');
        case 'contract':
            return html`${t('apps.bank.completed-the-contract', 'completed the contract')} <em>${contractName(row.source, row.title)}</em>`;
        case 'unlock':
            return html`${t('apps.bank.unlocked', 'unlocked')} <em>${unlockName(row.source, row.title)}</em>`;
        default:
            return row.kind;
    }
};

/// A month's name, as the reader's locale says it (the month itself is UTC, as the node counts).
const monthName = (month) =>
    new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });

/// One month of the ledger: a row saying its size and total, opening onto its grouped lines.
const Month = ({ month, lines, open, onToggle, current }) => html`<li class="bank-month">
    <button class=${open ? 'bank-month-head open' : 'bank-month-head'} type="button" aria-expanded=${open} onClick=${onToggle}>
        <span class="bank-month-name">${monthName(month.month)}</span>
        <span class="bank-month-count">${t('apps.bank.n-lines', '{n} lines', { n: month.lines })}</span>
        <span class="bank-line-amount">${signed(month.pennies)}</span>
    </button>
    ${
        open &&
        (lines
            ? html`<ul class="bank-lines">
              ${groupLedger(lines).map(
                  (row) => html`<li class="bank-line" key=${row.key + row.at_ms}>
                      <span class="bank-line-what"><${RowWords} row=${row} current=${current} /></span>
                      <span class="bank-line-when">${formatWhen(row.at_ms, undefined, { time: false })}</span>
                      <span class="bank-line-amount">${signed(row.pennies)}</span>
                  </li>`,
              )}
          </ul>`
            : html`<p class="null-sub">${t('apps.bank.counting', 'counting…')}</p>`)
    }
</li>`;

/// The market column (Curtis, 2026-09-29: "a column to the left of our horsebank statement… for
/// purchasing horse-themed fictitious financial instruments"): hrseBonds for now - a bordered
/// square, its terms on hover, a slider from H$ 2,000 to what the balance holds (at most a million,
/// 2026-09-30), a buy button. Nothing is sold past the balance (2026-09-30:
/// "overdraft is for special cases, not the average case"): an unaffordable bond greys out, and the
/// node refuses it besides.
const BOND_MIN = 2000; // whole H$ (bank.rs BOND_MIN)
const BOND_MAX = 1000000; // whole H$ (bank.rs BOND_MAX)

/// The unlocks for sale (plans/UNLOCKS.md; Curtis, 2026-10-05), above the hrseBond: one card per
/// unlock not owned yet, in the node's order - what it opens, its price, a buy button greyed when
/// the balance can't pay or another unlock must come first. Bought, a card leaves the Market, and
/// what it opened appears at once (unlocks.js `refreshUnlocks`).
const UnlockCard = ({ root, unlock, balance, owned, onBought }) => {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const needs = (unlock.requires || []).filter((r) => !owned.has(r));
    const affordable = BigInt(balance || '0') >= BigInt(unlock.pennies);
    const warning = unlockWarning(unlock.id);
    const Icon = unlockIcon(unlock.id);
    const buy = async () => {
        setBusy(true);
        setError(null);
        try {
            await api(`/api/identity/${root}/bank/unlocks`, {
                method: 'POST',
                body: JSON.stringify({ id: unlock.id }),
            });
            await refreshUnlocks(root);
            onBought();
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<section class=${affordable && needs.length === 0 ? 'bank-unlock' : 'bank-unlock unaffordable'}>
        <h3 class="bank-unlock-name"><${Icon} /> ${unlockName(unlock.id, unlock.name)}</h3>
        <p class="bank-unlock-about">${unlockAbout(unlock.id)}</p>
        ${warning && html`<p class="bank-unlock-warning"><${Icons.warn} /> ${warning}</p>`}
        ${
            needs.length > 0 &&
            html`<p class="bank-unlock-needs">${t('apps.bank.unlock-first', 'first: {unlocks}', {
                unlocks: needs.map((id) => unlockName(id, id)).join(', '),
            })}</p>`
        }
        <span class="bank-unlock-price">${formatHorseBucks(unlock.pennies)}</span>
        <button class="bank-buy" type="button" disabled=${busy || !affordable || needs.length > 0} onClick=${buy}>${busy ? '…' : t('apps.bank.unlock', 'unlock')}</button>
        ${error && html`<p class="form-error">${error}</p>`}
    </section>`;
};

const Market = ({ root, balance, unlocks, everything, onBought }) => {
    const owned = new Set(unlocks.filter((u) => u.bought_ms).map((u) => u.id));
    // The test rig owns everything already, so it sells nothing (bank.rs `everything_unlocked`).
    const forSale = everything ? [] : unlocks.filter((u) => !u.bought_ms);
    return html`<div class="bank-market-body">
        ${forSale.map(
            (u) => html`<${UnlockCard}
                key=${u.id}
                root=${root}
                unlock=${u}
                balance=${balance}
                owned=${owned}
                onBought=${onBought}
            />`,
        )}
        ${forSale.length > 0 && html`<hr class="bank-rule" />`}
        <${Bond} root=${root} balance=${balance} onBought=${onBought} />
        ${
            /* What's owned (plans/UNLOCKS.md): after the Market's wares, a short list of what's
            been bought and when - a returning player's answer to "what do I have?". */ ''
        }
        ${
            owned.size > 0 &&
            html`<hr class="bank-rule" />
            <p class="bank-contracts-head">${t('apps.bank.unlocked-heading', 'Unlocked')}</p>
            <ul class="bank-owned">
                ${unlocks
                    .filter((u) => u.bought_ms)
                    .map((u) => {
                        const Icon = unlockIcon(u.id);
                        return html`<li class="bank-owned-item" key=${u.id} title=${unlockAbout(u.id)}>
                            <span class="bank-owned-name"><${Icon} /> ${unlockName(u.id, u.name)}</span>
                            <span class="bank-owned-when">${formatWhen(u.bought_ms, undefined, { time: false })}</span>
                        </li>`;
                    })}
            </ul>`
        }
    </div>`;
};

const Bond = ({ root, balance, onBought }) => {
    const [bucks, setBucks] = useState(BOND_MIN);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    // The balance in whole H$, held to the bond's ceiling before it leaves BigInt: a balance past
    // a million is still only a million on the slider.
    const whole = BigInt(balance || '0') / 100n;
    const top = Number(whole > BigInt(BOND_MAX) ? BigInt(BOND_MAX) : whole);
    const affordable = top >= BOND_MIN;
    const chosen = Math.min(Math.max(bucks, BOND_MIN), Math.max(top, BOND_MIN));
    const price = BigInt(chosen) * 100n;
    const buy = async () => {
        setBusy(true);
        setError(null);
        try {
            await api(`/api/identity/${root}/bank/instruments`, {
                method: 'POST',
                body: JSON.stringify({ kind: 'horsebond', pennies: String(price) }),
            });
            onBought();
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(false);
        }
    };
    return html`<section
            class=${affordable ? 'bank-instrument' : 'bank-instrument unaffordable'}
            title=${t('apps.bank.hrsebond-terms', 'pays 1% interest every day for 100 days')}
        >
            <h3 class="bank-instrument-name"><${Icons.bond} /> ${t('apps.bank.hrsebond', 'hrseBond')}</h3>
            <label class="bank-instrument-amount">
                <span class="bank-instrument-price">${formatHorseBucks(price)}</span>
                <input
                    type="range"
                    min=${BOND_MIN}
                    max=${Math.max(top, BOND_MIN)}
                    step="1"
                    value=${chosen}
                    disabled=${!affordable}
                    onInput=${(e) => setBucks(Number(e.currentTarget.value))}
                />
            </label>
            <button class="bank-buy" type="button" disabled=${busy || !affordable} onClick=${buy}>${busy ? '…' : t('apps.bank.buy', 'buy')}</button>
            ${error && html`<p class="form-error">${error}</p>`}
        </section>`;
};

/// The portfolio column (Curtis, 2026-09-29: "tuck our purchased HorseBonds in a new column"):
/// every instrument held, newest first, with how far along each is. In debt, a bond still paying
/// can be sold for its price (2026-09-30: "If you're in debt you should be allowed to sell bonds").
const Portfolio = ({ root, instruments, inDebt, onSold }) => {
    const [busy, setBusy] = useState(null);
    const [error, setError] = useState(null);
    const sell = async (id) => {
        setBusy(id);
        setError(null);
        try {
            await api(`/api/identity/${root}/bank/instruments/${id}/sell`, { method: 'POST' });
            onSold();
        } catch (e) {
            setError(e.message || String(e));
        } finally {
            setBusy(null);
        }
    };
    const progress = (b) => {
        if (b.sold) return t('apps.bank.sold', 'sold');
        if (b.matured) return t('apps.bank.matured', 'matured');
        return t('apps.bank.day-of', 'day {days} of {of}', { days: b.days, of: b.of_days });
    };
    if (instruments.length === 0)
        return html`<p class="null-sub bank-portfolio-empty">${t('apps.bank.nothing-held-yet', 'nothing held yet - the market is to the left.')}</p>`;
    return html`<ul class="bank-holdings">
        ${instruments.map(
            (b) => html`<li class="bank-holding" key=${b.id}>
                <span class="bank-holding-kind">${t('apps.bank.hrsebond', 'hrseBond')}</span>
                <span class="bank-holding-progress">${progress(b)}</span>
                <span class="bank-holding-price">${formatHorseBucks(b.pennies)}</span>
                <span class="bank-holding-paid">${t('apps.bank.paid-so-far', 'paid {amount}', { amount: formatHorseBucks(b.paid) })}</span>
                <span class="bank-holding-bar"><span style=${`width: ${Math.round((100 * b.days) / b.of_days)}%`}></span></span>
                ${
                    inDebt &&
                    !b.sold &&
                    !b.matured &&
                    html`<button class="bank-sell" type="button" disabled=${busy !== null} onClick=${() => sell(b.id)}>
                    ${busy === b.id ? '…' : t('apps.bank.sell', 'sell')}
                </button>`
                }
            </li>`,
        )}
        ${error && html`<p class="form-error">${error}</p>`}
    </ul>`;
};

export const BankApp = ({ current }) => {
    const root = current && current.root;
    const [bank, setBank] = useState(null);
    const [error, setError] = useState(null);
    // Each month's lines, once fetched; the newest arrives with the first answer.
    const [lines, setLines] = useState({});
    const [open, setOpen] = useState(new Set());
    const { tucked, toggleTuck, tab, settle } = useColTucks(root, 'bank');
    const { resizer, colStyle } = useColWidths(root, 'bank', ['market', 'portfolio', 'contracts'], {
        market: 240,
        portfolio: 200,
        contracts: 200,
    });
    const [asked, setAsked] = useState(0); // bumped after a purchase or a sale: ask the ledger again
    useEffect(() => {
        if (!root) return undefined;
        let live = true;
        api(`/api/identity/${root}/bank`)
            .then((b) => {
                if (!live) return;
                setBank(b);
                noteBank(root, b); // the gates hear the full answer too
                if (b.month) {
                    setLines((l) => ({ ...l, [b.month]: b.lines }));
                    setOpen((o) => (o.size ? o : new Set([b.month])));
                }
            })
            .catch((e) => live && setError(e.message || String(e)));
        return () => {
            live = false;
        };
    }, [root, asked]);
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
    if (error)
        return html`<div class="bank-app"><div class="bank"><p class="form-error">${error}</p></div></div>`;
    if (!bank)
        return html`<div class="bank-app"><div class="bank"><p class="null-sub">${t('apps.bank.counting', 'counting…')}</p></div></div>`;
    const kinds = Object.entries(bank.by_kind || {}).filter(([, p]) => p !== '0');
    const months = bank.months || [];
    return html`<div class="bank-app"><div class="bank-columns panes" style=${colStyle}>
        ${
            tucked.has('market')
                ? html`<${Rail} icon=${Icons.bond} label=${t('apps.bank.market', 'market')} onClick=${() => toggleTuck('market')} />`
                : html`${tab('market', Icons.bond, t('apps.bank.market', 'market'))}<aside class="bank-market">
                  <${PaneHead} icon=${Icons.bond} label=${t('apps.bank.market', 'market')} onTuck=${() => toggleTuck('market')} />
                  <${Market} root=${root} balance=${bank.balance} unlocks=${bank.unlocks || []} everything=${bank.everything} onBought=${() => {
                      setAsked((n) => n + 1);
                      // Bought: on a phone the market closes onto the balance it moved. On success
                      // only - a refusal is said in the market column.
                      settle();
                  }} />
              </aside>${resizer('market')}`
        }
        ${
            tucked.has('portfolio')
                ? html`<${Rail} icon=${Icons.bank} label=${t('apps.bank.portfolio', 'portfolio')} onClick=${() => toggleTuck('portfolio')} />`
                : html`${tab('portfolio', Icons.bank, t('apps.bank.portfolio', 'portfolio'))}<aside class="bank-portfolio">
                  <${PaneHead} icon=${Icons.bank} label=${t('apps.bank.portfolio', 'portfolio')} onTuck=${() => toggleTuck('portfolio')} />
                  <${Portfolio}
                      root=${root}
                      instruments=${bank.instruments || []}
                      inDebt=${String(bank.balance).startsWith('-')}
                      onSold=${() => setAsked((n) => n + 1)}
                  />
              </aside>${resizer('portfolio')}`
        }
        ${
            tucked.has('contracts')
                ? html`<${Rail} icon=${Icons.contract} label=${t('apps.bank.contracts', 'contracts')} onClick=${() => toggleTuck('contracts')} />`
                : html`${tab('contracts', Icons.contract, t('apps.bank.contracts', 'contracts'))}<aside class="bank-contracts-column">
                  <${PaneHead} icon=${Icons.contract} label=${t('apps.bank.contracts', 'contracts')} onTuck=${() => toggleTuck('contracts')} />
                  <${Contracts} contracts=${bank.contracts || []} owns=${(id) => bank.everything || (bank.unlocks || []).some((u) => u.id === id && u.bought_ms)} />
              </aside>${resizer('contracts')}`
        }
        <div class="bank">
        <p class="bank-balance">${formatHorseBucks(bank.balance)}</p>
        ${
            kinds.length > 0 &&
            html`<table class="bank-kinds">
            <tbody>
                ${kinds.map(
                    ([kind, pennies]) => html`<tr key=${kind}>
                        <th>${(KINDS[kind] || (() => kind))()}</th>
                        <td>${formatHorseBucks(pennies)}</td>
                    </tr>`,
                )}
            </tbody>
        </table>`
        }
        <hr class="bank-rule" />
        ${
            months.length === 0
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
                      />`,
                  )}
              </ul>`
        }
        </div>
    </div></div>`;
};
