// Groups in People: the Groups tab's order, a group page's member order, and whom an owner may
// invite.
const assert = require('node:assert');

let groupsInOrder, isInvite, membersInOrder, inviteCandidates;
before(async () => {
    ({ groupsInOrder, isInvite, membersInOrder, inviteCandidates } =
        await import('../../../js/pure/groups.js'));
});

describe('groups in People', () => {
    it('lists invites first, unopened before opened, then the groups you keep, each by name', () => {
        const rows = [
            { group: 'a', name: 'Zither Club', standing: 'member' },
            { group: 'b', name: 'Potato Bunch', standing: 'owner' },
            { group: 'c', name: 'Allotment', standing: 'member' },
            { group: 'd', name: 'Turnip Lot', standing: 'invited' },
            { group: 'e', name: 'Beet Gang', standing: 'invite' },
        ];
        assert.deepEqual(
            groupsInOrder(rows).map((r) => r.name),
            ['Beet Gang', 'Turnip Lot', 'Potato Bunch', 'Allotment', 'Zither Club'],
        );
        assert.deepEqual(rows[0].name, 'Zither Club', 'the rows passed in are left as they were');
        assert.ok(isInvite(rows[3]) && isInvite(rows[4]) && !isInvite(rows[1]));
    });

    it('lists the founder first, then the other owners, then everyone else', () => {
        const roster = {
            founder: 'f',
            members: [
                { root: 'm1', owner: false },
                { root: 'o1', owner: true },
                { root: 'f', owner: true },
                { root: 'm2', owner: false },
            ],
        };
        assert.deepEqual(
            membersInOrder(roster).map((m) => m.root),
            ['f', 'o1', 'm1', 'm2'],
        );
        assert.deepEqual(membersInOrder(null), []);
    });

    it("offers to invite only contacts who aren't in, waiting, banned or you", () => {
        const roster = {
            members: [{ root: 'in' }],
            invited: ['waiting'],
            banned: ['banned'],
        };
        const contacts = ['in', 'waiting', 'banned', 'me', 'friend'].map((root) => ({ root }));
        assert.deepEqual(
            inviteCandidates(contacts, roster, 'me').map((c) => c.root),
            ['friend'],
        );
    });
});
