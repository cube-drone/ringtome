// The search behind the header's box on the feed and on a person's page (2026-09-07): the
// node answers over the WHOLE journal or the WHOLE held shelf (search.rs), not the cards on
// screen. One hook: hand it the listing URL and the query, get back the results while a
// query is open - debounced a beat behind the typing, stale answers dropped, an empty query
// meaning "no search, show the list".
import { useEffect, useState } from 'preact/hooks';

import { api } from './net.js';

const DEBOUNCE_MS = 250;

/// `{ active, results, searching, error }` - `active` while the query has words;
/// `results` the items the node returned (null until the first answer).
export function useSearch(url, query) {
    const q = (query || '').trim();
    const active = q.length > 0;
    const [state, setState] = useState({ for: '', results: null, error: null });
    useEffect(() => {
        if (!active || !url) return undefined;
        let alive = true;
        const timer = setTimeout(async () => {
            try {
                const page = await api(`${url}${url.includes('?') ? '&' : '?'}q=${encodeURIComponent(q)}`);
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
