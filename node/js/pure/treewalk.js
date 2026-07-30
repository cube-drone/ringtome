// Walking a document tree, as pure functions over the shape the node hands back from
// `GET /taxonomies/{root}`: a node is `{ taxonomy_id, title, members }`, and a member is either
// `{ doc_id, taxonomy }` (a section) or `{ doc_id, doc }` (a document leaf). Two wrinkles the shape
// carries and every walk below has to respect:
//
//   - a section member with NO `members` is a STUB: the section appears here for a second time (a
//     diamond's other parent, or a merge-minted cycle) and its expansion lives at its first
//     encounter. Never recurse into one, or a cycle walks forever.
//   - a leaf member with no `doc` is a DANGLING reference - a deleted document, or another
//     identity's, which the tree can represent but not render. Whether that counts depends on the
//     question being asked, which is why `flatDocs` and `filedDocIds` disagree on purpose.
//
// These were seven closures written inline across doc/tree.js and pure/naming.js, each subtly its
// own dialect. Pure and gathered here, they are testable without a browser - which matters most for
// the drop-index arithmetic at the bottom, the fiddliest three lines in the drag.

/// Every document in the tree, in the depth-first order a reader would meet them - the "book
/// order" that prev/next and the arrow keys walk. First occurrence only, so a diamond-placed
/// document reads once. Renderable leaves only: a dangling reference is not a page you can turn to.
export function flatDocs(node, out = [], seen = new Set()) {
    for (const m of (node && node.members) || []) {
        if (m.taxonomy) {
            if (m.taxonomy.members) flatDocs(m.taxonomy, out, seen);
        } else if (m.doc && !seen.has(m.doc_id)) {
            seen.add(m.doc_id);
            out.push(m.doc_id);
        }
    }
    return out;
}

/// The sections between the root and a document's FIRST occurrence, outermost first - or null if
/// the tree doesn't hold it. An empty array means "a direct member of the root". Used both to spell
/// a document's cozy path and to unfold its ancestors when the selection arrives inside them.
export function pathToDoc(node, docId, trail = []) {
    for (const m of (node && node.members) || []) {
        if (m.taxonomy) {
            if (m.taxonomy.members) {
                const found = pathToDoc(m.taxonomy, docId, [...trail, m.taxonomy]);
                if (found) return found;
            }
        } else if (m.doc_id === docId) {
            return trail;
        }
    }
    return null;
}

/// A section and every section beneath it, by id - what a delete takes down, and what a drag may
/// not be dropped into (its own subtree would make a cycle; the server refuses it too, and this
/// keeps the drop from even offering).
export function sectionIdsUnder(node) {
    const ids = [];
    const collect = (n) => {
        ids.push(n.taxonomy_id);
        for (const m of n.members || []) {
            if (m.taxonomy && m.taxonomy.members) collect(m.taxonomy);
        }
    };
    if (node) collect(node);
    return ids;
}

/// Every document id the tree MENTIONS, dangling references included - the question is "does the
/// tree already account for this?", so an id it holds counts even if nothing renders for it. The
/// complement against a bucket's documents is the unfiled bin.
export function filedDocIds(node) {
    const filed = new Set();
    const sweep = (n) => {
        for (const m of n.members || []) {
            if (m.taxonomy) {
                if (m.taxonomy.members) sweep(m.taxonomy);
            } else {
                filed.add(m.doc_id);
            }
        }
    };
    if (node) sweep(node);
    return filed;
}

/// The documents that live ONLY inside the given sections - the ones a delete would orphan, and so
/// the ones that must be re-placed before it. A document also filed elsewhere (a diamond) is left
/// alone: its other home keeps it in the tree already.
export function docsInsideOnly(tree, sectionIds) {
    const doomed = new Set(sectionIds);
    const inside = new Set();
    const outside = new Set();
    const walk = (n, inSub) => {
        const here = inSub || doomed.has(n.taxonomy_id);
        for (const m of n.members || []) {
            if (m.taxonomy) {
                if (m.taxonomy.members) walk(m.taxonomy, here);
            } else if (m.doc) {
                (here ? inside : outside).add(m.doc_id);
            }
        }
    };
    if (tree) walk(tree, false);
    for (const id of outside) inside.delete(id);
    return inside;
}

/**
 * Where a dragged member lands: the index to send with the member PUT, or undefined for "append".
 *
 * The PUT's contract is that the position is counted WITHOUT the dragged member itself, which is
 * the whole subtlety - dragging something down its own list would otherwise land it one short. A
 * reference the list doesn't hold means append rather than guess.
 *
 * @param members  the destination section's members, in their current order
 * @param dragId   the member being dragged (excluded from the count)
 * @param refId    the member it was dropped against
 * @param after    dropped on the reference's bottom half
 */
export function dropIndex(members, dragId, refId, after) {
    const order = (members || []).map((m) => m.doc_id).filter((id) => id !== dragId);
    const i = order.indexOf(refId);
    if (i === -1) return undefined;
    return after ? i + 1 : i;
}
