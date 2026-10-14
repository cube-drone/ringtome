// hrseAmp's shuffle (plans/AUDIO.md, section 4): every song once a cycle, artists and albums spread
// apart where the list allows it, five songs kept apart across the seam, and stable to walk back and
// forth.
const assert = require('node:assert');

let spreadOrder, ShuffleRun, seededRandom, SEAM, rated;
before(async () => {
    ({ spreadOrder, ShuffleRun, seededRandom, SEAM, rated } =
        await import('../../../js/pure/shuffle.js'));
});

const songs = (spec) =>
    spec.flatMap(([artist, album, n]) =>
        Array.from({ length: n }, (_, i) => ({ key: `${artist}/${album}/${i}`, artist, album })),
    );
const opts = (seed) => ({
    keyOf: (s) => s.key,
    artistOf: (s) => s.artist,
    albumOf: (s) => `${s.artist}/${s.album}`,
    random: seededRandom(seed),
});
const clashes = (order) =>
    order.slice(1).filter((s, i) => s.artist === order[i].artist || s.album === order[i].album)
        .length;

describe("hrseAmp's shuffle (plans/AUDIO.md)", () => {
    it('plays every song once a cycle', () => {
        const list = songs([
            ['a', 'x', 7],
            ['b', 'y', 3],
            ['c', 'z', 5],
        ]);
        for (let seed = 1; seed < 30; seed++) {
            const order = spreadOrder(list, opts(seed));
            assert.deepEqual(order.map((s) => s.key).sort(), list.map((s) => s.key).sort());
        }
    });

    it('keeps an artist from following itself where the list allows it', () => {
        const list = songs([
            ['a', 'x', 4],
            ['b', 'y', 4],
            ['c', 'z', 4],
            ['d', 'w', 4],
        ]);
        for (let seed = 1; seed < 50; seed++) {
            assert.equal(clashes(spreadOrder(list, opts(seed))), 0, `seed ${seed}`);
        }
    });

    it("spreads one artist's albums apart too", () => {
        const list = songs([
            ['a', 'one', 3],
            ['a', 'two', 3],
            ['b', 'x', 3],
            ['c', 'y', 3],
        ]);
        for (let seed = 1; seed < 30; seed++) {
            const order = spreadOrder(list, opts(seed));
            const sameAlbum = order
                .slice(1)
                .filter((s, i) => s.album === order[i].album && s.artist === order[i].artist);
            assert.equal(sameAlbum.length, 0, `seed ${seed}`);
        }
    });

    it("keeps the last five out of the next cycle's first five", () => {
        const list = songs([
            ['a', 'x', 8],
            ['b', 'y', 8],
            ['c', 'z', 8],
        ]);
        for (let seed = 1; seed < 20; seed++) {
            const run = new ShuffleRun(list, opts(seed));
            const firstCycle = [];
            for (let i = 0; i < list.length; i++) firstCycle.push(run.next().key);
            const next = [];
            for (let i = 0; i < SEAM; i++) next.push(run.next().key);
            const tail = new Set(firstCycle.slice(-SEAM));
            assert.ok(!next.some((k) => tail.has(k)), `seed ${seed}`);
            // ...and the seam doesn't undo the spreading.
            for (let i = SEAM; i < list.length; i++) run.next();
            const second = run.order.slice(list.length, 2 * list.length);
            assert.equal(clashes(second), 0, `seed ${seed}: the second cycle`);
        }
    });

    it('is stable walking back and forth, and a small list still plays', () => {
        const run = new ShuffleRun(
            songs([
                ['a', 'x', 4],
                ['b', 'y', 4],
            ]),
            opts(7),
        );
        const walked = [run.next(), run.next(), run.next(), run.next()].map((s) => s.key);
        assert.equal(run.prev().key, walked[2]);
        assert.equal(run.prev().key, walked[1]);
        assert.equal(run.next().key, walked[2]);
        assert.equal(run.next().key, walked[3]);
        const tiny = new ShuffleRun(songs([['a', 'x', 2]]), opts(3));
        const keys = [tiny.next(), tiny.next(), tiny.next(), tiny.next()].map((s) => s.key);
        assert.equal(new Set(keys.slice(0, 2)).size, 2, 'both before either again');
    });

    it('starts with the song chosen, and keeps what was played when the list changes', () => {
        const list = songs([
            ['a', 'x', 5],
            ['b', 'y', 5],
        ]);
        const chosen = list[7];
        const run = new ShuffleRun(list, opts(11), chosen);
        assert.equal(run.next().key, chosen.key);
        const played = [chosen.key, run.next().key, run.next().key];
        run.replaceItems([...list, ...songs([['c', 'z', 3]])]);
        assert.equal(run.current().key, played[2], 'still where it was');
        const rest = [];
        for (let i = 0; i < list.length + 3 - 3; i++) rest.push(run.next().key);
        assert.ok(!rest.some((k) => played.includes(k)), 'nothing played again this cycle');
        assert.equal(new Set(rest).size, rest.length);
    });

    it('picks up where it was from a snapshot, and the same list handed back keeps its order', () => {
        const list = songs([
            ['a', 'x', 3],
            ['b', 'y', 3],
            ['c', 'z', 3],
        ]);
        const run = new ShuffleRun(list, opts(21));
        const walked = [run.next(), run.next(), run.next()];
        const snap = JSON.parse(JSON.stringify(run.snapshot()));
        // As a refresh would: new objects for the same songs.
        const again = list.map((s) => ({ ...s }));
        const back = ShuffleRun.restore(again, opts(99), snap);
        assert.equal(back.current().key, walked[2].key, 'the same song');
        assert.equal(back.prev().key, walked[1].key, 'and previous walks back over the same ones');
        const ahead = run.next().key;
        back.next();
        assert.equal(back.next().key, ahead, 'and next goes where it would have');
        // The page hands the same songs back: the order stands.
        const before = run.snapshot().order;
        run.replaceItems(list.map((s) => ({ ...s })));
        assert.deepEqual(run.snapshot().order, before);
        // A snapshot naming none of the songs starts afresh.
        const fresh = ShuffleRun.restore(list, opts(5), { order: ['gone'], pos: 0 });
        assert.equal(fresh.current(), null);
        assert.ok(fresh.next());
    });

    it('plays a thumbs-up song twice a cycle, and a thumbs-down one every second cycle (2026-10-13)', () => {
        const list = songs([
            ['a', 'x', 4],
            ['b', 'y', 4],
            ['c', 'z', 4],
        ]);
        const up = list[0].key;
        const down = list[5].key;
        const ratingOf = (s) => (s.key === up ? 'up' : s.key === down ? 'down' : '');
        const run = new ShuffleRun(list, { ...opts(31), ratingOf });
        const cycles = [];
        let at = 0;
        for (let c = 0; c < 4; c++) {
            if (c > 0) run.extend();
            cycles.push(run.order.slice(at).map((s) => s.key));
            at = run.order.length;
        }
        for (const [c, cycle] of cycles.entries()) {
            assert.equal(cycle.filter((k) => k === up).length, 2, `cycle ${c}: twice`);
            assert.equal(cycle.filter((k) => k === down).length, c % 2, `cycle ${c}: every second`);
            const others = cycle.filter((k) => k !== up && k !== down);
            assert.equal(new Set(others).size, 10, `cycle ${c}: everything else once`);
            assert.equal(others.length, 10);
        }
        assert.equal(
            rated(list, 0, () => 'down').length,
            list.length,
            'all thumbs-down still plays',
        );
    });
});
