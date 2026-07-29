// Cozy addresses: `/home/<bucket>/<section>/<section>/<slugified-title>` as a human-readable
// pointer to a document, DERIVED from what already exists - bucket names, taxonomy-section
// titles, doc titles - with no register to maintain. This is deliberately NOT the plan's
// author-owned slug register (PROJECT_PLAN, Slugs - a public LWW namespace for the `ringtome://`
// face, still future): that one is a publication surface; this one is the private working-form
// convenience, in the same spirit ("pointers, never authority") but computed, not curated.
//
// The rules, stated once:
//   - the FIRST segment names the notebook: an app id (its home bucket) or a slugified bucket
//     name; middle segments are slugified section titles walked strictly down the bucket's
//     tree; the LAST is the slugified doc title.
//   - a 32-hex last segment is already canonical and resolves directly (the escape hatch, and
//     what untitled documents fall back to).
//   - TIES resolve to the lowest id (doc or taxonomy) - deterministic, stable, boring.
//   - when the strict tree walk misses, the resolver retries bucket-wide by title alone, so a
//     document dragged to a new section keeps its old links working (a pointer, not a fact).
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';

import { openMirror, useLive } from './cache.js';
import { appById, appForStyle, appTypeOf, DEFAULT_STYLE } from './apps.js';
import { rootTitleFor } from './tree.js';

async function api(path, options = {}) {
    const res = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
        ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(body.message || `request failed (${res.status})`);
    }
    return body;
}

export const HEX_ID = /^[0-9a-f]{32}$/;

/// The slugifier: lowercase, letter/number runs kept (any script), everything else a hyphen.
/// "I Love Bacon" -> "i-love-bacon". Empty in, empty out (the caller falls back to the id).
export const slugify = (s) =>
    (s || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');

// The bucket a first segment names, or null. App ids win (their home bucket); then slugified
// bucket names off the roster.
function bucketFor(seg, roster) {
    const app = appById(seg);
    if (app && app.style) return { name: app.style, app };
    const row = (roster || []).find((b) => slugify(b.name) === seg);
    if (!row) return null;
    return { name: row.name, app: appForStyle(appTypeOf(row.name, roster)) };
}

// The bucket's tree, fetched whole, or null when the bucket has none (or the fetch fails -
// the caller falls back to bucket-wide resolution either way).
async function treeFor(root, bucketName) {
    const tax = await openMirror(root).taxonomies.toArray();
    const rootRow = tax
        .filter((t) => t.title === rootTitleFor(bucketName))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    if (!rootRow) return null;
    try {
        return await api(`/api/identity/${root}/taxonomies/${rootRow.taxonomy_id}`);
    } catch {
        return null;
    }
}

/**
 * Resolve a cozy path (segments after `/home`) to `{ appId, docId }`, or null. Strict tree
 * walk first, bucket-wide title fallback second, lowest-id ties throughout.
 */
export async function resolveSlugPath(root, segs) {
    const parts = segs.filter(Boolean).map((s) => decodeURIComponent(s));
    if (parts.length < 2) return null;
    const db = openMirror(root);
    const found = bucketFor(parts[0], await db.buckets.toArray());
    if (!found || !found.app) return null;
    const { name: bucketName, app } = found;
    const last = parts[parts.length - 1];
    const mids = parts.slice(1, -1);

    // The id escape hatch: a canonical tail needs no resolving.
    if (HEX_ID.test(last)) return { appId: app.id, docId: last };

    // Strict: walk the tree by slugified section titles, then match the leaf title.
    if (mids.length) {
        const tree = await treeFor(root, bucketName);
        if (tree) {
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
                const hit = (node.members || [])
                    .filter((m) => m.doc && slugify(m.doc.title || '') === last)
                    .map((m) => m.doc_id)
                    .sort()[0];
                if (hit) return { appId: app.id, docId: hit };
            }
        }
    }

    // Forgiving: anywhere in the bucket by title alone (a moved doc keeps its links working).
    const docs = await db.docs.toArray();
    const hit = docs
        .filter((d) => (d.buckets || []).includes(bucketName))
        .filter((d) => slugify(d.title || '') === last)
        .map((d) => d.doc_id)
        .sort()[0];
    return hit ? { appId: app.id, docId: hit } : null;
}

/**
 * The canonical cozy path FOR a document - what the copy-link chip writes:
 * `/home/<bucket>/<sections...>/<slug>`. Home buckets wear their app id; the tree path is the
 * doc's first occurrence; a slug that would lose its own tie (an earlier-id sibling shares it),
 * or an empty title, falls back to the honest id tail.
 */
export async function slugPathFor(root, docId, bucket) {
    const db = openMirror(root);
    const row = await db.docs.get(docId);
    if (!row) return null;
    const roster = await db.buckets.toArray();
    const bucketName =
        bucket && (row.buckets || []).includes(bucket)
            ? bucket
            : (row.buckets || [])[0] || DEFAULT_STYLE;
    const app = appForStyle(appTypeOf(bucketName, roster));
    const head = app && bucketName === app.style ? app.id : slugify(bucketName);
    if (!head) return null;

    // The doc's first-occurrence path down the tree (empty when unfiled or treeless).
    const tree = await treeFor(root, bucketName);
    let pathTitles = null;
    let homeNode = tree; // the node whose siblings decide the slug's tie
    if (tree) {
        const walk = (n, trail) => {
            for (const m of n.members || []) {
                if (m.taxonomy) {
                    if (m.taxonomy.members) {
                        const found = walk(m.taxonomy, [...trail, m.taxonomy]);
                        if (found) return found;
                    }
                } else if (m.doc_id === docId) {
                    return trail;
                }
            }
            return null;
        };
        const trail = walk(tree, []);
        if (trail) {
            pathTitles = trail.map((t) => slugify(t.title)).filter(Boolean);
            homeNode = trail.length ? trail[trail.length - 1] : tree;
        }
    }

    const slug = slugify(row.title || '');
    // Would this slug resolve back to US? Ties go to the lowest id; if a sibling beats this
    // doc, the honest tail is the id.
    let tail = slug;
    if (slug) {
        const rivals =
            pathTitles !== null && homeNode
                ? (homeNode.members || [])
                      .filter((m) => m.doc && slugify(m.doc.title || '') === slug)
                      .map((m) => m.doc_id)
                : (await db.docs.toArray())
                      .filter((d) => (d.buckets || []).includes(bucketName))
                      .filter((d) => slugify(d.title || '') === slug)
                      .map((d) => d.doc_id);
        if (rivals.sort()[0] !== docId) tail = docId;
    } else {
        tail = docId;
    }
    const midPath = pathTitles && pathTitles.length ? `/${pathTitles.join('/')}` : '';
    return `/home/${head}${midPath}/${tail}`;
}

/**
 * The app-route shim: `/home/<app>/<something-not-hex>` means the something is a slug, not a
 * doc id. Resolves it (against the app's home bucket) to the EFFECTIVE doc id WITHOUT
 * redirecting - cozy URLs are the resting form, the hex id stays an implementation detail.
 * Returns the hex id (immediately for a hex param, after resolution for a slug; null while
 * resolving or when nothing matches).
 */
export function useSlugDocId(root, appId, docId) {
    const [resolved, setResolved] = useState(null);
    useEffect(() => {
        setResolved(null);
        if (!docId || HEX_ID.test(docId)) return;
        let alive = true;
        resolveSlugPath(root, [appId, docId])
            .then((hit) => {
                if (alive) setResolved(hit ? hit.docId : null);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, appId, docId]);
    if (!docId) return null;
    return HEX_ID.test(docId) ? docId : resolved;
}

/**
 * The address-bar dressing: while a document is open, the URL wears its cozy address. When the
 * computed path differs from the current one (a hex URL from a click, an off-canonical slug, a
 * RENAME landing), it's REPLACED - no history litter, and a no-op once the URL already matches,
 * so the loop terminates. The doc's live mirror row is a dependency, so retitling re-dresses
 * the address the moment the save echoes back. (Section renames and drag-moves still update on
 * the next navigation; the resolver's forgiving pass covers any stale form meanwhile.)
 */
export function useCozyAddress(root, selected, bucket) {
    const loc = useLocation();
    const row = useLive(
        () => (selected && HEX_ID.test(selected) ? openMirror(root).docs.get(selected) : null),
        [root, selected]
    );
    const liveTitle = (row && row.title) || '';
    useEffect(() => {
        if (!selected || !HEX_ID.test(selected)) return;
        let alive = true;
        slugPathFor(root, selected, bucket)
            .then((p) => {
                if (alive && p && loc.path !== p) loc.route(p, true);
            })
            .catch(() => {});
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, selected, bucket, loc.path, liveTitle]);
}
