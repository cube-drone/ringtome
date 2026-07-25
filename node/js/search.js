// Client-side search over the mirror's token-bag index (NEXT_STEPS, Where search lives). The
// node folds each private document into a bag of its unique lowercased words - title, resolved
// body, annotations - and streams those rows to the mirror like any other kind. Querying is a
// loop in the browser: local, offline, instant at cozy scale, zero round-trips per keystroke.
//
// The matcher is a pure function so it can be unit-tested without a browser or a node. Its
// policy: split the query into words the same way the index was tokenized, and a document
// matches when EVERY query word is a prefix of some token in its bag (AND across words,
// prefix within - "jum fo" finds a doc with "jumped" and "fox"). Prefix, not exact, is what
// makes type-ahead feel alive; AND is what makes adding a word narrow rather than widen.
import { useMemo } from 'preact/hooks';
import { openMirror, useLive } from './cache.js';

// Same normalization the node's tokenizer uses (record::documents::tokenize_into): lowercase,
// split on non-alphanumerics. No length band here - a one-letter query prefix is a fine
// filter even though one-letter *tokens* aren't worth indexing.
export function queryWords(q) {
    return (q || '')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}

/**
 * The doc_ids whose token bags match the query, as a Set. An empty query matches nothing
 * (the caller shows the full list instead - "no filter" is not "no results").
 *
 * @param query the raw search string
 * @param rows  the mirror's search rows: [{ doc_id, tokens }] (tokens is the space-joined bag)
 */
export function matchDocs(query, rows) {
    const words = queryWords(query);
    const hits = new Set();
    if (words.length === 0) return hits;
    for (const row of rows || []) {
        const bag = row.tokens ? row.tokens.split(' ') : [];
        const everyWordHits = words.every((w) => bag.some((t) => t.startsWith(w)));
        if (everyWordHits) hits.add(row.doc_id);
    }
    return hits;
}

/// The hook: a live matcher over the mirror's search table. Returns null while the query is
/// empty (meaning "don't filter"), otherwise a Set of matching doc_ids that updates as the
/// stream refreshes the index. The rows subscription is shared across queries.
export function useSearch(root, query) {
    const rows = useLive(() => openMirror(root).search.toArray(), [root]);
    return useMemo(() => {
        if (!queryWords(query).length) return null;
        return matchDocs(query, rows || []);
    }, [query, rows]);
}
