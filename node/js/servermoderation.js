// The server settings' Moderation page (plans/SCANNING.md, plans/MODERATION.md): what the people who look
// after this place do when something on it is something no one should hold.
//
// - Reports (node/src/reports.rs): Allow Users to Accept Reports, the strangers' pool and how long
//   reports are kept - with the advice that opens the door: put upload scanning in front first.
// - Quarantine (node/src/quarantine.rs): seal a picture by its address, or a file by its hash. The
//   bytes stay - keeping them can be the operator's legal duty - and nothing here reads, fetches or
//   serves them again until released. Beside it, what to do now: report it, keep it, don't look.
import { h } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { formatWhen } from './pure/when.js';
import { t } from './i18n.js';
import { askYes } from './modal.js';
import { personHref } from './links.js';
import { PersonInline } from './person.js';

const html = htm.bind(h);

/// Where a person reports a child being sexually abused or exploited, by country. Not exhaustive:
/// INHOPE lists a hotline for most others.
export const HOTLINES = () => [
    [t('quarantine.in-canada', 'In Canada'), 'Cybertip.ca', 'https://www.cybertip.ca'],
    [
        t('quarantine.in-the-us', 'In the United States'),
        "NCMEC's CyberTipline",
        'https://report.cybertip.org',
    ],
    [t('quarantine.elsewhere', 'Elsewhere'), 'INHOPE', 'https://www.inhope.org'],
];

export const Hotlines = () =>
    html`<ul class="quarantine-hotlines">
        ${HOTLINES().map(
            ([where, name, href]) =>
                html`<li key=${href}>
                    ${where}: <a href=${href} target="_blank" rel="noopener noreferrer">${name}</a>
                </li>`,
        )}
    </ul>`;

/// What to do the moment you find out - in the order it matters.
const WhatToDoNow = () => html`<div class="quarantine-now">
    <h3>${t('quarantine.what-to-do-now', 'What to do now')}</h3>
    <ol>
        <li>
            ${t('quarantine.dont-look', "Don't look at it again, and don't screenshot, save, download or forward it - not even to report it. Quarantining it here is enough to stop this server showing it to anyone.")}
        </li>
        <li>
            ${t('quarantine.report-it', 'If it shows a child being sexually abused or exploited, report it. Where you live, the law may say you must - in Canada, anyone providing an internet service to the public has to. Give them the address of the post, not the picture.')}
            <${Hotlines} />
        </li>
        <li>
            ${t('quarantine.keep-it', "Keep it quarantined. This server keeps the file, sealed, because you may have to preserve it for the authorities; release it only when they say, or when the time the law sets is up. The list below is this server's record of what it held, when, and who acted.")}
        </li>
        <li>
            ${t('quarantine.purge-the-cdn', "If a CDN sits in front of this server, purge the picture's address from its cache too - a copy there would outlive the one here.")}
        </li>
    </ol>
    <p class="null-sub">${t('quarantine.not-legal-advice', 'This is not legal advice.')}</p>
</div>`;

/// One quarantined file. A seal a child-abuse report made names its reporter (Curtis, 2026-11-03),
/// and offers to undo everything their reports sealed at once.
const QuarantineRow = ({ row, onRelease, onReleaseReporter }) => {
    const sealed = !row.released_ms;
    return html`<li class=${sealed ? 'quarantine-row' : 'quarantine-row quarantine-released'}>
        <code class="quarantine-hash">${row.hash}</code>
        <span class="null-sub">
            ${
                sealed
                    ? t('quarantine.sealed-since', 'sealed {when}', {
                          when: formatWhen(row.quarantined_ms),
                      })
                    : t('quarantine.released-at', 'released {when}', {
                          when: formatWhen(row.released_ms),
                      })
            }
            ${row.held ? '' : html` - ${t('quarantine.never-arrived', 'not on this disk')}`}
        </span>
        ${row.why && html`<span class="quarantine-why">${row.why}</span>`}
        ${
            row.reporter &&
            html`<span class="quarantine-reporter">
                ${t('quarantine.reported-by', 'reported by')}
                <a class="moderation-who" href=${personHref(row.reporter)}><${PersonInline} root=${row.reporter} /></a>
            </span>`
        }
        ${
            sealed &&
            html`<span class="quarantine-actions">
                <button class="removal-option" onClick=${() => onRelease(row.hash)}>
                    ${t('quarantine.release', 'release')}
                </button>
                ${
                    row.reporter &&
                    html`<button class="removal-option" onClick=${() => onReleaseReporter(row.reporter)}>
                        ${t('quarantine.release-all-they-reported', 'release everything they reported')}
                    </button>`
                }
            </span>`
        }
    </li>`;
};

const Quarantine = () => {
    const [rows, setRows] = useState(null);
    const [address, setAddress] = useState('');
    const [why, setWhy] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const load = useCallback(() => {
        api('/api/admin/quarantine')
            .then((r) => setRows(r.rows))
            .catch((e) => setError(e.message));
    }, []);
    useEffect(load, [load]);
    const seal = async () => {
        setError('');
        setBusy(true);
        const said = address.trim();
        const body = /^[0-9a-f]{64}$/i.test(said) ? { hash: said, why } : { address: said, why };
        try {
            setRows(
                (await api('/api/admin/quarantine', { method: 'POST', body: JSON.stringify(body) }))
                    .rows,
            );
            setAddress('');
            setWhy('');
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    };
    const release = async (hash) => {
        setError('');
        try {
            setRows((await api(`/api/admin/quarantine/${hash}/release`, { method: 'POST' })).rows);
        } catch (e) {
            setError(e.message);
        }
    };
    const releaseReporter = async (root) => {
        const count = (rows || []).filter((r) => r.reporter === root && !r.released_ms).length;
        if (
            !(await askYes({
                title: t('quarantine.release-all-title', 'release everything they reported'),
                body: t(
                    'quarantine.release-all-body',
                    "Every file still sealed by this person's reports - {n} of them - is served here again. Each row stays on the list, released, as the record.",
                    { n: count },
                ),
                yes: t('quarantine.release-all-yes', 'release them'),
                danger: true,
            }))
        )
            return;
        setError('');
        try {
            setRows(
                (await api(`/api/admin/quarantine/reported-by/${root}/release`, { method: 'POST' }))
                    .rows,
            );
        } catch (e) {
            setError(e.message);
        }
    };
    return html`<section class="quarantine">
        <h3>${t('quarantine.quarantine', 'Quarantine')}</h3>
        <p class="null-sub">
            ${t('quarantine.what-it-does', 'Seal a picture this server holds: nobody here - on the web, in the app, or another server asking - gets it again, and the file is kept, untouched, until you release it.')}
        </p>
        <label class="device-field">
            <span>${t('quarantine.the-pictures-address', "the picture's address, or its post's - or a file's hash")}</span>
            <input value=${address} onInput=${(e) => setAddress(e.currentTarget.value)} />
        </label>
        <label class="device-field">
            <span>${t('quarantine.a-note-for-the-record', 'a note for the record')}</span>
            <input value=${why} onInput=${(e) => setWhy(e.currentTarget.value)} />
        </label>
        ${error && html`<p class="form-error">${error}</p>`}
        <button class="removal-go" disabled=${busy || !address.trim()} onClick=${seal}>
            ${t('quarantine.quarantine-it', 'quarantine it')}
        </button>
        <${WhatToDoNow} />
        ${
            rows &&
            (rows.length
                ? html`<ul class="quarantine-list">
                      ${rows.map((row) => html`<${QuarantineRow} key=${row.hash} row=${row} onRelease=${release} onReleaseReporter=${releaseReporter} />`)}
                  </ul>`
                : html`<p class="null-sub">${t('quarantine.nothing-quarantined', 'Nothing is quarantined here.')}</p>`)
        }
    </section>`;
};

/// The operator's half of reports: whether people here may take them, and the bounds.
const ReportPolicy = () => {
    const [policy, setPolicy] = useState(null);
    const [error, setError] = useState('');
    useEffect(() => {
        api('/api/admin/report-policy')
            .then(setPolicy)
            .catch((e) => setError(e.message));
    }, []);
    const save = async (patch) => {
        setError('');
        try {
            setPolicy(
                await api('/api/admin/report-policy', {
                    method: 'PUT',
                    body: JSON.stringify({ ...policy, ...patch }),
                }),
            );
        } catch (e) {
            setError(e.message);
        }
    };
    if (!policy) return error ? html`<p class="form-error">${error}</p>` : null;
    const number = (key) => (e) => {
        const n = Number(e.currentTarget.value);
        if (Number.isFinite(n) && n >= 0) save({ [key]: Math.round(n) });
    };
    return html`<section class="quarantine">
        <h3>${t('reports.reports', 'Reports')}</h3>
        <label class="profile-setting">
            <input type="checkbox" checked=${policy.users_may} onChange=${(e) => save({ users_may: e.currentTarget.checked })} />
            ${t('reports.allow-users-to-accept-reports', 'Allow Users to Accept Reports')}
        </label>
        <p class="null-sub">
            ${t('reports.allow-why', "On, people here may turn on Accept Reports and take reports from the people who trust them to moderate. A report's pictures arrive over this server's public address, so put an upload-scanning layer in front of it first - Bunny's Upload Scanning, Cloudflare's CSAM scanning, or another - if you let anyone report to anyone here. Strongly advised; SERVER.md says how.")}
        </p>
        ${
            !policy.public &&
            html`<p class="null-sub">${t('reports.no-public-address', 'This server has no public address, so reports arrive without pictures - the moderator sees only the words.')}</p>`
        }
        <label class="device-field">
            <span>${t('reports.strangers-pool', "how many strangers' reports each person keeps")}</span>
            <input type="number" min="0" value=${policy.stranger_pool} onChange=${number('stranger_pool')} />
        </label>
        <label class="device-field">
            <span>${t('reports.keep-days', 'how many days a report is kept')}</span>
            <input type="number" min="1" value=${policy.keep_days} onChange=${number('keep_days')} />
        </label>
        ${error && html`<p class="form-error">${error}</p>`}
    </section>`;
};

export const ServerModeration = () => html`<div class="device">
    <h2 class="computers-title">${t('device.moderation', 'Moderation')}</h2>
    <${ReportPolicy} />
    <${Quarantine} />
</div>`;
