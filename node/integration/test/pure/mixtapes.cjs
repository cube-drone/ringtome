// hrseAmp's mixtapes (plans/AUDIO.md, section 5): a taxonomy titled `mixtape:<name>`, its members the
// songs in order - which songs are in which, the table in a mixtape's order, what "add" adds, and
// where a dragged song lands.
const assert = require('node:assert');

let m;
before(async () => {
    m = await import('../../../js/pure/mixtapes.js');
});

const me = 'm'.repeat(64);
const them = 't'.repeat(64);
const key = (root, doc) => `${root}.${doc}`;

describe("hrseAmp's mixtapes (plans/AUDIO.md)", () => {
    it('is a taxonomy titled mixtape:<name>, its members in order, a nested taxonomy passed over', () => {
        assert.ok(m.isMixtape('mixtape:Songs for Becky'));
        assert.ok(!m.isMixtape('wiki:Songs for Becky'));
        assert.equal(m.mixtapeTitle('  90s Jams '), 'mixtape:90s Jams');
        const tape = m.readMixtape({
            taxonomy_id: 'aa',
            title: 'mixtape:90s Jams',
            members: [
                { root: them, doc_id: 'd2' },
                { root: me, doc_id: 'd1' },
                { root: me, doc_id: 'sec', taxonomy: { members: [] } },
            ],
        });
        assert.deepEqual(tape, {
            id: 'aa',
            name: '90s Jams',
            members: [key(them, 'd2'), key(me, 'd1')],
        });
    });

    it('says which mixtapes each song is in, and shows a mixtape in its own order', () => {
        const tapes = [
            { id: 'a', name: 'Jams', members: ['x', 'y'] },
            { id: 'b', name: 'Becky', members: ['y', 'z'] },
        ];
        const by = m.mixtapesBySong(tapes);
        assert.deepEqual(by.get('y'), ['Jams', 'Becky'], 'a song in two mixtapes');
        assert.deepEqual(by.get('z'), ['Becky']);
        const rows = [{ key: 'z' }, { key: 'x' }, { key: 'y' }, { key: 'w' }];
        assert.deepEqual(
            m.inMixtapeOrder(rows, tapes[0]).map((r) => r.key),
            ['x', 'y'],
            "the mixtape's order, only its songs",
        );
        assert.deepEqual(
            m.inMixtapeOrder([{ key: 'y' }], tapes[0]).map((r) => r.key),
            ['y'],
            'a song the strip hides is left out, the rest keep their order',
        );
    });

    it('adds only what is not in it yet, so a song already there keeps its place', () => {
        const tape = { id: 'a', name: 'Jams', members: ['x'] };
        assert.deepEqual(
            m.notYetIn(tape, [{ key: 'x' }, { key: 'y' }]).map((r) => r.key),
            ['y'],
        );
        assert.equal(m.notYetIn(null, [{ key: 'x' }]).length, 1, 'a new mixtape takes them all');
    });

    it('lands a dragged song where it was dropped, counted without the song itself', () => {
        const order = ['a', 'b', 'c', 'd'];
        assert.equal(m.dropIndex(order, 'a', 'c', true), 2, 'a after c: b, c, [a], d');
        assert.equal(m.dropIndex(order, 'd', 'a', false), 0, 'd before a: to the top');
        assert.equal(m.dropIndex(order, 'b', 'd', true), 3, 'b after d: to the end');
        assert.equal(m.dropIndex(order, 'b', 'c', false), null, 'b before c: where it is');
        assert.equal(m.dropIndex(order, 'b', 'b', true), null, 'onto itself');
    });
});
