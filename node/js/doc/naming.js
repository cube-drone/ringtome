// The naming and addressing conventions, as pure rules: how a title becomes a slug, how a slug
// path resolves to a document, what path a document should wear, what a bucket's tree root is
// titled, and what extension a media format goes by. Values in, values out - no mirror, no fetch,
// no hooks. Those live in doc/address.js, which is a thin shell that gathers the rows these
// functions want and hands them over.
//
// Cozy addresses: `/home/<bucket>/<section>/<section>/<slugified-title>` as a human-readable
// pointer to a document, DERIVED from what already exists - bucket names, taxonomy-section titles,
// doc titles - with no register to maintain. This is deliberately NOT the plan's author-owned slug
// register (PROJECT_PLAN, Slugs - a public LWW namespace for the `ringtome://` face, still
// future): that one is a publication surface; this one is the private working-form convenience, in
// the same spirit ("pointers, never authority") but computed, not curated.
//
// The rules, stated once:
//   - the FIRST segment names the notebook: an app id (its home bucket) or a slugified bucket
//     name; middle segments are slugified section titles walked strictly down the bucket's tree;
//     the LAST is the slugified doc title.
//   - a 32-hex last segment is already canonical and resolves directly (the escape hatch, and
//     what untitled documents fall back to).
//   - TIES resolve to the lowest id (doc or taxonomy) - deterministic, stable, boring.
//   - when the strict tree walk misses, the resolver retries bucket-wide by title alone, so a
//     document dragged to a new section keeps its old links working (a pointer, not a fact).
//
// The round trip is the contract these rules are tested against: `buildSlugPath` followed by
// `matchSlugPath` must return the document you started from, whatever the roster and tree look
// like - which is why `buildSlugPath` falls back to the honest id whenever a slug would lose its
// own tie. See integration/test/pure/naming.cjs.
import { appById, appForStyle, appTypeOf, DEFAULT_STYLE } from '../apps.js';
import { pathToDoc } from './treewalk.js';

export const HEX_ID = /^[0-9a-f]{32}$/;

/// What extension a media format goes by on a byte URL - decorative (the served Content-Type is
/// authoritative), but the renderer's kind sniff reads it, so it has to be right.
export const MEDIA_EXT = { avif: 'avif', apng: 'png', webm: 'webm', opus: 'ogg' };

/// The root taxonomy's title for a bucket's tree. The prefix keeps user-titled SECTIONS (also
/// taxonomies, also on the roster) from ever colliding with a root lookup. (`wiki:` even when
/// Notes wears the tree - it names the shape, and existing wikis already use it.)
export const rootTitleFor = (bucket) => `wiki:${bucket}`;

/// The slugifier: lowercase, letter/number runs kept (any script), everything else a hyphen.
/// "I Love Bacon" -> "i-love-bacon". Empty in, empty out (the caller falls back to the id).
export const slugify = (s) =>
    (s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');

/// Path segments (those after `/home`) as the resolver wants them: blanks dropped, percent-escapes
/// undone. Separate so the shell and the matcher cannot disagree about what a segment is.
export const pathSegments = (segs) => (segs || []).filter(Boolean).map((s) => decodeURIComponent(s));

/// The bucket a first segment names, or null. App ids win (their home bucket); then slugified
/// bucket names off the roster, ties to the lowest NAME.
///
/// The sort is deliberate. Two buckets can slugify alike ("My Book" and "my-book"), and the tie has
/// to break the same way every time or a cozy link resolves differently on different computers.
/// The roster happens to arrive name-keyed from the mirror, so a bare `find` picked the same row in
/// practice - but a pure function should not depend on its caller's ordering, and the module's
/// doctrine is that ties are deterministic and boring. (The colliding bucket's own links may still
/// resolve nowhere; a derived address is a pointer, never authority.)
export function bucketFor(seg, roster) {
    const app = appById(seg);
    if (app && app.style) return { name: app.style, app };
    const name = (roster || [])
        .map((b) => b.name)
        .filter((n) => slugify(n) === seg)
        .sort()[0];
    if (name === undefined) return null;
    return { name, app: appForStyle(appTypeOf(name, roster)) };
}

/// The bucket a document's path is built under: the notebook in view when the document is really
/// in it, else the document's first, else the default app's home (which gathers the unbucketed).
/// The shell reads this to know whose tree to fetch; `buildSlugPath` reads it to build the head.
/// One definition, because a disagreement between those two produces a path that cannot resolve.
export const bucketNameFor = (row, bucket) =>
    bucket && ((row && row.buckets) || []).includes(bucket)
        ? bucket
        : ((row && row.buckets) || [])[0] || DEFAULT_STYLE;

/// Does resolving this path need the bucket's tree? Only when there are middle segments to walk
/// and the tail isn't already canonical - so the shell can skip fetching a tree it won't read.
export const needsTree = (parts) =>
    parts.length > 2 && !HEX_ID.test(parts[parts.length - 1]);

/// The lowest of a set of ids, which is how every tie in here breaks.
const lowest = (ids) => ids.slice().sort()[0];

/**
 * Resolve a cozy path to `{ appId, docId }`, or null. Strict tree walk first, bucket-wide title
 * fallback second, lowest-id ties throughout.
 *
 * @param segs  the path segments after `/home` (raw; normalized in here)
 * @param rows  `{ roster, docs, tree }` - the bucket roster, every doc row, and the bucket's
 *              expanded tree (null when it has none, or when `needsTree` said not to bother)
 */
export function matchSlugPath(segs, { roster, docs, tree } = {}) {
    const parts = pathSegments(segs);
    if (parts.length < 2) return null;
    const found = bucketFor(parts[0], roster);
    if (!found || !found.app) return null;
    const { name: bucketName, app } = found;
    const last = parts[parts.length - 1];
    const mids = parts.slice(1, -1);

    // The id escape hatch: a canonical tail needs no resolving.
    if (HEX_ID.test(last)) return { appId: app.id, docId: last };

    // Strict: walk the tree by slugified section titles, then match the leaf title.
    if (mids.length && tree) {
        let node = tree;
        for (const seg of mids) {
            const next = (node.members || [])
                .filter((m) => m.taxonomy && m.taxonomy.members)
                .map((m) => m.taxonomy)
                .filter((t) => slugify(t.title) === seg)
                .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
            if (!next) {
                node = null;
                break;
            }
            node = next;
        }
        if (node) {
            const hit = lowest(
                (node.members || [])
                    .filter((m) => m.doc && slugify(m.doc.title || '') === last)
                    .map((m) => m.doc_id)
            );
            if (hit) return { appId: app.id, docId: hit };
        }
    }

    // Forgiving: anywhere in the bucket by title alone (a moved doc keeps its links working).
    const hit = lowest(
        (docs || [])
            .filter((d) => (d.buckets || []).includes(bucketName))
            .filter((d) => slugify(d.title || '') === last)
            .map((d) => d.doc_id)
    );
    return hit ? { appId: app.id, docId: hit } : null;
}

/**
 * The canonical cozy path FOR a document - what the copy-link chip writes:
 * `/home/<bucket>/<sections...>/<slug>`. Home buckets wear their app id; the tree path is the
 * doc's first occurrence; a slug that would lose its own tie (an earlier-id sibling shares it),
 * or an empty title, falls back to the honest id tail.
 *
 * @param row     the document's mirror row (doc_id, title, buckets)
 * @param rows    `{ roster, docs, tree }` as above; `bucket` is the notebook in view, which wins
 *                when the document is actually in it
 */
export function buildSlugPath(row, rows = {}) {
    if (!row) return null;
    const docId = row.doc_id;
    const bucketName = bucketNameFor(row, rows.bucket);
    const app = appForStyle(appTypeOf(bucketName, rows.roster));
    const head = app && bucketName === app.style ? app.id : slugify(bucketName);
    if (!head) return null;

    // The doc's first-occurrence path down the tree - but only when every section along it can be
    // SPELLED. A section titled "???" is legal and slugifies to nothing, so it cannot appear in a
    // path at all; a trail containing one is no trail.
    let mids = [];
    if (rows.tree) {
        const trail = pathToDoc(rows.tree, docId);
        if (trail && trail.length) {
            const titles = trail.map((t) => slugify(t.title));
            if (titles.every(Boolean)) mids = titles;
        }
    }

    // Is the pretty form usable? Ask the resolver, rather than reasoning about which tie is judged
    // in which scope. Those two answers have to agree exactly or a copied link opens the WRONG
    // document, and keeping them in sync by hand is how that bug got in: a section whose title
    // slugified away narrowed the tie without narrowing the path (found by the round-trip property,
    // 2026-07-29). One authority - matchSlugPath - and the invariant holds by construction.
    const slug = slugify(row.title || '');
    if (slug) {
        const pretty = [head, ...mids, slug];
        const hit = matchSlugPath(pretty, rows);
        if (hit && hit.docId === docId) return `/home/${pretty.join('/')}`;
    }
    // The honest tail: a canonical id resolves directly, whatever the sections say.
    return `/home/${[head, ...mids, docId].join('/')}`;
}
