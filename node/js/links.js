// Minting Ringtome addresses (PROJECT_PLAN's "`/ringtome/` replaces `/home`, `/in` and `/id`",
// 2026-09-28): every link the app writes to a person, a post, a document or a room goes through
// here, in the one grammar (pure/ringtome.js), the root in its short form (bare base58). And the
// shareable URL a copy button hands over: the node's declared public URL when it has one, this
// page's own origin otherwise - which is exactly what the address bar shows.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { toBase58 } from './speakable.js';
import { ringtomePath, withHints, PREFIX, localOfAnswer } from './pure/ringtome.js';
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
/// A post at its web address (plans/WEB_ADDRESSES.md): under the author's @name when `slug` is the
/// one this node gave them, else under their real address. `path` is the author's own `path` label.
export const pathHref = (rootHex, path, slug = null) =>
    slug ? `/@${slug}/${path}` : ringtomePath({ seg: seg(rootHex), kind: 'path', at: path });

/// The short name this node gave a persona, or null - asked once per persona per page load.
const slugsAsked = new Map();
export function slugOf(rootHex) {
    if (!slugsAsked.has(rootHex))
        slugsAsked.set(
            rootHex,
            api(`/api/node/slug-of/${rootHex}`)
                .then((r) => (r && r.slug) || null)
                .catch(() => null),
        );
    return slugsAsked.get(rootHex);
}

/// `slugOf` for a component: undefined while it's asked, and nothing asked unless `wanted`.
export function useSlugOf(rootHex, wanted = true) {
    const [slug, setSlug] = useState(undefined);
    useEffect(() => {
        if (!rootHex || !wanted) return undefined;
        let live = true;
        slugOf(rootHex).then((s) => live && setSlug(s));
        return () => {
            live = false;
        };
    }, [rootHex, wanted]);
    return slug;
}

/// Another node's `@name` address, opened here (plans/WEB_ADDRESSES.md, slice 3): this node asks that
/// one what it names, and the answer becomes a local address - so a link copied off someone's site
/// opens in the reader's own app, where they can comment. `place` is the public post the link sits
/// in, for a reader who isn't signed in. Asked once per address per page load; null when it names
/// nothing, or can't be asked.
const webAddresses = new Map(); // url -> { asked: Promise, local: undefined | string | null }
export function webAddress(url, place = null) {
    let entry = webAddresses.get(url);
    if (!entry) {
        entry = { local: undefined };
        const query = `url=${encodeURIComponent(url)}${place ? `&in=${encodeURIComponent(place)}` : ''}`;
        entry.asked = api(`/api/web-address?${query}`)
            .then((answer) =>
                localOfAnswer(
                    { ...answer, via: answer.endpoint ? toBase58(answer.endpoint) : null },
                    seg(answer.root),
                ),
            )
            .catch(() => null)
            .then((local) => (entry.local = local));
        webAddresses.set(url, entry);
    }
    return entry.asked;
}
/// What `webAddress` already knows, without asking: the local address, null, or undefined.
export const webAddressKnown = (url) => {
    const entry = webAddresses.get(url);
    return entry ? entry.local : undefined;
};

/// A post's history (2026-10-02): every version it has been, where its "edited" mark leads.
export const postHistoryHref = (rootHex, doc) => `${postHref(rootHex, doc)}/history`;

/// Any other document - a note, a drawing, a picture - private or public. Given the document's row
/// and the notebook in view, the address says which notebook it was opened in when that is a
/// question (filed in more than one: `?bucket=`, pure/naming.js `bucketHint`).
export const docHref = (rootHex, doc, { row = null, bucket = null } = {}) =>
    withHints(ringtomePath({ seg: seg(rootHex), kind: 'doc', doc }), {
        bucket: bucketHint(row, bucket),
    });

/// The console (2026-09-28: `/ringtome` where `/home` was), and an app in it. The persona's own
/// pages moved into the Settings app (2026-10-09, `settingsHref` below).
export const LAUNCHER = PREFIX;
export const appHref = (appId) => (appId ? `${PREFIX}/${appId}` : PREFIX);

/// People's Groups tab, and one group's page under it (plans/GROUPS.md, section 7).
export const groupsHref = () => `${appHref('people')}/groups`;
export const groupHref = (group) => `${groupsHref()}/${group}`;
/// A group post's own page, inside its group (Curtis, 2026-10-16): there to members only.
export const groupPostHref = (group, doc) => `${groupHref(group)}/posts/${doc}`;
/// The feed opened to write in a group (its page's "new post"): that group's posts, and the
/// composer's "only show to" on it - read once by the feed, which then drops it from the address.
export const groupComposeHref = (group) => `${appHref('feed')}?group=${encodeURIComponent(group)}`;

/// The new-chat form, with "only show to" on a group (plans/GROUP_ROOMS.md): a group's section in
/// the chats column, and its page, send here to start a room in it.
export const groupChatHref = (group) => `${appHref('chat')}/new?group=${encodeURIComponent(group)}`;

/// The Settings app and its pages (2026-10-09: "they deserve an app all to themselves") -
/// `profile`, `app` (how the app behaves), `personas`, `computers`, `content`, `import-export`.
/// They lived under the persona at `/ringtome/persona/<page>`, which still redirects here;
/// application settings was `persona/settings`, and is `settings/app`.
export const settingsHref = (page) => {
    if (!page) return `${PREFIX}/settings`;
    return `${PREFIX}/settings/${page === 'settings' ? 'app' : page}`;
};

/// Your computers' tabs (2026-10-09): `new` adds a computer (the page's default), `all` is every
/// computer with how each is syncing, `mine` is what this one holds; `all/report` is the sync
/// report. Anything about syncing goes to `all`.
export const computersHref = (tab = 'new') => settingsHref(`computers/${tab}`);

/// Import/export's two tabs (plans/EXPORT.md): `export` (the default) and `import`.
export const importExportHref = (tab = 'export') => settingsHref(`import-export/${tab}`);

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

/// The node's declared public URL, or '' (plans/QR.md: what a QR code says depends on it).
export const publicUrl = () => base();

/// This node's key in its base58 spelling - the `via` hint an address carries - asked once per page.
let nodeKeyAsked = null;
export const nodeKey = () => {
    if (!nodeKeyAsked)
        nodeKeyAsked = api('/api/node')
            .then((n) => (n && n.endpoint_id ? toBase58(n.endpoint_id) : ''))
            .catch(() => '');
    return nodeKeyAsked;
};

/// The whole URL for an address path: the public URL, or this page's origin (a desktop app's
/// `localhost` - a Ringtome reader rehomes it; outside Ringtome it is only good on this computer).
export async function shareUrl(path) {
    const declared = await base();
    return `${declared || window.location.origin}${path}`;
}

/// Put words on the clipboard, wherever the page is served from (Curtis, 2026-10-08: "link" did
/// nothing in a phone's Firefox). `navigator.clipboard` exists only in a secure context - https, or
/// localhost - so a page reached over the LAN at plain http has none, and the copy threw into a
/// silent catch. There, and wherever the browser refuses it, the old road: a hidden field, selected,
/// and `execCommand('copy')`, which still runs inside the press that asked for it. Throws when both
/// are refused, so no caller says "copied" for nothing.
export async function writeClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            /* refused: the old road below */
        }
    }
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '0';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, text.length); // iOS selects nothing without the range
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } finally {
        field.remove();
    }
    if (!ok) throw new Error('the clipboard refused');
}

/// Put an address on the clipboard, as its whole URL.
export async function copyLink(path) {
    await writeClipboard(await shareUrl(path));
}

/// The copy-a-link chip (2026-09-28): the thing's address, whole - what the address bar would show,
/// and what the desktop app, which has no address bar, needs a button for. Pasted anywhere in the
/// app it unfolds (doc/turbolinks.js); pasted outside, it opens.
export const CopyLinkChip = ({ path, title }) => {
    const [copied, setCopied] = useState(false);
    // The public base asked for ahead of the press: a copy that waits on the network first may
    // outlast the press's leave to touch the clipboard.
    useEffect(() => {
        base();
    }, []);
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
        modifier="chip-keeps-menu"
        title=${copied ? t('links.copied', 'copied!') : title || t('links.copy-link', 'copy link')}
        word=${copied ? t('chips.copied', 'copied') : t('chips.link', 'link')}
        onClick=${copy}
    />`;
};
