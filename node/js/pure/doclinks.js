// A note's links, both ways (the Writer's Links column, 2026-09-30): read off the search rows the
// node streams to the mirror, where each row carries the links its body makes (bake.rs
// `doc_links`) - `doc` set on a link that is one of the persona's own documents.

/// The documents whose bodies link to `docId`, newest-titled first as the caller sorts them - not
/// the note itself, and each once however many times it links.
export const incomingTo = (rows, docId) =>
    docId
        ? (rows || [])
              .filter((r) => r.doc_id !== docId && (r.links || []).some((l) => l.doc === docId))
              .map((r) => r.doc_id)
        : [];

/// What `docId`'s own body links to, in its order, each place once (Curtis, 2026-09-30: "de-dupe
/// links in this list"): one of your notes is one row however many ways it was addressed (with a
/// notebook hint, without, the old `/home/…` path), and anywhere else is one row per address, a
/// trailing slash aside. The first link to a place wins, words and all.
export const outgoingOf = (rows, docId) => {
    const row = docId && (rows || []).find((r) => r.doc_id === docId);
    const seen = new Set();
    return ((row && row.links) || []).filter((l) => {
        const key = l.doc ? `doc:${l.doc}` : (l.to || '').replace(/\/+$/, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

/// How a link to somewhere else reads when it wore no words: the web's host and path, less the
/// scheme, or the target as written.
export const linkLabel = (link) => {
    if (link.text) return link.text;
    const m = /^https?:\/\/(.+)$/.exec(link.to || '');
    return m ? m[1].replace(/\/$/, '') : link.to;
};
