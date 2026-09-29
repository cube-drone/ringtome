// hrseFiles™ browsed the way the picture picker is (2026-09-29): a notebook, then tags, then the
// files. The notebook narrows before the cloud is counted, so a tag is only offered where it finds
// something; the unfiled are a notebook of their own.
const assert = require('node:assert');

let browseFiles, UNFILED;
before(async () => {
    ({ browseFiles, UNFILED } = await import('../../../js/pure/filebrowse.js'));
});

const doc = (id, buckets, tags = []) => ({ doc_id: id, buckets, tags });
const docs = [
    doc('a', ['files'], ['horse', 'red']),
    doc('b', ['journal', 'files'], ['horse']),
    doc('c', [], ['stray']),
    doc('d', ['journal'], []),
];
const ids = (list) => list.map((d) => d.doc_id);

describe('browseFiles', () => {
    it('shows everything, offers every notebook by name, and knows there are strays', () => {
        const b = browseFiles(docs);
        assert.deepEqual(ids(b.files), ['a', 'b', 'c', 'd'], 'the order it was given');
        assert.deepEqual(b.notebooks, ['files', 'journal']);
        assert.equal(b.unfiled, true);
        assert.deepEqual(b.cloud, [['horse', 2], ['red', 1], ['stray', 1]]);
    });

    it('a notebook narrows the files and the cloud alike', () => {
        const b = browseFiles(docs, { notebook: 'journal' });
        assert.deepEqual(ids(b.files), ['b', 'd']);
        assert.deepEqual(b.cloud, [['horse', 1]], 'no tag offered that would find nothing here');
        assert.deepEqual(b.notebooks, ['files', 'journal'], 'the other notebooks stay on offer');
    });

    it('the unfiled are a notebook of their own', () => {
        assert.deepEqual(ids(browseFiles(docs, { notebook: UNFILED }).files), ['c']);
        assert.equal(browseFiles(docs.filter((d) => d.buckets.length)).unfiled, false);
    });

    it('tags AND, within the notebook', () => {
        assert.deepEqual(ids(browseFiles(docs, { tags: ['horse'] }).files), ['a', 'b']);
        assert.deepEqual(ids(browseFiles(docs, { tags: ['horse', 'red'] }).files), ['a']);
        assert.deepEqual(ids(browseFiles(docs, { notebook: 'journal', tags: ['red'] }).files), []);
    });
});
