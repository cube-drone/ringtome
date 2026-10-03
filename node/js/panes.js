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
import { useCallback, useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import {
    usePrefMap,
    flagsOf,
    setPref,
    setFlag,
    widthKey,
    widthPrefix,
    tuckKey,
    tuckPrefix,
} from './mirror/prefs.js';
import { Icons } from './icons.js';
import { t } from './i18n.js';

const html = htm.bind(h);

/// A column's little header: its icon and name, and the button that tucks it away. Two files drew
/// this by hand - the documents app for each of its three columns, the tree pane for itself. The
/// icon is the one its rail wears (2026-09-30), so a column and its tucked tab are the same thing.
/// The whole header tucks its column (Curtis, 2026-10-02: "a click anywhere in the column header
/// folds the column, rather than just the tiny <| target"). The button stays, for the keyboard: its
/// click bubbles here, so it carries no handler of its own - two would tuck and untuck at once.
export const PaneHead = ({ icon = null, label, onTuck }) => html`<div
    class="pane-head jag-line"
    title=${`tuck the ${label} column away`}
    onClick=${onTuck}
>
    <span class="pane-head-label">${icon && html`<${icon} />`}${label}</span>
    <button class="pane-min" title=${`tuck the ${label} column away`}>
        <${Icons.back} />
    </button>
</div>`;

/// What a tucked column leaves behind: a slim vertical strip, its icon above its name running
/// downward, which brings the column back when clicked. In a narrow window it is a tab, and the
/// open column's own tab is `active` - still in the strip, where it was, marked as the one open.
export const Rail = ({ icon, label, onClick, active = false }) => html`<button
    class=${active ? 'pane-rail jag-line active' : 'pane-rail jag-line'}
    title=${active ? `close ${label}` : `show ${label}`}
    aria-pressed=${active}
    onClick=${onClick}
>
    <${icon} />
    <span class="pane-rail-label">${label}</span>
</button>`;

// Narrow windows (Curtis, 2026-09-30: below about 900px "the huge number of vertical columns starts to
// completely overtake the situation… can we replace the columns with a set of vertical tabs where
// only one tab can be open at the same time?"). Under NARROW every column is a tab - its rail - and
// at most one is open, across the whole page: a drawing's tools share the Writer's row, so "one"
// can't be per app. The open column fills the row and the main surface steps aside until it closes
// (notes.css, `.panes`); choosing something in it closes it (`settle`). This is the window's state,
// not a preference: nothing is stored, and the wide arrangement is untouched underneath.
const NARROW = '(max-width: 900px)';
let openKey = null; // `${appId}/${col}`, or none
const openers = new Set();
const setOpen = (key) => {
    openKey = key;
    openers.forEach((tell) => tell(key));
};

// An action taken in an open column closes it (Curtis, 2026-10-01: "new chat", "new picture", "new
// note", a drawing tool - "this didn't cause the column to close, leaving the user feeling like
// nothing had happened"). Choosing a document settles by its own road (`settle`, on the selection);
// an action that changes no selection says so on itself with `data-settles`, and this closes the
// column. It listens on the way DOWN (capture), so no `stopPropagation` in a row of actions can hide
// the click from it; the button's own handler still runs, against the column as it was, since the
// close is a state change that renders afterwards. A disabled button fires no click at all. Opt-in,
// because most of a column's clicks (a fold, a filter, a field) want it to stay - and `data-stays`
// marks what keeps the column open INSIDE something that closes it: a note row closes, the tag
// chips on it filter the list and stay.
if (typeof document !== 'undefined') {
    document.addEventListener(
        'click',
        (e) => {
            if (!openKey) return;
            const query = narrowQuery();
            if (!query || !query.matches) return;
            const settles =
                e.target && e.target.closest ? e.target.closest('[data-settles]') : null;
            if (!settles) return;
            const stays = e.target.closest('[data-stays]');
            if (stays && settles.contains(stays)) return;
            setOpen(null);
        },
        { capture: true },
    );
}

/// Whether the window is narrow, live as it resizes.
const narrowQuery = () =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(NARROW) : null;

export function useNarrow() {
    const [narrow, setNarrow] = useState(() => {
        const query = narrowQuery();
        return !!(query && query.matches);
    });
    useEffect(() => {
        const query = narrowQuery();
        if (!query) return undefined;
        const on = (e) => setNarrow(e.matches);
        query.addEventListener('change', on);
        setNarrow(query.matches);
        return () => query.removeEventListener('change', on);
    }, []);
    return narrow;
}

function useOpenKey() {
    const [key, setKey] = useState(openKey);
    useEffect(() => {
        openers.add(setKey);
        setKey(openKey);
        return () => openers.delete(setKey);
    }, []);
    return key;
}

/// Which of an app's columns are tucked away (minimized to a rail), and the toggle. The main
/// surface can't tuck; everything to its left can.
///
/// In a narrow window it answers differently (above): every column is tucked but the one open
/// tab, the toggle opens one and closes the rest, and `settle()` - called when something is chosen
/// in a column - closes it to show what was chosen. `lead` is the tab a narrow window opens on
/// when nothing of this app's is open: the Writer's list while no note is chosen. `tab(col, icon,
/// label)` is the open column's own tab, for the column to wear ahead of itself in a narrow window
/// (a binder shows every divider, the open one too) - nothing in a wide one.
///
/// `startsTucked` names the columns that are away until this device says otherwise - how
/// Writer opens on a plain list with its tag column and tree as rails, rather than greeting a
/// newcomer with four columns at once. It is a DEFAULT, not a rule: `setFlag` writes '0' when a
/// column is opened, so a stored preference always outranks it, and the absence of a stored key is
/// what "never touched this" looks like. (Hence the raw pref map here rather than `flagsOf` alone:
/// that helper collapses '0' and never-set into the same nothing, and they are different.)
export function useColTucks(root, appId, startsTucked = [], { lead = null } = {}) {
    const stored = usePrefMap(root, tuckPrefix(appId));
    const narrow = useNarrow();
    const open = useOpenKey();
    const mine = (col) => open === `${appId}/${col}`;
    const settle = useCallback(() => {
        if ((openKey || '').startsWith(`${appId}/`)) setOpen(null);
    }, [appId]);
    useEffect(() => {
        if (narrow && lead && !(openKey || '').startsWith(`${appId}/`)) setOpen(`${appId}/${lead}`);
    }, [narrow, appId, lead]);
    if (narrow) {
        return {
            tab: (col, icon, label) =>
                html`<${Rail} icon=${icon} label=${label} active=${true} onClick=${() => setOpen(null)} />`,
            tucked: { has: (col) => !mine(col) },
            toggleTuck: (col) => setOpen(mine(col) ? null : `${appId}/${col}`),
            settle,
        };
    }
    const tucked = flagsOf(stored);
    const known = new Set([...(stored || new Map())].map(([col]) => col));
    for (const col of startsTucked) if (!known.has(col)) tucked.add(col);
    return {
        tab: () => null,
        tucked,
        toggleTuck: (col) => setFlag(root, tuckKey(appId, col), !tucked.has(col)),
        settle,
    };
}

/// `open` names columns with no ceiling (Curtis, 2026-09-29: "in Files and also in Feed, the leftmost
/// column should not have a maximum width"): they drag as wide as the window leaves room for,
/// short of swallowing the column to their right.
export function useColWidths(root, appId, cols, mins = {}, open = []) {
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
    const ceiling = (c) => (open.includes(c) ? Math.max(560, window.innerWidth - 320) : 560);
    const clampW = (c, w) => Math.max(mins[c] ?? 140, Math.min(ceiling(c), Math.round(w)));
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

// The tag cloud: every tag in view, most-used first, clicking one into (or out of) the filter
// the list reads. Column furniture, so it lives here with the heads and the rails: Writer asks
// for it through `features.tagColumn`, and the chat app keeps one for rooms (Curtis,
// 2026-09-20). `label` names what the tags are on, when "tags" is not enough.
export const TagColumn = ({
    cloud,
    active,
    onToggleTag,
    onTuck,
    label,
}) => html`<aside class="tag-column">
    <${PaneHead} icon=${Icons.tag} label=${label || t('panes.tags', 'tags')} onTuck=${onTuck} />
    ${cloud.map(
        ([tag, count]) => html`<button
            key=${tag}
            class=${active.includes(tag) ? 'tag-cloud-row active' : 'tag-cloud-row'}
            onClick=${() => onToggleTag(tag)}
        >
            <span class="tag-cloud-name">${tag}</span>
            <span class="tag-cloud-count">${count}</span>
        </button>`,
    )}
    ${cloud.length === 0 && html`<p class="null-sub tag-column-empty">${t('panes.no-tags-yet', 'no tags yet')}</p>`}
</aside>`;
