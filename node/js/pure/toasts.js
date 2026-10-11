// Toasts, as values (plans/TOASTS.md): the stack's rules - adding, merging a repeat, the cap,
// fading, holding under the pointer - and when an alert from the node becomes one. Everything here
// takes the stack and a clock reading and returns a new stack; toasts.js owns the timers, the
// store and the drawing.
//
// A toast in the stack: `{ id, key, text, kind, action, count, ttl, expiresAt, paused }`.
// `expiresAt` is null while paused - the countdown restarts in full when the pointer leaves.

/// How long each kind stays (Curtis, 2026-10-11: errors "fade like everything else, but slower").
export const TOAST_MS = { info: 5000, error: 10000 };
/// At most this many at once; a newer one pushes the oldest out.
export const MAX_TOASTS = 3;

/// What makes two toasts one: the caller's key, or the words themselves - the same error three
/// times is one error, three times.
export const toastKey = ({ key, text, kind }) => key || `${kind || 'info'}:${text}`;

/// Add a toast: a repeat of one already up takes the newer words and action, counts, and starts
/// its countdown again where it stands; anything else joins at the end, pushing out the oldest
/// past the cap.
export function addToast(stack, { text, kind = 'info', action = null, key = null }, now, id) {
    const k = toastKey({ key, text, kind });
    const ttl = TOAST_MS[kind] || TOAST_MS.info;
    const held = stack.find((t) => t.key === k);
    if (held) {
        return stack.map((t) =>
            t === held
                ? {
                      ...t,
                      text,
                      kind,
                      action,
                      ttl,
                      count: t.count + 1,
                      expiresAt: t.paused ? null : now + ttl,
                  }
                : t,
        );
    }
    const fresh = {
        id,
        key: k,
        text,
        kind,
        action,
        count: 1,
        ttl,
        expiresAt: now + ttl,
        paused: false,
    };
    return [...stack, fresh].slice(-MAX_TOASTS);
}

/// The pointer is over it: the countdown stops.
export const pauseToast = (stack, id) =>
    stack.map((t) => (t.id === id ? { ...t, paused: true, expiresAt: null } : t));

/// The pointer left: the countdown restarts in full, so a toast just read isn't snatched away.
export const resumeToast = (stack, id, now) =>
    stack.map((t) => (t.id === id ? { ...t, paused: false, expiresAt: now + t.ttl } : t));

/// The × - or following its action.
export const dismissToast = (stack, id) => stack.filter((t) => t.id !== id);

/// What is still up at `now`.
export const liveToasts = (stack, now) => stack.filter((t) => t.paused || t.expiresAt > now);

/// When the next one fades, or null when nothing is counting down - when the timer should wake.
export function nextExpiry(stack) {
    const times = stack.filter((t) => !t.paused).map((t) => t.expiresAt);
    return times.length ? Math.min(...times) : null;
}

// --- alerts from the node ------------------------------------------------------------------------

/// Is the page at this route - the room itself, or the bell's list - or somewhere beneath it
/// (a room's line address)?
export const atRoute = (path, route) => path === route || path.startsWith(`${route}/`);

/// A room's address, as `attention.rs` words one (`room_route`); everything else is the bell's.
export const isRoomRoute = (route) => /^\/ringtome\/user\/[^/]+\/room\/[^/]+$/.test(route);

/**
 * What an alert from the node becomes (plans/TOASTS.md, "when a toast is not raised"):
 *
 *   'skip'  - the page is hidden (the badge, Web Push or the OS notification has it), the page is
 *             already where it points, or it is a room that has spoken once since you last looked
 *             and its toast has gone (Curtis, 2026-10-11: "one per room");
 *   'show'  - a toast, keyed by its route, so a second line from a room still up updates the
 *             first toast rather than stacking another.
 *
 * `quiet` is the set of rooms that have spoken since you were last in them; `upKeys` the keys of
 * the toasts up now. Returns the decision and the quiet set after it.
 */
export function alertDecision({ route, path, hidden, quiet, upKeys }) {
    if (hidden || atRoute(path, route)) return { show: false, quiet };
    if (!isRoomRoute(route)) return { show: true, quiet };
    if (quiet.has(route) && !upKeys.includes(route)) return { show: false, quiet };
    return { show: true, quiet: new Set([...quiet, route]) };
}

/// You were in these rooms: they may speak again. Called with every page the tab visits.
export function visitedRoute(quiet, path) {
    const left = [...quiet].filter((route) => !atRoute(path, route));
    return left.length === quiet.size ? quiet : new Set(left);
}
