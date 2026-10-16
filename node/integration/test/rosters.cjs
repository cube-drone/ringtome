/*
    Groups, slice 1b (plans/GROUPS.md): a group is its members' lanes - one chain per device per
    group, each on its member's own persona - and its roster a fold over them that every member's
    node computes alike. Ada founds the Potato Bunch on her node and invites bea, on another; a
    stranger's node is refused it; cal joins on a third and meets the members' nodes. Ownership is
    a ranked tree: a junior can't remove a senior, and a demotion takes the demoted owner's
    appointees with them. A removal is anchored at what the remover had seen: bea's posts past
    it, which cal's node counted first, are void there once the removal arrives. Every claim
    syncs by hand - the group beat is an hour on the rig - so what each node has heard is the
    claim's to say.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B && HOST_C ? describe : describe.skip)(
    'groups: one roster, kept by everyone in it',
    function () {
        this.timeout(600000);

        let ada, adaRoot, bea, beaRoot, cal, calRoot, dee, deeRoot, group;

        const persona = async (prefix, host) => {
            const who = await makeUserFetch({ prefix, host });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };
        const act = async (who, root, verb, body = {}) => {
            const res = await j(who, `api/identity/${root}/groups/${group}/${verb}`, body);
            const text = await res.text();
            assert.equal(res.status, 200, `${verb}: ${text}`);
            return JSON.parse(text);
        };
        const sync = (who, root) => act(who, root, 'sync');
        // The roster as a node holds it, after folding everyone it could have heard from.
        const roster = async (host, who, root) => {
            for (const r of [adaRoot, beaRoot, calRoot].filter(Boolean))
                await beat(host, 'fold', r);
            const res = await who(`api/identity/${root}/groups/${group}`);
            return res.status === 200 ? res.json() : { status: res.status };
        };
        const members = (r) => (r.members || []).map((m) => m.root).sort();
        const owners = (r) =>
            (r.members || [])
                .filter((m) => m.owner)
                .map((m) => m.root)
                .sort();
        // A group post is a document (section 7): a draft, published to the group.
        const postTo = async (who, root, words) => {
            const d = await (
                await j(who, `api/identity/${root}/docs`, {
                    title: 'news',
                    body: words,
                    format: 'marquee',
                })
            ).json();
            return (await act(who, root, 'publish', { doc: d.doc_id })).post;
        };
        // The group's page as a node holds it, after folding everyone it could have heard from.
        const posts = async (host, who, root) => {
            for (const r of [adaRoot, beaRoot, calRoot].filter(Boolean))
                await beat(host, 'fold', r);
            const res = await who(`api/identity/${root}/groups/${group}/posts`);
            return res.status === 200 ? ((await res.json()).posts || []).map((p) => p.doc) : [];
        };
        const invite = (who, root, invitee) => act(who, root, 'invites', { invitee });
        const join = (who, root, token) =>
            act(who, root, 'join', {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });

        before(async function () {
            [ada, adaRoot] = await persona('grpada');
            [bea, beaRoot] = await persona('grpbea', HOST_B);
            [cal, calRoot] = await persona('grpcal', HOST_C);
            [dee, deeRoot] = await persona('grpdee', HOST_C);
            const founded = await j(ada, `api/identity/${adaRoot}/groups`, {
                name: 'Potato Bunch',
            });
            const text = await founded.text();
            assert.equal(founded.status, 200, text);
            group = JSON.parse(text).group;
        });

        it('an invite brings a member in, and both nodes fold one roster', async () => {
            const token = await invite(ada, adaRoot, beaRoot);
            const joined = await join(bea, beaRoot, token);
            assert.equal(joined.name, 'Potato Bunch');
            assert.deepEqual(members(joined), [adaRoot, beaRoot].sort());
            await sync(ada, adaRoot);
            const there = await roster(HOST, ada, adaRoot);
            assert.deepEqual(members(there), [adaRoot, beaRoot].sort());
            assert.deepEqual(owners(there), [adaRoot]);
        });

        it("a stranger's node is refused the group", async () => {
            // Dee holds bea's invite - not hers - and asks ada's node for the group with it.
            const token = await invite(ada, adaRoot, beaRoot);
            const res = await j(dee, `api/identity/${deeRoot}/groups/${group}/join`, {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });
            assert.equal(res.status, 404, 'nothing of the group reached her node');
            await sync(ada, adaRoot);
            assert.ok(!members(await roster(HOST, ada, adaRoot)).includes(deeRoot));
        });

        it("a third member joins on a third node, and every node's roster agrees", async () => {
            const token = await invite(ada, adaRoot, calRoot);
            assert.ok(token.via.length >= 2, 'the invite names the nodes the group is heard at');
            const joined = await join(cal, calRoot, token);
            assert.deepEqual(members(joined), [adaRoot, beaRoot, calRoot].sort());
            await sync(bea, beaRoot);
            await sync(ada, adaRoot);
            for (const [host, who, root] of [
                [HOST, ada, adaRoot],
                [HOST_B, bea, beaRoot],
                [HOST_C, cal, calRoot],
            ]) {
                assert.deepEqual(
                    members(await roster(host, who, root)),
                    [adaRoot, beaRoot, calRoot].sort(),
                );
            }
            // Dee shares cal's node, and still isn't shown it (ruling 3).
            assert.equal((await dee(`api/identity/${deeRoot}/groups/${group}`)).status, 404);
        });

        it("a junior's removal of a senior changes nothing", async () => {
            await act(ada, adaRoot, 'appoint', { target: beaRoot });
            await sync(ada, adaRoot);
            await sync(bea, beaRoot);
            await act(bea, beaRoot, 'appoint', { target: calRoot });
            await sync(bea, beaRoot);
            await sync(cal, calRoot);
            assert.deepEqual(
                owners(await roster(HOST_C, cal, calRoot)),
                [adaRoot, beaRoot, calRoot].sort(),
            );

            const mutiny = await act(cal, calRoot, 'remove', { target: beaRoot });
            assert.ok(members(mutiny).includes(beaRoot), 'bea appointed cal, so bea is senior');
            await sync(cal, calRoot);
            await sync(ada, adaRoot);
            const there = await roster(HOST, ada, adaRoot);
            assert.deepEqual(members(there), [adaRoot, beaRoot, calRoot].sort());
            assert.deepEqual(owners(there), [adaRoot, beaRoot, calRoot].sort());
        });

        it("a demotion takes the demoted owner's appointees with them", async () => {
            await act(ada, adaRoot, 'demote', { target: beaRoot });
            await sync(ada, adaRoot);
            await sync(cal, calRoot);
            for (const [host, who, root] of [
                [HOST, ada, adaRoot],
                [HOST_C, cal, calRoot],
            ]) {
                const r = await roster(host, who, root);
                assert.deepEqual(
                    owners(r),
                    [adaRoot],
                    'cal was appointed by bea, and falls with her',
                );
                assert.deepEqual(
                    members(r),
                    [adaRoot, beaRoot, calRoot].sort(),
                    'demoted, not removed',
                );
            }
        });

        it("posts past a removal's anchor are void, on a node that counted them first", async () => {
            const first = await postTo(bea, beaRoot, 'the first word');
            await sync(bea, beaRoot);
            await sync(ada, adaRoot);
            await sync(cal, calRoot);
            assert.ok((await posts(HOST, ada, adaRoot)).includes(first));

            // Ada removes bea, anchored at what her node has seen: the first post. She doesn't
            // sync, so the removal is still on her node alone when bea posts again.
            await act(ada, adaRoot, 'remove', { target: beaRoot });
            const second = await postTo(bea, beaRoot, 'the second word');
            await sync(bea, beaRoot);
            const before = await roster(HOST_C, cal, calRoot);
            assert.ok(
                (await posts(HOST_C, cal, calRoot)).includes(second),
                "cal's node hasn't heard of the removal yet",
            );
            assert.ok(members(before).includes(beaRoot));

            await sync(ada, adaRoot);
            const after = await roster(HOST_C, cal, calRoot);
            assert.ok(!members(after).includes(beaRoot));
            const page = await posts(HOST_C, cal, calRoot);
            assert.ok(page.includes(first), 'the anchored prefix stands');
            assert.ok(!page.includes(second), 'past the anchor is void');
        });

        it("leaving is the member's own act, and every node hears it", async () => {
            const left = await act(cal, calRoot, 'leave');
            assert.equal(left.left, true);
            await sync(cal, calRoot);
            await sync(ada, adaRoot);
            assert.deepEqual(members(await roster(HOST, ada, adaRoot)), [adaRoot]);
            assert.equal((await cal(`api/identity/${calRoot}/groups/${group}`)).status, 404);
        });

        it('the removed and the banned stay listed, and an owner can lift a ban and invite back', async () => {
            // Bea was removed above; cal left of their own accord, which is no removal.
            let r = await roster(HOST, ada, adaRoot);
            assert.deepEqual(r.removed, [beaRoot], 'bea is listed as removed, cal (who left) not');
            // Dee comes in, and is banned.
            await join(dee, deeRoot, await invite(ada, adaRoot, deeRoot));
            await sync(dee, deeRoot);
            await sync(ada, adaRoot);
            r = await act(ada, adaRoot, 'remove', { target: deeRoot, ban: true });
            assert.deepEqual(r.banned, [deeRoot]);
            assert.ok(!r.removed.includes(deeRoot), 'banned, and listed as that alone');
            // Lifted, dee is removed, not banned.
            r = await act(ada, adaRoot, 'unban', { target: deeRoot });
            assert.deepEqual(r.banned, []);
            assert.ok(r.removed.includes(deeRoot), 'lifted, dee is removed');
            const again = await j(ada, `api/identity/${adaRoot}/groups/${group}/unban`, {
                target: deeRoot,
            });
            assert.equal(again.status, 400, 'nothing left to lift');
            // Invited back, bea leaves the list, and the invite readmits the removal.
            await invite(ada, adaRoot, beaRoot);
            r = await roster(HOST, ada, adaRoot);
            assert.ok(!r.removed.includes(beaRoot), 'invited back, no longer just removed');
            assert.ok(r.invited.includes(beaRoot));
        });
    },
);
