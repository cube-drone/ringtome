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
        assert.deepEqual(b.cloud, [
            ['horse', 2],
            ['red', 1],
            ['stray', 1],
        ]);
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

describe('the kind row (2026-10-02: "just get me images")', () => {
    let browseFiles, fileKind;
    before(async () => {
        ({ browseFiles, fileKind } = await import('../../../js/pure/filebrowse.js'));
    });
    const docs = [
        { doc_id: 'n', format: 'marquee', tags: ['horses'] },
        { doc_id: 'd', format: 'drawing', tags: ['horses'] },
        { doc_id: 'p', format: 'avif', tags: ['horses', 'sky'] },
        { doc_id: 'l', format: 'webm', media: { animation: true }, tags: [] },
        { doc_id: 'v', format: 'webm', media: { animation: false }, tags: ['sky'] },
        { doc_id: 'a', format: 'opus', tags: [] },
    ];

    it("names each file's kind - a silent loop is an image", () => {
        assert.deepEqual(docs.map(fileKind), [
            'post',
            'drawing',
            'image',
            'image',
            'video',
            'audio',
        ]);
        assert.equal(fileKind({ format: 'plaintext' }), 'post');
        assert.equal(fileKind({ format: 'mystery' }), null);
    });

    it('counts the kinds in order, narrows to either of those picked, and the tags count what is left', () => {
        const all = browseFiles(docs);
        assert.deepEqual(
            all.kinds.map((k) => `${k.value}:${k.count}`),
            ['post:1', 'drawing:1', 'image:2', 'audio:1', 'video:1'],
        );
        const images = browseFiles(docs, { kinds: ['image'] });
        assert.deepEqual(
            images.files.map((d) => d.doc_id),
            ['p', 'l'],
        );
        assert.equal(
            images.kinds.find((k) => k.value === 'post').count,
            1,
            'the row still offers the other kinds',
        );
        assert.deepEqual(
            images.cloud,
            [
                ['horses', 1],
                ['sky', 1],
            ],
            'the tags count only the images',
        );
        const either = browseFiles(docs, { kinds: ['image', 'video'], tags: ['sky'] });
        assert.deepEqual(
            either.files.map((d) => d.doc_id),
            ['p', 'v'],
            'either kind, and the tag',
        );
        assert.deepEqual(
            either.kinds.map((k) => `${k.value}:${k.count}`),
            ['image:1', 'video:1'],
            'counted under the tag, not the kinds',
        );
    });
});
