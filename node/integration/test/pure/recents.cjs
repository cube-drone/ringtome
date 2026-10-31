// Recents (plans/RECENTS.md): the dock's and the launcher's order of use, and the three newest
// things heading them.
const assert = require('node:assert');

let orderByUse, newestThings, thingTitle, consoleCellsFor;
before(async () => {
    ({ orderByUse, newestThings, thingTitle } = await import('../../../js/pure/recents.js'));
    ({ consoleCellsFor } = await import('../../../js/pure/apps.js'));
});

const apps = (...ids) => ids.map((id) => ({ id }));

describe('recents', () => {
    it('orders apps by last use, the persona always first, the never-used in registry order', () => {
        const used = new Map([
            ['chat', 300],
            ['notes', 500],
            ['persona', 900],
        ]);
        assert.deepEqual(
            orderByUse(apps('persona', 'settings', 'feed', 'chat', 'notes', 'bank'), used).map(
                (a) => a.id,
            ),
            ['persona', 'notes', 'chat', 'settings', 'feed', 'bank'],
        );
        assert.deepEqual(
            orderByUse(apps('persona', 'settings', 'feed'), undefined).map((a) => a.id),
            ['persona', 'settings', 'feed'],
            'nothing used yet: the registry order',
        );
    });

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

    it('heads the launcher with the persona, then the things, then the apps by use', () => {
        const cells = consoleCellsFor(false, 4, () => true, {
            used: new Map([['chat', 10]]),
            things: [{ key: 't1' }, { key: 't2' }],
        });
        assert.equal(cells[0].id, 'persona');
        assert.deepEqual(
            cells.slice(1, 3).map((c) => c.thing.key),
            ['t1', 't2'],
        );
        assert.equal(cells[3].id, 'chat', 'the most recently used app next');
        assert.equal(cells.length % 4, 0, 'whole rows');
    });
});
