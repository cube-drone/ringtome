// The download panel (Curtis, 2026-09-29): the newest release, one button per system - links the
// node reads off the GitHub releases page (src/downloads.rs), so a visitor's browser never asks
// GitHub itself. A system the release didn't ship a download for has no button; when none could be
// found, the releases page itself. Under it all, quietly, what this server is running - the app's
// own version link. The front page's Download tab, and - for a person already signed in, who had
// nowhere to get the app from (2026-10-09) - "Your Computers" too.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';
import { Version } from './version.js';
import { RELEASES_PAGE } from './pure/update.js';

const html = htm.bind(h);

/// The newest release's downloads, as the node last read them (it asks GitHub at most hourly).
/// Never throws: GitHub out of reach is `{ releases }` and no buttons.
export const fetchDownloads = () =>
    api('/api/node/downloads').catch(() => ({ releases: RELEASES_PAGE }));

export const DownloadPanel = () => {
    const [found, setFound] = useState(null);
    useEffect(() => {
        fetchDownloads().then(setFound);
    }, []);
    const systems = found
        ? [
              [found.mac, Icons.appleLogo, t('auth.download-mac', 'macOS')],
              [found.windows, Icons.windowsLogo, t('auth.download-windows', 'Windows')],
              [found.linux, Icons.linuxLogo, t('auth.download-linux', 'Linux')],
              // Since 0.3.1 (2026-10-09): the phone's APK, installed by hand.
              [found.android, Icons.androidLogo, t('auth.download-android', 'Android')],
          ].filter(([href]) => href)
        : [];
    return html`<div class="welcome-download">
        ${!found && html`<p class="null-sub">${t('auth.download-looking', 'looking for the newest release…')}</p>`}
        ${
            systems.length > 0 &&
            html`<div class="download-buttons">
            ${systems.map(
                ([
                    href,
                    Icon,
                    name,
                ]) => html`<a class="download-button" key=${name} href=${href} title=${found.tag || ''}>
                    <${Icon} /><span>${name}</span>
                </a>`,
            )}
        </div>`
        }
        ${
            found &&
            systems.length === 0 &&
            html`<p class="field-note">
            ${t('auth.download-none-found', "the downloads couldn't be found just now.")}
            ${' '}<a href=${found.releases} target="_blank" rel="noopener">${t('auth.download-every-release', 'every release is here')}</a>
        </p>`
        }
        <p class="download-server">
            ${t('auth.this-server-is-running', 'this server is running')}${' '}<${Version} className="download-version" />
        </p>
    </div>`;
};
