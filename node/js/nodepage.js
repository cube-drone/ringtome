// A node's page (plans/NODE_PAGE.md; Curtis, 2026-11-05): any server, by its endpoint id, so a
// person can look at one before they report it and a moderator before they list it. What the
// server said when this one last asked it to introduce itself - its name, software and size, its
// web address (checked: it answers there as the same server, or the page says it only says so),
// and the people it lists - beside what this server has seen of it: how reliably it answers, who
// it has been seen serving, and the viewer's own links to it. Asking again is a button, never a
// timer.
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { formatWhen } from './pure/when.js';
import { personHref } from './links.js';
import { PersonInline } from './person.js';
import { MachineRow, aboutLine } from './serversettings.js';
import { NodeReportModal } from './report.js';
import { NodeMark } from './nodemark.js';
import {
    ReasonInput,
    levelWord,
    listTarget,
    unlistTarget,
    unlistWord,
    useModeration,
} from './moderation.js';
import { MAX_REASON_BYTES, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

/// Why the last ask got no introduction, in words.
const WHY_WORDS = () => ({
    blocked: t('nodepage.why-blocked', "This server has blocked it, so it doesn't ask."),
    unreachable: t(
        'nodepage.why-unreachable',
        "Couldn't reach it: no address known for it, or it isn't answering.",
    ),
    'no-answer': t(
        'nodepage.why-no-answer',
        "It answered, but didn't introduce itself - an older version, perhaps.",
    ),
});

/// One person the server hosts: whether it says so, and whether this server has seen it.
const HOST_WORDS = () => ({
    both: t('nodepage.host-confirmed', 'it says so, and this server has seen it'),
    says: t('nodepage.host-says', 'it says so'),
    seen: t('nodepage.host-seen', 'seen serving them'),
});

const hostKind = (h) => (h.says && h.seen ? 'both' : h.says ? 'says' : 'seen');

const HOST_CLASS = {
    both: 'node-page-host node-page-host-confirmed',
    says: 'node-page-host',
    seen: 'node-page-host',
};

/// The viewer's own word on this server, and their moderators'.
const Lists = ({ root, endpoint, current }) => {
    const view = useModeration(root);
    const mine = (view.mine || []).find((r) => r.kind === 'node' && r.target === endpoint);
    const taken = (view.taken || []).find((r) => r.kind === 'node' && r.target === endpoint);
    const mineLevel = (mine && mine.level) || 'block';
    const mineReason = (mine && mine.reason) || '';
    const [level, setLevel] = useState(mineLevel);
    const [reason, setReason] = useState(mineReason);
    const [error, setError] = useState('');
    useEffect(() => {
        setLevel(mineLevel);
        setReason(mineReason);
    }, [mineLevel, mineReason]);
    const run = async (fn) => {
        setError('');
        try {
            await fn();
        } catch (e) {
            setError(e.message || String(e));
        }
    };
    return html`<section class="node-page-section">
        <h3 class="computers-subtitle">${t('nodepage.lists', 'lists')}</h3>
        ${
            taken && taken.sources.length > 0
                ? html`<ul class="moderation-sources">
                      ${taken.sources.map(
                          (s) => html`<li key=${s.author}>
                              <a class="moderation-who" href=${personHref(s.author)}><${PersonInline} root=${s.author} current=${current} /></a>
                              <span class="moderation-said">${levelWord(s.level)}${s.reason ? html`: ${s.reason}` : ''}</span>
                          </li>`,
                      )}
                  </ul>`
                : html`<p class="null-sub">${t('nodepage.nobody-lists-it', 'Neither you nor your moderators list this server.')}</p>`
        }
        <div class="moderation-add">
            <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
                <option value="warn">${levelWord('warn')}</option>
                <option value="block">${levelWord('block')}</option>
            </select>
            <${ReasonInput} value=${reason} onInput=${setReason} />
        </div>
        <div class="report-buttons">
            ${
                mine &&
                html`<button class="removal-option" onClick=${() => run(() => unlistTarget(root, 'node', endpoint))}>
                    ${unlistWord(mine.level)}
                </button>`
            }
            <button
                class="removal-go"
                disabled=${reasonBytes(reason) > MAX_REASON_BYTES || (mine && mine.level === level && mine.reason === reason.trim())}
                onClick=${() => run(() => listTarget(root, 'node', endpoint, level, reason.trim()))}
            >${mine ? t('moderation.save', 'save') : t('moderation.add-to-public-list', 'add to my public list')}</button>
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
    </section>`;
};

export const NodePage = ({ endpoint, current }) => {
    const root = current && current.root;
    const [page, setPage] = useState(null);
    const [error, setError] = useState('');
    const [asking, setAsking] = useState(false);
    const [reporting, setReporting] = useState(false);
    const load = useCallback(() => {
        if (!root || !endpoint) return;
        api(`/api/identity/${root}/nodes/${endpoint}`)
            .then((p) => {
                setPage(p);
                setError('');
            })
            .catch((e) => setError(e.message));
    }, [root, endpoint]);
    useEffect(load, [load]);
    const ask = async () => {
        setAsking(true);
        setError('');
        try {
            setPage(
                await api(`/api/identity/${root}/nodes/${endpoint}/introduce`, { method: 'POST' }),
            );
        } catch (e) {
            setError(e.message);
        } finally {
            setAsking(false);
        }
    };
    if (!page) {
        return html`<div class="computers">
            ${error ? html`<p class="form-error">${error}</p>` : html`<p class="null-sub">${t('nodepage.looking', 'looking…')}</p>`}
        </div>`;
    }
    const intro = page.intro;
    const said = intro && intro.answered_ms ? intro : null;
    const name =
        (said && said.name) ||
        (page.machine && page.machine.name) ||
        page.words ||
        page.endpoint.slice(0, 12);
    const now = Date.now();
    const facts = said && aboutLine(said);
    return html`<div class="computers node-page">
        <div class="node-page-head">
            <${NodeMark} endpoint=${page.endpoint} size="hero" />
            <div class="node-page-head-names">
                <h2 class="computers-title">${name}</h2>
                <p class="node-page-id">
                    ${page.words && html`<span class="machine-words">${page.words}</span>`}
                    <code title=${page.endpoint}>${page.endpoint}</code>
                </p>
            </div>
        </div>
        ${page.ours && html`<p class="null-sub">${t('nodepage.this-is-us', 'This is the server you are on. This is how it introduces itself to others.')}</p>`}
        ${page.blocked_here && html`<p class="form-error">${t('nodepage.blocked-here', "This server's administrators have blocked it: they don't connect to each other.")}</p>`}
        ${facts && html`<p class="machine-facts">${facts}</p>`}
        ${
            said &&
            said.address &&
            (said.address_checked
                ? html`<p class="node-page-address">
                      <a href=${said.address} target="_blank" rel="noopener noreferrer">${said.address}</a>
                  </p>`
                : html`<p class="null-sub">${t('nodepage.says-its-at', "It says it's at {address}, but that address doesn't answer as this server.", { address: said.address })}</p>`)
        }
        ${said && said.description && html`<p class="node-page-description">${said.description}</p>`}
        ${
            said &&
            said.rules &&
            html`<p><a href=${said.rules} target="_blank" rel="noopener noreferrer">${t('nodepage.its-rules', 'its rules')}</a></p>`
        }
        ${
            !page.ours &&
            html`<div class="node-page-ask">
                <span class="null-sub">
                    ${
                        intro
                            ? said
                                ? t('nodepage.introduced-itself', 'Introduced itself {when}.', {
                                      when: formatWhen(said.answered_ms, now),
                                  })
                                : t('nodepage.never-introduced', 'It has never introduced itself.')
                            : t(
                                  'nodepage.never-asked',
                                  "This server hasn't asked it to introduce itself yet.",
                              )
                    }
                    ${intro && intro.error && html` ${WHY_WORDS()[intro.error] || intro.error}`}
                </span>
                <div class="report-buttons">
                    <button class="removal-option" disabled=${asking} onClick=${ask}>
                        ${asking ? t('nodepage.asking', 'asking…') : t('nodepage.ask-again', 'ask it to introduce itself')}
                    </button>
                </div>
            </div>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
        ${
            page.machine &&
            html`<section class="node-page-section">
                <h3 class="computers-subtitle">${t('nodepage.as-this-server-knows-it', 'as this server knows it')}</h3>
                <ul class="machine-list"><${MachineRow} m=${page.machine} now=${now} linked=${false} /></ul>
            </section>`
        }
        <section class="node-page-section">
            <h3 class="computers-subtitle">${t('nodepage.who-it-hosts', 'who it hosts')}</h3>
            ${
                page.hosts.length === 0
                    ? html`<p class="null-sub">${t('nodepage.hosts-nobody-known', 'Nobody that it lists, or that this server has seen it serve.')}</p>`
                    : html`<ul class="node-page-hosts">
                          ${page.hosts.map((host) => {
                              const kind = hostKind(host);
                              return html`<li key=${host.root} class=${HOST_CLASS[kind]}>
                                  <a class="moderation-who" href=${personHref(host.root)}><${PersonInline} root=${host.root} current=${current} /></a>
                                  <span class="null-sub">${HOST_WORDS()[kind]}</span>
                              </li>`;
                          })}
                      </ul>`
            }
        </section>
        ${
            !page.ours &&
            html`<${Lists} root=${root} endpoint=${page.endpoint} current=${current} />
            <div class="report-buttons">
                <button class="removal-option" onClick=${() => setReporting(true)}>
                    ${t('nodepage.report-this-server', 'report this server to my moderators')}
                </button>
            </div>`
        }
        ${reporting && html`<${NodeReportModal} endpoint=${page.endpoint} name=${name} current=${current} onClose=${() => setReporting(false)} />`}
    </div>`;
};
