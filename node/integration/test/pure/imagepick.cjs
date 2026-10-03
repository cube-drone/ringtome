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
const pic = (doc_id, title, created_ms, extra = {}) => ({
    doc_id,
    title,
    format: 'avif',
    media,
    created_ms,
    updated_ms: created_ms,
    tags: [],
    buckets: [],
    ...extra,
});
const docs = () => [
    pic('a1', 'Horse in a field', 1000, { tags: ['horse', 'ref'], buckets: ['refs'] }),
    pic('a2', 'Grey HORSE', 3000, { tags: ['horse'], buckets: ['refs', 'barn'], updated_ms: 1 }),
    pic('a3', 'Barn at dusk', 2000, { tags: ['barn'], buckets: ['barn'] }),
    pic('a4', 'loop', 4000, { format: 'apng' }),
    {
        doc_id: 'n1',
        title: 'horse notes',
        format: 'marquee',
        created_ms: 9000,
        tags: ['horse'],
        buckets: ['refs'],
    },
    { doc_id: 'v1', title: 'horse video', format: 'webm', media, created_ms: 9000 },
    pic('x1', 'no size yet', 9000, { media: { width: null, height: null } }),
];
const ids = (r) => r.pictures.map((d) => d.doc_id);

describe('the image picker', () => {
    it('offers only pictures with a known size, newest-added first', () => {
        assert.deepEqual(
            ids(p.pickPictures(docs())),
            ['a4', 'a2', 'a3', 'a1'],
            'an edit (updated_ms) does not reorder',
        );
    });

    it('narrows by notebook, by every word of the title, and by every picked tag', () => {
        assert.deepEqual(ids(p.pickPictures(docs(), { bucket: 'barn' })), ['a2', 'a3']);
        assert.deepEqual(
            ids(p.pickPictures(docs(), { query: '  horse  FIELD ' })),
            ['a1'],
            'case and order do not matter',
        );
        assert.deepEqual(ids(p.pickPictures(docs(), { tags: ['horse', 'ref'] })), ['a1']);
        assert.deepEqual(
            ids(p.pickPictures(docs(), { bucket: 'refs', query: 'horse', tags: ['horse'] })),
            ['a2', 'a1'],
        );
    });

    it('counts the tag cloud before the picked tags, and keeps every notebook on the menu', () => {
        const r = p.pickPictures(docs(), { query: 'horse', tags: ['ref'] });
        assert.deepEqual(
            r.tags,
            [
                ['horse', 2],
                ['ref', 1],
            ],
            'what could still be added, over the search',
        );
        assert.deepEqual(r.buckets, ['barn', 'refs'], 'notebooks with pictures, not with notes');
    });

    it('offers drawings too, only when asked', () => {
        const withDrawing = [
            ...docs(),
            {
                doc_id: 'd1',
                title: 'my horse',
                format: 'drawing',
                created_ms: 5000,
                tags: ['horse'],
                buckets: ['drawing'],
            },
        ];
        assert.ok(
            !ids(p.pickPictures(withDrawing)).includes('d1'),
            'the drawing app picks pictures only',
        );
        const r = p.pickPictures(withDrawing, { drawings: true, query: 'horse' });
        assert.deepEqual(
            ids(r),
            ['d1', 'a2', 'a1'],
            'the profile can pick a drawing, newest first with the rest',
        );
        assert.ok(p.pickPictures(withDrawing, { drawings: true }).buckets.includes('drawing'));
    });
});

// Stickers (Curtis, 2026-09-28): a picture or drawing tagged `sticker`, on a shelf in the drawing's
// tools, stamped where you click.
describe('the sticker shelf', () => {
    let p, d;
    before(async () => {
        p = await import('../../../js/pure/imagepick.js');
        d = await import('../../../js/pure/drawing.js');
    });
    const pic = (id, tags, ms) => ({
        doc_id: id,
        format: 'avif',
        media: { width: 40, height: 20 },
        tags,
        created_ms: ms,
        buckets: ['files'],
    });

    it('holds the pictures and drawings tagged sticker, newest first, and narrows by their other tags', () => {
        const docs = [
            pic('a', ['sticker', 'horse'], 1),
            pic('b', ['sticker'], 3),
            pic('c', ['horse'], 2),
            { doc_id: 'd', format: 'drawing', tags: ['sticker', 'horse'], created_ms: 4 },
            { doc_id: 'e', format: 'marquee', tags: ['sticker'], created_ms: 5 },
        ];
        const all = p.stickersOf(docs);
        assert.deepEqual(
            all.stickers.map((s) => s.doc_id),
            ['d', 'b', 'a'],
            'a note is not a sticker, an untagged picture neither',
        );
        assert.deepEqual(
            all.tags,
            [['horse', 2]],
            'the cloud leaves out the tag every sticker wears',
        );
        assert.deepEqual(
            p.stickersOf(docs, ['horse']).stickers.map((s) => s.doc_id),
            ['d', 'a'],
        );
    });

    it('shows under the cursor at its own size, never larger than a cursor may be', () => {
        assert.deepEqual(p.stickerCursorSize(40, 20, 1), [40, 20]);
        assert.deepEqual(
            p.stickerCursorSize(400, 200, 1),
            [128, 64],
            'the longer side capped, the shape kept',
        );
        assert.deepEqual(p.stickerCursorSize(40, 20, 0.5), [20, 10], "at the canvas's scale");
    });

    it('stamps a copy on the CURRENT layer, centred where it was stamped, at the size it showed', () => {
        let body = d.addLayer(d.blankDrawing(), 'aaaaaaaaaaaaaaa2', 1);
        const layersBefore = body.layers.length;
        body = d.stampImage(
            body,
            { doc: 'f'.repeat(32) },
            'aaaaaaaaaaaaaaa2',
            [100, 50],
            [40, 20],
            'c000000000000001',
            2,
        );
        body = d.stampImage(
            body,
            { doc: 'f'.repeat(32) },
            d.BASE_LAYER,
            [10, 10],
            [40, 20],
            'c000000000000002',
            3,
        );
        assert.equal(body.layers.length, layersBefore, 'no new layer');
        const [one, two] = body.strokes.filter((s) => s.tool === 'image');
        assert.deepEqual(
            [one.points, one.w, one.h, one.layer],
            [[80, 40], 40, 20, 'aaaaaaaaaaaaaaa2'],
        );
        assert.equal(two.layer, undefined, 'the base layer is the default');
        assert.deepEqual(two.points, [-10, 0], 'part of it may hang off the edge, as a brush may');
    });
});
