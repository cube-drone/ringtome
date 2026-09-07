// The facet strip on the feed and on a person's page (2026-09-07): the buckets and tags
// across the WHOLE set, counted by the node (`/feed/labels`, `/id/<seg>/labels`), each
// list folded to its top few with a "more" that opens the rest. Picking narrows the page
// through the same door the search uses (postsearch.js): buckets widen among themselves,
// tags each narrow, and the words narrow what survives. Hidden when there is nothing to
// pick from.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import htm from 'htm';

import { api } from './net.js';
import { t } from './i18n.js';
import { facetSlice, togglePick } from './pure/facets.js';

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

const FacetRow = ({ label, items, picked, onToggle }) => {
    const [expanded, setExpanded] = useState(false);
    if (!items || items.length === 0) return null;
    const { shown, hidden } = facetSlice(items, picked, expanded);
    return html`<div class="facet-row">
        <span class="facet-row-label">${label}</span>
        ${shown.map(
            (f) => html`<button
                key=${f.value}
                class=${(picked || []).includes(f.value) ? 'facet-chip facet-chip-on' : 'facet-chip'}
                onClick=${() => onToggle(f.value)}
            >${f.value} <span class="facet-count">${f.count}</span></button>`
        )}
        ${hidden > 0 &&
        html`<button class="facet-more" onClick=${() => setExpanded(true)}>
            ${t('facets.and-n-more', 'and {n} more…', { n: hidden })}
        </button>`}
        ${expanded &&
        items.length > shown.length - hidden &&
        html`<button class="facet-more" onClick=${() => setExpanded(false)}>${t('facets.fewer', 'fewer')}</button>`}
    </div>`;
};

/// The strip: `labels` from `useLabels`, `picks` as `{ buckets: [], tags: [] }`, and
/// `onPicks` with the next picks.
export const LabelFacets = ({ labels, picks, onPicks }) => {
    if (!labels || ((labels.buckets || []).length === 0 && (labels.tags || []).length === 0)) return null;
    const toggle = (kind) => (value) => onPicks({ ...picks, [kind]: togglePick(picks[kind], value) });
    return html`<div class="facets">
        <${FacetRow} label=${t('facets.buckets', 'in')} items=${labels.buckets} picked=${picks.buckets} onToggle=${toggle('buckets')} />
        <${FacetRow} label=${t('facets.tags', 'tagged')} items=${labels.tags} picked=${picks.tags} onToggle=${toggle('tags')} />
    </div>`;
};

export const NO_PICKS = { buckets: [], tags: [] };
export const anyPicks = (picks) => !!(picks && ((picks.buckets || []).length || (picks.tags || []).length));
