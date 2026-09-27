// The house tooltip (Curtis, 2026-09-27: every tooltip styled, and quicker than the browser's -
// whose delay is the browser's and the system's, not the page's). Installed once, for the whole
// app: nothing marks an element for it but the ordinary `title` attribute every button already
// carries, so there is nothing to add to new code and nothing to forget.
//
// While the pointer rests on something with a title (or keyboard focus lands on it), the title is
// BORROWED - moved to `data-tip`, so the browser's own tooltip does not show beside ours - and put
// back when the pointer leaves. An element with no accessible name of its own keeps one from the
// title while it is borrowed. The bubble wears the palette and Phosphor's info glyph; the rules for
// when and where are pure/tooltip.js. Never on touch, where no tooltip shows either. With tooltips
// turned off (the profile's application settings) titles are still borrowed - so the browser's do
// not show either - and nothing is drawn.
import { h, render } from 'preact';

import { Icons } from './icons.js';
import { tipDelay, placeTip } from './pure/tooltip.js';

let enabled = true;
let tip = null; // the bubble, made once
let words = null; // its text
let owner = null; // the element whose title is borrowed
let shown = false;
let timer = null;
let hiddenAt = -Infinity;
let watcher = null;
let pressed = null; // clicked while its tooltip showed: not again until the pointer leaves it

/// Turn the house tooltips on or off (the profile's "disable tooltips").
export function setTooltipsEnabled(on) {
    enabled = !!on;
    if (!enabled) hide();
}

function bubble() {
    if (tip) return;
    tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.setAttribute('role', 'tooltip');
    const icon = document.createElement('span');
    icon.className = 'tooltip-icon';
    // Outside the app's tree, so outside its IconContext: the house weight is said here.
    render(h(Icons.info, { weight: 'duotone', size: '1em' }), icon);
    words = document.createElement('span');
    words.className = 'tooltip-words';
    tip.append(icon, words);
    document.body.append(tip);
}

const titled = (el) => (el && el.closest ? el.closest('[title], [data-tip]') : null);

function borrow(el) {
    const take = () => {
        const title = el.getAttribute('title');
        if (title === null) return;
        el.setAttribute('data-tip', title);
        el.removeAttribute('title');
        if (el.hasAttribute('data-tip-label')) el.setAttribute('aria-label', title);
        if (shown && owner === el) {
            words.textContent = title;
            place();
        }
    };
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && el.getAttribute('title')) {
        el.setAttribute('aria-label', el.getAttribute('title'));
        el.setAttribute('data-tip-label', '');
    }
    take();
    // The page may set the title again while it is borrowed (a re-render with new words): take
    // that too, so the browser's never shows and ours says the new words.
    watcher = new MutationObserver(take);
    watcher.observe(el, { attributes: true, attributeFilter: ['title'] });
}

function giveBack(el) {
    if (watcher) watcher.disconnect();
    watcher = null;
    const title = el.getAttribute('data-tip');
    if (title !== null && !el.hasAttribute('title')) el.setAttribute('title', title);
    el.removeAttribute('data-tip');
    if (el.hasAttribute('data-tip-label')) {
        el.removeAttribute('aria-label');
        el.removeAttribute('data-tip-label');
    }
}

function place() {
    const r = owner.getBoundingClientRect();
    const at = placeTip(r, { width: tip.offsetWidth, height: tip.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
    tip.style.left = `${at.left}px`;
    tip.style.top = `${at.top}px`;
}

function show() {
    timer = null;
    if (!owner || !enabled) return;
    const text = (owner.getAttribute('data-tip') || '').trim();
    if (!text) return;
    bubble();
    words.textContent = text;
    tip.classList.add('on');
    shown = true;
    place();
}

function hide() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (shown) hiddenAt = performance.now();
    shown = false;
    if (tip) tip.classList.remove('on');
}

function enter(el) {
    if (el === owner) return;
    leave();
    if (el === pressed) return;
    pressed = null;
    owner = el;
    borrow(el);
    if (enabled) timer = setTimeout(show, tipDelay(performance.now(), hiddenAt));
}

function leave() {
    hide();
    if (owner) giveBack(owner);
    owner = null;
}

/// Install the house tooltips on the page. Once, at start.
export function installTooltips() {
    if (typeof document === 'undefined') return;
    document.addEventListener(
        'pointerover',
        (e) => {
            if (e.pointerType === 'touch') return;
            const el = titled(e.target);
            if (el) enter(el);
            else {
                pressed = null;
                leave();
            }
        },
        true
    );
    document.addEventListener(
        'pointerout',
        (e) => {
            if (!e.relatedTarget) {
                pressed = null;
                leave(); // out of the window altogether
            }
        },
        true
    );
    document.addEventListener(
        'pointerdown',
        () => {
            if (owner) pressed = owner;
            leave();
        },
        true
    );
    document.addEventListener(
        'focusin',
        (e) => {
            // Keyboard focus only: a click focuses too, and is not asking what a thing is.
            const el = titled(e.target);
            if (el && e.target.matches && e.target.matches(':focus-visible')) enter(el);
        },
        true
    );
    document.addEventListener('focusout', () => leave(), true);
    document.addEventListener('keydown', (e) => e.key === 'Escape' && hide(), true);
    window.addEventListener('scroll', () => leave(), true);
}
