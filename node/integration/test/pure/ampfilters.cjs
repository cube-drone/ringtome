// hrseAmp's filters (plans/AUDIO.md, section 3): the strip's three-state chips over via, artist,
// genre and tags; each row counted over what the other rows leave; whose tags count; and a filter
// saved, read back, and known again when it's on screen.
const assert = require('node:assert');

let f;
before(async () => {
    f = await import('../../../js/pure/ampfilters.js');
});

const song = (key, { from = 'ann', artist = '', genre = '', tags = [], ourTags = tags } = {}) => ({
    key,
    from,
    artist,
    genre,
    tags,
    ourTags,
});
const songs = () => [
    song('a', { from: 'me', artist: 'Doe', genre: 'Folk', tags: ['chill'] }),
    song('b', { artist: 'Doe', genre: 'Rock', tags: ['loud', 'chill'], ourTags: ['loud'] }),
    song('c', { artist: 'Roe', genre: 'Rock', tags: ['loud'] }),
    song('d', { from: 'bo', artist: 'Roe', genre: 'Folk' }),
];
const keys = (list) => list.map((s) => s.key);

describe("hrseAmp's filters (plans/AUDIO.md)", () => {
    it('cycles a chip: only, then left out, then alone again', () => {
        let p = f.cycleAmpPick(f.NO_AMP_PICKS, 'artists', 'Doe');
        assert.deepEqual(p.artists, ['Doe']);
        assert.equal(f.ampPickState(p, 'artists', 'Doe'), 'only');
        p = f.cycleAmpPick(p, 'artists', 'Doe');
        assert.deepEqual([p.artists, p.notArtists], [[], ['Doe']]);
        p = f.cycleAmpPick(p, 'artists', 'Doe');
        assert.equal(f.ampPickState(p, 'artists', 'Doe'), null);
        assert.ok(!f.anyAmpPicks(p));
    });

    it('narrows by every row at once: any of a row\'s "only" picks, none of its left-out ones', () => {
        const only = f.cycleAmpPick(f.NO_AMP_PICKS, 'genres', 'Rock');
        assert.deepEqual(keys(f.narrowedSongs(songs(), only)), ['b', 'c']);
        const both = f.cycleAmpPick(f.cycleAmpPick(only, 'genres', 'Folk'), 'genres', 'Folk');
        assert.deepEqual(keys(f.narrowedSongs(songs(), both)), ['b', 'c'], 'Folk left out');
        const notMe = f.cycleAmpPick(f.cycleAmpPick(f.NO_AMP_PICKS, 'from', 'me'), 'from', 'me');
        assert.deepEqual(keys(f.narrowedSongs(songs(), notMe)), ['b', 'c', 'd'], '"me" left out');
        const notChill = f.cycleAmpPick(f.cycleAmpPick(only, 'tags', 'chill'), 'tags', 'chill');
        assert.deepEqual(keys(f.narrowedSongs(songs(), notChill)), ['c'], 'Rock, but not chill');
    });

    it("counts each row over what the other rows leave, so a row's other values stay to pick", () => {
        const doe = f.cycleAmpPick(f.NO_AMP_PICKS, 'artists', 'Doe');
        const facets = f.songFacets(songs(), doe);
        assert.deepEqual(
            facets.artists,
            [
                { value: 'Doe', count: 2 },
                { value: 'Roe', count: 2 },
            ],
            'every artist still on the artist row',
        );
        assert.deepEqual(
            facets.genres,
            [
                { value: 'Folk', count: 1 },
                { value: 'Rock', count: 1 },
            ],
            "the genres are Doe's",
        );
        assert.deepEqual(facets.from, [
            { value: 'ann', count: 1 },
            { value: 'me', count: 1 },
        ]);
    });

    it("whose tags: everyone's by default, or only the author's and yours", () => {
        const loud = f.cycleAmpPick(f.NO_AMP_PICKS, 'tags', 'chill');
        assert.deepEqual(keys(f.narrowedSongs(songs(), loud)), ['a', 'b']);
        assert.deepEqual(
            keys(f.narrowedSongs(songs(), loud, 'ours')),
            ['a'],
            "b's chill is someone else's",
        );
        const ours = f.songFacets(songs(), f.NO_AMP_PICKS, 'ours').tags;
        assert.deepEqual(ours, [
            { value: 'loud', count: 2 },
            { value: 'chill', count: 1 },
        ]);
    });

    it('saves a filter, reads it back by name, and knows it on screen', () => {
        const picks = f.cycleAmpPick(
            f.cycleAmpPick(f.NO_AMP_PICKS, 'genres', 'Rock'),
            'artists',
            'Roe',
        );
        const settings = f.filterSettings(picks, 'interest', 'ours');
        const read = f.readFilters([
            { key: 'b1', value: f.filterValue('  rock  ', settings) },
            { key: 'a1', value: f.filterValue('Mellow', f.filterSettings(f.NO_AMP_PICKS, null)) },
            { key: 'gone', value: '' },
            { key: 'junk', value: 'not json' },
        ]);
        assert.deepEqual(
            read.map((x) => [x.id, x.name]),
            [
                ['a1', 'Mellow'],
                ['b1', 'rock'],
            ],
            'by name; emptied and unreadable registers left out',
        );
        const rock = read[1];
        assert.equal(rock.stop, 'interest');
        assert.equal(rock.scope, 'ours');
        // The same picks in another order are the same filter.
        const again = f.cycleAmpPick(
            f.cycleAmpPick(f.NO_AMP_PICKS, 'artists', 'Roe'),
            'genres',
            'Rock',
        );
        assert.ok(f.sameFilter(rock, f.filterSettings(again, 'interest', 'ours')));
        assert.ok(!f.sameFilter(rock, f.filterSettings(again, 'interest', 'all')), 'whose tags');
        assert.ok(!f.sameFilter(rock, f.filterSettings(again, 'high', 'ours')), 'the dial');
    });

    it('keeps the search words with a filter (Curtis, 2026-10-12)', () => {
        const s = f.filterSettings(f.NO_AMP_PICKS, 'high', 'all', ' buck ');
        assert.equal(s.q, 'buck');
        const [back] = f.readFilters([{ key: 'x', value: f.filterValue('bucks', s) }]);
        assert.equal(back.q, 'buck');
        assert.ok(f.sameFilter(back, f.filterSettings(f.NO_AMP_PICKS, 'high', 'all', 'buck')));
        assert.ok(!f.sameFilter(back, f.filterSettings(f.NO_AMP_PICKS, 'high', 'all', '')));
    });

    it('narrows by a year and a length range (Curtis, 2026-10-12)', () => {
        const list = [
            { key: 'old', year: '1979-05-01', lengthMs: 200000, tags: [] },
            { key: 'new', year: '2021', lengthMs: 95000, tags: [] },
            { key: 'none', year: '', lengthMs: null, tags: [] },
        ];
        const keysOf = (picks) =>
            f.narrowedSongs(list, { ...f.NO_AMP_PICKS, ...picks }).map((s) => s.key);
        assert.deepEqual(keysOf({ yearMin: 2000 }), ['new'], 'no year is outside a year range');
        assert.deepEqual(keysOf({ yearMax: 1990 }), ['old']);
        assert.deepEqual(keysOf({ lengthMin: 120 }), ['old']);
        assert.deepEqual(keysOf({ lengthMax: 100 }), ['new']);
        assert.deepEqual(keysOf({}), ['old', 'new', 'none']);
        assert.ok(f.anyAmpPicks({ ...f.NO_AMP_PICKS, lengthMax: 100 }));
        assert.equal(f.yearOf('May 1979'), 1979);
        assert.equal(f.readLength('3:30'), 210);
        assert.equal(f.readLength('1:02:03'), 3723);
        assert.equal(f.readLength('2.5'), 150, 'a number is minutes');
        assert.equal(f.readLength('soon'), null);
        const s1 = f.filterSettings({ ...f.NO_AMP_PICKS, yearMin: 1990 }, null, 'all');
        const [back] = f.readFilters([{ key: 'k', value: f.filterValue('90s', s1) }]);
        assert.equal(back.picks.yearMin, 1990, 'a filter keeps its ranges');
        assert.ok(!f.sameFilter(back, f.filterSettings(f.NO_AMP_PICKS, null, 'all')));
    });

    it('finds probable duplicates: one title, one artist where both say one, within five seconds', () => {
        const giorgio = (key, title, artist, secs) => ({
            key,
            title,
            artist,
            lengthMs: secs * 1000,
            tags: [],
        });
        const list = [
            giorgio('a', 'Giorgio by Moroder', 'Daft Punk', 544),
            giorgio('x', 'Touch', 'Daft Punk', 498),
            giorgio('b', '04 - Giorgio By Moroder.mp3', 'Daft Punk', 547),
            giorgio('c', 'Giorgio by Moroder', '', 549), // from the feed: no artist yet
            giorgio('d', 'Giorgio by Moroder', 'Someone Else', 545),
            giorgio('e', 'Giorgio by Moroder', 'Daft Punk', 300), // the radio edit
        ];
        const groups = f.duplicateGroups(list);
        assert.deepEqual(
            [...groups.keys()].sort(),
            ['a', 'b', 'c', 'd'],
            'd, by someone else, joins through c, which says no artist',
        );
        assert.equal(groups.get('a'), groups.get('b'));
        assert.ok(!groups.has('x'), 'no copy');
        assert.ok(!groups.has('e'), 'four minutes shorter is another cut');
        assert.equal(f.dupeTitle('03. Giorgio by Moroder!'), 'giorgio by moroder');
        const on = { ...f.NO_AMP_PICKS, dupes: true };
        assert.deepEqual(
            f.narrowedSongs(list, on).map((s) => s.key),
            ['a', 'b', 'c', 'd'],
        );
        assert.deepEqual(
            f.byDuplicateGroup([list[5], list[0], list[1], list[2]], groups).map((s) => s.key)[0],
            'a',
            'grouped songs come first, together',
        );
        const [back] = f.readFilters([
            { key: 'k', value: f.filterValue('dupes', f.filterSettings(on, null, 'all')) },
        ]);
        assert.equal(back.picks.dupes, 'only', 'a filter keeps it, a plain "on" as "only"');
    });

    it('cycles probable duplicates as a tag cycles: only them, then one of each, then everything', () => {
        let p = f.cycleDupes(f.NO_AMP_PICKS);
        assert.equal(f.dupeMode(p), 'only');
        p = f.cycleDupes(p);
        assert.equal(f.dupeMode(p), 'out');
        assert.equal(f.dupeMode(f.cycleDupes(p)), null);
        const song = (key, extra) => ({
            key,
            title: 'Giorgio by Moroder',
            lengthMs: 544000,
            tags: [],
            ...extra,
        });
        const list = [
            song('feed', { artist: '' }),
            song('mine', { own: true, artist: 'Daft Punk' }),
            song('theirs', { artist: 'Daft Punk' }),
            { key: 'touch', title: 'Touch', artist: 'Daft Punk', lengthMs: 498000, tags: [] },
        ];
        assert.deepEqual(
            f.narrowedSongs(list, p).map((s) => s.key),
            ['mine', 'touch'],
            'one of each - your own copy stays - and everything without a copy',
        );
        assert.equal(f.keeperOf([list[0], list[2]]).key, 'theirs', 'one that says its artist');
        // A copy the other picks hide never costs the keeper its place.
        const notMine = f.cycleAmpPick(f.cycleAmpPick(p, 'from', 'me'), 'from', 'me');
        const fromd = list.map((s) => ({ ...s, from: s.own ? 'me' : 'ann' }));
        assert.deepEqual(
            f.narrowedSongs(fromd, notMine).map((s) => s.key),
            ['theirs', 'touch'],
        );
    });
});
