// Import/export (plans/EXPORT.md): the persona, whole, as one zip - every note in each rendering a
// reader might open, its pictures, its posts opened, its profile, contacts, chats and bank. Made in
// the background on the node (export.rs), one at a time; a new one replaces the last. This page
// starts one, follows it while it's made, and hands it over: a browser downloads it, the desktop
// app shows it in the file manager (a webview downloads nothing - backup.rs's rule). Import takes
// such a zip back (import.rs), additively: what the persona already has is skipped, and said so.
import { h } from 'preact';
import { useState, useEffect, useCallback } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { Icons } from './icons.js';
import { useLocation } from 'preact-iso';
import { t, tNodes } from './i18n.js';
import { computersHref, importExportHref } from './links.js';
import { sizeLabel } from './pure/backups.js';
import { formatWhen } from './pure/when.js';
import { Progress } from './progress.js';

const html = htm.bind(h);

/// How often the page asks again while an export is queued or being made.
const LOOK_MS = 1500;

/// The page's tabs, each its own address as Your computers' are (Curtis, 2026-10-09).
const TABS = ['export', 'import'];

/// `/ringtome/settings/import-export` and `/ringtome/settings/import-export/:tab` - a bare or
/// unknown tab lands on `export`. Above both, the word that they are not sync.
export const ExportPage = ({ current, tab }) => {
    const loc = useLocation();
    const known = TABS.includes(tab);
    useEffect(() => {
        if (!known) loc.route(importExportHref('export'), true);
    }, [known, loc]);
    if (!current || !known) return null;
    const tabLink = (to, icon, words) =>
        html`<a class=${tab === to ? 'tab active' : 'tab'} href=${importExportHref(to)}>
            <${icon} /> ${words}
        </a>`;
    return html`<div class="computers export-page">
        <h2 class="computers-title">${t('exportpage.title', 'import/export')}</h2>
        <p class="import-export-notice">
            ${tNodes(
                'exportpage.not-sync',
                'Import and Export are useful for getting your files into and out of the network, but if you’re interested in reliable, automatic sync between devices, please check out {link}.',
                {
                    link: html`<a href=${computersHref('all')}>${t('exportpage.persona-sync', 'persona sync')}</a>`,
                },
            )}
        </p>
        <nav class="welcome-tabs">
            ${tabLink('export', Icons.exportPersona, t('exportpage.export', 'export'))}
            ${tabLink('import', Icons.importUser, t('exportpage.import', 'import'))}
        </nav>
        ${tab === 'export' ? html`<${ExportSection} root=${current.root} />` : html`<${ImportSection} root=${current.root} />`}
    </div>`;
};

/// Making an export, following it, and handing it over.
const ExportSection = ({ root }) => {
    const [report, setReport] = useState(null);
    const [error, setError] = useState(null);

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
    const interrupted = status === 'interrupted';
    const working = queued || running;
    useEffect(() => {
        if (!working) return undefined;
        const timer = setInterval(look, LOOK_MS);
        return () => clearInterval(timer);
    }, [working, look]);

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
    return html`<section class="import-section">
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
            html`<${Progress}
                done=${report.done}
                total=${report.phase === 'writing' ? report.total : 0}
                doing=${t('exportpage.gathering', 'gathering everything you have…')}
            />`
        }
        ${failed && html`<p class="form-error">${t('exportpage.failed', 'It didn’t work: {error}', { error: report.error })}</p>`}
        ${
            interrupted &&
            html`<p class="form-error">${t(
                'exportpage.interrupted',
                'The server stopped while this was being made ({done} of {total} done) - make it again.',
                {
                    done: Number(report.done || 0).toLocaleString(),
                    total: Number(report.total || 0).toLocaleString(),
                },
            )}</p>`
        }
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
    </section>`;
};

/// The import half (Curtis, 2026-10-09: additive only): a zip in, every document this persona
/// lacks added, everything it has "skipped: It already exists!" - and the import's own account of
/// what it did, line by line, once it's done.
const ImportSection = ({ root }) => {
    const [file, setFile] = useState(null);
    const [report, setReport] = useState(null);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState(null);

    const look = useCallback(
        () =>
            api(`/api/identity/${root}/import`)
                .then(setReport)
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
    const finished = status === 'done';
    const working = sending || queued || running;
    useEffect(() => {
        if (!(queued || running)) return undefined;
        const timer = setInterval(look, LOOK_MS);
        return () => clearInterval(timer);
    }, [queued, running, look]);

    const send = async (e) => {
        e.preventDefault();
        if (!file) return;
        setSending(true);
        setError(null);
        try {
            setReport(
                await api(`/api/identity/${root}/import`, {
                    method: 'POST',
                    body: file,
                    headers: { 'Content-Type': 'application/zip' },
                }),
            );
        } catch (err) {
            setError(err.message);
        } finally {
            setSending(false);
        }
    };

    if (report && !report.allowed)
        return html`<div class="null-state computers-alone">
            <span class="null-glyph"><${Icons.importUser} /></span>
            <p class="null-sub">
                ${t('exportpage.import-not-here', "This server doesn't allow imports.")}
            </p>
        </div>`;
    return html`<section class="import-section">
        <p class="null-sub">
            ${t(
                'exportpage.import-what',
                "Bring an export back in - this persona's own, or another's. Only what's new is added: a document this persona already has is skipped, even if the file has changed, so nothing here is ever overwritten. Posts are published again as yours, and the people in it are followed again.",
            )}
        </p>
        <form class="welcome-form" onSubmit=${send}>
            <input
                class="import-file"
                type="file"
                accept=".zip,application/zip"
                disabled=${working}
                onChange=${(e) => setFile(e.currentTarget.files[0] || null)}
            />
            <button class="welcome-go export-go" type="submit" disabled=${!file || working}>
                <${Icons.importUser} /> ${sending ? t('exportpage.sending', 'sending it…') : t('exportpage.import-it', 'import it')}
            </button>
        </form>
        ${queued && html`<p class="null-sub">${t('exportpage.import-queued', 'waiting its turn - this server does one export or import at a time')}</p>`}
        ${running && html`<p class="null-sub">${t('exportpage.importing', 'importing…')}</p>`}
        ${failed && html`<p class="form-error">${t('exportpage.import-failed', 'The import stopped: {error}', { error: report.error })}</p>`}
        ${
            report &&
            report.log &&
            report.log.length > 0 &&
            html`<ul class="import-log">
                ${report.log.map((line, i) => html`<li key=${i}>${line}</li>`)}
            </ul>`
        }
        ${finished && html`<p class="null-sub">${t('exportpage.import-done', 'Done.')}</p>`}
        ${error && html`<p class="form-error">${error}</p>`}
    </section>`;
};
