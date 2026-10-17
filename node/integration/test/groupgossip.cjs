/*
    Group sync by gossip (plans/NETWORK.md, "Group gossip"): the group-sync beat asks a few of
    the current members' machines - two by reliability and one check-in - and each exchange runs
    both ways, so news spreads from node to node without anyone dialing everyone. Four members on
    four nodes. A post said at alpha reaches the other three by beats alone, and once a member is
    removed, the beat never asks their node again: the removal and what follows it reach the
    others, and the removed member's machine at alpha goes unasked.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C, HOST_E, makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)('groups: sync by gossip', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, dee, deeRoot, group;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const act = async (who, root, path, body = {}) => {
        const res = await j(who, `api/identity/${root}/groups/${group}/${path}`, body);
        const text = await res.text();
        assert.equal(res.status, 200, `${path}: ${text}`);
        return JSON.parse(text);
    };
    const post = async (who, root, body) => {
        const d = await (
            await j(who, `api/identity/${root}/docs`, { title: '', body, format: 'marquee' })
        ).json();
        return (await act(who, root, 'publish', { doc: d.doc_id })).post;
    };
    const has = async (host, who, root, doc) => {
        await beat(host, 'fold', root);
        const res = await who(`api/identity/${root}/groups/${group}/posts`);
        if (res.status !== 200) return false;
        return ((await res.json()).posts || []).some((p) => p.doc === doc);
    };
    const machineAtAlpha = async (name) =>
        (await (await ada(`api/identity/${adaRoot}/machines`)).json()).machines.find(
            (m) => m.name === name,
        );

    before(async () => {
        [ada, adaRoot] = await persona('ggada');
        [bea, beaRoot] = await persona('ggbea', HOST_B);
        [cal, calRoot] = await persona('ggcal', HOST_C);
        [dee, deeRoot] = await persona('ggdee', HOST_E);
        const founded = await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Gossip Bunch' });
        group = (await founded.json()).group;
        for (const [who, root] of [
            [bea, beaRoot],
            [cal, calRoot],
            [dee, deeRoot],
        ]) {
            const token = await act(ada, adaRoot, 'invites', { invitee: root });
            await act(who, root, 'join', {
                invite: token.invite,
                founder: token.founder,
                inviter: token.inviter,
                via: token.via,
            });
        }
        await act(ada, adaRoot, 'sync');
    });

    it('a post reaches every member by beats alone', async () => {
        const said = await post(ada, adaRoot, 'news from alpha');
        let everywhere = false;
        for (let i = 0; i < 6 && !everywhere; i++) {
            for (const host of [HOST, HOST_B, HOST_C, HOST_E]) await beat(host, 'group-sync');
            everywhere =
                (await has(HOST_B, bea, beaRoot, said)) &&
                (await has(HOST_C, cal, calRoot, said)) &&
                (await has(HOST_E, dee, deeRoot, said));
        }
        assert.ok(everywhere, 'bravo, charlie and echo all hold it');
        const bravo = await machineAtAlpha('bravo');
        assert.ok(bravo && bravo.lanes.sync, 'and alpha knows bravo for it');
    });

    it("a removed member's node is never asked again", async () => {
        const echo = await machineAtAlpha('echo');
        assert.ok(echo, 'alpha knows echo');
        const partners = async () =>
            (await makeFetch(HOST)(`test/group-partners?group=${group}`)).json();
        assert.ok(
            (await partners()).candidates.includes(echo.endpoint),
            'a candidate while dee is in',
        );

        await act(ada, adaRoot, 'remove', { target: deeRoot });
        for (const host of [HOST, HOST_B, HOST_C]) await beat(host, 'group-sync');
        const after = await partners();
        assert.ok(
            !after.candidates.includes(echo.endpoint),
            `echo is no candidate: ${JSON.stringify(after)}`,
        );
        assert.ok(after.picked.length >= 2, 'bravo and charlie still are');

        const said = await post(ada, adaRoot, 'news after dee');
        let reached = false;
        for (let i = 0; i < 6 && !reached; i++) {
            await beat(HOST, 'group-sync');
            await beat(HOST_B, 'group-sync');
            reached =
                (await has(HOST_B, bea, beaRoot, said)) && (await has(HOST_C, cal, calRoot, said));
        }
        assert.ok(reached, 'the members still hear');
    });
});
