/*
    A drawing's flat copy, reused (node/js/pure/flatcopy.js): the same drawing at the same version
    finds the copy it already has; a new version, or another drawing, does not.
*/
const assert = require('node:assert');

let f;
before(async () => {
    f = await import('../../../js/pure/flatcopy.js');
});

describe("a drawing's flat copy", () => {
    const copy = (doc_id, from, version) => ({ doc_id, format: 'avif', fields: { [f.FLAT_FROM]: from, [f.FLAT_VERSION]: version } });

    it('names a version by its heads, in any order', () => {
        assert.equal(f.flatVersion({ save_parents: ['b2', 'a1'] }), 'a1,b2');
        assert.equal(f.flatVersion({ save_parents: ['a1', 'b2'] }), f.flatVersion({ save_parents: ['b2', 'a1'] }));
        assert.equal(f.flatVersion({}), '');
    });

    it('finds the copy of the same drawing at the same version, and nothing else', () => {
        const docs = [copy('p1', 'drawA', 'v1'), copy('p2', 'drawA', 'v2'), copy('p3', 'drawB', 'v1'), { doc_id: 'n1', fields: {} }];
        assert.equal(f.findFlatCopy(docs, 'drawA', 'v2').doc_id, 'p2');
        assert.equal(f.findFlatCopy(docs, 'drawA', 'v3'), null, 'changed since: a fresh copy');
        assert.equal(f.findFlatCopy(docs, 'drawC', 'v1'), null);
        assert.equal(f.findFlatCopy(docs, 'drawA', ''), null, 'no version, no guess');
    });
});
