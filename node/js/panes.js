// Column chrome, shared by every app with columns (Notes' three, the wiki's tree): how WIDE each
// column is, and whether it's tucked away to a rail at all. Both are per-app choices that settle
// into the mirror's prefs (prefs.js owns the keys) - durable in this browser, live across its
// tabs, never synced.
//
// Widths: each resizable column drags at its right edge via a slim resizer strip; the live drag
// rides component state and only the release writes, so a drag isn't a hundred IndexedDB puts.
// They apply as CSS vars (`--w-<col>`) on the columns row, so the stylesheet keeps its defaults
// for anyone who never drags.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { usePrefMap, flagsOf, setPref, setFlag, widthKey, widthPrefix, tuckKey, tuckPrefix }
    from './prefs.js';

const html = htm.bind(h);

/// Which of an app's columns are tucked away (minimized to a rail), and the toggle. The main
/// surface can't tuck; everything to its left can.
export function useColTucks(root, appId) {
    const tucked = flagsOf(usePrefMap(root, tuckPrefix(appId)));
    return {
        tucked,
        toggleTuck: (col) => setFlag(root, tuckKey(appId, col), !tucked.has(col)),
    };
}

export function useColWidths(root, appId, cols) {
    const widths = usePrefMap(root, widthPrefix(appId));
    const prefWidths = {};
    for (const [col, value] of widths || []) {
        const w = parseInt(value, 10);
        if (w) prefWidths[col] = w;
    }
    const [dragWidths, setDragWidths] = useState({});
    const widthOf = (c) => dragWidths[c] ?? prefWidths[c];
    const clampW = (w) => Math.max(140, Math.min(560, Math.round(w)));
    const startResize = (col) => (e) => {
        e.preventDefault();
        const strip = e.currentTarget;
        const aside = strip.previousElementSibling; // the column this strip resizes
        if (!aside) return;
        const startW = aside.getBoundingClientRect().width;
        const startX = e.clientX;
        strip.setPointerCapture(e.pointerId);
        const move = (ev) =>
            setDragWidths((s) => ({ ...s, [col]: clampW(startW + ev.clientX - startX) }));
        const up = (ev) => {
            strip.removeEventListener('pointermove', move);
            strip.removeEventListener('pointerup', up);
            setPref(root, widthKey(appId, col), String(clampW(startW + ev.clientX - startX)));
        };
        strip.addEventListener('pointermove', move);
        strip.addEventListener('pointerup', up);
    };
    const resizer = (col) => html`<div
        class="col-resizer"
        title="drag to resize"
        onPointerDown=${startResize(col)}
    ></div>`;
    const colStyle = cols
        .filter((c) => widthOf(c))
        .map((c) => `--w-${c}: ${widthOf(c)}px`)
        .join('; ');
    return { resizer, colStyle };
}
