// A long press: a phone's way to say what a desktop says with Shift or Ctrl (Curtis, 2026-10-12:
// picking several songs, notes or files by touch, where there's no key to hold). Browsers have no
// such event - Android's Chrome sends `contextmenu` at about half a second and iOS's Safari sends
// nothing - so it's counted here from pointer events: a finger held still for HOLD, and not moved
// past SLOP (that's a scroll, and the browser's pointercancel ends it too). Touch only: a mouse
// already has its keys.
//
// What the press leaves behind is kept from meaning anything else: the click its lifting may send
// (swallowed at the window, ahead of every listener - panes.js's `data-settles` included, so a
// held row doesn't close its column), the browser's own long-press menu, and a drag of a draggable
// row. One finger at a time, so one press at a time: module state.

const HOLD = 450; // ms: inside Chrome's own long press, so this one is heard first
const SLOP = 10; // px

let held = null; // { timer, x, y }
let fired = false; // the gesture now under way was a long press

const drop = () => {
    if (held) clearTimeout(held.timer);
    held = null;
};

if (typeof window !== 'undefined') {
    // Every gesture starts clean: a long press that sent no click must not swallow the next tap's.
    window.addEventListener('pointerdown', () => (fired = false), true);
    const swallow = (e) => {
        if (!fired) return;
        e.preventDefault();
        e.stopPropagation();
    };
    window.addEventListener(
        'click',
        (e) => {
            swallow(e);
            fired = false;
        },
        true,
    );
    window.addEventListener('dragstart', swallow, true);
    window.addEventListener('contextmenu', (e) => (held || fired) && e.preventDefault(), true);
}

/// The handlers to spread on what can be held: `onHold` runs once the finger has stayed put.
/// `onUp` is the element's own pointer-up, for one that has one (hrseAmp's double-tap counter).
export function longPress(onHold, { onUp = null } = {}) {
    return {
        onPointerDown: (e) => {
            if (e.pointerType !== 'touch') return;
            drop();
            const at = { x: e.clientX, y: e.clientY };
            held = {
                ...at,
                timer: setTimeout(() => {
                    held = null;
                    fired = true;
                    // A tick under the finger, where the phone has one: something happened.
                    if (navigator.vibrate) navigator.vibrate(12);
                    onHold();
                }, HOLD),
            };
        },
        onPointerMove: (e) => {
            if (held && Math.hypot(e.clientX - held.x, e.clientY - held.y) > SLOP) drop();
        },
        onPointerUp: (e) => {
            drop();
            if (onUp) onUp(e);
        },
        onPointerCancel: drop,
    };
}

/// Whether the gesture under way was a long press - for a handler of its own lifting (a tap
/// counter) to leave it be.
export const pressedLong = () => fired;
