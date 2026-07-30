// Walking a document tree. Seven closures written inline across two modules until 2026-07-30, each
// its own dialect about the two wrinkles in the shape: a STUB section (a second placement, carrying
// no members - recursing into one walks a cycle forever) and a DANGLING leaf (a member whose
// document is gone or belongs to someone else). Gathered, pure, and now pinned.
//
// `dropIndex` is the reason this file matters most: three lines of arithmetic that decide where a
// dragged page lands, counted WITHOUT the dragged member, and previously unexercised.
const assert = require('node:assert');

let flatDocs, pathToDoc, sectionIdsUnder, filedDocIds, docsInsideOnly, dropIndex;
before(async () => {
    ({ flatDocs, pathToDoc, sectionIdsUnder, filedDocIds, docsInsideOnly, dropIndex } =
        await import('../../../js/pure/treewalk.js'));
});

const sec = (id, members, title = id) => ({ taxonomy_id: id, title, members });
const stub = (id, title = id) => ({ taxonomy_id: id, title }); // no members: a second placement
const inTree = (t) => ({ doc_id: t.taxonomy_id, taxonomy: t });
const leaf = (docId, title = docId) => ({ doc_id: docId, doc: { title } });
const dangling = (docId) => ({ doc_id: docId }); // no `doc`: deleted, or another identity's

//        root
//        ├── starters ── d1, cold ── d2
//        ├── mains ── d3, d1 (a diamond: d1's second placement)
//        └── d4
const TREE = sec('root', [
    inTree(sec('starters', [leaf('d1'), inTree(sec('cold', [leaf('d2')]))])),
    inTree(sec('mains', [leaf('d3'), leaf('d1')])),
    leaf('d4'),
]);

describe('flatDocs (the book order)', () => {
    it('reads documents in the order a reader would meet them', () => {
        assert.deepEqual(flatDocs(TREE), ['d1', 'd2', 'd3', 'd4']);
    });

    it('reads a diamond-placed document once, at its first occurrence', () => {
        assert.equal(flatDocs(TREE).filter((id) => id === 'd1').length, 1);
    });

    it('skips a dangling reference - it is not a page you can turn to', () => {
        const t = sec('root', [leaf('a'), dangling('gone'), leaf('b')]);
        assert.deepEqual(flatDocs(t), ['a', 'b']);
    });

    it('does not descend into a stub, and cannot loop on one', () => {
        const t = sec('root', [inTree(stub('starters')), leaf('a')]);
        assert.deepEqual(flatDocs(t), ['a']);
    });

    it('is empty for an empty or absent tree', () => {
        assert.deepEqual(flatDocs(sec('root', [])), []);
        assert.deepEqual(flatDocs(null), []);
        assert.deepEqual(flatDocs({ taxonomy_id: 'root' }), []);
    });
});

describe('pathToDoc', () => {
    it('gives the sections down to the document, outermost first', () => {
        assert.deepEqual(pathToDoc(TREE, 'd2').map((t) => t.taxonomy_id), ['starters', 'cold']);
    });

    it('gives an empty trail for a direct member of the root', () => {
        assert.deepEqual(pathToDoc(TREE, 'd4'), []);
    });

    it('gives the FIRST occurrence of a diamond', () => {
        assert.deepEqual(pathToDoc(TREE, 'd1').map((t) => t.taxonomy_id), ['starters']);
    });

    it('is null - not empty - when the tree does not hold it', () => {
        assert.equal(pathToDoc(TREE, 'nobody'), null);
        assert.equal(pathToDoc(null, 'd1'), null);
    });

    it('finds a dangling member by id (the tree still mentions it)', () => {
        const t = sec('root', [inTree(sec('s', [dangling('gone')]))]);
        assert.deepEqual(pathToDoc(t, 'gone').map((x) => x.taxonomy_id), ['s']);
    });
});

describe('sectionIdsUnder', () => {
    it('includes the section itself, then everything beneath it', () => {
        assert.deepEqual(sectionIdsUnder(TREE), ['root', 'starters', 'cold', 'mains']);
    });

    it('is just the section when it has no sub-sections', () => {
        assert.deepEqual(sectionIdsUnder(sec('lonely', [leaf('a')])), ['lonely']);
    });

    it('does not count a stub as a subtree to walk', () => {
        const t = sec('root', [inTree(stub('elsewhere'))]);
        assert.deepEqual(sectionIdsUnder(t), ['root']);
    });

    it('is empty for no section at all', () => {
        assert.deepEqual(sectionIdsUnder(null), []);
    });
});

describe('filedDocIds', () => {
    it('collects every document the tree holds, at any depth', () => {
        assert.deepEqual([...filedDocIds(TREE)].sort(), ['d1', 'd2', 'd3', 'd4']);
    });

    it('counts a DANGLING reference as filed - the tree accounts for it either way', () => {
        // Deliberately unlike flatDocs: the question here is "is this already in the tree?", and
        // an id the tree mentions is, whether or not anything renders for it.
        assert.ok(filedDocIds(sec('root', [dangling('gone')])).has('gone'));
    });

    it('is empty for an empty or absent tree', () => {
        assert.equal(filedDocIds(null).size, 0);
        assert.equal(filedDocIds(sec('root', [])).size, 0);
    });
});

describe('docsInsideOnly (what a delete would orphan)', () => {
    it('lists the documents that live only inside the doomed sections', () => {
        assert.deepEqual([...docsInsideOnly(TREE, ['cold'])], ['d2']);
    });

    it('spares a diamond - its other home keeps it in the tree', () => {
        // d1 is in `starters` AND `mains`; deleting starters does not orphan it.
        assert.deepEqual([...docsInsideOnly(TREE, ['starters'])], ['d2']);
    });

    it('takes sub-sections into account when the whole subtree goes', () => {
        assert.deepEqual([...docsInsideOnly(TREE, ['starters', 'cold'])], ['d2']);
        assert.deepEqual([...docsInsideOnly(TREE, ['mains'])], ['d3']);
    });

    it('is empty when nothing is doomed, or nothing is inside', () => {
        assert.equal(docsInsideOnly(TREE, []).size, 0);
        assert.equal(docsInsideOnly(TREE, ['no-such-section']).size, 0);
        assert.equal(docsInsideOnly(null, ['cold']).size, 0);
    });
});

describe('dropIndex (where a dragged member lands)', () => {
    // Four members, and we drag the first one about.
    const members = [leaf('a'), leaf('b'), leaf('c'), leaf('d')];

    it('counts the position WITHOUT the dragged member', () => {
        // Dragging `a` onto the top half of `c`: with `a` removed the list is [b, c, d], so `c` is
        // at 1. Counting with `a` still in would have said 2 and landed it one place too low.
        assert.equal(dropIndex(members, 'a', 'c', false), 1);
        assert.equal(dropIndex(members, 'a', 'c', true), 2);
    });

    it('puts a before-drop at the reference s index and an after-drop just past it', () => {
        assert.equal(dropIndex(members, 'd', 'b', false), 1);
        assert.equal(dropIndex(members, 'd', 'b', true), 2);
    });

    it('handles a member arriving from ANOTHER section (nothing to exclude)', () => {
        assert.equal(dropIndex(members, 'stranger', 'a', false), 0);
        assert.equal(dropIndex(members, 'stranger', 'd', true), 4);
    });

    it('appends - undefined - when the reference is not in this list', () => {
        assert.equal(dropIndex(members, 'a', 'nobody', false), undefined);
        assert.equal(dropIndex([], 'a', 'b', false), undefined);
        assert.equal(dropIndex(undefined, 'a', 'b', false), undefined);
    });

    it('drops onto the top of the list as index 0', () => {
        assert.equal(dropIndex(members, 'c', 'a', false), 0);
    });
});
