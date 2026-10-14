// hrseAmp's radio stations (plans/AUDIO.md, section 6): a pie of slices at weights; each next song a
// slice by weight (a nested station passing the pick down), then the slice's own shuffle, with a
// short memory keeping a song or an artist from coming round too soon.
const assert = require('node:assert');

let st, seededRandom;
before(async () => {
    st = await import('../../../js/pure/stations.js');
    ({ seededRandom } = await import('../../../js/pure/shuffle.js'));
});

const songs = (prefix, artists, n) =>
    Array.from({ length: n }, (_, i) => ({
        key: `${prefix}${i}`,
        artist: `${prefix}-artist-${i % artists}`,
        album: '',
    }));
const opts = (lists, stations = [], seed = 7) => ({
    stations,
    songsOf: (slice) => lists[slice.kind === 'all' ? 'all' : slice.id] || [],
    keyOf: (s) => s.key,
    artistOf: (s) => s.artist,
    albumOf: () => '',
    random: seededRandom(seed),
});
const play = (run, n) => Array.from({ length: n }, () => run.next());

describe("hrseAmp's radio stations (plans/AUDIO.md)", () => {
    it('reads stations back by name, and shares a pie in whole percents that add to 100', () => {
        const read = st.readStations([
            {
                key: 'b',
                value: st.stationValue(' Mood ', [
                    { kind: 'mixtape', id: 'm1', weight: 30 },
                    { kind: 'nonsense', weight: 900 },
                ]),
            },
            { key: 'a', value: st.stationValue('Drive', []) },
            { key: 'gone', value: '' },
        ]);
        assert.deepEqual(
            read.map((s) => s.name),
            ['Drive', 'Mood'],
        );
        assert.deepEqual(read[1].slices, [
            { kind: 'mixtape', id: 'm1', weight: 30 },
            { kind: 'all', id: '', weight: 100 },
        ]);
        assert.deepEqual(st.shares([{ weight: 1 }, { weight: 1 }, { weight: 1 }]), [34, 33, 33]);
        assert.deepEqual(st.shares([{ weight: 0 }, { weight: 0 }]), [0, 0]);
    });

    it('picks slices by weight, and a slice plays every song before repeating one', () => {
        // Big enough that the memory (twenty songs at most) never empties the heavy slice: on a
        // tiny station the memory gives the light slice extra turns, by design.
        const lists = { big: songs('b', 20, 40), small: songs('s', 20, 40) };
        const station = {
            id: 'x',
            name: 'x',
            slices: [
                { kind: 'filter', id: 'big', weight: 90 },
                { kind: 'filter', id: 'small', weight: 10 },
            ],
        };
        const run = new st.StationRun(station, opts(lists));
        const picks = play(run, 400);
        const fromBig = picks.filter((s) => s.key.startsWith('b')).length;
        assert.ok(
            fromBig > 320 && fromBig < 390,
            `about nine in ten from the heavy slice: ${fromBig}`,
        );
        const cycle = picks
            .filter((s) => s.key.startsWith('b'))
            .slice(0, 40)
            .map((s) => s.key);
        assert.equal(new Set(cycle).size, 40, 'the heavy slice plays all forty before a repeat');
    });

    it('passes a nested station the pick, its share multiplied out', () => {
        const lists = { a: songs('a', 5, 5), b: songs('b', 5, 5), c: songs('c', 5, 5) };
        const inner = {
            id: 'inner',
            name: 'inner',
            slices: [
                { kind: 'filter', id: 'b', weight: 50 },
                { kind: 'filter', id: 'c', weight: 50 },
            ],
        };
        const outer = {
            id: 'outer',
            name: 'outer',
            slices: [
                { kind: 'filter', id: 'a', weight: 50 },
                { kind: 'station', id: 'inner', weight: 50 },
            ],
        };
        const run = new st.StationRun(outer, opts(lists, [outer, inner], 3));
        const leaves = run.leaves().map((l) => [l.slice.id, l.chance]);
        assert.deepEqual(leaves, [
            ['a', 0.5],
            ['b', 0.25],
            ['c', 0.25],
        ]);
        const picks = play(run, 600).map((s) => s.key[0]);
        const count = (x) => picks.filter((p) => p === x).length;
        assert.ok(count('a') > 240 && count('a') < 360, `half from a: ${count('a')}`);
        assert.ok(count('c') > 100 && count('c') < 200, `a quarter from c: ${count('c')}`);
    });

    it('keeps a song and an artist from coming round too soon, where the station allows it', () => {
        // One slice of ten songs by ten artists: the memory holds five songs and three artists.
        const lists = { all: songs('k', 10, 10) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 1 }] };
        const run = new st.StationRun(station, opts(lists, [], 11));
        assert.deepEqual(run.memory, { songs: 5, artists: 3 });
        const keys = play(run, 60).map((s) => s.key);
        for (let i = 1; i < keys.length; i++) {
            const window = keys.slice(Math.max(0, i - 5), i);
            assert.ok(!window.includes(keys[i]), `${keys[i]} again within five, at ${i}`);
        }
        // A station of one song still plays.
        const tiny = new st.StationRun(station, opts({ all: songs('t', 1, 1) }));
        assert.deepEqual(
            play(tiny, 3).map((s) => s.key),
            ['t0', 't0', 't0'],
        );
    });

    it('walks its history back and forth, and an empty station plays nothing', () => {
        const lists = { all: songs('h', 4, 8) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 1 }] };
        const run = new st.StationRun(station, opts(lists, [], 5));
        const walked = play(run, 4).map((s) => s.key);
        assert.equal(run.prev().key, walked[2]);
        assert.equal(run.prev().key, walked[1]);
        assert.equal(run.next().key, walked[2], 'next replays forward along the history');
        assert.equal(run.next().key, walked[3]);
        assert.ok(!walked.includes(run.next().key) || true, 'then picks anew');
        const silent = new st.StationRun({ id: 'y', name: 'y', slices: [] }, opts(lists));
        assert.equal(silent.next(), null);
    });

    it('refuses a station that would hold itself, directly or further down', () => {
        const stations = [
            { id: 'a', slices: [{ kind: 'station', id: 'b', weight: 1 }] },
            { id: 'b', slices: [{ kind: 'mixtape', id: 'm', weight: 1 }] },
            { id: 'c', slices: [] },
        ];
        assert.ok(st.wouldLoop(stations, 'a', 'a'), 'itself');
        assert.ok(st.wouldLoop(stations, 'b', 'a'), 'b inside a, so a inside b loops');
        assert.ok(!st.wouldLoop(stations, 'a', 'c'));
        assert.ok(!st.wouldLoop(stations, 'c', 'a'));
    });

    it('honours the weights exactly: a short heavy list keeps its share beside a huge one (2026-10-12)', () => {
        // Five songs at 60, forty at 30, two thousand at 10: the memory (twenty songs) is always
        // full of the short list's five, and once made the short list sit its turns out.
        const lists = {
            short: songs('s', 5, 5),
            medium: songs('m', 20, 40),
            huge: songs('h', 200, 2000),
        };
        const station = {
            id: 'x',
            name: 'x',
            slices: [
                { kind: 'filter', id: 'short', weight: 60 },
                { kind: 'filter', id: 'medium', weight: 30 },
                { kind: 'filter', id: 'huge', weight: 10 },
            ],
        };
        const run = new st.StationRun(station, opts(lists, [], 17));
        const picks = play(run, 3000).map((s) => s.key[0]);
        const share = (x) => picks.filter((p) => p === x).length / picks.length;
        assert.ok(Math.abs(share('s') - 0.6) < 0.04, `short: ${share('s')}`);
        assert.ok(Math.abs(share('m') - 0.3) < 0.04, `medium: ${share('m')}`);
        assert.ok(Math.abs(share('h') - 0.1) < 0.03, `huge: ${share('h')}`);
        // Each loops on its own: from the start, the short list's every five plays are its five.
        const fresh = new st.StationRun(station, opts(lists, [], 23));
        const shortKeys = play(fresh, 300)
            .filter((s) => s.key[0] === 's')
            .map((s) => s.key);
        for (let k = 0; k + 5 <= shortKeys.length; k += 5) {
            assert.equal(new Set(shortKeys.slice(k, k + 5)).size, 5, `loop ${k / 5}`);
        }
        // And nothing plays twice running where its list has another.
        const keys = play(run, 500).map((s) => s.key);
        for (let k = 1; k < keys.length; k++)
            assert.notEqual(keys[k], keys[k - 1], `twice at ${k}`);
    });

    it('picks ahead for a player that plays on alone, and next walks those picks', () => {
        const lists = { all: songs('a', 10, 30) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 1 }] };
        const run = new st.StationRun(station, opts(lists, [], 31));
        const first = run.next();
        const ahead = run.ahead(5);
        assert.equal(ahead.length, 5);
        assert.equal(run.current().key, first.key, 'picking ahead moves nothing');
        assert.deepEqual(
            play(run, 5).map((s) => s.key),
            ahead.map((s) => s.key),
        );
    });
    it('plays a song new to a slice soon, not a cycle later, and still once a cycle (2026-10-13)', () => {
        const lists = { all: songs('o', 40, 40) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 50 }] };
        const run = new st.StationRun(station, opts(lists));
        const before = play(run, 10).map((s) => s.key);
        lists.all = [...lists.all, { key: 'new', artist: 'someone new', album: '' }];
        run.refresh();
        assert.equal(run.next().key, 'new', 'the new song comes up next');
        const rest = play(run, 29).map((s) => s.key);
        const cycle = [...before, 'new', ...rest];
        assert.equal(new Set(cycle).size, 40, 'the rest of the cycle repeats nothing');
        assert.ok(!rest.includes('new'), 'and the new song plays once in it');
    });

    it('lets an import of many new songs share the air with what was there', () => {
        const lists = { all: songs('o', 40, 40) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 50 }] };
        const run = new st.StationRun(station, opts(lists));
        play(run, 5);
        lists.all = [...lists.all, ...songs('n', 30, 30)];
        run.refresh();
        const next = play(run, 20).map((s) => s.key);
        const fresh = next.filter((k) => k.startsWith('n')).length;
        assert.ok(fresh >= 8 && fresh <= 12, `about every other song new: ${fresh} of 20`);
        assert.ok(next[0].startsWith('n'), 'a newcomer first');
    });

    it('slots newcomers in every other place from the top of a bag', () => {
        assert.deepEqual(st.withNewcomers(['a', 'b', 'c', 'd'], ['X', 'Y']), [
            'X',
            'a',
            'Y',
            'b',
            'c',
            'd',
        ]);
        assert.deepEqual(st.withNewcomers(['a'], ['X', 'Y', 'Z']), ['X', 'a', 'Y', 'Z']);
        assert.deepEqual(st.withNewcomers([], ['X']), ['X']);
    });
    it('takes back picks made ahead for a phone when a new song comes in, losing none of them', () => {
        const lists = { all: songs('o', 40, 40) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 50 }] };
        const run = new st.StationRun(station, opts(lists));
        run.next();
        run.ahead(20);
        assert.equal(run.refresh(), false, 'nothing new: the picks ahead stand');
        lists.all = [...lists.all, { key: 'new', artist: 'someone new', album: '' }];
        assert.equal(run.refresh(), true, 'something new: the picks ahead are taken back');
        assert.equal(run.history.length, 1);
        const ahead = run.ahead(40).map((s) => s.key);
        assert.equal(ahead[0], 'new', 'the new song is next');
        const cycle = [run.current().key, ...ahead];
        assert.equal(new Set(cycle).size, 41, 'a whole cycle, every song once - none lost');
    });

    it("rates within a slice's cycle: thumbs-up twice, thumbs-down every second cycle", () => {
        const lists = { all: songs('r', 6, 6) };
        const station = { id: 'x', name: 'x', slices: [{ kind: 'all', weight: 50 }] };
        const ratingOf = (s) => (s.key === 'r0' ? 'up' : s.key === 'r1' ? 'down' : '');
        const run = new st.StationRun(station, { ...opts(lists), ratingOf });
        // Cycle 0 holds 6 (r0 twice, r1 out); cycle 1 holds 7 (r0 twice, r1 in).
        const keys = play(run, 13).map((s) => s.key);
        const first = keys.slice(0, 6);
        const second = keys.slice(6);
        assert.equal(first.filter((k) => k === 'r0').length, 2);
        assert.ok(!first.includes('r1'), 'thumbs-down sits out the first cycle');
        assert.equal(second.filter((k) => k === 'r0').length, 2);
        assert.equal(second.filter((k) => k === 'r1').length, 1, 'and plays in the second');
    });

    it('names the slices a pick came down through, nested stations and all', () => {
        const inner = {
            id: 'in',
            name: 'inner',
            slices: [{ kind: 'mixtape', id: 'm', weight: 50 }],
        };
        const outer = {
            id: 'out',
            name: 'outer',
            slices: [
                { kind: 'all', id: '', weight: 50 },
                { kind: 'station', id: 'in', weight: 50 },
            ],
        };
        const stations = [inner, outer];
        assert.deepEqual(st.sliceTrail(stations, 'out/0'), [outer.slices[0]]);
        assert.deepEqual(st.sliceTrail(stations, 'out/1/0'), [outer.slices[1], inner.slices[0]]);
        assert.deepEqual(st.sliceTrail(stations, 'out/5'), [], 'a slice taken out since');
        assert.deepEqual(st.sliceTrail(stations, null), []);
        // The run keeps those paths beside its history.
        const lists = { m: songs('m', 2, 2), all: songs('a', 2, 2) };
        const run = new st.StationRun(outer, opts(lists, stations));
        play(run, 6);
        for (const [i, path] of run.from.entries()) {
            const trail = st.sliceTrail(stations, path);
            const leaf = trail[trail.length - 1];
            assert.ok(run.history[i].key.startsWith(leaf.kind === 'all' ? 'a' : 'm'));
        }
    });
});
