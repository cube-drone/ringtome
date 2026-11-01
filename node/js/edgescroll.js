// Edge scrolling while dragging (pure/edgescroll.js has the rule): started from a dragstart, it
// finds the nearest scrolling box around the dragged element and, every frame until the drag ends,
// scrolls it when the pointer is held near its top or bottom edge. Native drags don't do this for
// a scrolling box inside the page, only (sometimes) for the window.
import { edgeSpeed } from './pure/edgescroll.js';

/// A drag held still goes on firing dragover, at worst every ~550ms (the HTML spec's 350 ± 200):
/// a pointer older than FRESH_MS no longer scrolls, and this long without one the drag has ended
/// unseen (its row unmounted before dragend) and the loop stops.
const FRESH_MS = 600;
const STALE_MS = 1500;

/// The nearest ancestor of `el` that scrolls vertically, or the page's own scroller.
function scrollerOf(el) {
    for (let at = el && el.parentElement; at; at = at.parentElement) {
        const { overflowY } = getComputedStyle(at);
        if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight) {
            return at;
        }
    }
    return document.scrollingElement;
}

/// Scroll `from`'s scroller while a drag started on it is held near an edge. Call from the
/// dragstart handler; it stops itself when the drag ends or drops.
export function edgeScrollDuring(from) {
    const box = scrollerOf(from);
    if (!box) return;
    let point = null;
    let frame = 0;
    const page = box === document.scrollingElement;
    const tick = () => {
        const age = point ? performance.now() - point.at : 0;
        if (age > STALE_MS) return stop();
        frame = requestAnimationFrame(tick);
        if (!point || age > FRESH_MS) return;
        const r = page
            ? { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
            : box.getBoundingClientRect();
        if (point.x < r.left || point.x > r.right) return;
        const dy = edgeSpeed(point.y, r.top, r.bottom);
        if (dy) box.scrollTop += dy;
    };
    const over = (e) => {
        point = { x: e.clientX, y: e.clientY, at: performance.now() };
    };
    const stop = () => {
        cancelAnimationFrame(frame);
        document.removeEventListener('dragover', over, true);
        document.removeEventListener('dragend', stop, true);
        document.removeEventListener('drop', stop, true);
    };
    document.addEventListener('dragover', over, true);
    document.addEventListener('dragend', stop, true);
    document.addEventListener('drop', stop, true);
    frame = requestAnimationFrame(tick);
}
