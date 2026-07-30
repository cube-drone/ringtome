// The shell around doc/naming.js: gather the rows the pure rules want (the bucket roster, the doc
// rows, the bucket's expanded tree), call them, and wire the two hooks that keep the address bar
// honest. Everything decision-shaped lives next door and is tested without a browser; everything
// here is fetching and effects.
import { useEffect, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';

import { api } from '../net.js';
import { openMirror, useLive } from '../mirror.js';
import { cachedTree, rememberTree, rosterFingerprint } from '../mirror/doccache.js';
import {
    HEX_ID,
    bucketFor,
    bucketNameFor,
    buildSlugPath,
    matchSlugPath,
    needsTree,
    pathSegments,
    rootTitleFor,
} from './naming.js';

// The bucket's tree, cache-first (mirror/doccache.js - resolution and link-generation ride the same
// fingerprinted cache as the tree pane), fetched when the roster stamp says it moved, or null when
// the bucket has no tree (the rules fall back to bucket-wide resolution either way).
async function treeFor(root, bucketName) {
    const tax = await openMirror(root).taxonomies.toArray();
    const rootRow = tax
        .filter((t) => t.title === rootTitleFor(bucketName))
        .sort((a, b) => (a.taxonomy_id < b.taxonomy_id ? -1 : 1))[0];
    if (!rootRow) return null;
    const fp = rosterFingerprint(tax);
    const hit = await cachedTree(root, rootRow.taxonomy_id, fp);
    if (hit) return hit;
    try {
        const tree = await api(`/api/identity/${root}/taxonomies/${rootRow.taxonomy_id}`);
        rememberTree(root, rootRow.taxonomy_id, fp, tree);
        return tree;
    } catch {
        return null;
    }
}

/// Resolve a cozy path (segments after `/home`) to `{ appId, docId }`, or null. The rules are in
/// naming.js; this reads the roster first so it knows which bucket's tree to ask for - and skips
/// the tree entirely when the path can't need one.
export async function resolveSlugPath(root, segs) {
    const parts = pathSegments(segs);
    if (parts.length < 2) return null;
    const db = openMirror(root);
    const roster = await db.buckets.toArray();
    const found = bucketFor(parts[0], roster);
    if (!found || !found.app) return null;
    const tree = needsTree(parts) ? await treeFor(root, found.name) : null;
    const docs = await db.docs.toArray();
    return matchSlugPath(parts, { roster, docs, tree });
}

/// The canonical cozy path FOR a document - what the copy-link chip writes, and what the address
/// bar settles on. Null when the document isn't in the mirror.
export async function slugPathFor(root, docId, bucket) {
    const db = openMirror(root);
    const row = await db.docs.get(docId);
    if (!row) return null;
    const roster = await db.buckets.toArray();
    const tree = await treeFor(root, bucketNameFor(row, bucket));
    const docs = await db.docs.toArray();
    return buildSlugPath(row, { roster, docs, tree, bucket });
}

/**
 * The app-route shim: `/home/<app>/<something-not-hex>` means the something is a slug, not a doc
 * id. Resolves it (against the app's home bucket) to the EFFECTIVE doc id WITHOUT redirecting -
 * cozy URLs are the resting form, the hex id stays an implementation detail. Returns the hex id
 * (immediately for a hex param, after resolution for a slug; null while resolving or when nothing
 * matches).
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
 * RENAME landing), it's REPLACED - no history litter, and a no-op once the URL already matches, so
 * the loop terminates. The doc's live mirror row is a dependency, so retitling re-dresses the
 * address the moment the save echoes back. (Section renames and drag-moves still update on the
 * next navigation; the resolver's forgiving pass covers any stale form meanwhile.)
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
