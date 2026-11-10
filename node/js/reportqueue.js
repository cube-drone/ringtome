// The moderator's side of reports (plans/MODERATION.md, _Reports_; node/src/reports.rs), on the
// content control page's reports tab: Accept Reports and how far it reaches, and the queue.
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
import { nodeHref, personHref } from './links.js';
import { NodeMark } from './nodemark.js';
import { HostedHereNote, useHostedAccount } from './hostedhere.js';
import { PersonInline } from './person.js';
import {
    levelWord,
    listTarget,
    moderationMoved,
    ReasonInput,
    useModeration,
} from './moderation.js';
import { Icons } from './icons.js';
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

/// The four things a report can be about, as its card's header says (Curtis, 2026-11-05).
const KINDS = () => ({
    image: [Icons.mediaImage, t('reports.kind-image', 'Image')],
    node: [Icons.server, t('reports.kind-node', 'Node')],
    post: [Icons.kindPost, t('reports.kind-post', 'Post')],
    user: [Icons.persona, t('reports.kind-user', 'User')],
});

/// The strip across a report's top: what it is about, and on the right, when it arrived. A
/// blocklist entry wears the same strip (moderationpage.js).
export const KindHead = ({ kind, when }) => {
    const [Icon, word] = KINDS()[kind] || KINDS().post;
    return html`<p class="report-kind">
        <${Icon} /> ${word}
        <span class="report-kind-when">${formatWhen(when)}</span>
    </p>`;
};

/// A server, by its id: opening its page (plans/NODE_PAGE.md), where it can be looked at.
const NodeName = ({ id }) =>
    html`<a class="report-node" href=${nodeHref(id)} title=${id}><${NodeMark} endpoint=${id} /><code>${id.slice(0, 12)}…</code></a>`;

/// Whom reports are taken from, as one choice (Curtis, 2026-11-05: "everyone" is the select's third
/// option, not a checkbox beside it). Everyone takes the people the trusted trust as well; a
/// stranger's report still waits in the server's pool, oldest dropped first.
const FROM_WHOM = {
    1: { reach: 1, strangers: false },
    2: { reach: 2, strangers: false },
    everyone: { reach: 2, strangers: true },
};

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
        ${locked && html`<p class="null-sub">${t('reports.not-allowed-here', "This server's operator doesn't let people take reports here.")}</p>`}
        ${
            settings.takes &&
            html`<label class="device-field">
                <span>${t('reports.from-whom', 'from')}</span>
                <select
                    class="profile-input"
                    value=${settings.strangers ? 'everyone' : String(settings.reach)}
                    onChange=${(e) => save(FROM_WHOM[e.currentTarget.value])}
                >
                    <option value="1">${t('reports.the-people-i-trust', 'the people I trust')}</option>
                    <option value="2">${t('reports.and-the-people-they-trust', 'the people I trust, and the people they trust')}</option>
                    <option value="everyone">${t('reports.from-everyone', 'everyone')}</option>
                </select>
            </label>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

/// A picture that came with a report, and "block this picture" - an entry on the moderator's own
/// list for the file itself, with the report's reason, wherever else it is posted.
const Picture = ({ root, hash, src, covered, reason }) => {
    const [shown, setShown] = useState(!covered);
    const [listed, setListed] = useState(false);
    const [error, setError] = useState('');
    const list = async () => {
        setError('');
        try {
            await listTarget(root, 'picture', hash, 'block', reason);
            setListed(true);
        } catch (e) {
            setError(e.message);
        }
    };
    return html`<div class="report-picture-row">
        ${
            shown
                ? html`<img class="report-picture" src=${src} alt="" />`
                : html`<button class="removal-option report-covered" onClick=${() => setShown(true)}>
                      ${t('reports.a-strangers-picture-show', "a stranger's picture - show it")}
                  </button>`
        }
        <button class="removal-option" disabled=${listed} onClick=${list}>
            ${listed ? t('reports.picture-blocked', 'on your public list') : t('reports.block-this-picture', 'block this picture')}
        </button>
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};

const ReportRow = ({ root, current, report, administers, onMoved }) => {
    const proposal = report.proposal;
    const [level, setLevel] = useState((proposal && proposal.level) || 'block');
    const [reason, setReason] = useState((proposal && proposal.reason) || report.reason);
    const [error, setError] = useState('');
    const [sealed, setSealed] = useState(false);
    // Reported, and hosted here: a block won't stop this server hosting them (account.js).
    const hosted = useHostedAccount(report.target, !!administers && report.target_kind !== 'node');
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
        <${KindHead} kind=${report.kind} when=${report.received_ms} />
        <p class="report-from">
            <${Who} root=${report.reporter} current=${current} />
            <span class="report-standing">${STANDING_WORDS()[report.standing] || report.standing}</span>
        </p>
        <p class="report-asks">
            ${t('reports.reported', 'reported')}
            ${report.target_kind === 'node' ? html`<${NodeName} id=${report.target} />` : html`<${Who} root=${report.target} current=${current} />`}
        </p>
        ${report.reason && html`<blockquote class="report-reason">${report.reason}</blockquote>`}
        ${
            report.child_abuse &&
            html`<div class="report-child">
                <p><strong>${t('reports.reported-as-child-abuse', 'Reported as a child being sexually abused or exploited.')}</strong></p>
                <p>${t('reports.child-only-the-reference', "Only the post's location was sent, not the picture. Report it where you live, with its address:")}</p>
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
                    ${report.item_sealed ? t('reports.a-sealed-post', 'a post for the people they trust') : report.item_title}
                    <span class="null-sub">
                        ${t('reports.signed-by-them', 'signed by them {when}', { when: formatWhen(report.item_signed_ms) })}
                    </span>
                </p>
                ${report.words && html`<pre class="report-words">${report.words}</pre>`}
                ${(report.pictures || []).map(
                    (hash) =>
                        html`<${Picture}
                            key=${hash}
                            root=${root}
                            hash=${hash}
                            src=${`${base}/picture/${hash}`}
                            covered=${report.standing === 'stranger'}
                            reason=${report.reason}
                        />`,
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
        </div>
        <div class="report-buttons">
            <button class="removal-option" onClick=${() => act('dismiss')}>${t('reports.dismiss', 'dismiss')}</button>
            <button
                class="removal-go"
                disabled=${reasonBytes(reason) > MAX_REASON_BYTES}
                onClick=${() => act('list', { level, reason: reason.trim() })}
            >${t('moderation.add-to-public-list', 'add to my public list')}</button>
        </div>
        ${level === 'block' && html`<${HostedHereNote} account=${hosted} />`}
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
        <span class="report-buttons">
            <button class="removal-option" onClick=${() => drop(false)}>${t('reports.drop-these', 'drop these')}</button>
            <button class="removal-go" onClick=${() => drop(true)}>${t('reports.block-that-node-and-drop-these', 'block that node and drop these')}</button>
        </span>
        ${error && html`<p class="form-error">${error}</p>`}
    </li>`;
};

/// How many reports from one node make it worth a line of its own. The lines come biggest first
/// (reports.rs `groups`), folded shut so a crowd of servers can't push the reports themselves
/// off the screen.
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
        <${Settings} root=${root} settings=${settings} onSaved=${setSettings} />
        ${
            floods.length > 0 &&
            html`<details class="report-floods-box">
                <summary class="report-floods-head">
                    ${t('reports.floods-summary', 'Servers sending lots of reports ({m})', { m: floods.length })}
                </summary>
                <ul class="report-floods">${floods.map((g) => html`<${Flood} key=${g.node} root=${root} group=${g} onMoved=${load} />`)}</ul>
            </details>`
        }
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
