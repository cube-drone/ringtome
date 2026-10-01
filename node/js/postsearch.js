// The narrowing behind the header's box and the facet strip on the feed and on a person's
// page (2026-09-07): the node answers over the WHOLE journal or the WHOLE held shelf
// (search.rs), not the cards on screen. One hook: hand it the listing URL, the words and
// the picks, get back the results while any of them is set - debounced a beat behind the
// typing, stale answers dropped, nothing set meaning "no narrowing, show the list".
import { useEffect, useState } from 'preact/hooks';

import { api } from './net.js';
import { sortParams } from './pure/feed.js';

const DEBOUNCE_MS = 250;

/// The query string the node's narrowing reads: `q=` for the words, `kind=`, `bucket=` and `tag=`
/// repeated for the "only" picks, and `not_kind=`, `not_bucket=`, `not_tag=` for the left-out ones
/// (facets.js).
export function narrowParams(query, picks, extra = {}) {
    const parts = [];
    const q = (query || '').trim();
    if (q) parts.push(`q=${encodeURIComponent(q)}`);
    for (const b of (picks && picks.buckets) || []) parts.push(`bucket=${encodeURIComponent(b)}`);
    for (const g of (picks && picks.tags) || []) parts.push(`tag=${encodeURIComponent(g)}`);
    for (const k of (picks && picks.kinds) || []) parts.push(`kind=${encodeURIComponent(k)}`);
    // The left-out chips (2026-10-01): what carries one is dropped.
    for (const b of (picks && picks.notBuckets) || []) parts.push(`not_bucket=${encodeURIComponent(b)}`);
    for (const g of (picks && picks.notTags) || []) parts.push(`not_tag=${encodeURIComponent(g)}`);
    for (const k of (picks && picks.notKinds) || []) parts.push(`not_kind=${encodeURIComponent(k)}`);
    // The feed's selectivity dial rides along (2026-09-08) so the node narrows what the
    // dial shows; it never makes a search on its own.
    const stop = extra.stop && extra.stop !== 'explorer' ? extra.stop : null;
    if (stop && parts.length) parts.push(`stop=${encodeURIComponent(stop)}`);
    // The feed's "me" (apps/feed.js), left out or alone, rides along the same way: it narrows a
    // search, and never makes one.
    if (extra.me && parts.length) parts.push(`me=${extra.me}`);
    // A best order (2026-09-27) ranks a search's results the same way, and never makes one.
    const sort = sortParams(extra.sort);
    if (sort && parts.length) parts.push(sort);
    return parts.join('&');
}

/// `{ active, results, searching, error }` - `active` while there are words or picks;
/// `results` the items the node returned (null until the first answer).
export function useSearch(url, query, picks, extra = {}) {
    const q = narrowParams(query, picks, extra);
    const active = q.length > 0;
    const [state, setState] = useState({ for: '', results: null, error: null });
    useEffect(() => {
        if (!active || !url) return undefined;
        let alive = true;
        const timer = setTimeout(async () => {
            try {
                const page = await api(`${url}${url.includes('?') ? '&' : '?'}${q}`);
                if (alive) setState({ for: q, results: page.items || page.posts || [], error: null });
            } catch (e) {
                if (alive) setState({ for: q, results: [], error: e.message || String(e) });
            }
        }, DEBOUNCE_MS);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [active, url, q]);
    if (!active) return { active: false, results: null, searching: false, error: null };
    const fresh = state.for === q;
    return { active: true, results: fresh ? state.results : null, searching: !fresh, error: fresh ? state.error : null };
}
