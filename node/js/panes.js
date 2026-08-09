// Column chrome, shared by every app with columns (Notes' three, the wiki's tree): how WIDE each
// column is, and whether it's tucked away to a rail at all. Both are per-app choices that settle
// into the mirror's prefs (mirror/prefs.js owns the keys) - durable in this browser, live across its
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
    from './mirror/prefs.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// A column's little header: its name, and the button that tucks it away. Two files drew this by
/// hand - the documents app for each of its three columns, the tree pane for itself.
export const PaneHead = ({ label, onTuck }) => html`<div class="pane-head">
    <span class="pane-head-label">${label}</span>
    <button class="pane-min" title=${`tuck the ${label} column away`} onClick=${onTuck}>
        <${Icons.back} />
    </button>
</div>`;

/// What a tucked column leaves behind: a slim vertical strip, its icon above its name running
/// downward, which brings the column back when clicked.
export const Rail = ({ icon, label, onClick }) => html`<button
    class="pane-rail"
    title=${`show ${label}`}
    onClick=${onClick}
>
    <${icon} />
    <span class="pane-rail-label">${label}</span>
</button>`;

/// Which of an app's columns are tucked away (minimized to a rail), and the toggle. The main
/// surface can't tuck; everything to its left can.
///
/// `startsTucked` names the columns that are away until this device says otherwise - how
/// TurboNotes opens on a plain list with its tag column and tree as rails, rather than greeting a
/// newcomer with four columns at once. It is a DEFAULT, not a rule: `setFlag` writes '0' when a
/// column is opened, so a stored preference always outranks it, and the absence of a stored key is
/// what "never touched this" looks like. (Hence the raw pref map here rather than `flagsOf` alone:
/// that helper collapses '0' and never-set into the same nothing, and they are different.)
export function useColTucks(root, appId, startsTucked = []) {
    const stored = usePrefMap(root, tuckPrefix(appId));
    const tucked = flagsOf(stored);
    const known = new Set([...(stored || new Map())].map(([col]) => col));
    for (const col of startsTucked) if (!known.has(col)) tucked.add(col);
    return {
        tucked,
        toggleTuck: (col) => setFlag(root, tuckKey(appId, col), !tucked.has(col)),
    };
}

export function useColWidths(root, appId, cols, mins = {}) {
    const widths = usePrefMap(root, widthPrefix(appId));
    const prefWidths = {};
    for (const [col, value] of widths || []) {
        const w = parseInt(value, 10);
        if (w) prefWidths[col] = w;
    }
    const [dragWidths, setDragWidths] = useState({});
    // Per-column floors (the feed's composer needs 260px before its chrome crushes); 140 is
    // the house default. Applied to STORED widths too, so a pref written under an older,
    // lower floor honors the new one on read.
    const clampW = (c, w) => Math.max(mins[c] ?? 140, Math.min(560, Math.round(w)));
    const widthOf = (c) => {
        const w = dragWidths[c] ?? prefWidths[c];
        return w == null ? undefined : clampW(c, w);
    };
    const startResize = (col) => (e) => {
        e.preventDefault();
        const strip = e.currentTarget;
        const aside = strip.previousElementSibling; // the column this strip resizes
        if (!aside) return;
        const startW = aside.getBoundingClientRect().width;
        const startX = e.clientX;
        strip.setPointerCapture(e.pointerId);
        const move = (ev) =>
            setDragWidths((s) => ({ ...s, [col]: clampW(col, startW + ev.clientX - startX) }));
        const up = (ev) => {
            strip.removeEventListener('pointermove', move);
            strip.removeEventListener('pointerup', up);
            setPref(root, widthKey(appId, col), String(clampW(col, startW + ev.clientX - startX)));
        };
        strip.addEventListener('pointermove', move);
        strip.addEventListener('pointerup', up);
    };
    const resizer = (col) => html`<div
        class="col-resizer"
        title=${t('panes.drag-to-resize', 'drag to resize')}
        onPointerDown=${startResize(col)}
    ></div>`;
    const colStyle = cols
        .filter((c) => widthOf(c))
        .map((c) => `--w-${c}: ${widthOf(c)}px`)
        .join('; ');
    return { resizer, colStyle };
}
