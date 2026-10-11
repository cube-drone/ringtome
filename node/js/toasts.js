// Toasts (plans/TOASTS.md): short messages that fade by themselves - above the quickbar at the
// right on a wide window, across the lower third on a narrow one. `toast()` raises one from
// anywhere; `announceAlert()` is how the node's alerts arrive (mirror.js, off the live stream);
// `<Toasts />` is drawn once, by the shell.
//
// The rules - merging a repeat, the cap, fading, holding under the pointer, and when an alert is
// worth a toast - are values in pure/toasts.js. This module holds what they can't: the stack, the
// one timer that wakes for the next fade, and the drawing. The store is the module-level listener
// idiom of warnings.js: one stack for the tab, every `<Toasts />` (there is one) re-rendered when
// it changes.
import { h } from 'preact';
import { useState, useEffect } from 'preact/hooks';
import htm from 'htm';
import { useLocation } from 'preact-iso';

import {
    addToast,
    alertDecision,
    dismissToast,
    liveToasts,
    nextExpiry,
    pauseToast,
    resumeToast,
    visitedRoute,
} from './pure/toasts.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

let stack = [];
let nextId = 1;
let timer = null;
const listeners = new Set();

// Rooms that have spoken since you were last in them (pure/toasts.js `alertDecision`): the tab's
// own memory, forgotten on reload.
let quietRooms = new Set();

function set(next) {
    stack = next;
    // One timer, for whichever toast fades first; re-armed on every change.
    clearTimeout(timer);
    const wake = nextExpiry(stack);
    if (wake !== null) {
        timer = setTimeout(
            () => set(liveToasts(stack, Date.now())),
            Math.max(0, wake - Date.now()),
        );
    }
    listeners.forEach((fn) => fn());
}

/**
 * Raise a toast. `kind` is 'info' or 'error' (slower, and angrier); `action` an optional
 * `{ label, href }` - a link, which dismisses the toast when followed; `key` makes later toasts
 * with the same key update this one rather than stack beside it (the words are the key without
 * one).
 */
export function toast(text, { kind = 'info', action = null, key = null } = {}) {
    set(addToast(liveToasts(stack, Date.now()), { text, kind, action, key }, Date.now(), nextId++));
}

/// The node's attention watcher said something about this persona (`alerts` on a stream frame):
/// a toast, unless the page is hidden, already there, or it's a room that has had its say.
export function announceAlert({ title, body, route }) {
    const up = liveToasts(stack, Date.now());
    const decision = alertDecision({
        route,
        path: location.pathname,
        hidden: document.visibilityState === 'hidden',
        quiet: quietRooms,
        upKeys: up.map((x) => x.key),
    });
    quietRooms = decision.quiet;
    if (!decision.show) return;
    toast(t('toasts.alert', '{title}: {body}', { title, body }), {
        key: route,
        action: { label: t('toasts.open', 'open'), href: route },
    });
}

/// The stack, drawn once by the shell. Also where the tab's visits are noticed: a room you've
/// been in may raise a toast again.
export const Toasts = () => {
    const loc = useLocation();
    const [, bump] = useState(0);
    useEffect(() => {
        const fn = () => bump((n) => n + 1);
        listeners.add(fn);
        return () => listeners.delete(fn);
    }, []);
    useEffect(() => {
        quietRooms = visitedRoute(quietRooms, loc.path);
    }, [loc.path]);
    // Drawn even when empty: a screen reader announces what changes inside a live region that was
    // already there, and reliably nothing else. An error interrupts (`role="alert"`); the rest wait
    // their turn (the region's `polite`).
    return html`<div class="toasts" aria-live="polite">
        ${stack.map(
            (x) => html`<div
                key=${x.id}
                class=${x.kind === 'error' ? 'toast toast-error jag-line' : 'toast jag-line'}
                role=${x.kind === 'error' ? 'alert' : null}
                onMouseEnter=${() => set(pauseToast(stack, x.id))}
                onMouseLeave=${() => set(resumeToast(stack, x.id, Date.now()))}
            >
                <span class="toast-text">${x.text}</span>
                ${x.count > 1 && html`<span class="toast-count">×${x.count}</span>`}
                ${
                    x.action &&
                    html`<a class="toast-action" href=${x.action.href} onClick=${() => set(dismissToast(stack, x.id))}>
                        ${x.action.label}
                    </a>`
                }
                <button
                    class="toast-close"
                    title=${t('toasts.dismiss', 'dismiss')}
                    onClick=${() => set(dismissToast(stack, x.id))}
                >
                    <${Icons.close} />
                </button>
            </div>`,
        )}
    </div>`;
};
