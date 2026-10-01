// The facet strip on the feed and on a person's page (2026-09-07): the buckets and tags
// across the WHOLE set, counted by the node (`/feed/labels`, `/id/<seg>/labels`), each
// list one line of as many as fit, with a "more" that opens the rest (2026-09-30). Picking narrows the page
// through the same door the search uses (postsearch.js): buckets widen among themselves,
// tags each narrow, and the words narrow what survives. Hidden when there is nothing to
// pick from.
import { h } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { cycleMe, cyclePick, facetSlice, fitCount, LEFT_OUT } from './pure/facets.js';

const html = htm.bind(h);

/// The counts for one listing: `{ buckets, tags }` or null until they land. `refresh`
/// bumps to ask again (a page that just posted).
export function useLabels(url, refresh = 0) {
    const [labels, setLabels] = useState(null);
    useEffect(() => {
        if (!url) return undefined;
        let live = true;
        api(url)
            .then((r) => live && setLabels(r || { buckets: [], tags: [] }))
            .catch(() => live && setLabels({ buckets: [], tags: [] }));
        return () => {
            live = false;
        };
    }, [url, refresh]);
    return labels;
}

/// The kind row's words (the node speaks in keys).
const KIND_NAMES = {
    post: () => t('facets.kind-posts', 'posts'),
    reply: () => t('facets.kind-replies', 'replies'),
    rebroadcast: () => t('facets.kind-rebroadcasts', 'rebroadcasts'),
    book: () => t('facets.kind-books', 'books'),
    room: () => t('facets.kind-rooms', 'rooms'),
};

/// A chip's look and its words, by where it stands: left alone, "only", or left out - and what the
/// next click does, since a chip that cycles should say where it goes.
const CHIP_CLASS = { only: 'facet-chip facet-chip-on', out: 'facet-chip facet-chip-out' };
const chipClass = (state) => CHIP_CLASS[state] || 'facet-chip';
const chipTitle = (state) =>
    state === 'only'
        ? t('facets.chip-only', 'showing only these - click to leave them out instead')
        : state === 'out'
          ? t('facets.chip-out', 'left out - click to show them again')
          : t('facets.chip-alone', 'click to show only these; click again to leave them out');

/// One row of chips, one line of them (Curtis, 2026-09-30: the space "isn't really taken into
/// account"): as many as its width holds, then "and n more…", which opens the rest onto the lines
/// below. The chips are measured once per list - every one shown on the line, unseen, before the
/// first paint - and a resize only re-does the arithmetic (pure/facets.js `fitCount`). A picked
/// value shows whatever the fit (`facetSlice`), so what narrows the page is never folded away.
/// `picked` are the row's "only" values, `out` its left-out ones (2026-10-01, three-state chips).
const FacetRow = ({ label, items: counted, picked, out, onToggle, names, extra = null }) => {
    const [expanded, setExpanded] = useState(false);
    const rowRef = useRef(null);
    const measured = useRef(null); // { sig, widths, fixed, more, gap }
    const [fit, setFit] = useState(null); // { n }: a fresh object, so every reckoning re-renders
    // A picked value always shows, either way, even once nothing is left under it - so it can be
    // clicked on round.
    const chosen = [...(picked || []), ...(out || [])];
    const have = new Set((counted || []).map((f) => f.value));
    const items = [...(counted || []), ...chosen.filter((v) => !have.has(v)).map((value) => ({ value, count: 0 }))];
    const word = (v) => (names && names[v] ? names[v]() : v);
    const stateIn = (v) => ((picked || []).includes(v) ? 'only' : (out || []).includes(v) ? 'out' : null);
    const sig = `${extra ? 'x' : ''}|${items.map((f) => `${f.value}:${f.count}`).join('|')}|${(picked || []).join('|')}|${(out || []).join('|')}`;
    const measuring = !expanded && (!measured.current || measured.current.sig !== sig);
    const reckon = () => {
        const row = rowRef.current;
        const m = measured.current;
        if (!row || !m) return;
        setFit({ n: fitCount(m.widths, row.clientWidth - m.fixed, m.more, m.gap) });
    };
    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!measuring || !row) return;
        const width = (e) => e.getBoundingClientRect().width;
        const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
        const fixed = [...row.querySelectorAll(':scope > .facet-row-label, :scope > [data-facet-extra]')].reduce((sum, e) => sum + width(e) + gap, 0);
        const moreButton = row.querySelector(':scope > [data-facet-more]');
        measured.current = {
            sig,
            widths: [...row.querySelectorAll(':scope > [data-facet]')].map(width),
            fixed,
            more: moreButton ? width(moreButton) : 0,
            gap,
        };
        reckon();
    });
    useEffect(() => {
        const row = rowRef.current;
        if (!row || typeof ResizeObserver === 'undefined') return undefined;
        const watch = new ResizeObserver(() => reckon());
        watch.observe(row);
        return () => watch.disconnect();
    }, []);
    if (items.length === 0 && !extra) return null;
    // Measuring: every chip, and the widest "more" the row could need, on the one line.
    const top = expanded || measuring || !fit ? items.length : fit.n;
    const { shown, hidden } = facetSlice(items, chosen, expanded, top);
    const folds = !!fit && fit.n < items.length;
    return html`<div class=${expanded ? 'facet-row facet-row-open' : 'facet-row'} ref=${rowRef}>
        <span class="facet-row-label">${label}</span>
        ${extra && html`<span class="facet-row-extra" data-facet-extra>${extra}</span>`}
        ${shown.map(
            (f) => html`<button
                key=${f.value}
                data-facet
                class=${chipClass(stateIn(f.value))}
                title=${chipTitle(stateIn(f.value))}
                onClick=${() => onToggle(f.value)}
            >${word(f.value)} <span class="facet-count">${f.count}</span></button>`
        )}
        ${measuring &&
        html`<button class="facet-more" data-facet-more tabindex="-1" aria-hidden="true">
            ${t('facets.and-n-more', 'and {n} more…', { n: items.length })}
        </button>`}
        ${!measuring &&
        hidden > 0 &&
        html`<button class="facet-more" onClick=${() => setExpanded(true)}>
            ${t('facets.and-n-more', 'and {n} more…', { n: hidden })}
        </button>`}
        ${expanded && folds && html`<button class="facet-more" onClick=${() => setExpanded(false)}>${t('facets.fewer', 'fewer')}</button>`}
    </div>`;
};

/// The strip: `labels` from `useLabels`, `picks` as `{ kinds, buckets, tags }` (each row's "only"
/// values) with `notKinds`, `notBuckets`, `notTags` (its left-out ones) and `me`, and `onPicks`
/// with the next picks. Every chip cycles the same way (Curtis, 2026-10-01): left alone, only,
/// left out - "only" picks in one row widen to either, the rows narrow together.
export const LabelFacets = ({ labels, picks, onPicks, meChip = false, note = null }) => {
    if (!meChip && (!labels || ((labels.kinds || []).length === 0 && (labels.buckets || []).length === 0 && (labels.tags || []).length === 0))) return null;
    const toggle = (row) => (value) => onPicks(cyclePick(picks, row, value));
    // "me" (Curtis, 2026-09-27), the reader's own feed only: your own posts, cycling like every
    // other chip - among the rest, only yours, or left out (`picks.me`: undefined, 'only', false).
    const meState = picks.me === 'only' ? 'only' : picks.me === false ? 'out' : null;
    const me = meChip
        ? html`<button
              class=${chipClass(meState)}
              title=${chipTitle(meState)}
              onClick=${() => onPicks({ ...picks, me: cycleMe(picks.me) })}
          >${t('facets.me', 'me')}</button>`
        : null;
    return html`<div class="facets">
        ${/* The kind row (Curtis, 2026-09-08): posts, replies, rebroadcasts, books - the
            same semantics as the rows below it: nothing picked shows everything, a pick
            narrows to just those. "posts" is what is none of the other kinds. */ ''}
        <${FacetRow} label=${t('facets.kinds', 'show')} items=${(labels && labels.kinds) || []} picked=${picks.kinds} out=${picks[LEFT_OUT.kinds]} onToggle=${toggle('kinds')} names=${KIND_NAMES} extra=${me} />
        <${FacetRow} label=${t('facets.buckets', 'in')} items=${labels && labels.buckets} picked=${picks.buckets} out=${picks[LEFT_OUT.buckets]} onToggle=${toggle('buckets')} />
        <${FacetRow} label=${t('facets.tags', 'tagged')} items=${labels && labels.tags} picked=${picks.tags} out=${picks[LEFT_OUT.tags]} onToggle=${toggle('tags')} />
        ${note && html`<p class="facets-note">${note}</p>`}
    </div>`;
};

export const NO_PICKS = { kinds: [], buckets: [], tags: [], notKinds: [], notBuckets: [], notTags: [] };

/// The picks, kept for the browser session (Curtis, 2026-09-08): a refresh of the feed
/// or of a person's page finds the same kinds, buckets and tags picked. Keyed by the
/// page - the feed per persona, a person's page per person - in sessionStorage, so it
/// stays in this tab and never crosses a server. Storage may be absent or full; the picks
/// then live for the page alone.
const PICKS_PREFIX = 'picks:';
const readPicks = (key) => {
    try {
        const raw = sessionStorage.getItem(PICKS_PREFIX + key);
        const p = raw ? JSON.parse(raw) : null;
        return p && typeof p === 'object' ? { ...NO_PICKS, ...p } : NO_PICKS;
    } catch {
        return NO_PICKS;
    }
};
const writePicks = (key, picks) => {
    try {
        if (anyPicks(picks)) sessionStorage.setItem(PICKS_PREFIX + key, JSON.stringify(picks));
        else sessionStorage.removeItem(PICKS_PREFIX + key);
    } catch {
        /* no storage: the picks live for the page */
    }
};
export function usePicks(key) {
    const [picks, setPicksState] = useState(() => (key ? readPicks(key) : NO_PICKS));
    useEffect(() => {
        setPicksState(key ? readPicks(key) : NO_PICKS);
    }, [key]);
    const setPicks = (next) => {
        setPicksState(next);
        if (key) writePicks(key, next);
    };
    return [picks, setPicks];
}
export const anyPicks = (picks) =>
    !!(
        picks &&
        (picks.me === false ||
            picks.me === 'only' ||
            ['kinds', 'buckets', 'tags'].some((row) => (picks[row] || []).length || (picks[LEFT_OUT[row]] || []).length))
    );
