// Import/export (plans/EXPORT.md): the persona, whole, as one zip - every note in each rendering a
// reader might open, its pictures, its posts opened, its profile, contacts, chats and bank. Made in
// the background on the node (export.rs), one at a time; a new one replaces the last. This page
// starts one, follows it while it's made, and hands it over: a browser downloads it, the desktop
// app shows it in the file manager (a webview downloads nothing - backup.rs's rule). Import is a
// later piece.
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';
import { sizeLabel } from './pure/backups.js';
import { formatWhen } from './pure/when.js';

const html = htm.bind(h);

/// How often the page asks again while an export is queued or being made.
const LOOK_MS = 1500;

export const ExportPage = ({ current }) => {
    const [report, setReport] = useState(null);
    const [error, setError] = useState(null);
    const root = current && current.root;

    const look = useCallback(
        () =>
            api(`/api/identity/${root}/export`)
                .then((r) => {
                    setReport(r);
                    setError(null);
                })
                .catch((e) => setError(e.message)),
        [root],
    );
    useEffect(() => {
        if (root) look();
    }, [root, look]);
    const status = report && report.status;
    const queued = status === 'queued';
    const running = status === 'running';
    const failed = status === 'failed';
    const working = queued || running;
    useEffect(() => {
        if (!working) return undefined;
        const timer = setInterval(look, LOOK_MS);
        return () => clearInterval(timer);
    }, [working, look]);

    if (!current) return null;

    const start = async () => {
        setError(null);
        try {
            setReport(await api(`/api/identity/${root}/export`, { method: 'POST' }));
        } catch (e) {
            setError(e.message);
        }
    };
    const reveal = async () => {
        try {
            await api(`/api/identity/${root}/export/reveal`, { method: 'POST' });
        } catch (e) {
            setError(e.message);
        }
    };

    const ready = status === 'ready';
    return html`<div class="computers export-page">
        <h2 class="computers-title">${t('exportpage.title', 'import/export')}</h2>
        <h3 class="computers-subtitle"><${Icons.exportPersona} /> ${t('exportpage.export', 'export')}</h3>
        <p class="null-sub">
            ${t(
                'exportpage.what-it-is',
                "Everything you are here, in one .zip: every note, drawing and picture, by notebook and section; your posts; your profile, contacts, chats and bank. Notes come as Marquee, Markdown and plain text, so something opens them wherever you take them. It's unencrypted - anyone holding the file can read all of it - but it holds no keys: it can't be used to become you.",
            )}
        </p>
        ${!report && !error && html`<p class="null-sub">${t('exportpage.looking', 'looking…')}</p>`}
        ${queued && html`<p class="null-sub">${t('exportpage.queued', 'waiting its turn - this server makes one export at a time')}</p>`}
        ${
            running &&
            html`<p class="null-sub">${
                report.total
                    ? t('exportpage.running', 'making it: {done} of {total}', {
                          done: Number(report.done || 0).toLocaleString(),
                          total: Number(report.total).toLocaleString(),
                      })
                    : t('exportpage.starting', 'making it…')
            }</p>`
        }
        ${failed && html`<p class="form-error">${t('exportpage.failed', 'It didn’t work: {error}', { error: report.error })}</p>`}
        ${
            ready &&
            html`<p class="null-sub">
                    ${t('exportpage.ready', 'Ready: {size}, made {when}.', {
                        size: sizeLabel(report.bytes || 0),
                        when: formatWhen(report.made_ms),
                    })}
                </p>
                ${
                    report.reveal
                        ? html`<button class="welcome-go export-go" type="button" onClick=${reveal}>
                              <${Icons.exportPersona} /> ${t('exportpage.show-in-folder', 'show it in its folder')}
                          </button>`
                        : html`<a class="welcome-go export-go" href=${`/api/identity/${root}/export/download`} download>
                              <${Icons.exportPersona} /> ${t('exportpage.download', 'download it')}
                          </a>`
                }`
        }
        ${
            report &&
            !working &&
            html`<button class=${ready ? 'sync-act export-again' : 'welcome-go export-go'} type="button" onClick=${start}>
                ${ready ? t('exportpage.make-another', 'make a new one (it replaces this one)') : t('exportpage.make', 'make an export')}
            </button>`
        }
        ${error && html`<p class="form-error">${error}</p>`}
    </div>`;
};
