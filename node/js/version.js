// The running build, beside the clock (Curtis, 2026-09-25): a release shows its name,
// `0.1.5-potato-pancakes`, and a click opens its notes; a local dev build shows its branch
// (`main`, `feature-dinglebingle`), since it is no release at all. The version comes from the page the node served (html/index.html's
// `app-version` meta, filled from the node's own Cargo version), so it names what is actually
// running - after an update, the new one; the name is derived from it (pure/releasename.js), the
// same way `just release-*` named the tag.
import { h } from 'preact';
import htm from 'htm';

import { releaseTag, releaseUrl } from './pure/releasename.js';
import { t } from './i18n.js';

const html = htm.bind(h);

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';

export const Version = () => {
    // A dev node names its branch (src/ui.rs), and the branch is the truth about a local build:
    // it is not any release, whatever version number the checkout carries.
    const branch = meta('app-branch');
    const version = meta('app-version');
    if (branch) {
        return html`<span
            class="quickbar-version"
            title=${t('version.dev-build', 'a development build of {branch}, on {version}', { branch, version })}
        >${branch}</span>`;
    }
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null; // a shell that predates the meta
    return html`<a
        class="quickbar-version"
        href=${releaseUrl(version)}
        target="_blank"
        rel="noopener"
        title=${t('version.release-notes', 'the release notes for this version')}
    >${releaseTag(version)}</a>`;
};
