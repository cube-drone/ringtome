// The server's front door, its own parts (frontdoor.rs; Curtis, 2026-09-30): the name the header
// calls the place, the marquee of taglines under the sign-in, and the posts a node administrator
// super-pinned above "lately on this node" - plus the chip that pins them, on an administrator's
// cards. Nothing chosen comes back null, and the defaults are said here, in the reader's language.
import { h, createContext } from 'preact';
import { useContext, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { Icons } from './icons.js';

const html = htm.bind(h);

/// Whether the reader may super-pin: a node administrator, on a server (index.js provides it).
export const SuperPinner = createContext(false);

/// The app's own name for a server's front page.
export const defaultName = () => t('frontdoor.default-name', 'Horse Drawing Tycoon 2');

/// The app's own taglines (Curtis, 2026-09-30), the marquee's lines until an administrator writes
/// their own.
export const defaultTaglines = () => [
    t('frontdoor.tagline-draw-and-share', 'finally, a way to draw and share pictures of horses'),
    t('frontdoor.tagline-tycoon', 'a tycoon game where you draw horses indefinitely'),
    t('frontdoor.tagline-p2p', 'a horse-themed peer-to-peer social network'),
    t(
        'frontdoor.tagline-least-qualified',
        'a social network designed by the least qualified possible person to design a social network',
    ),
    t('frontdoor.tagline-marquee', "finally a home for the internet's lost marquee element"),
    t('frontdoor.tagline-both', 'horses! drawings! both at the same time!'),
    t(
        'frontdoor.tagline-zug-zug',
        'do you remember when you played Starcraft 2 and you clicked on a guy a few too many times and he started to say weird comedy things? anyways, zug zug.',
    ),
];

// One ask of `/api/node/front`, shared by the header, the front page and every card's chip.
let front = null;
let asking = null;
const listeners = new Set();

/// Ask again - after a pin, an unpin, or a save in the Server app - and tell everyone listening.
export const refreshFront = () => {
    asking = api('/api/node/front')
        .then((f) => {
            front = f;
            listeners.forEach((l) => l(f));
            return f;
        })
        .catch(() => {
            asking = null;
        });
    return asking;
};

/// The front door's choices and pins, or null until the first answer.
export const useFront = () => {
    const [f, setF] = useState(front);
    useEffect(() => {
        listeners.add(setF);
        if (!asking) refreshFront();
        else if (front) setF(front);
        return () => listeners.delete(setF);
    }, []);
    return f;
};

/// The name the front page's header wears.
export const frontName = (f) => (f && f.name) || defaultName();

/// The taglines, one after the other, scrolling forever (Curtis, 2026-09-30: "an endlessly
/// scrolling marquee"). The run is laid twice, end to end, and slides one run's width, so its
/// seam never shows; its pace follows its length, so a long list doesn't race. A hover holds it
/// still to be read, and a reader who asked for less motion gets the lines standing still.
export const Marquee = () => {
    const f = useFront();
    const lines = (f && f.taglines && f.taglines.length ? f.taglines : defaultTaglines()).filter(
        Boolean,
    );
    const chars = lines.reduce((n, l) => n + l.length + 6, 0);
    const run = (copy) =>
        lines.map(
            (line, i) =>
                html`<span class="marquee-line" key=${`${copy}:${i}`} aria-hidden=${copy > 0}>${line}</span>`,
        );
    return html`<p class="marquee" style=${`--marquee-seconds: ${Math.max(10, Math.round(chars * 0.14))}s`}>
        <span class="marquee-track">${run(0)}${run(1)}</span>
    </p>`;
};

const SuperPinToggle = ({ item }) => {
    const f = useFront();
    const [busy, setBusy] = useState(false);
    const pinned =
        !!f && (f.pins || []).some((p) => p.author === item.author && p.doc_id === item.doc_id);
    const flip = async () => {
        setBusy(true);
        try {
            await api(`/api/admin/super-pins/${item.author}/${item.doc_id}`, {
                method: pinned ? 'DELETE' : 'PUT',
            });
            await refreshFront();
        } catch {
            /* the next click retries; the chip stays honest to what the server holds */
        }
        setBusy(false);
    };
    return html`<button
        class=${pinned ? 'chip chip-button chip-pinned' : 'chip chip-button'}
        title=${
            pinned
                ? t(
                      'frontdoor.take-this-off-the-front-page',
                      "take this off the server's front page",
                  )
                : t(
                      'frontdoor.super-pin-this',
                      "super-pin this to the top of the server's front page",
                  )
        }
        disabled=${busy}
        onClick=${flip}
    ><${Icons.superPin} /></button>`;
};

/// The super-pin chip, on a node administrator's cards only. The node decides what may be pinned
/// (a public post hosted here); the card offers it on anything open.
export const SuperPinChip = ({ item }) =>
    useContext(SuperPinner) ? html`<${SuperPinToggle} item=${item} />` : null;
