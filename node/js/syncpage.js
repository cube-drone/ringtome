// The sync half of "Your computers" (plans/SYNC_STATUS.md, piece 4): where the corner cloud leads.
// Since 2026-10-09 each of the persona's other computers says how it is syncing under its own row
// in the All computers tree - reached when, or why not; syncing right now; how far apart the two
// were at the last exchange - and beneath the tree come the bodies still to come, a Sync now
// button, and, for the curious, what this server is doing for everyone (rulings 2 and 5: how many,
// never who). A pair that keeps exchanging without getting closer says so, and the sync report
// (piece 7) is a page of plain text for a bug report.
// Read from the node's sync ledger every few seconds while the page is open; the words are decided
// in pure/syncstatus.js.
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';

import { api, apiTextTitled } from './net.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { agoUnit, agoWords } from './pure/ago.js';
import { computerState, gapOf } from './pure/syncstatus.js';
import { sizeLabel } from './pure/backups.js';
import { writeClipboard, computersHref } from './links.js';

const html = htm.bind(h);

/// How often the page asks the ledger again while it's open.
const LOOK_MS = 3000;

const ago = (ms) => {
    const unit = agoUnit(ms, Date.now());
    return unit ? agoWords(unit.value, unit.unit) : t('syncpage.just-now', 'just now');
};

const count = (n) => Number(n || 0).toLocaleString();

/// One computer's sync, in words, under its row in the tree: what's happening with it, and how far
/// apart the two were at the last exchange.
export const SyncLine = ({ computer, running }) => {
    const state = computerState(computer, running);
    const gap = gapOf(computer);
    let said;
    if (state.kind === 'stuck')
        said = t(
            'syncpage.stuck',
            'stalled - the last {n} syncs left the two of them no closer. Sync now tries again; a sync report says why.',
            { n: count(state.tries) },
        );
    else if (state.kind === 'pulling')
        said = t('syncpage.pulling', 'syncing now - {n} brought in so far', {
            n: count(state.moved),
        });
    else if (state.kind === 'serving')
        said = t('syncpage.serving', 'syncing now - sending it your things');
    else if (state.kind === 'failing')
        said = state.reached
            ? t(
                  'syncpage.failing-since',
                  "can't be reached right now ({error}) - last reached {when}",
                  {
                      error: state.error,
                      when: ago(state.reached),
                  },
              )
            : t('syncpage.failing', "can't be reached ({error}) - is it on, and online?", {
                  error: state.error,
              });
    else if (state.kind === 'reached')
        said = t('syncpage.reached', 'reached {when}', { when: ago(state.reached) });
    else said = t('syncpage.never', 'not reached since this server started');
    return html`<span class="computer-sync">
        <span class=${['failing', 'stuck'].includes(state.kind) ? 'sync-computer-state sync-failing' : 'sync-computer-state'}>${said}</span>
        ${
            gap &&
            html`<span class="sync-computer-gap">${
                gap.theirs > 0
                    ? t('syncpage.theirs-ahead', 'it had {n} entries this computer didn’t', {
                          n: count(gap.theirs),
                      })
                    : t('syncpage.ours-ahead', 'this computer had {n} entries it didn’t', {
                          n: count(gap.ours),
                      })
            }</span>`
        }
    </span>`;
};

/// The persona's sync status from the node's ledger, asked again every few seconds while the page
/// is open: `{ status, error, look }`, `look` asking right now.
export const useSyncStatus = (root) => {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState(null);
    const look = useCallback(
        () =>
            api(`/api/identity/${root}/sync/status`)
                .then((s) => {
                    setStatus(s);
                    setError(null);
                })
                .catch((e) => setError(e.message)),
        [root],
    );
    useEffect(() => {
        look();
        const timer = setInterval(look, LOOK_MS);
        return () => clearInterval(timer);
    }, [look]);
    return { status, error, look };
};

/**
 * Beneath the computers on the All computers tab: the bodies still to come, Sync now, the way to
 * the sync report, and - for the curious - what this server is doing for everyone (rulings 2 and
 * 5: how many, never who).
 * @param root  the persona
 * @param status  its sync status ({@link useSyncStatus})
 * @param look  ask for the status again
 */
export const SyncActs = ({ root, status, look }) => {
    const [asked, setAsked] = useState(false);
    const [error, setError] = useState(null);

    // Sync now (piece 4): every computer that can be reached, in the background - the node answers
    // within seconds either way, and the lines above fill in as it works.
    const syncNow = async () => {
        setAsked(true);
        try {
            await api(`/api/identity/${root}/sync`, { method: 'POST' });
        } catch (e) {
            setError(e.message);
        }
        setAsked(false);
        look();
    };

    const others = (status.computers || []).length > 0;
    const network = status.network || {};
    return html`<section class="sync-section">
        ${!others && html`<p class="null-sub">${t('syncpage.only-this-one', 'This is the only computer this persona is on.')}</p>`}
        ${
            status.bodies_waiting > 0 &&
            html`<p class="null-sub">${t(
                'syncpage.bodies-waiting',
                '{n} files and notes still on their way here',
                {
                    n: count(status.bodies_waiting),
                },
            )}</p>`
        }
        ${
            others &&
            html`<div class="sync-acts">
                <button class="welcome-go sync-now" type="button" disabled=${asked} onClick=${syncNow}>
                    <${Icons.syncNow} /> ${asked ? '…' : t('syncpage.sync-now', 'sync now')}
                </button>
                <a class="sync-act" href=${computersHref('all/report')}>
                    <${Icons.syncReport} /> ${t('syncpage.sync-report', 'sync report')}
                </a>
            </div>`
        }
        <h3 class="computers-subtitle"><${Icons.syncSun} /> ${t('syncpage.network-title', 'this server and the network')}</h3>
        <p class="null-sub">${
            network.exchanges > 0
                ? t(
                      'syncpage.network-busy',
                      'Syncing the network for {people} people right now: {pulling} bringing in, {serving} sending out.',
                      {
                          people: count(network.people),
                          pulling: count(network.pulling),
                          serving: count(network.serving),
                      },
                  )
                : t('syncpage.network-quiet', 'Not syncing the network for anyone right now.')
        }</p>
        ${error && html`<p class="form-error">${error}</p>`}
    </section>`;
};

/// The sync report (piece 7), on a page of its own: plain text for a bug report - counts, heads and
/// keys, nothing anyone wrote - laid out to be read or copied whole.
export const SyncReport = ({ root }) => {
    const [text, setText] = useState(null);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        apiTextTitled(`/api/identity/${root}/sync/report`)
            .then((r) => setText(r.text))
            .catch((e) => setError(e.message));
    }, [root]);
    const copy = async () => {
        try {
            await writeClipboard(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 3000);
        } catch (e) {
            setError(e.message);
        }
    };
    return html`<section class="sync-section">
        <p class="null-sub">${t(
            'syncpage.report-about',
            'for a bug report: how this computer and the others have been syncing, in numbers - nothing you wrote.',
        )}</p>
        ${!text && !error && html`<p class="null-sub">${t('syncpage.counting', 'counting…')}</p>`}
        ${
            text &&
            html`<div class="sync-acts">
                    <button class="sync-act" type="button" onClick=${copy}>
                        <${Icons.copy} /> ${copied ? t('syncpage.report-copied', 'copied - paste it into your bug report') : t('syncpage.copy', 'copy')}
                    </button>
                </div>
                <pre class="sync-report">${text}</pre>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    </section>`;
};

/// The This computer tab (plans/SYNC_STATUS.md, piece 5): what this computer holds of the persona,
/// in counts a person can read off two devices and compare - and the sync code, which says whether
/// the chains themselves agree. The same code on two computers: they hold the same things.
export const ThisComputer = ({ root }) => {
    const [held, setHeld] = useState(null);
    const [error, setError] = useState(null);
    const [checked, setChecked] = useState(null);
    // Check and mend this computer's records of what it holds (piece 7): what a restart does when
    // it opens the persona, without the restart.
    const check = async () => {
        setChecked('…');
        try {
            const { differed } = await api(`/api/identity/${root}/sync/repair`, { method: 'POST' });
            setChecked(
                differed > 0
                    ? t(
                          'syncpage.repaired',
                          '{n} of its records were out of step with what it holds, and are mended.',
                          {
                              n: count(differed),
                          },
                      )
                    : t('syncpage.records-agree', 'Its records agree with what it holds.'),
            );
        } catch (e) {
            setChecked(null);
            setError(e.message);
        }
    };
    useEffect(() => {
        let live = true;
        api(`/api/identity/${root}/sync/held`)
            .then((h) => live && setHeld(h))
            .catch((e) => live && setError(e.message));
        return () => {
            live = false;
        };
    }, [root]);
    if (error) return html`<p class="form-error">${error}</p>`;
    if (!held) return html`<p class="null-sub">${t('syncpage.counting', 'counting…')}</p>`;
    const row = (label, value) =>
        html`<li class="held-row"><span>${label}</span><span class="held-count">${value}</span></li>`;
    const d = held.documents || {};
    const p = held.posts || {};
    const c = held.chat || {};
    const people = held.people || {};
    const bank = held.bank || {};
    return html`<section class="held">
        <p class="held-code-label">${t('syncpage.sync-code', 'sync code')}</p>
        <p class="held-code">${held.sync_code}</p>
        <p class="null-sub">${t(
            'syncpage.sync-code-about',
            'Your other computers show the same code when they hold the same things. Counts can differ for a while - something still on its way - but the code is what has to match.',
        )}</p>
        <ul class="held-list">
            ${row(t('syncpage.notes', 'notes'), count(d.notes))}
            ${row(t('syncpage.drawings', 'drawings'), count(d.drawings))}
            ${row(t('syncpage.files', 'files'), count(d.files))}
            ${row(t('syncpage.books', 'books'), count(d.books))}
            ${row(t('syncpage.still-coming', 'still on their way here'), count(held.bodies_waiting))}
            ${row(t('syncpage.posts', 'posts published'), count(p.published))}
            ${row(t('syncpage.replies', 'replies'), count(p.replies))}
            ${row(t('syncpage.shares', 'shares'), count(p.shares))}
            ${row(t('syncpage.rooms', 'chat rooms started'), count(c.rooms))}
            ${row(t('syncpage.lines', 'things said in chats'), count(c.lines))}
            ${row(t('syncpage.following', 'people followed'), count(people.following))}
            ${row(t('syncpage.trusting', 'people trusted'), count(people.trusting))}
            ${row(t('syncpage.followers', 'followers this server knows of'), count(people.followers))}
            ${row(t('syncpage.unlocks', 'unlocks owned'), count(bank.unlocks))}
            ${row(t('syncpage.ledger', 'ledger lines'), count(bank.lines))}
            ${row(t('syncpage.chains', 'chains'), count(held.chains))}
            ${row(t('syncpage.entries', 'entries'), count(held.entries))}
            ${row(t('syncpage.disk', 'space on this computer'), sizeLabel(held.disk_bytes || 0))}
        </ul>
        <p class="null-sub">
            <button class="sync-quiet-act" type="button" disabled=${checked === '…'} onClick=${check}>
                ${t('syncpage.check-records', 'check this computer’s records')}
            </button>
            ${' '}${checked && checked !== '…' ? checked : ''}
        </p>
    </section>`;
};
