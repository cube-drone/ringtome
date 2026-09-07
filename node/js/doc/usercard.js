// The user card in the words (2026-09-06): Marquee's `:::user id=/id/<address>:::` leaf
// directive, rendered as the person it names - their heptagon and their full name when the
// node knows it, their words when it does not (Curtis: "their septagon and full user name,
// if available"). Two renderers, two hooks: the react renderer (every MarqueeBody - the
// feed card, the reader, the post page, the book) takes a vnode and gets `UserCard`, which
// resolves the person the way every other face does; the live editor's CodeMirror preview
// takes an HTML string, so it draws the same card from a face cache that `useUserCards`
// fills as the profiles land - the turbolink pattern, a fresh profile identity per landing.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';
import { parse } from '@cube-drone/marquee-react-renderer';

import { api } from '../net.js';
import { t } from '../i18n.js';
import { PersonHex, usePerson } from '../person.js';
import { parseIdReference, parseSpeakable, speakable } from '../speakable.js';
import { identiconUri } from '../pure/identicon.js';
import { personaHue, displayNames } from '../pure/person.js';
import { CARD_DIRECTIVE } from '../pure/mentions.js';

const html = htm.bind(h);

/// The root a card names, or null: the `id` attribute read the way the /id door reads a
/// path - worded with its checksum verified, bare base58, or hex. Words that lie name nobody.
export function cardRoot(attrs) {
    const ref = parseIdReference(attrs && attrs.id);
    if (!ref) return null;
    const parsed = parseSpeakable(ref.seg);
    return parsed && parsed.ok ? parsed.root : null;
}

const nobody = () => t('doc.usercard.a-card-naming-nobody', 'a user card naming nobody');

/// The card proper: the smallest shape that still carries a name (Curtis, 2026-09-06) -
/// the small heptagon, the names beside it, a link to their page, sized to its content.
const UserCard = ({ root }) => {
    const person = usePerson(root);
    return html`<a class="user-card" href=${person.href}>
        <${PersonHex} person=${person} size="small" />
        <span class="user-card-names">
            <strong>${person.primary}</strong>
            ${person.others.length > 0 && html`<small>${person.others.join(' · ')}</small>`}
        </span>
    </a>`;
};

/// The inline shape: the mini heptagon and the name, in the line of text. The name is the
/// node's when it knows one, else the words the author wrote inside the span.
const UserSpan = ({ root, children }) => {
    const person = usePerson(root);
    const known = person.primary && person.primary !== person.words;
    return html`<a class="user-span" href=${person.href}>
        <${PersonHex} person=${person} size="mini" />
        <span>${known ? person.primary : children}</span>
    </a>`;
};

/// The react renderer's hooks: only `user` is ours - the directive is the block card, the
/// span the inline one; anything else falls through to Marquee's own handling.
export const marqueeHooks = {
    directive: (name, attrs) => {
        if (name !== CARD_DIRECTIVE) return null;
        const root = cardRoot(attrs);
        if (!root) return html`<div class="user-card user-card-bad">${nobody()}</div>`;
        return html`<${UserCard} root=${root} />`;
    },
    span: (name, attrs, children) => {
        if (name !== CARD_DIRECTIVE) return null;
        const root = cardRoot(attrs);
        if (!root) return html`<span class="user-span user-card-bad">${children}</span>`;
        return html`<${UserSpan} root=${root}>${children}</${UserSpan}>`;
    },
};

// The face cache for the string renderer: root -> { name, avatar }, filled once per root
// per page load. `attempted` keeps a failed or pending fetch from being asked again on
// every keystroke.
const faces = new Map();
const attempted = new Set();

const cardRoots = (source) => {
    let doc;
    try {
        doc = parse(source);
    } catch {
        return [];
    }
    const found = [];
    const walk = (node) => {
        if ((node.type === 'directive' || node.type === 'span') && node.name === CARD_DIRECTIVE) {
            const root = cardRoot(node.attrs);
            if (root && !found.includes(root)) found.push(root);
        }
        for (const child of node.children || []) walk(child);
    };
    walk(doc);
    return found;
};

/// The editor's hook: parse the buffer for cards, fetch the faces it lacks, and return a
/// generation that bumps as they land - the live profile is rebuilt on it, so the preview
/// repaints with the name.
export function useUserCards(source, format) {
    const [gen, setGen] = useState(0);
    useEffect(() => {
        if (format !== 'marquee' || !source) return;
        const fresh = cardRoots(source).filter((r) => !attempted.has(r));
        if (fresh.length === 0) return;
        let alive = true;
        for (const root of fresh) attempted.add(root);
        Promise.all(
            fresh.map((root) =>
                api(`/api/id/${root}/profile`)
                    .then((p) => {
                        const field = (k) => ((p.fields || []).find((f) => f.field === k) || {}).value || '';
                        faces.set(root, { name: field('name'), avatar: field('avatar') });
                    })
                    .catch(() => {})
            )
        ).then(() => alive && setGen((g) => g + 1));
        return () => {
            alive = false;
        };
    }, [source, format]);
    return gen;
}

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const faceOf = (root) => {
    const face = faces.get(root) || {};
    const words = speakable(root).split('-').slice(0, 2).join('-');
    const names = displayNames({ name: face.name, words });
    const src = face.avatar ? `/id/${root}/docs/${face.avatar}/thumb` : identiconUri(root);
    const hex = (size) =>
        `<span class="person-hex person-hex-${size}" style="background: hsl(${personaHue(root)}, 60%, 55%)">`
        + `<img class="person-hex-img" src="${escapeHtml(src)}" alt=""></span>`;
    return { names, known: !!face.name, hex };
};

/// The live preview's string hook (a Marquee profile's `directive`): the same card, drawn
/// from the cache - words alone until the face lands.
export function userCardHtml(name, attrs) {
    if (name !== CARD_DIRECTIVE) return null;
    const root = cardRoot(attrs);
    if (!root) return `<div class="user-card user-card-bad">${escapeHtml(nobody())}</div>`;
    const face = faceOf(root);
    const others = face.names.length > 1 ? `<small>${escapeHtml(face.names.slice(1).join(' · '))}</small>` : '';
    return `<a class="user-card" href="/id/${escapeHtml(speakable(root))}">${face.hex('small')}`
        + `<span class="user-card-names"><strong>${escapeHtml(face.names[0] || '')}</strong>${others}</span></a>`;
}

/// The live preview's span hook: the inline shape, the author's own words inside the span
/// standing in until the face lands.
export function userSpanHtml(name, attrs, renderedChildren) {
    if (name !== CARD_DIRECTIVE) return null;
    const root = cardRoot(attrs);
    if (!root) return `<span class="user-span user-card-bad">${renderedChildren}</span>`;
    const face = faceOf(root);
    const label = face.known ? escapeHtml(face.names[0]) : renderedChildren;
    return `<a class="user-span" href="/id/${escapeHtml(speakable(root))}">${face.hex('mini')}<span>${label}</span></a>`;
}
