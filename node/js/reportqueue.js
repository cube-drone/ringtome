// The moderator's side of reports (plans/MODERATION.md, _Reports_; node/src/reports.rs), on the
// content control page under the lists: Accept Reports and how far it reaches, and the queue.
//
// The queue shows each report's evidence as its author signed it, with "add to my list" and
// "dismiss". It counts reports by the node they came from, so a flood is one line with one action.
// A stranger's picture stays covered until clicked; a proposal from an assistant waits for the
// moderator's own tap. Nothing goes back to the reporter, and no response time is promised.
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { formatWhen } from './pure/when.js';
import { personHref } from './links.js';
import { PersonInline } from './person.js';
import { levelWord, moderationMoved, ReasonInput, useModeration } from './moderation.js';
import { Hotlines } from './servermoderation.js';
import { MAX_REASON_BYTES, reasonBytes } from './pure/moderation.js';

const html = htm.bind(h);

const STANDING_WORDS = () => ({
    trusted: t('reports.someone-you-trust', 'someone you trust'),
    reach: t('reports.trusted-by-someone-you-trust', 'trusted by someone you trust'),
    stranger: t('reports.a-stranger', 'a stranger'),
});

const Who = ({ root, current }) =>
    html`<a class="moderation-who" href=${personHref(root)}><${PersonInline} root=${root} current=${current} /></a>`;

const NodeName = ({ id }) => html`<code class="report-node" title=${id}>${id.slice(0, 12)}…</code>`;

const Settings = ({ root, settings, onSaved }) => {
    const [error, setError] = useState('');
    const save = async (patch) => {
        setError('');
        try {
            onSaved(
                await api(`/api/identity/${root}/reports/settings`, {
                    method: 'PUT',
                    body: JSON.stringify({ ...settings, ...patch }),
                }),
            );
        } catch (e) {
            setError(e.message);
        }
    };
    const locked = !settings.allowed && !settings.takes;
    return html`<div class="report-settings">
        <label class="profile-setting">
            <input
                type="checkbox"
                checked=${settings.takes}
                disabled=${locked}
                onChange=${(e) => save({ takes: e.currentTarget.checked })}
            />
            ${t('reports.accept-reports', 'Accept Reports')}
        </label>
        ${
            locked
                ? html`<p class="null-sub">${t('reports.not-allowed-here', "This server's operator doesn't let people take reports here.")}</p>`
                : html`<p class="null-sub">${t('reports.what-taking-means', 'People who trust you to moderate for them can ask you to put someone on your list. Reports come to this server and stay here - never on your chains, never on your other computers.')}</p>`
        }
        ${
            settings.takes &&
            html`<label class="device-field">
                    <span>${t('reports.from-whom', 'from')}</span>
                    <select
                        class="profile-input"
                        value=${String(settings.reach)}
                        onChange=${(e) => save({ reach: Number(e.currentTarget.value) })}
                    >
                        <option value="1">${t('reports.the-people-i-trust', 'the people I trust')}</option>
                        <option value="2">${t('reports.and-the-people-they-trust', 'the people I trust, and the people they trust')}</option>
                    </select>
                </label>
                <label class="profile-setting">
                    <input
                        type="checkbox"
                        checked=${settings.strangers}
                        onChange=${(e) => save({ strangers: e.currentTarget.checked })}
                    />
                    ${t('reports.and-from-strangers', 'and from anyone - a stranger waits in a pool of {n}, oldest dropped first', { n: settings.stranger_pool })}
                </label>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

const Picture = ({ src, covered }) => {
    const [shown, setShown] = useState(!covered);
    return shown
        ? html`<img class="report-picture" src=${src} alt="" />`
        : html`<button class="removal-option report-covered" onClick=${() => setShown(true)}>
              ${t('reports.a-strangers-picture-show', "a stranger's picture - show it")}
          </button>`;
};

const ReportRow = ({ root, current, report, administers, onMoved }) => {
    const proposal = report.proposal;
    const [level, setLevel] = useState((proposal && proposal.level) || 'block');
    const [reason, setReason] = useState((proposal && proposal.reason) || report.reason);
    const [error, setError] = useState('');
    const [sealed, setSealed] = useState(false);
    const base = `/api/identity/${root}/reports/${report.id}`;
    const act = async (path, body) => {
        setError('');
        try {
            await api(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
            onMoved();
            if (path === 'list') moderationMoved(root);
        } catch (e) {
            setError(e.message);
        }
    };
    const quarantine = async () => {
        setError('');
        try {
            await api(`${base}/quarantine`, { method: 'POST' });
            setSealed(true);
        } catch (e) {
            setError(e.message);
        }
    };
    return html`<li class=${report.child_abuse ? 'report-row report-row-child' : 'report-row'}>
        <p class="report-from">
            <${Who} root=${report.reporter} current=${current} />
            <span class="report-standing">${STANDING_WORDS()[report.standing] || report.standing}</span>
            <span class="null-sub">${formatWhen(report.received_ms)}</span>
        </p>
        <p class="report-asks">
            ${t('reports.asks-you-to-list', 'asks you to list')}
            ${report.target_kind === 'node' ? html`<${NodeName} id=${report.target} />` : html`<${Who} root=${report.target} current=${current} />`}
        </p>
        ${report.reason && html`<blockquote class="report-reason">${report.reason}</blockquote>`}
        ${
            report.child_abuse &&
            html`<div class="report-child">
                <p><strong>${t('reports.reported-as-child-abuse', 'Reported as a child being sexually abused or exploited.')}</strong></p>
                <p>${t('reports.child-only-the-reference', 'Only where it is came with it, never the picture. Report it where you live, with its address:')}</p>
                <${Hotlines} />
                ${
                    administers &&
                    report.item_doc &&
                    html`<button class="removal-option" disabled=${sealed} onClick=${quarantine}>
                        ${sealed ? t('reports.quarantined', 'quarantined on this server') : t('reports.quarantine-its-files', 'quarantine its files on this server')}
                    </button>`
                }
            </div>`
        }
        ${
            report.item_doc &&
            html`<div class="report-item">
                <p class="report-item-head">
                    ${report.item_sealed ? t('reports.a-sealed-post', 'a post for the people they trust') : report.item_title || t('reports.untitled', 'untitled')}
                    <span class="null-sub">
                        ${t('reports.signed-by-them', 'signed by them {when}', { when: formatWhen(report.item_signed_ms) })}
                    </span>
                </p>
                ${report.words && html`<pre class="report-words">${report.words}</pre>`}
                ${(report.pictures || []).map(
                    (hash) =>
                        html`<${Picture} key=${hash} src=${`${base}/picture/${hash}`} covered=${report.standing === 'stranger'} />`,
                )}
            </div>`
        }
        ${
            proposal &&
            html`<p class="report-proposal">
                ${t('reports.your-assistant-proposes', 'Your assistant proposes: {level}', { level: levelWord(proposal.level) })}
                ${proposal.reason && html` - ${proposal.reason}`}
            </p>`
        }
        <div class="moderation-add">
            <select class="profile-input" value=${level} onChange=${(e) => setLevel(e.currentTarget.value)}>
                <option value="warn">${levelWord('warn')}</option>
                <option value="block">${levelWord('block')}</option>
            </select>
            <${ReasonInput} value=${reason} onInput=${setReason} />
            <button
                class="removal-option"
                disabled=${reasonBytes(reason) > MAX_REASON_BYTES}
                onClick=${() => act('list', { level, reason: reason.trim() })}
            >${t('moderation.add-to-public-list', 'add to my public list')}</button>
            <button class="removal-option" onClick=${() => act('dismiss')}>${t('reports.dismiss', 'dismiss')}</button>
        </div>
        ${error && html`<p class="form-error">${error}</p>`}
    </li>`;
};

/// "9,800 reports from 9,800 personas on node X, since Tuesday": a flood, with one action.
const Flood = ({ root, group, onMoved }) => {
    const [error, setError] = useState('');
    const drop = async (block) => {
        setError('');
        try {
            await api(`/api/identity/${root}/reports/from/${group.node}/drop`, {
                method: 'POST',
                body: JSON.stringify({
                    block,
                    reason: block ? t('reports.a-flood-of-reports', 'a flood of reports') : '',
                }),
            });
            onMoved();
            if (block) moderationMoved(root);
        } catch (e) {
            setError(e.message);
        }
    };
    return html`<li class="report-flood">
        ${t('reports.n-reports-from-m-personas', '{n} reports from {m} personas on node', { n: group.reports, m: group.reporters })}
        <${NodeName} id=${group.node} />
        <span class="null-sub">${t('reports.since', 'since {when}', { when: formatWhen(group.since_ms) })}</span>
        <button class="removal-option" onClick=${() => drop(true)}>${t('reports.block-that-node-and-drop-these', 'block that node and drop these')}</button>
        <button class="removal-option" onClick=${() => drop(false)}>${t('reports.drop-these', 'drop these')}</button>
        ${error && html`<p class="form-error">${error}</p>`}
    </li>`;
};

/// How many reports from one node make it worth a line of its own.
const FLOOD_AT = 3;

export const ReportSections = ({ current }) => {
    const root = current && current.root;
    const administers = useModeration(root).administers;
    const [settings, setSettings] = useState(null);
    const [queue, setQueue] = useState(null);
    const load = useCallback(() => {
        if (!root) return;
        api(`/api/identity/${root}/reports/settings`)
            .then(setSettings)
            .catch(() => setSettings(null));
        api(`/api/identity/${root}/reports`)
            .then(setQueue)
            .catch(() => setQueue(null));
    }, [root]);
    useEffect(load, [load]);
    if (!root || !settings) return null;
    const reports = (queue && queue.reports) || [];
    const floods = ((queue && queue.groups) || []).filter((g) => g.reports >= FLOOD_AT);
    return html`<section class="moderation-section">
        <h2 class="settings-section-title">${t('reports.reports', 'Reports')}</h2>
        <${Settings} root=${root} settings=${settings} onSaved=${setSettings} />
        ${floods.length > 0 && html`<ul class="report-floods">${floods.map((g) => html`<${Flood} key=${g.node} root=${root} group=${g} onMoved=${load} />`)}</ul>`}
        ${
            reports.length
                ? html`<ul class="report-queue">
                      ${reports.map(
                          (r) =>
                              html`<${ReportRow} key=${r.id} root=${root} current=${current} report=${r} administers=${administers} onMoved=${load} />`,
                      )}
                  </ul>`
                : settings.takes &&
                  html`<p class="null-sub">${t('reports.nothing-to-look-at', 'nothing to look at')}</p>`
        }
    </section>`;
};
