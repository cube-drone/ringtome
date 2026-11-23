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

    it("a published mixtape's words are its songs, in its order", () => {
        const body = { tracks: [{ doc: 'd2' }, { doc: 'd1' }, { title: 'no document' }] };
        assert.deepEqual(m.tapeMembers('ada', body), ['ada.d2', 'ada.d1']);
        assert.deepEqual(m.tapeMembers('ada', null), []);
    });

    it("a person's loose songs are the ones no mixtape of theirs brought", () => {
        const rows = [
            { key: 'me:1', own: true, author: 'me', post: null, dateMs: 9 },
            { key: 'garf:a', author: 'garf', post: 'p1', dateMs: 1 },
            { key: 'garf:b', author: 'garf', post: 'p0', taped: true, dateMs: 5 },
            { key: 'garf:c', author: 'garf', post: 'p2', dateMs: 3 },
            { key: 'bea:x', author: 'bea', post: 'p3', dateMs: 7 },
        ];
        const loose = m.looseTracks(rows);
        assert.deepEqual(loose, [
            { author: 'bea', members: ['bea:x'] },
            { author: 'garf', members: ['garf:c', 'garf:a'] },
        ]);
        assert.deepEqual(m.looseTracks(rows.slice(0, 1)), [], 'your own are not a row');
    });

    it('a shared playlist is a mixtape whose draft stands published, and says where it went', () => {
        const tapes = [
            { id: 't1', name: 'Out', members: [] },
            { id: 't2', name: 'Drafted', members: [] },
            { id: 't3', name: 'Never', members: [] },
            { id: 't4', name: 'Sealed', members: [] },
        ];
        const docRows = new Map([
            ['n1', { fields: { published_as: 'post1' } }],
            ['n2', { fields: {} }],
            ['n4', { fields: { published_as: 'post4', audience: 'band' } }],
        ]);
        const shared = m.sharedTapes(tapes, { t1: 'n1', t2: 'n2', t4: 'n4' }, docRows);
        assert.deepEqual(
            shared.map((x) => [x.tape.name, x.post, x.to]),
            [
                ['Out', 'post1', ''],
                ['Sealed', 'post4', 'tag:band'],
            ],
        );
    });

    it("a sealed mixtape's songs take their names from its tracklist", () => {
        const sounds = [
            { author: 'ada', doc: 'd1', fields: {}, duration_ms: null },
            { author: 'ada', doc: 'd2', fields: { track: 'Its Own' }, duration_ms: 5 },
            { author: 'bea', doc: 'd1', fields: {} },
        ];
        const opened = {
            'ada/p': {
                tracks: [
                    { doc: 'd1', title: 'One', artist: 'Them', ms: 9 },
                    { doc: 'd2', title: 'Two', album: 'LP' },
                ],
            },
        };
        const named = m.namedBySealedTapes(sounds, opened);
        assert.deepEqual(named[0].fields, { track: 'One', artist: 'Them' });
        assert.equal(named[0].duration_ms, 9);
        assert.deepEqual(named[1].fields, { track: 'Its Own', album: 'LP' }, 'its own word stays');
        assert.equal(named[2], sounds[2], "another person's song of the same id is left alone");
        assert.equal(m.namedBySealedTapes(sounds, {}), sounds);
    });

    it("sorts the groups' mixtapes into a section per group that has any", () => {
        const tapes = [
            { author: 'a', post: 'p1', title: 'Public' },
            { author: 'a', post: 'p2', title: 'Two', group: { id: 'g2', name: 'Zebra Club' } },
            { author: 'b', post: 'p3', title: 'Three', group: { id: 'g1', name: 'Aardvarks' } },
            { author: 'b', post: 'p4', title: 'Four', group: { id: 'g2', name: 'Zebra Club' } },
        ];
        const sections = m.groupSections(tapes);
        assert.deepEqual(
            sections.map((g) => [g.id, g.name, g.tapes.map((x) => x.post)]),
            [
                ['g1', 'Aardvarks', ['p3']],
                ['g2', 'Zebra Club', ['p2', 'p4']],
            ],
            "by the group's name, each mixtape in the order it came; the public one in none",
        );
        assert.deepEqual(m.groupSections([tapes[0]]), []);
    });

    it("takes only other people's public songs to the trash, each by its name", () => {
        const rows = [
            { own: true, author: 'me', doc: 'd0', title: 'Mine' },
            { own: false, author: 'a', doc: 'd1', title: 'Theirs', artist: 'Them' },
            { own: false, author: 'a', doc: 'd2', title: 'A Group Song', group: 'g1' },
        ];
        assert.deepEqual(
            rows.map((r) => m.trashable(r)),
            [false, true, false],
            "never your own, nor a group's",
        );
        assert.deepEqual(m.songTrashItems(rows), [
            { author: 'a', doc: 'd1', title: 'Theirs', artist: 'Them' },
        ]);
    });

    it('takes a mixtape to the trash with its songs, each naming it', () => {
        const tape = { author: 'a', post: 'p1', name: 'Road Songs' };
        const tracks = [{ doc: 'd1', title: 'One', artist: 'Them' }, { doc: 'd2' }, { title: 'x' }];
        assert.deepEqual(m.tapeTrashItems(tape, tracks), [
            { author: 'a', doc: 'p1', kind: 'mixtape', title: 'Road Songs' },
            { author: 'a', doc: 'd1', title: 'One', artist: 'Them', tape: 'p1' },
            { author: 'a', doc: 'd2', title: '', artist: '', tape: 'p1' },
        ]);
        assert.deepEqual(
            m.tapeTrashItems(tape, null),
            [{ author: 'a', doc: 'p1', kind: 'mixtape', title: 'Road Songs' }],
            'unread, the mixtape still goes',
        );
    });
});
