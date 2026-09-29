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
import { api } from '../net.js';
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
    if (ref.kind === 'room') return { ...who, kind: 'room', href: ref.path };
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

function renderRingtome(data, level) {
    if (!data) return null;
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
