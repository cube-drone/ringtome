// Adjustable column widths, shared by every app with columns (Notes' three, the wiki's tree).
// Each resizable column drags at its right edge via a slim resizer strip; the live drag rides
// component state, and the width settles into Dexie prefs (`colw:<appId>:<col>`) on release -
// the same durable, local, live-across-tabs home as the tuck state. Widths apply as CSS vars
// (`--w-<col>`) on the columns row, so the stylesheet keeps its defaults for anyone who never
// drags.
import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';

import { openMirror, useLive } from './cache.js';

const html = htm.bind(h);

export function useColWidths(root, appId, cols) {
    const widthRows = useLive(
        () => openMirror(root).prefs.where('key').startsWith(`colw:${appId}:`).toArray(),
        [root, appId]
    );
    const prefWidths = {};
    for (const r of widthRows || []) {
        const w = parseInt(r.value, 10);
        if (w) prefWidths[r.key.split(':')[2]] = w;
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
            openMirror(root)
                .prefs.put({
                    key: `colw:${appId}:${col}`,
                    value: String(clampW(startW + ev.clientX - startX)),
                })
                .catch(() => {});
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
