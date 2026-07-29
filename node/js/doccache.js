// The read-your-cache layer: GET responses (doc details, expanded taxonomy trees) kept in the
// Dexie mirror beside the streamed rows that VOUCH for their freshness. Opening a document
// you've seen paints instantly from disk; the network runs only when the stream says a new
// copy exists - the same contract the doc headers and annotations already live by, extended
// to the bodies and tree shapes that used to fetch (and flash "opening…") on every click.
//
// The freshness handshake, stated once:
//   - a cached doc detail is stamped with the live docs row's fingerprint
//     (`head:heads:diverged` - the same trio the divergence lookout watches); it's served only
//     while the row still matches. A save, a sync, a resolution - anything that mints a new
//     copy - moves the fingerprint, and the stale cache entry simply stops matching.
//   - a cached tree is stamped with the taxonomy-ROSTER fingerprint (every taxonomy's id,
//     title, and member count): coarse on purpose - any taxonomy change invalidates every
//     cached tree - because trees span taxonomies and the roster is the only streamed signal.
//   - stamps can lag mid-race (a fetch landing while the stream catches up); the next roster
//     or row tick mismatches the stamp and forces one honest refetch. Self-healing, never
//     silently stale beyond a stream beat.
import { openMirror } from './cache.js';

/// The doc row's freshness fingerprint - the same trio `needsReload` watches (lookout.js).
export const docFingerprint = (row) =>
    row ? `${row.head}:${row.heads}:${row.diverged ? 1 : 0}` : null;

/// The taxonomy roster's fingerprint - shared by every tree consumer so stamps agree.
export const rosterFingerprint = (taxRows) =>
    (taxRows || []).map((t) => `${t.taxonomy_id}:${t.title}:${t.members}`).join(',');

/// The cached doc detail, IF it's current per the live mirror row; null means fetch.
export async function cachedDoc(root, docId) {
    try {
        const db = openMirror(root);
        const [row, hit] = await Promise.all([db.docs.get(docId), db.docdetails.get(docId)]);
        if (!row || !hit || hit.fp !== docFingerprint(row)) return null;
        return hit.doc;
    } catch {
        return null;
    }
}

/// Remember a fresh GET response. A null body (blobs still travelling) is never remembered -
/// the waiting room must keep asking the node, not the cache.
export async function rememberDoc(root, docId, doc) {
    try {
        if (!doc || doc.body == null) return;
        const db = openMirror(root);
        const row = await db.docs.get(docId);
        if (!row) return;
        await db.docdetails.put({ doc_id: docId, fp: docFingerprint(row), doc });
    } catch {
        /* a cache that fails to write is just a cache miss later */
    }
}

/// The cached expanded tree, IF its roster stamp still matches; null means fetch.
export async function cachedTree(root, taxonomyId, fingerprint) {
    try {
        const hit = await openMirror(root).trees.get(taxonomyId);
        return hit && hit.fp === fingerprint ? hit.tree : null;
    } catch {
        return null;
    }
}

/// Remember a freshly fetched tree under the roster stamp it was fetched beside.
export async function rememberTree(root, taxonomyId, fingerprint, tree) {
    try {
        await openMirror(root).trees.put({ taxonomy_id: taxonomyId, fp: fingerprint, tree });
    } catch {
        /* miss later */
    }
}
