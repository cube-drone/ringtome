// The shell around pure/naming.js's cozy-path rules: gather the rows they want (the bucket roster,
// the doc rows, the bucket's expanded tree) and resolve a cozy path. Since 2026-09-28 the app
// navigates at `/ringtome/` addresses and mints none of these; what is left reads the old `/home`
// and `/in` links that documents written before then still hold (index.js `LegacyHome`).
import { api } from '../net.js';
import { openMirror } from '../mirror.js';
import { cachedTree, rememberTree, rosterFingerprint } from '../mirror/doccache.js';
import {
    bucketFor,
    matchSlugPath,
    needsTree,
    pathSegments,
    rootTitleFor,
} from '../pure/naming.js';

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
export async function resolveSlugPath(root, segs, { cozy = false } = {}) {
    const parts = pathSegments(segs);
    if (parts.length < 1) return null;
    const db = openMirror(root);
    const roster = await db.buckets.toArray();
    const found = bucketFor(parts[0], roster, { cozy });
    if (!found || !found.app) return null;
    if (parts.length === 1) return { appId: found.app.id, docId: null }; // the bucket's own list
    const tree = needsTree(parts) ? await treeFor(root, found.name) : null;
    const docs = await db.docs.toArray();
    return matchSlugPath(parts, { roster, docs, tree }, { cozy });
}
