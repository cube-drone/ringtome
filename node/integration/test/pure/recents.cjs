// Recents (plans/RECENTS.md): the three newest things heading the dock and the launcher, whose
// apps keep a fixed order.
const assert = require('node:assert');

let newestThings, thingTitle, consoleCellsFor;
before(async () => {
    ({ newestThings, thingTitle } = await import('../../../js/pure/recents.js'));
    ({ consoleCellsFor } = await import('../../../js/pure/apps.js'));
});

describe('recents', () => {
    it('shows the three newest things, only of apps that may be opened', () => {
        const things = [
            { key: 'a', app: 'notes', href: '/a', at: 1 },
            { key: 'b', app: 'chat', href: '/b', at: 5 },
            { key: 'c', app: 'bank', href: '/c', at: 9 },
            { key: 'd', app: 'drawing', href: '/d', at: 4 },
            { key: 'e', app: 'feed', href: '/e', at: 3 },
        ];
        assert.deepEqual(
            newestThings(things, (id) => id !== 'bank').map((t) => t.key),
            ['b', 'd', 'e'],
        );
    });

    it('names a thing by its title, else its first words, cut short', () => {
        assert.equal(thingTitle('  my notes ', 'ignored'), 'my notes');
        assert.equal(thingTitle('', '\n## the oven\nis on'), 'the oven');
        assert.equal(thingTitle('', ':::user id=/id/x:::\nhello'), 'hello');
        assert.equal(thingTitle('', 'x'.repeat(80)).length, 60);
        assert.equal(thingTitle('', ''), '');
    });

    it('heads the launcher with the persona, then the things, then the apps in a fixed order', () => {
        const plain = consoleCellsFor(false, 4, () => true).filter((c) => c.id);
        const cells = consoleCellsFor(false, 4, () => true, {
            things: [{ key: 't1' }, { key: 't2' }],
        });
        assert.equal(cells[0].id, 'persona');
        assert.deepEqual(
            cells.slice(1, 3).map((c) => c.thing.key),
            ['t1', 't2'],
        );
        assert.deepEqual(
            cells.filter((c) => c.id).map((c) => c.id),
            plain.map((c) => c.id),
            'the apps where they always are, whatever was touched',
        );
        assert.equal(cells.length % 4, 0, 'whole rows');
    });
});
