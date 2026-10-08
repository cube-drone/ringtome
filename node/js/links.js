// Minting Ringtome addresses (PROJECT_PLAN's "`/ringtome/` replaces `/home`, `/in` and `/id`",
// 2026-09-28): every link the app writes to a person, a post, a document or a room goes through
// here, in the one grammar (pure/ringtome.js), the root in its short form (bare base58). And the
// shareable URL a copy button hands over: the node's declared public URL when it has one, this
// page's own origin otherwise - which is exactly what the address bar shows.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { toBase58 } from './speakable.js';
import { ringtomePath, withHints, PREFIX } from './pure/ringtome.js';
import { bucketHref, bucketHint } from './pure/naming.js';
import { api } from './net.js';
import { Chip } from './doc/chips.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

const seg = (rootHex) => (rootHex ? toBase58(rootHex) : '');

/// A person's page.
export const personHref = (rootHex, via = []) => {
    const path = ringtomePath({ seg: seg(rootHex) });
    return path && via.length ? `${path}?via=${via.join(',')}` : path;
};

/// A public post, or one page of a book (`page` is the page's own post id).
export const postHref = (rootHex, doc, page = null) =>
    ringtomePath({ seg: seg(rootHex), kind: 'post', doc, page });
/// A post's history (2026-10-02): every version it has been, where its "edited" mark leads.
export const postHistoryHref = (rootHex, doc) => `${postHref(rootHex, doc)}/history`;

/// Any other document - a note, a drawing, a picture - private or public. Given the document's row
/// and the notebook in view, the address says which notebook it was opened in when that is a
/// question (filed in more than one: `?bucket=`, pure/naming.js `bucketHint`).
export const docHref = (rootHex, doc, { row = null, bucket = null } = {}) =>
    withHints(ringtomePath({ seg: seg(rootHex), kind: 'doc', doc }), {
        bucket: bucketHint(row, bucket),
    });

/// The console (2026-09-28: `/ringtome` where `/home` was), an app in it, and the persona's pages.
export const LAUNCHER = PREFIX;
export const appHref = (appId) => (appId ? `${PREFIX}/${appId}` : PREFIX);
export const personaPageHref = (page) => (page ? `${PREFIX}/persona/${page}` : `${PREFIX}/persona`);

/// A notebook's own list.
export const notebookHref = (bucketName, roster) => bucketHref(bucketName, roster);

/// A chat room, or one line in it.
export const roomHref = (authorHex, doc, line = null) =>
    ringtomePath({ seg: seg(authorHex), kind: 'room', doc, line });

// The node's declared public URL, asked once per page load.
let publicBase = null;
const base = () => {
    if (!publicBase) {
        publicBase = api('/api/config')
            .then((c) => (c.public_url || '').trim().replace(/\/+$/, ''))
            .catch(() => '');
    }
    return publicBase;
};

/// The whole URL for an address path: the public URL, or this page's origin (a desktop app's
/// `localhost` - a Ringtome reader rehomes it; outside Ringtome it is only good on this computer).
export async function shareUrl(path) {
    const declared = await base();
    return `${declared || window.location.origin}${path}`;
}

/// Put an address on the clipboard, as its whole URL.
export async function copyLink(path) {
    await navigator.clipboard.writeText(await shareUrl(path));
}

/// The copy-a-link chip (2026-09-28): the thing's address, whole - what the address bar would show,
/// and what the desktop app, which has no address bar, needs a button for. Pasted anywhere in the
/// app it unfolds (doc/turbolinks.js); pasted outside, it opens.
export const CopyLinkChip = ({ path, title }) => {
    const [copied, setCopied] = useState(false);
    const copy = async (e) => {
        if (e) e.preventDefault();
        try {
            await copyLink(path);
        } catch {
            return; // clipboard denied: no false "copied"
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
    };
    return html`<${Chip}
        icon=${Icons.link}
        on=${copied}
        title=${copied ? t('links.copied', 'copied!') : title || t('links.copy-link', 'copy link')}
        word=${copied ? t('chips.copied', 'copied') : t('chips.link', 'link')}
        onClick=${copy}
    />`;
};
