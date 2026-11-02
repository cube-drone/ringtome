// The download panel (Curtis, 2026-09-29): the newest release, one button per system - links the
// node reads off the GitHub releases page (src/downloads.rs), so a visitor's browser never asks
// GitHub itself. A system the release didn't ship a download for has no button; when none could be
// found, the releases page itself. Under it all, quietly, what this server is running - the app's
// own version link. The front page's Download tab, and - for a person already signed in, who had
// nowhere to get the app from (2026-10-09) - "Your Computers" too. A store build (src/store.rs)
// leaves out the download for its own system: that one comes from the store, and the store's
// rules forbid pointing anywhere else for it. The other systems' downloads stay.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';
import { Version } from './version.js';
import { RELEASES_PAGE } from './pure/update.js';

const html = htm.bind(h);

/// The system a store build's own store serves, whose download it never offers.
const STORE_SYSTEM = { play: 'android', 'app-store': 'mac' };
const storeSystem = () =>
    typeof document === 'undefined'
        ? null
        : STORE_SYSTEM[document.querySelector('meta[name="app-store"]')?.getAttribute('content')] ||
          null;

/// The newest release's downloads, as the node last read them (it asks GitHub at most hourly).
/// Never throws: GitHub out of reach is `{ releases }` and no buttons.
export const fetchDownloads = () =>
    api('/api/node/downloads').catch(() => ({ releases: RELEASES_PAGE }));

export const DownloadPanel = () => {
    const [found, setFound] = useState(null);
    useEffect(() => {
        fetchDownloads().then(setFound);
    }, []);
    const own = storeSystem();
    const systems = found
        ? [
              ['mac', found.mac, Icons.appleLogo, t('auth.download-mac', 'macOS')],
              ['windows', found.windows, Icons.windowsLogo, t('auth.download-windows', 'Windows')],
              ['linux', found.linux, Icons.linuxLogo, t('auth.download-linux', 'Linux')],
              // Since 0.3.1 (2026-10-09): the phone's APK, installed by hand.
              ['android', found.android, Icons.androidLogo, t('auth.download-android', 'Android')],
          ]
              .filter(([system, href]) => href && system !== own)
              .map(([, ...rest]) => rest)
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
            // Every release offers every download, its own system's too: a store build never links it.
            !own &&
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
