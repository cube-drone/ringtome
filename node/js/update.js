// The update notice (Curtis, 2026-10-09): "we check every hour for a new version - if there's a new
// version the user can download, we display at the top of the feed and above the septagons in the
// app-selector, a prompt" - and it can't be hidden or skipped: "HDT2 is so new that ALL UPDATES ARE
// IMPORTANT". Only in an installed app (the desktop app, the Android app), where the person is the
// one who installs; a browser is always as new as its server, and a dev build is no release.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { isDevice } from './net.js';
import { t, tNodes } from './i18n.js';
import { Icons } from './icons.js';
import { fetchDownloads } from './downloads.js';
import { downloadFor, isNewer } from './pure/update.js';

const html = htm.bind(h);

const HOUR = 60 * 60 * 1000;
const meta = (name) =>
    document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';

/// The newer release this app should install - `{ tag, href }` - or null. Asked at once and every
/// hour after; the node reads GitHub at most hourly however many apps ask it.
function useUpdate() {
    const [update, setUpdate] = useState(null);
    useEffect(() => {
        if (typeof document === 'undefined' || !isDevice() || meta('app-branch')) return undefined;
        const running = meta('app-version');
        let live = true;
        const check = () =>
            fetchDownloads().then((found) => {
                if (!live) return;
                setUpdate(
                    found && isNewer(found.tag, running)
                        ? { tag: found.tag, href: downloadFor(window.__ringtome_platform, found) }
                        : null,
                );
            });
        check();
        const id = setInterval(check, HOUR);
        return () => {
            live = false;
            clearInterval(id);
        };
    }, []);
    return update;
}

/// The notice itself: no dismiss, by design.
export const UpdateNotice = () => {
    const update = useUpdate();
    if (!update) return null;
    const here = html`<a href=${update.href} target="_blank" rel="noopener" title=${update.tag}>${t('update.here', 'here')}</a>`;
    return html`<div class="update-notice" role="alert">
        <p class="update-notice-head">
            <span class="update-notice-icon"><${Icons.download} /></span>
            <span>
                <strong>${t('update.update', 'Update:')}</strong>${' '}
                ${tNodes('update.there-is-a-new-version', "There's a new version of Horse Drawing Tycoon 2 for you to install! Please download it from {here}!", { here })}
            </span>
        </p>
        <p class="update-notice-note">
            ${t('update.still-in-alpha', "HDT2 is still in alpha, so if you don't update, your client might stop working correctly with the rest of the network!")}
        </p>
    </div>`;
};
