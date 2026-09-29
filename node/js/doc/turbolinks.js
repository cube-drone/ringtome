// Turbolink wiring: the embedder-policy chain every Marquee surface in the UI shares.
//
// The chain is marquee-turbolink's fetchless defaults (YouTube, Spotify, image/audio/video
// kinds - all derivable from the URL) plus our own OpenGraph plugin composed LAST. The
// package's own opengraphPlugin fetches target pages directly, which a browser cannot do
// (CORS); ours asks the node's /api/unfurl endpoint instead - the node fetches on our
// behalf, SSRF-guarded, globally rate-limited, and cached per URL (net::unfurl). Same
// summary shape, so the package's renderCard draws the card.
//
// Ahead of all of them, Ringtome's own (2026-09-28, PROJECT_PLAN's "`/ringtome/` replaces `/home`,
// `/in` and `/id`"): any `/ringtome/…` address, at ANY origin, is resolved by key through this
// node - a person, a post, a document, a room - and drawn as a card whose link is this node's own
// address for it. What it cannot see is "(THIS DOCUMENT IS PRIVATE)", never an error.
//
// Resolution is two-phase by the plugin contract: resolve() gathers (async, network),
// render() is sync over gathered data. The gathered data lives in this module's `resolved`
// map, shared by every surface - one unfurl per URL per page load, no matter how many
// editors and readers show it.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { nameToEmoji } from 'gemoji';
import { parse } from '@cube-drone/marquee-react-renderer';
import { bareWebProfile } from '@cube-drone/marquee-html-renderer';
import { mediaResolver } from '../pure/mediakind.js';
import { api, apiTextTitled } from '../net.js';
import { excerpt } from '../pure/excerpt.js';
import { parseRingtome, ringtomePath } from '../pure/ringtome.js';
import { parseSpeakable, wordsFor } from '../speakable.js';
import { identiconUri } from '../pure/identicon.js';
import { t } from '../i18n.js';
import {
    composeTurbolinks,
    defaultPlugins,
    renderCard,
    resolveTargets,
    turbolinkStyles,
    turbolinkTargets,
} from '@cube-drone/marquee-turbolink';

const ogPlugin = {
    name: 'ringtome-og',
    match: (target) => /^https?:\/\//i.test(target),
    resolve: async (target) => {
        try {
            // A summary, or null for "that page has no card".
            return await api(`/api/unfurl?url=${encodeURIComponent(target)}`);
        } catch {
            return null; // refused, rate-limited, or failed: the link stays plain
        }
    },
    render: (target, { level, data }) => (data ? renderCard(target, data, level) : null),
};

/// Who is reading (2026-09-28): a room's words are per-reader - a sealed room's are for its members
/// only - so a room card asks the room door as the persona that is open. Set by the shell.
let reader = null;
export const turbolinkReader = () => reader;
export const setTurbolinkReader = (root) => {
    if ((root || null) === reader) return;
    reader = root || null;
    // What was resolved for somebody else - or for nobody, before a persona opened - is not this
    // reader's to see: every card is asked again.
    resolved.clear();
    attempted.clear();
};

/// A room's icon (Phosphor's Hash, duotone - the app's own `Icons.room`, 2026-09-28), as markup: a
/// card is an HTML string, and cannot hold the component. Beside the room's title, it is the room's
/// `#`, so the title goes bare.
const ROOM_ICON = `<svg class="rt-card-icon" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M165.82,96l-11.64,64h-64l11.64-64Z" opacity="0.2"/><path d="M224,88H175.4l8.47-46.57a8,8,0,0,0-15.74-2.86l-9,49.43H111.4l8.47-46.57a8,8,0,0,0-15.74-2.86L95.14,88H48a8,8,0,0,0,0,16H92.23L83.5,152H32a8,8,0,0,0,0,16H80.6l-8.47,46.57a8,8,0,0,0,6.44,9.3A7.79,7.79,0,0,0,80,224a8,8,0,0,0,7.86-6.57l9-49.43H144.6l-8.47,46.57a8,8,0,0,0,6.44,9.3A7.79,7.79,0,0,0,144,224a8,8,0,0,0,7.86-6.57l9-49.43H208a8,8,0,0,0,0-16H163.77l8.73-48H224a8,8,0,0,0,0-16Zm-76.5,64H99.77l8.73-48h47.73Z"/></svg>`;

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/// What a Ringtome address points at, as this node can see it: `{ kind, href, root, name, avatar,
/// title, when, thumb }`, or `{ private: true }`. The href is always this node's own path.
async function resolveRingtome(target) {
    const ref = parseRingtome(target);
    const parsed = ref && parseSpeakable(ref.seg);
    if (!parsed || !parsed.ok) return { private: true };
    const root = parsed.root;
    const via = ref.via.length ? `?via=${ref.via.join(',')}` : '';
    // The profile first: for someone this node does not carry, asking is the peek that makes
    // their posts readable here at all.
    const profile = await api(`/api/id/${ref.seg}/profile${via}`).catch(() => null);
    const field = (k) => (((profile && profile.fields) || []).find((f) => f.field === k) || {}).value || '';
    const who = { root, name: field('name'), avatar: field('avatar') };
    if (!ref.kind) return { ...who, kind: 'person', href: ref.path, title: field('bio') };
    if (ref.kind === 'room') return resolveRoom(ref, who);
    // A post - or a document that is one: the public read answers for both.
    const doc = ref.page || ref.doc;
    try {
        const post = await api(`/api/id/${ref.seg}/posts/${doc}`);
        return {
            ...who,
            kind: 'post',
            href: ref.kind === 'doc' ? ringtomePath({ seg: ref.seg, kind: 'post', doc }) : ref.path,
            title: post.title || '',
            when: post.published_ms || null,
            thumb: post.thumb ? `/id/${root}/docs/${doc}/thumb` : '',
        };
    } catch {
        /* not a public post here: maybe a document of the reader's own */
    }
    if (ref.kind === 'doc') {
        try {
            const mine = await api(`/api/identity/${root}/docs/${doc}`);
            return { ...who, kind: 'doc', href: ref.path, title: mine.title || '' };
        } catch {
            /* not theirs to read */
        }
        // A private note that has since been published (slice 3, 2026-09-28): the author's own
        // `published_from` label names the post, and the link becomes the post.
        try {
            const { post: published } = await api(`/api/id/${ref.seg}/from/${doc}`);
            const post = await api(`/api/id/${ref.seg}/posts/${published}`);
            return {
                ...who,
                kind: 'post',
                href: ringtomePath({ seg: ref.seg, kind: 'post', doc: published }),
                title: post.title || '',
                when: post.published_ms || null,
                thumb: post.thumb ? `/id/${root}/docs/${published}/thumb` : '',
            };
        } catch {
            /* still private */
        }
    }
    return { private: true };
}

/// A room, or one line in it (Curtis, 2026-09-28): the room's title, and for a line who said it and
/// what. As the reader sees them - a room the reader may not enter gives its title where that is
/// public, and never its words.
async function resolveRoom(ref, who) {
    const card = { ...who, kind: 'room', href: ref.path, title: '', speaker: null, words: '', sealed: false };
    try {
        const post = await api(`/api/id/${ref.seg}/posts/${ref.doc}`);
        card.title = post.title || '';
        card.sealed = !!post.trusted_only;
        // A sealed room's title travels with its words, for whoever may have them.
        if (!card.title && post.trusted_only) card.title = (await apiTextTitled(`/id/${who.root}/docs/${ref.doc}/body`).catch(() => ({}))).title || '';
    } catch {
        /* not on this node's shelf: the room may still answer its members */
    }
    // Whether this reader may enter: a sealed room refuses its history to anyone it does not admit.
    if (card.sealed && !ref.line && reader) {
        const open = await api(`/api/identity/${reader}/rooms/${who.root}/${ref.doc}/messages?limit=1`)
            .then(() => true)
            .catch(() => false);
        card.locked = !open;
    }
    if (ref.line && reader) {
        try {
            const page = await api(`/api/identity/${reader}/rooms/${who.root}/${ref.doc}/messages?at=${ref.line}&limit=20`);
            const line = (page.items || []).find((m) => m.hash === ref.line);
            if (line && typeof line.words === 'string') {
                card.words = excerpt(line.words, 'marquee') || line.words;
                const profile = await api(`/api/id/${line.speaker}/profile`).catch(() => null);
                const field = (k) => (((profile && profile.fields) || []).find((f) => f.field === k) || {}).value || '';
                card.speaker = { root: line.speaker, name: field('name'), avatar: field('avatar') };
                card.when = line.said_ms || null;
            }
        } catch (e) {
            // Refused: a sealed room this reader is not admitted to.
            if (e.status === 403) card.locked = true;
        }
    }
    if (card.sealed && !card.words && !card.title) card.locked = true;
    return card;
}

function renderRoom(data, level) {
    // A room this reader may not enter says so (Curtis, 2026-09-28) - clicking it lands on the room's
    // own refusal, and the card should not promise more.
    const room = data.title || (data.locked ? t('doc.turbolinks.a-private-chat-room', 'a private chat room') : t('doc.turbolinks.a-chat-room', 'a chat room'));
    const owner = data.name || wordsFor(data.root).join('-');
    const speaker = data.speaker && (data.speaker.name || wordsFor(data.speaker.root).join('-'));
    const face = data.speaker && (data.speaker.avatar ? `/id/${data.speaker.root}/docs/${data.speaker.avatar}/thumb` : identiconUri(data.speaker.root));
    const when =
        level === 'full' && data.when
            ? new Date(data.when).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : '';
    return (
        `<a class="rt-card rt-card-room" href="${escapeHtml(data.href)}">` +
        ROOM_ICON +
        `<span class="rt-card-text"><span class="rt-card-who">${escapeHtml(room)}</span>` +
        (data.words
            ? `<span class="rt-card-said"><img class="rt-card-speaker" src="${escapeHtml(face)}" alt=""><span class="rt-card-speaker-name">${escapeHtml(speaker)}</span> <span class="rt-card-title">${escapeHtml(data.words)}</span></span>`
            : `<span class="rt-card-title">${escapeHtml(owner)}</span>`) +
        (when ? `<span class="rt-card-when">${escapeHtml(when)}</span>` : '') +
        `</span></a>`
    );
}

function renderRingtome(data, level) {
    if (!data) return null;
    if (data.kind === 'room') return renderRoom(data, level);
    if (data.private) {
        return `<span class="rt-card rt-card-private">${escapeHtml(t('doc.turbolinks.this-document-is-private', '(THIS DOCUMENT IS PRIVATE)'))}</span>`;
    }
    const face = data.avatar ? `/id/${data.root}/docs/${data.avatar}/thumb` : identiconUri(data.root);
    const who = data.name || wordsFor(data.root).join('-');
    const line =
        data.kind === 'room'
            ? t('doc.turbolinks.a-chat-room', 'a chat room')
            : data.kind === 'person'
              ? data.title
              : data.title || t('doc.turbolinks.untitled', 'untitled');
    const when =
        level === 'full' && data.when
            ? new Date(data.when).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
            : '';
    return (
        `<a class="rt-card rt-card-${data.kind}" href="${escapeHtml(data.href)}">` +
        `<img class="rt-card-face" src="${escapeHtml(face)}" alt="">` +
        `<span class="rt-card-text"><span class="rt-card-who">${escapeHtml(who)}</span>` +
        (line ? `<span class="rt-card-title">${escapeHtml(line)}</span>` : '') +
        (when ? `<span class="rt-card-when">${escapeHtml(when)}</span>` : '') +
        `</span>` +
        (level === 'full' && data.thumb ? `<img class="rt-card-thumb" src="${escapeHtml(data.thumb)}" alt="" loading="lazy">` : '') +
        `</a>`
    );
}

const ringtomePlugin = {
    name: 'ringtome',
    match: (target) => parseRingtome(target) !== null,
    resolve: (target) => resolveRingtome(target).catch(() => ({ private: true })),
    render: (target, { level, data }) => renderRingtome(data, level),
};

// Ours first: a `/ringtome/` address must never fall through to the OpenGraph fetcher, which
// would draw the author's page head rather than the thing.
const plugins = [ringtomePlugin, ...defaultPlugins, ogPlugin];

// One stylesheet for the whole chain, injected once - turbolinkStyles collects each
// plugin's declared skin plus the standard card's baseline.
if (typeof document !== 'undefined' && !document.getElementById('turbolink-styles')) {
    const style = document.createElement('style');
    style.id = 'turbolink-styles';
    style.textContent = turbolinkStyles(plugins);
    document.head.appendChild(style);
}

// The shared resolve cache: plugin-keyed, exactly the map composeTurbolinks consumes.
// `attempted` keeps a failed or card-less target from re-fetching every keystroke.
const resolved = new Map();
const attempted = new Set();

async function prime(targets) {
    const fresh = targets.filter((t) => !attempted.has(t));
    if (fresh.length === 0) return false;
    fresh.forEach((t) => attempted.add(t));
    const found = await resolveTargets(fresh, plugins, { concurrency: 4 });
    for (const [key, value] of found) {
        resolved.set(key, value);
    }
    return found.size > 0;
}

/// The hook a surface uses: hand it the current Marquee source, get back a profile whose
/// turbolink socket knows everything resolved so far. The profile is a fresh object each
/// time new data lands, so renderers re-render on identity change; per-keystroke re-parses
/// are cheap and re-fetch nothing (`attempted` dedupes).
export function useTurbolinks(source, format) {
    const [gen, setGen] = useState(0);
    useEffect(() => {
        if (format !== 'marquee' || !source) return;
        let doc;
        try {
            doc = parse(source);
        } catch {
            return; // a mid-edit unparsable doc resolves nothing; next parse catches up
        }
        const targets = turbolinkTargets(doc);
        if (targets.length === 0) return;
        let alive = true;
        prime(targets).then((changed) => {
            if (alive && changed) setGen((g) => g + 1);
        });
        return () => {
            alive = false;
        };
    }, [source, format]);
     
    return useMemo(
        () => ({
            // Ringtome's own media spellings (pure/mediakind.js) - `.apng` and `.opus` twins
            // rendered as bracketed links until the profile learned them (2026-09-03).
            media: mediaResolver(bareWebProfile),
            turbolink: composeTurbolinks(plugins, resolved),
            // The gemoji table: `:smile:` -> 😄. Marquee's emoji socket is embedder-supplied
            // by design (bareWebProfile ships no table - the spec's custom-emoji map is our
            // configuration); this is the table. Unknown slugs stay literal `:slug:`.
            emoji: (slug) => nameToEmoji[slug] || null,
        }),
        // `gen` IS the dependency: `resolved` is a module-level map mutated in place, so the
        // counter is the only identity the renderer can see change. The memo exists to mint a
        // fresh profile object per resolution batch - "unnecessary" is exactly backwards.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [gen]
    );
}
