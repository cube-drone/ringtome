// Which note `:e Title` means (doc/livemarquee.js's vim commands; Curtis, 2026-10-08): the note in
// this notebook with that title - exactly as typed first, then ignoring case - and, of several, the
// one most recently edited. Pure, so the rule is tested; `null` means there's none, and `:e` makes it.

/**
 * @param docs  the notebook's rows (`doc_id`, `title`, `updated_ms`)
 * @param title  what was typed after `:e`
 * @returns the doc_id to open, or null
 */
export function noteByTitle(docs, title) {
    const want = (title || '').trim();
    if (!want) return null;
    const newest = (rows) =>
        rows.reduce(
            (best, d) => (!best || (d.updated_ms || 0) > (best.updated_ms || 0) ? d : best),
            null,
        );
    const rows = docs || [];
    const exact = rows.filter((d) => (d.title || '').trim() === want);
    const loose = exact.length
        ? exact
        : rows.filter((d) => (d.title || '').trim().toLowerCase() === want.toLowerCase());
    const found = newest(loose);
    return found ? found.doc_id : null;
}
