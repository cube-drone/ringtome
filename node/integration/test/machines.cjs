/*
    The machine table and the Network page (plans/NETWORK.md, 2026-10-17). Two nodes that talk
    know each other: by the name each announces in its Hello, by whether it answered and how fast,
    by the protocols they used. Everyone on a node sees its machines; only a person's own links
    to them - here, a group they're in - come with the row, and another account on the same node
    sees the row bare. An administrator renames the machine, and the next Hello carries the new
    name to the other side.

    The failure half (decay, dark at boot, the flush surviving a restart) is the unit tests' in
    machines.rs: the rig neither restarts nodes nor marks them dark.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { HOST, HOST_B, sql } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)('the machine table and the Network page', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, beaAdmin, group;

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
    const table = async (who, root) => {
        const res = await who(`api/identity/${root}/machines`);
        assert.equal(res.status, 200, await res.clone().text());
        return res.json();
    };

    before(async () => {
        [ada, adaRoot] = await persona('mtada');
        [cal, calRoot] = await persona('mtcal');
        [bea, beaRoot] = await persona('mtbea', HOST_B);
        beaAdmin = await makeUserFetch({ prefix: 'mtadm', host: HOST_B });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${beaAdmin.account.id}', 'node_admin')`,
            HOST_B,
        );
        const founded = await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Network Bunch' });
        group = (await founded.json()).group;
        const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
        await act(bea, beaRoot, 'join', {
            invite: token.invite,
            founder: token.founder,
            inviter: token.inviter,
            via: token.via,
        });
        await act(ada, adaRoot, 'sync');
    });

    after(async () => {
        await j(beaAdmin, 'api/admin/machine-name', { name: null }, 'PUT');
    });

    it('a machine this node talked to is in its table, by the name it announced', async () => {
        const { this: me, machines } = await table(ada, adaRoot);
        assert.ok(me.name, 'this machine has a name');
        assert.ok(me.words, 'and speakable words');
        assert.deepEqual([me.client, me.device], ['hdt', 'server'], 'and says what it is');
        assert.ok(!machines.some((m) => m.endpoint === me.endpoint), 'never itself');
        const bravo = machines.find((m) => m.name === 'bravo');
        assert.ok(bravo, `bravo is known by name: ${JSON.stringify(machines.map((m) => m.name))}`);
        assert.ok(bravo.last_ok_ms, 'it answered');
        assert.ok(bravo.reliability > 0.5, `and reads reliable: ${bravo.reliability}`);
        assert.ok(bravo.connect_ms != null, 'with a connect time');
        assert.ok(bravo.lanes.sync, 'over the sync lane');
        assert.ok(bravo.version, 'its version is known');
        assert.equal(bravo.client, 'hdt', 'the client it runs');
        assert.equal(bravo.device, 'server', 'a rig node is a server');
        assert.ok(
            bravo.users >= 1 && bravo.personas >= 1,
            `what it carries: ${bravo.users}, ${bravo.personas}`,
        );
        assert.ok(bravo.words, 'and its words');
    });

    it('the other side knows the caller too, as one that called in', async () => {
        const { machines } = await table(bea, beaRoot);
        const alpha = machines.find((m) => m.name === 'alpha');
        assert.ok(alpha, `alpha is known at bravo: ${JSON.stringify(machines.map((m) => m.name))}`);
        assert.ok(alpha.last_inbound_ms, 'it called in');
    });

    it("a person's own links come with the row, and nobody else's", async () => {
        const mine = (await table(ada, adaRoot)).machines.find((m) => m.name === 'bravo');
        assert.ok(
            mine.links.some(
                (l) => l.kind === 'group' && l.group === group && l.name === 'Network Bunch',
            ),
            `ada's group runs through bravo: ${JSON.stringify(mine.links)}`,
        );
        const theirs = (await table(cal, calRoot)).machines.find((m) => m.name === 'bravo');
        assert.ok(theirs, 'cal, on the same node, sees the machine');
        assert.deepEqual(theirs.links, [], "but not ada's links to it");
    });

    it('a stranger to the persona is refused the page', async () => {
        assert.notEqual((await cal(`api/identity/${adaRoot}/machines`)).status, 200);
    });

    it('an administrator renames the machine, and the next Hello carries it', async () => {
        assert.notEqual(
            (await j(bea, 'api/admin/machine-name', { name: 'the attic' }, 'PUT')).status,
            200,
            'not for someone who only lives there',
        );
        const named = await j(beaAdmin, 'api/admin/machine-name', { name: '  the attic  ' }, 'PUT');
        assert.equal(named.status, 200, await named.clone().text());
        assert.deepEqual(await named.json(), { name: 'the attic', chosen: true });
        assert.equal((await table(bea, beaRoot)).this.name, 'the attic');

        await act(ada, adaRoot, 'sync');
        const row = (await table(ada, adaRoot)).machines.find((m) => m.name === 'the attic');
        assert.ok(row, 'alpha hears the new name');

        const back = await j(beaAdmin, 'api/admin/machine-name', { name: null }, 'PUT');
        assert.deepEqual(await back.json(), { name: 'bravo', chosen: false }, 'back to its own');
    });
});
