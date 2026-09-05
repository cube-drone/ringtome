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

/// The kv rows of the `books` collection as a map of bucket -> the facts the rollout keeps
/// there: `mode`, and once rolled out `published_as_book` (the book's public id).
export function bookFacts(values) {
    const out = {};
    for (const v of values || []) {
        try {
            const parsed = JSON.parse(v.value || 'null');
            if (parsed && typeof parsed === 'object') out[v.key] = parsed;
        } catch {
            /* an unreadable value is no fact */
        }
    }
    return out;
}

/// A book document's payload (BOOKS.md ruling 9), tolerant of anything that is not one.
export function parseBook(text) {
    let raw;
    try {
        raw = JSON.parse(text || '');
    } catch {
        return null;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const section = (s) => ({
        title: String((s && s.title) || ''),
        pages: Array.isArray(s && s.pages) ? s.pages.filter((p) => p && p.post).map((p) => ({ post: String(p.post), title: String(p.title || '') })) : [],
        sections: Array.isArray(s && s.sections) ? s.sections.map(section) : [],
    });
    const top = section(raw);
    const count = (s) => s.pages.length + s.sections.reduce((n, x) => n + count(x), 0);
    const cover = raw.cover && raw.cover.post ? { post: String(raw.cover.post), title: String(raw.cover.title || '') } : null;
    return { title: String(raw.title || ''), cover, sections: top.sections, pages: top.pages, count: count(top) };
}

/// The page a book borrows its title from (BOOKS.md ruling 11): the first page in reading
/// order over the PRIVATE tree - top-level pages first, then sections depth-first, hidden
/// ones skipped - else the first page of the notebook by id. Returns a doc id, or null.
export function titlePageOf(tree, docs, hidden) {
    const hiddenDocs = hiddenDocsOf(tree, hidden || new Set());
    const isPage = (id) => docs.some((d) => d.doc_id === id) && !hiddenDocs.has(id) && !(hidden && hidden.has(`doc:${id}`));
    // The same order the rollout and the reader use: the tree's top-level pages, then the
    // notebook's unfiled pages (by id), then the sections depth-first.
    const filedIds = new Set();
    const collect = (node, seen) => {
        if (!node || seen.has(node.taxonomy_id)) return;
        seen.add(node.taxonomy_id);
        for (const m of node.members || []) {
            if (m.taxonomy) collect(m.taxonomy, seen);
            else if (m.doc_id) filedIds.add(m.doc_id);
        }
    };
    collect(tree, new Set());
    const top = tree ? (tree.members || []).filter((m) => !m.taxonomy && m.doc_id && isPage(m.doc_id)).map((m) => m.doc_id) : [];
    if (top.length) return top[0];
    const loose = docs.map((d) => d.doc_id).filter((id) => !filedIds.has(id) && isPage(id)).sort();
    if (loose.length) return loose[0];
    const walk = (node, seen) => {
        if (!node || seen.has(node.taxonomy_id)) return null;
        seen.add(node.taxonomy_id);
        for (const m of node.members || []) {
            if (!m.taxonomy || !m.taxonomy.members || (hidden && hidden.has(`sec:${m.taxonomy.taxonomy_id}`))) continue;
            for (const x of m.taxonomy.members || []) if (!x.taxonomy && x.doc_id && isPage(x.doc_id)) return x.doc_id;
            const deeper = walk(m.taxonomy, seen);
            if (deeper) return deeper;
        }
        return null;
    };
    return walk(tree, new Set());
}

/// The book in reading order (BOOKS.md slice 4): every page depth-first with the trail of
/// section titles above it - what the reader's tree, prev/next, and "up" all walk.
export function readingOrder(book) {
    const out = [];
    const walk = (section, trail) => {
        for (const p of section.pages) out.push({ post: p.post, title: p.title, trail });
        for (const s of section.sections) walk(s, [...trail, s.title]);
    };
    if (book) walk({ pages: book.pages, sections: book.sections }, []);
    return out;
}

/// A page's neighbours in reading order: `{ index, prev, next }` (prev/next are entries or
/// null); index -1 when the page is not in the book.
export function neighbours(book, post) {
    const order = readingOrder(book);
    const index = order.findIndex((p) => p.post === post);
    if (index < 0) return { index, prev: null, next: null, order };
    return { index, prev: index > 0 ? order[index - 1] : null, next: index + 1 < order.length ? order[index + 1] : null, order };
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
