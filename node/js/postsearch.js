// The narrowing behind the header's box and the facet strip on the feed and on a person's
// page (2026-09-07): the node answers over the WHOLE journal or the WHOLE held shelf
// (search.rs), not the cards on screen. One hook: hand it the listing URL, the words and
// the picks, get back the results while any of them is set - debounced a beat behind the
// typing, stale answers dropped, nothing set meaning "no narrowing, show the list".
import { useEffect, useState } from 'preact/hooks';

import { api } from './net.js';

const DEBOUNCE_MS = 250;

/// The query string the node's narrowing reads: `q=` for the words, `bucket=` and `tag=`
/// repeated for the picks (facets.js).
export function narrowParams(query, picks) {
    const parts = [];
    const q = (query || '').trim();
    if (q) parts.push(`q=${encodeURIComponent(q)}`);
    for (const b of (picks && picks.buckets) || []) parts.push(`bucket=${encodeURIComponent(b)}`);
    for (const g of (picks && picks.tags) || []) parts.push(`tag=${encodeURIComponent(g)}`);
    return parts.join('&');
}

/// `{ active, results, searching, error }` - `active` while there are words or picks;
/// `results` the items the node returned (null until the first answer).
export function useSearch(url, query, picks) {
    const q = narrowParams(query, picks);
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
