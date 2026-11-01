// Edge scrolling while dragging (pure/edgescroll.js has the rule): started from a dragstart (or a
// finger's pointerdown), it
// finds the nearest scrolling box around the dragged element and, every frame until the drag ends,
// scrolls it when the pointer is held near its top or bottom edge. Native drags don't do this for
// a scrolling box inside the page, only (sometimes) for the window.
import { edgeSpeed } from './pure/edgescroll.js';

/// A drag held still goes on firing dragover, at worst every ~550ms (the HTML spec's 350 ± 200):
/// a pointer older than FRESH_MS no longer scrolls, and this long without one the drag has ended
/// unseen (its row unmounted before dragend) and the loop stops.
const FRESH_MS = 600;
const STALE_MS = 1500;

/// The nearest box around `el` (itself included) that scrolls vertically, or the page's own
/// scroller. `{ overflowing: false }` takes one that would scroll, though it holds too little to.
export function scrollerOf(el, { overflowing = true } = {}) {
    for (let at = el; at; at = at.parentElement) {
        const { overflowY } = getComputedStyle(at);
        if (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            (!overflowing || at.scrollHeight > at.clientHeight)
        ) {
            return at;
        }
    }
    return document.scrollingElement;
}

/// The events a drag is followed by: a native drag's, and a finger's (a pointer captured by the
/// thing dragged, which fires nothing while the finger is held still - and needs nothing, since a
/// captured pointer always ends in pointerup or pointercancel).
const NATIVE = { move: 'dragover', ends: ['dragend', 'drop'], stale: true };
const FINGER = { move: 'pointermove', ends: ['pointerup', 'pointercancel'], stale: false };

/// Scroll `from`'s scroller while a drag started on it is held near an edge. Call from the
/// dragstart handler (or, `{ finger: true }`, from a pointerdown that captures the pointer); it
/// stops itself when the drag ends or drops. `onScrolled(point)` hears each frame that scrolled
/// (the pointer's last `{ clientX, clientY }`),
/// for a drop line to follow the list moving under a pointer held still; `onLost()`, a native drag
/// that ended unseen (its row unmounted, so dragend never came), for whatever it left set.
export function edgeScrollDuring(from, { finger = false, onScrolled, onLost } = {}) {
    const box = scrollerOf(from);
    if (!box) return;
    const follow = finger ? FINGER : NATIVE;
    let point = null;
    let frame = 0;
    const page = box === document.scrollingElement;
    const tick = () => {
        const age = point && follow.stale ? performance.now() - point.at : 0;
        if (age > STALE_MS) {
            stop();
            if (onLost) onLost();
            return;
        }
        frame = requestAnimationFrame(tick);
        if (!point || age > FRESH_MS) return;
        const r = page
            ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
            : box.getBoundingClientRect();
        if (point.clientX < r.left || point.clientX > r.right) return;
        const dy = edgeSpeed(point.clientY, r.top, r.bottom);
        if (!dy) return;
        const was = box.scrollTop;
        box.scrollTop += dy;
        if (onScrolled && box.scrollTop !== was) onScrolled(point);
    };
    const over = (e) => {
        point = { clientX: e.clientX, clientY: e.clientY, at: performance.now() };
    };
    const stop = () => {
        cancelAnimationFrame(frame);
        document.removeEventListener(follow.move, over, true);
        for (const end of follow.ends) document.removeEventListener(end, stop, true);
    };
    document.addEventListener(follow.move, over, true);
    for (const end of follow.ends) document.addEventListener(end, stop, true);
    frame = requestAnimationFrame(tick);
}
