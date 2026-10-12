// hrseAmp's library (plans/AUDIO.md): rows from your sounds and the feed's in one shape, the folded
// Title and Artist, your layer over another author's fields, the sorts, the search, the selection.
const assert = require('node:assert');

let amp;
before(async () => {
    amp = await import('../../../js/pure/amp.js');
});

const me = 'm'.repeat(64);
const them = 't'.repeat(64);

describe("hrseAmp's library (plans/AUDIO.md)", () => {
    it("folds Title and Artist, and lays your fields over the author's", () => {
        const mine = amp.ownRow(
            {
                doc_id: 'a1',
                title: 'buck.ogg',
                fields: { artist: 'Doe', 'album artist': 'Various' },
                media: { duration_ms: 20010 },
                buckets: ['files', 'Albums'],
                tags: ['audio', 'chill'],
            },
            me,
        );
        assert.equal(mine.title, 'buck.ogg', "no title tag: the document's title");
        assert.equal(mine.artist, 'Various', 'the album artist before the artist');
        assert.equal(mine.notebook, 'Albums', 'not the files notebook');
        assert.deepEqual(mine.tags, ['chill'], 'not the medium');
        const layer = amp.readLayer([
            { key: `${them}.b2.track`, value: 'My Name For It' },
            { key: `${them}.b2.genre`, value: 'polka' },
            { key: `${them}.b2.artist`, value: '' },
        ]);
        const theirs = amp.feedRow(
            {
                author: them,
                doc: 'b2',
                post: 'p',
                via: null,
                title: 'b2.ogg',
                fields: { track: 'Their Title', artist: 'Them' },
                tags: [],
                duration_ms: 1000,
                arrived_ms: 5,
                score: 2000,
            },
            layer,
        );
        assert.equal(theirs.title, 'My Name For It', 'yours over theirs');
        assert.equal(theirs.artist, 'Them', 'an emptied field of yours is no field');
        assert.equal(theirs.genre, 'polka');
        assert.equal(theirs.from, them);
    });

    it('sorts an album in its own order, the empty last, and searches title, artist and album', () => {
        const rows = [
            { key: '1', title: 'C', album: 'Z', number: 2 },
            { key: '2', title: 'A', album: 'Z', number: 1 },
            { key: '3', title: 'B', album: '', number: null },
            { key: '4', title: 'D', album: 'Y', number: 1 },
        ];
        assert.deepEqual(
            amp.sorted(rows, { column: 'album', down: false }).map((r) => r.key),
            ['4', '2', '1', '3'],
        );
        assert.deepEqual(
            amp
                .searched(
                    rows.map((r) => ({ ...r, artist: '', docTitle: '' })),
                    'z c',
                )
                .map((r) => r.key),
            ['1'],
        );
        assert.equal(amp.clock(20010), '0:20');
        assert.equal(amp.clock(3_723_000), '1:02:03');
    });

    it('selects one, toggles one, and runs from the last click', () => {
        const order = ['a', 'b', 'c', 'd', 'e'];
        assert.deepEqual([...amp.clickSelect(new Set(), 'b', order, null)], ['b']);
        assert.deepEqual(
            [...amp.clickSelect(new Set(['b']), 'd', order, 'b', { toggle: true })].sort(),
            ['b', 'd'],
        );
        assert.deepEqual(
            [...amp.clickSelect(new Set(['b']), 'e', order, 'b', { shift: true })],
            ['b', 'c', 'd', 'e'],
        );
    });

    it("reads the table's settings back, every column accounted for", () => {
        const fresh = amp.readTableSettings(null);
        assert.deepEqual(
            fresh.hidden.sort(),
            ['by', 'date', 'from', 'genre', 'notebook', 'number', 'score', 'year'].sort(),
            'title, artist, album, length and tags show to begin with',
        );
        assert.deepEqual(fresh.sort, { column: 'date', down: true });
        const kept = amp.readTableSettings(
            JSON.stringify({
                hidden: ['score'],
                widths: { title: 10, album: 300 },
                sort: { column: 'tags' },
            }),
        );
        assert.equal(kept.widths.title, 280, 'too narrow: the default');
        assert.equal(kept.widths.album, 300);
        assert.deepEqual(kept.sort, { column: 'date', down: true }, 'tags never sort');
    });
});
