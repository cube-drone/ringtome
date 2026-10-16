// Groups in People: the Groups tab's order, a group page's member order, and whom an owner may
// invite.
const assert = require('node:assert');

let groupsInOrder,
    isInvite,
    membersInOrder,
    inviteCandidates,
    groupFeeds,
    membersAtAGlance,
    groupFeedOn,
    groupPostItem;
before(async () => {
    ({
        groupsInOrder,
        isInvite,
        membersInOrder,
        inviteCandidates,
        groupFeeds,
        membersAtAGlance,
        groupFeedOn,
        groupPostItem,
    } = await import('../../../js/pure/groups.js'));
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

    it('shows the founder, the owners, then the latest posters, then the rest, at a glance', () => {
        const roster = {
            founder: 'f',
            members: ['m1', 'm2', 'm3', 'o1', 'f', 'm4'].map((root) => ({
                root,
                owner: root === 'o1' || root === 'f',
            })),
        };
        const posts = [{ author: 'm3' }, { author: 'gone' }, { author: 'f' }, { author: 'm2' }];
        assert.deepEqual(membersAtAGlance(roster, posts, 10), ['f', 'o1', 'm3', 'm2', 'm1', 'm4']);
        assert.deepEqual(
            membersAtAGlance(roster, posts, 3),
            ['f', 'o1', 'm3'],
            'one who left is never shown',
        );
        assert.deepEqual(membersAtAGlance(roster, null, 3), ['f', 'o1', 'm1']);
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

    it("makes one feed per group you're in, picking that group alone, and none for an invite", () => {
        const feeds = groupFeeds([
            { group: 'b'.repeat(32), name: 'Potato Bunch', standing: 'owner' },
            { group: 'a'.repeat(32), name: 'Allotment', standing: 'member' },
            { group: 'c'.repeat(32), name: 'Beet Gang', standing: 'invite' },
            { group: 'd'.repeat(32), name: 'Turnip Lot', standing: 'invited' },
        ]);
        assert.deepEqual(
            feeds.map((f) => f.name),
            ['Potato Bunch', 'Allotment'],
        );
        assert.deepEqual(feeds[0].picks, { groups: ['b'.repeat(32)] });
        assert.equal(feeds[0].id, `group:${'b'.repeat(32)}`, 'never a saved feed id');
    });

    it("lights a group's feed while its pick alone is on, whatever the curiosity and the order", () => {
        const id = 'b'.repeat(32);
        const [feed] = groupFeeds([{ group: id, name: 'Potato Bunch', standing: 'member' }]);
        const now = (picks, extra = {}) => ({
            picks,
            stop: 'trusted',
            sort: 'best',
            q: null,
            ...extra,
        });
        assert.ok(groupFeedOn(feed, now({ groups: [id] })), 'the group alone: lit');
        assert.ok(
            !groupFeedOn(feed, now({ groups: [id], tags: ['spuds'] })),
            'a tag beside it: not',
        );
        assert.ok(!groupFeedOn(feed, now({})), 'nothing picked: not');
        assert.ok(
            !groupFeedOn(feed, now({ groups: [id] }, { q: 'turnip' })),
            'words searched: not',
        );
    });

    it("draws a just-posted group post's card from what its composer knows", () => {
        const item = groupPostItem({
            root: 'me',
            post: 'p'.repeat(32),
            draft: { title: 'Spuds' },
            group: { group: 'g'.repeat(32), name: 'Potato Bunch' },
            settled: true,
            now: 5,
        });
        assert.equal(item.doc_id, 'p'.repeat(32));
        assert.equal(item.author, 'me');
        assert.ok(item.mine);
        assert.equal(item.title, 'Spuds');
        assert.deepEqual(item.group, { id: 'g'.repeat(32), name: 'Potato Bunch' });
        assert.equal(item.published_ms, 5);
        assert.ok(item.settled);
        assert.equal(
            groupPostItem({ root: 'me', post: 'x', group: { group: 'g' }, now: 1 }).title,
            '',
        );
    });
});
