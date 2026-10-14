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
            ['by', 'from', 'genre', 'notebook', 'number', 'year'].sort(),
            'title, artist, album, length, tags, date added and score show to begin with',
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

    it('shows the reactions a song collected with their counts, and its tags without them', () => {
        assert.deepEqual(
            amp.reactionsOf({ '\u{1F44D}': 1, chill: 3, '\u{2764}\u{FE0F}': 2, '\u{1F44E}': 0 }),
            [
                ['\u{2764}\u{FE0F}', 2],
                ['\u{1F44D}', 1],
            ],
            'emoji only, the most said first, none said none shown',
        );
        assert.deepEqual(amp.wordTags(['chill', '\u{1F44D}', 'loud']), ['chill', 'loud']);
        const theirs = amp.feedRow({ author: them, doc: 'd', tag_counts: { '\u{1F434}': 4 } });
        assert.deepEqual(theirs.reactions, [['\u{1F434}', 4]]);
        const mine = amp.ownRow({ doc_id: 'e', title: 'x' }, me, {
            [amp.rowKey(me, 'e')]: { reaction: 'up' },
        });
        assert.deepEqual(mine.reactions, [['\u{1F44D}', 1]], 'your own like of your own sound');
    });

    it("keeps what the player needs of a song, and reads the player's state back", () => {
        const row = amp.feedRow({
            author: them,
            doc: 'd1',
            title: 'Buck',
            duration_ms: 2000,
            thumb: true,
        });
        const slim = amp.slimRow(row);
        assert.deepEqual(Object.keys(slim).sort(), [
            'album',
            'artist',
            'author',
            'doc',
            'key',
            'lengthMs',
            'loudness',
            'own',
            'thumb',
            'title',
        ]);
        const state = amp.readPlayerState(
            JSON.stringify({
                rows: [slim, { key: 'broken' }],
                current: slim.key,
                shuffle: true,
                run: { order: [slim.key], pos: 0, cycleStart: 0 },
            }),
        );
        assert.equal(state.rows.length, 1, 'a row with nothing to play is dropped');
        assert.equal(state.current.key, slim.key);
        assert.equal(state.shuffle, true);
        assert.deepEqual(state.run.order, [slim.key]);
        assert.equal(amp.readPlayerState('not json'), null);
        assert.equal(amp.readPlayerState(JSON.stringify({ rows: [] })), null);
    });

    it('levels a loud song down to -14 LUFS, and never turns a quiet one up', () => {
        assert.equal(amp.loudnessOf({ loudness: '-9.4' }), -9.4);
        assert.equal(amp.loudnessOf({}), null);
        assert.equal(amp.loudnessOf({ loudness: 'loud' }), null);
        assert.ok(Math.abs(amp.levelGain(-8) - 10 ** (-6 / 20)) < 1e-9, 'six over: down six dB');
        assert.equal(amp.levelGain(-20), 1, 'quieter than the target: as it is');
        assert.equal(amp.levelGain(null), 1, 'never measured: as it is');
        const row = amp.feedRow({ author: them, doc: 'd', fields: { loudness: '-7.5' } });
        assert.equal(row.loudness, -7.5, 'a feed song brings its loudness');
        assert.equal(amp.slimRow(row).loudness, -7.5, 'and the player keeps it across a refresh');
    });

    it("writes a long title smaller on the cassette's label, and cuts only past the smallest (2026-10-13)", () => {
        assert.deepEqual(amp.onLabel('short', 30, 22, 13), { words: 'short', size: 22 });
        assert.deepEqual(amp.onLabel('', 30, 22, 13), { words: '', size: 22 });
        const forty = 'x'.repeat(40);
        assert.deepEqual(amp.onLabel(forty, 30, 22, 13), { words: forty, size: 16 });
        const long = amp.onLabel('y'.repeat(80), 30, 22, 13);
        assert.equal(long.size, 13);
        assert.equal(long.words.length, 50);
        assert.ok(long.words.endsWith('…'));
    });
});
