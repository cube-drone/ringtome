/*
    Groups: an invite reaches its invitee (plans/GROUPS.md, section 5). Ada founds the Potato
    Bunch and invites dee, a stranger on another node who has never heard of it. The invite
    travels as a notice, the notifications road strangers use: dee's bell rings with the
    group's name, and dee's groups list it as an invite. Opening it fetches the group from the
    node that delivered it, so dee sees whom they'd be joining; joining needs nothing more.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_C } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_C ? describe : describe.skip)('groups: an invite reaches its invitee', function () {
    this.timeout(300000);

    let ada, adaRoot, dee, deeRoot, group;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const ok = async (res, what) => {
        const text = await res.text();
        assert.equal(res.status, 200, `${what}: ${text}`);
        return JSON.parse(text);
    };

    before(async function () {
        [ada, adaRoot] = await persona('giada', HOST);
        [dee, deeRoot] = await persona('gidee', HOST_C);
        // Ada has looked dee up, as anyone inviting someone has: her node knows where dee is.
        const { toBase58 } = await import('../../js/speakable.js');
        const viaC = toBase58((await (await dee('api/node')).json()).endpoint_id);
        assert.equal((await ada(`api/id/${deeRoot}/profile?via=${viaC}`)).status, 200);
        group = (
            await ok(
                await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Potato Bunch' }),
                'found',
            )
        ).group;
    });

    it("rings the invitee's bell with the group's name, and lists it among their groups", async () => {
        await ok(
            await j(ada, `api/identity/${adaRoot}/groups/${group}/invites`, { invitee: deeRoot }),
            'invite',
        );
        await beat(HOST, 'outbox');
        let rung = [];
        for (let i = 0; i < 30 && rung.length === 0; i++) {
            const items =
                (await (await dee(`api/identity/${deeRoot}/notifications`)).json()).items || [];
            rung = items.filter((n) => n.kind === 'group-invite' && n.author === adaRoot);
            if (rung.length === 0) await wait(400);
        }
        assert.equal(rung.length, 1, "the invite rang dee's bell");
        assert.equal(rung[0].doc_id, group, 'naming the group');
        assert.equal(rung[0].detail, 'Potato Bunch', 'by its name');
        const mine = await ok(await dee(`api/identity/${deeRoot}/groups`), 'list');
        const row = mine.find((g) => g.group === group);
        assert.ok(row, `dee's groups list it: ${JSON.stringify(mine)}`);
        assert.equal(row.standing, 'invite');
        assert.equal(row.inviter, adaRoot);
    });

    it('opening it fetches the group, and joining needs nothing more', async () => {
        const opened = await ok(
            await j(dee, `api/identity/${deeRoot}/groups/${group}/open`, {}),
            'open',
        );
        assert.equal(opened.name, 'Potato Bunch');
        assert.ok(opened.invited.includes(deeRoot), 'dee is invited');
        assert.ok(
            opened.members.some((m) => m.root === adaRoot && m.owner),
            'ada is its owner',
        );
        assert.equal(opened.you.member, false);

        const joined = await ok(
            await j(dee, `api/identity/${deeRoot}/groups/${group}/join`, {}),
            'join',
        );
        assert.ok(joined.you.member, 'dee is in');
        await j(dee, `api/identity/${deeRoot}/groups/${group}/sync`, {});
        let roster;
        for (let i = 0; i < 20; i++) {
            roster = await ok(
                await j(ada, `api/identity/${adaRoot}/groups/${group}/sync`, {}),
                'sync',
            );
            if (roster.members.some((m) => m.root === deeRoot)) break;
            await wait(300);
        }
        assert.ok(
            roster.members.some((m) => m.root === deeRoot),
            `and ada's node counts dee too: ${JSON.stringify(roster.members)}`,
        );
    });

    it('a hidden post is out of sight, but for the owners and its author', async () => {
        const base = (root) => `api/identity/${root}/groups/${group}`;
        const posts = async (who, root) =>
            (await ok(await who(`${base(root)}/posts`), 'posts')).posts;
        // Dee - a member, neither an owner nor the author - syncs until the post is, or isn't, on
        // the page. Seeing it first is what makes its absence mean something.
        const deeSees = async (post, want) => {
            let sees = !want;
            for (let i = 0; i < 20 && sees !== want; i++) {
                await j(dee, `${base(deeRoot)}/sync`, {});
                sees = (await posts(dee, deeRoot)).some((p) => p.doc === post);
                // The feed narrowed to the group, and the post's own page, say the same.
                const feed = (
                    (await (await dee(`api/identity/${deeRoot}/feed?group=${group}`)).json())
                        .items || []
                ).some((i) => i.doc_id === post);
                const own = (await dee(`${base(deeRoot)}/posts/${post}`)).status === 200;
                if (feed !== sees || own !== sees) sees = !want;
                if (sees !== want) await wait(300);
            }
            return sees;
        };
        const draft = await ok(
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'rules',
                body: 'be kind to potatoes',
                format: 'marquee',
            }),
            'draft',
        );
        const { post } = await ok(
            await j(ada, `${base(adaRoot)}/publish`, { doc: draft.doc_id }),
            'publish',
        );
        await j(ada, `${base(adaRoot)}/sync`, {});
        assert.equal(await deeSees(post, true), true, 'dee sees the post');

        await ok(await j(ada, `${base(adaRoot)}/docs/${post}/hide`, { hidden: true }), 'hide');
        await j(ada, `${base(adaRoot)}/sync`, {});
        assert.equal(await deeSees(post, false), false, "hidden, it leaves dee's page");
        const kept = (await posts(ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(kept && kept.hidden, 'the owner still sees it, marked hidden');

        await ok(await j(ada, `${base(adaRoot)}/docs/${post}/hide`, { hidden: false }), 'show');
        await j(ada, `${base(adaRoot)}/sync`, {});
        assert.equal(await deeSees(post, true), true, 'shown again, dee sees it');
    });

    it('a group nobody invited you to opens nothing', async () => {
        const res = await j(dee, `api/identity/${deeRoot}/groups/${'00'.repeat(16)}/open`, {});
        assert.equal(res.status, 404);
    });
});
