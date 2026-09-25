// The running build, beside the clock (Curtis, 2026-09-25): `0.1.5-potato-pancakes`, and a click
// opens that release's notes. The version comes from the page the node served (html/index.html's
// `app-version` meta, filled from the node's own Cargo version), so it names what is actually
// running - after an update, the new one; the name is derived from it (pure/releasename.js), the
// same way `just release-*` named the tag.
import { h } from 'preact';
import htm from 'htm';

import { releaseTag, releaseUrl } from './pure/releasename.js';
import { t } from './i18n.js';

const html = htm.bind(h);

const running = () => document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '';

export const Version = () => {
    const version = running();
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null; // a shell that predates the meta
    return html`<a
        class="quickbar-version"
        href=${releaseUrl(version)}
        target="_blank"
        rel="noopener"
        title=${t('version.release-notes', 'the release notes for this version')}
    >${releaseTag(version)}</a>`;
};
