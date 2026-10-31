// A picture opened full size (Curtis, 2026-10-30: "an 800x600 image might be fit to 300px wide,
// rendering it too small to interact with"). Installed once, for the whole app: a tap on a picture
// in a post, a chat line or the reader that the page shows smaller than its own pixels opens it over
// everything, fitted to the screen, to pinch, drag, double-tap and wheel around in. The arithmetic
// is pure/zoomview.js.
//
// Not a picture inside a link or a button, which already goes somewhere; not one under a veil,
// whose tap lifts the veil; not an emoji, which is a character wearing an image's clothes.
import { h, render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { Icons } from './icons.js';
import { t } from './i18n.js';
import { fitted, gesture, zoomAt, doubleTap, settle, shrunk } from './pure/zoomview.js';

const html = htm.bind(h);

const PICTURES = '.feed-entry-body img, .chat-line-body img, img.reader-media';

const TAP_SLOP = 10; // px: moved further, it was a drag
const TAP_TIME = 300; // ms: held longer, or apart longer for a double tap, it wasn't one

function openable(el) {
    if (!(el instanceof HTMLImageElement) || !el.matches(PICTURES)) return false;
    if (el.classList.contains('mq-emoji') || el.closest('a, button, [aria-hidden="true"]'))
        return false;
    if (!el.complete || !el.naturalWidth) return false;
    return shrunk(
        { width: el.naturalWidth, height: el.naturalHeight },
        { width: el.clientWidth, height: el.clientHeight },
    );
}

const screenBox = () => ({ width: window.innerWidth, height: window.innerHeight });

const Viewer = ({ src, alt, pic, onClose }) => {
    const stage = useRef(null);
    const box = useRef(screenBox());
    const [view, setViewState] = useState(() => fitted(box.current, pic));
    const now = useRef(view);
    const setView = (v) => {
        now.current = v;
        setViewState(v);
    };
    // The fingers down, by pointer id, and where the gesture under way began.
    const down = useRef(new Map());
    const begun = useRef(null);
    // The tap under way, and the last one: { x, y, at }.
    const tap = useRef(null);
    const lastTap = useRef(null);

    const points = () => [...down.current.values()];
    const restart = () => {
        begun.current = down.current.size ? { view: now.current, from: points() } : null;
    };

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        const onResize = () => {
            box.current = screenBox();
            setView(settle(box.current, pic, now.current));
        };
        // Not passive: the wheel zooms the picture, never scrolls the page under it.
        const onWheel = (e) => {
            e.preventDefault();
            const v = now.current;
            setView(
                zoomAt(
                    box.current,
                    pic,
                    v,
                    v.scale * Math.exp(-e.deltaY * 0.002),
                    e.clientX,
                    e.clientY,
                ),
            );
        };
        const el = stage.current;
        document.addEventListener('keydown', onKey);
        window.addEventListener('resize', onResize);
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => {
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', onResize);
            el.removeEventListener('wheel', onWheel);
        };
    }, [pic, onClose]);

    const onPointerDown = (e) => {
        if (e.target.closest('.zoomview-close')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        down.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        tap.current =
            down.current.size === 1 ? { x: e.clientX, y: e.clientY, at: e.timeStamp } : null;
        restart();
    };
    const onPointerMove = (e) => {
        if (!down.current.has(e.pointerId)) return;
        down.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (
            tap.current &&
            Math.hypot(e.clientX - tap.current.x, e.clientY - tap.current.y) > TAP_SLOP
        )
            tap.current = null;
        const b = begun.current;
        if (b) setView(gesture(box.current, pic, b.view, b.from, points()));
    };
    const onPointerUp = (e) => {
        if (!down.current.delete(e.pointerId)) return;
        restart();
        const was = tap.current;
        tap.current = null;
        if (e.type !== 'pointerup' || !was || e.timeStamp - was.at > TAP_TIME) return;
        const prev = lastTap.current;
        if (
            prev &&
            e.timeStamp - prev.at < TAP_TIME &&
            Math.hypot(was.x - prev.x, was.y - prev.y) < TAP_SLOP * 3
        ) {
            lastTap.current = null;
            setView(doubleTap(box.current, pic, now.current, was.x, was.y));
            return;
        }
        lastTap.current = { ...was, at: e.timeStamp };
        // A tap on the dark beside the picture closes it.
        const v = now.current;
        const inside =
            was.x >= v.x &&
            was.x <= v.x + pic.width * v.scale &&
            was.y >= v.y &&
            was.y <= v.y + pic.height * v.scale;
        if (!inside) onClose();
    };

    return html`<div
        class="zoomview"
        ref=${stage}
        role="dialog"
        aria-modal="true"
        aria-label=${alt || t('zoomview.picture', 'picture')}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${onPointerUp}
    >
        <img
            class="zoomview-picture"
            src=${src}
            alt=${alt}
            draggable=${false}
            width=${pic.width}
            height=${pic.height}
            style=${{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
        <button class="zoomview-close" type="button" title=${t('zoomview.close', 'close')} onClick=${onClose}>
            <${Icons.close} />
        </button>
    </div>`;
};

let host = null;

function close() {
    if (!host) return;
    render(null, host);
    host.remove();
    host = null;
}

function open(img) {
    close();
    host = document.createElement('div');
    document.body.appendChild(host);
    render(
        html`<${Viewer}
            src=${img.currentSrc || img.src}
            alt=${img.alt}
            pic=${{ width: img.naturalWidth, height: img.naturalHeight }}
            onClose=${close}
        />`,
        host,
    );
}

/// Listen, once, for taps on pictures worth opening - ahead of the card or line around them, whose
/// own click would otherwise answer too.
export function installPictureViewer() {
    document.addEventListener(
        'click',
        (e) => {
            if (!openable(e.target)) return;
            e.preventDefault();
            e.stopPropagation();
            open(e.target);
        },
        true,
    );
    // Over a picture that would open, the pointer says so.
    document.addEventListener(
        'pointerover',
        (e) => {
            if (e.target instanceof HTMLImageElement && e.target.matches(PICTURES))
                e.target.classList.toggle('zoomview-opens', openable(e.target));
        },
        true,
    );
}
