// A notebook published as a book (BOOKS.md slice 1): the private bookkeeping, pure.
//
// Two private kv collections carry the facts, so no header and no document changes:
//   `books`        - key: the bucket's name, value: JSON `{"mode":"book"}` - the switch.
//   `book_hidden`  - key: `doc:<doc_id>` or `sec:<taxonomy_id>`, value: "yes" - hidden never
//                    publishes (ruling 3); an empty value clears the mark.
// The ledger against the last rollout (ruling 6) reads each page's `published_version` - the
// private version a rollout published, recorded by the rollout itself (slice 2) - against
// the page's current head. Before any rollout every page is simply "new".

export const BOOKS_KV = 'books';
export const HIDDEN_KV = 'book_hidden';
export const PUBLISHED_VERSION = 'published_version';

/// The kv rows (`{ key, value }`) of the `books` collection, as a map of bucket -> mode.
export function bookModes(values) {
    const out = {};
    for (const v of values || []) {
        try {
            const parsed = JSON.parse(v.value || 'null');
            if (parsed && parsed.mode) out[v.key] = parsed.mode;
        } catch {
            /* an unreadable value is no mode */
        }
    }
    return out;
}

/// Whether a bucket publishes as a book.
export function isBookBucket(modes, bucket) {
    return !!bucket && (modes || {})[bucket] === 'book';
}

/// The hidden marks, as a Set of `doc:<id>` / `sec:<id>` keys, off the kv rows.
export function hiddenSetOf(values) {
    const out = new Set();
    for (const v of values || []) if ((v.value || '').trim() === 'yes') out.add(v.key);
    return out;
}

/// Every document hidden from the book, directly or by an ancestor section: a Set of doc ids.
/// `tree` is the expanded root node (`{ taxonomy_id, title, members }`); a section member is
/// `{ taxonomy }`, a leaf `{ doc_id, doc }`; a section without members is a stub.
export function hiddenDocsOf(tree, hidden) {
    const out = new Set();
    const walk = (node, under, seen) => {
        if (!node || seen.has(node.taxonomy_id)) return;
        seen.add(node.taxonomy_id);
        const here = under || hidden.has(`sec:${node.taxonomy_id}`);
        for (const m of node.members || []) {
            if (m.taxonomy) {
                if (m.taxonomy.members) walk(m.taxonomy, here, seen);
            } else if (m.doc_id && (here || hidden.has(`doc:${m.doc_id}`))) {
                out.add(m.doc_id);
            }
        }
    };
    walk(tree, false, new Set());
    return out;
}

/// A page's standing against the last rollout: hidden, new (never rolled out), changed
/// (its head moved since), or current.
export function pageStanding(row, hiddenDocs, hidden) {
    if (!row) return 'new';
    if ((hiddenDocs && hiddenDocs.has(row.doc_id)) || (hidden && hidden.has(`doc:${row.doc_id}`))) return 'hidden';
    const published = row.fields && row.fields[PUBLISHED_VERSION];
    if (!published) return 'new';
    return published === row.head ? 'current' : 'changed';
}

/// The ledger: the bucket's pages sorted into the four standings.
export function bookLedger(rows, hiddenDocs, hidden) {
    const out = { hidden: [], new: [], changed: [], current: [] };
    for (const r of rows || []) out[pageStanding(r, hiddenDocs, hidden)].push(r);
    return out;
}
