/*
    The drawing's image picker (node/js/pure/imagepick.js): only pictures, newest-added first; a
    notebook, words in the title and tags each narrow it, stacking; the tag cloud narrows with the
    search but not with the tags already picked; and the notebook menu lists every notebook holding a
    picture, whatever is being searched.
*/
const assert = require('node:assert');

let p;
before(async () => {
    p = await import('../../../js/pure/imagepick.js');
});

const media = { width: 640, height: 480, has_thumb: true };
const pic = (doc_id, title, created_ms, extra = {}) => ({ doc_id, title, format: 'avif', media, created_ms, updated_ms: created_ms, tags: [], buckets: [], ...extra });
const docs = () => [
    pic('a1', 'Horse in a field', 1000, { tags: ['horse', 'ref'], buckets: ['refs'] }),
    pic('a2', 'Grey HORSE', 3000, { tags: ['horse'], buckets: ['refs', 'barn'], updated_ms: 1 }),
    pic('a3', 'Barn at dusk', 2000, { tags: ['barn'], buckets: ['barn'] }),
    pic('a4', 'loop', 4000, { format: 'apng' }),
    { doc_id: 'n1', title: 'horse notes', format: 'marquee', created_ms: 9000, tags: ['horse'], buckets: ['refs'] },
    { doc_id: 'v1', title: 'horse video', format: 'webm', media, created_ms: 9000 },
    pic('x1', 'no size yet', 9000, { media: { width: null, height: null } }),
];
const ids = (r) => r.pictures.map((d) => d.doc_id);

describe('the image picker', () => {
    it('offers only pictures with a known size, newest-added first', () => {
        assert.deepEqual(ids(p.pickPictures(docs())), ['a4', 'a2', 'a3', 'a1'], 'an edit (updated_ms) does not reorder');
    });

    it('narrows by notebook, by every word of the title, and by every picked tag', () => {
        assert.deepEqual(ids(p.pickPictures(docs(), { bucket: 'barn' })), ['a2', 'a3']);
        assert.deepEqual(ids(p.pickPictures(docs(), { query: '  horse  FIELD ' })), ['a1'], 'case and order do not matter');
        assert.deepEqual(ids(p.pickPictures(docs(), { tags: ['horse', 'ref'] })), ['a1']);
        assert.deepEqual(ids(p.pickPictures(docs(), { bucket: 'refs', query: 'horse', tags: ['horse'] })), ['a2', 'a1']);
    });

    it('counts the tag cloud before the picked tags, and keeps every notebook on the menu', () => {
        const r = p.pickPictures(docs(), { query: 'horse', tags: ['ref'] });
        assert.deepEqual(r.tags, [['horse', 2], ['ref', 1]], 'what could still be added, over the search');
        assert.deepEqual(r.buckets, ['barn', 'refs'], 'notebooks with pictures, not with notes');
    });
});
