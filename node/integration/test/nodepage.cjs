/*
    A node introduces itself (plans/NODE_PAGE.md; Curtis, 2026-11-05): "Here's who I host, here's
    some basic information about me and the software I'm running". Asked from the node page, it
    answers with its name, version and size, its web address - believed only where that address
    answers as the same node - and the people it lists on its own front page, nobody else.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { HOST, HOST_B, sql, makeFetch } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)('node introductions', function () {
    this.timeout(60000);

    // A viewer on alpha looks at bravo, where one person is listed and one asked not to be.
    let viewer, viewerRoot, bravo, listedRoot, quietRoot;
    const bravoDoor = makeFetch(HOST_B);
    const page = async (endpoint) =>
        (await viewer(`api/identity/${viewerRoot}/nodes/${endpoint}`)).json();
    const introduce = async (endpoint) => {
        const r = await viewer(`api/identity/${viewerRoot}/nodes/${endpoint}/introduce`, {
            method: 'POST',
        });
        assert.equal(r.status, 200, await r.clone().text());
        return r.json();
    };
    const sayAddress = (address) => j(bravoDoor, 'test/intro-address', { address });

    before(async () => {
        viewer = await makeUserFetch({ prefix: 'introview' });
        viewerRoot = (await (await viewer('api/identity', { method: 'POST' })).json()).root_pubkey;
        const host = await makeUserFetch({ prefix: 'introhost', host: HOST_B });
        listedRoot = (await (await host('api/identity', { method: 'POST' })).json()).root_pubkey;
        quietRoot = (await (await host('api/identity', { method: 'POST' })).json()).root_pubkey;
        const off = await j(host, `api/identity/${quietRoot}/listed`, { listed: false }, 'PUT');
        assert.equal(off.status, 200, await off.clone().text());
        bravo = (await (await host('api/node')).json()).endpoint_id;
    });

    after(() => sayAddress(null));

    it('says its name, its software, its size and the people it lists, and nobody else', async function () {
        const p = await introduce(bravo);
        assert.deepEqual(p.asked, { ok: true });
        assert.ok(p.intro.name, 'a name');
        assert.ok(p.intro.version, 'a version');
        assert.equal(p.intro.device, 'server');
        assert.ok(p.intro.personas >= 2, `${p.intro.personas} personas`);
        const hosts = new Map(p.hosts.map((h) => [h.root, h]));
        assert.equal(hosts.get(listedRoot)?.says, true, 'the listed person, in its own words');
        assert.ok(!hosts.get(quietRoot)?.says, 'not the one who asked not to be listed');
        assert.equal(p.ours, false);
        assert.ok(p.machine, 'and the machine table met it');
    });

    it('believes an address only where it answers as the same node', async function () {
        await sayAddress(`http://${HOST_B}`);
        const own = await introduce(bravo);
        assert.equal(own.intro.address, `http://${HOST_B}`);
        assert.equal(own.intro.address_checked, true, 'its own address checks out');

        await sayAddress(`http://${HOST}`);
        const borrowed = await introduce(bravo);
        assert.equal(borrowed.intro.address, `http://${HOST}`, 'kept, as what it said');
        assert.equal(borrowed.intro.address_checked, false, "another node's doesn't");
    });

    it('learns who a machine is by itself, without the button', async function () {
        // Forget bravo's introduction, then let the background pass run once (the rig's beat).
        await sql(`DELETE FROM machine_intros WHERE endpoint_id = '${bravo}'`, HOST);
        assert.equal((await page(bravo)).intro, null, 'forgotten');
        const beat = await j(makeFetch(HOST), 'test/beat', { pass: 'introductions' });
        assert.equal(beat.status, 200, await beat.clone().text());
        const p = await page(bravo);
        assert.ok(p.intro && p.intro.answered_ms, 'it asked on its own');
        assert.ok(
            p.hosts.some((h) => h.root === listedRoot && h.says),
            'and heard who it lists',
        );
    });

    it('names the servers a person lives on, from their own serving records', async function () {
        const { toBase58 } = await import('../../js/speakable.js');
        assert.equal(
            (await viewer(`api/id/${listedRoot}/profile?via=${toBase58(bravo)}`)).status,
            200,
        );
        let where;
        for (let i = 0; i < 40; i++) {
            where = await (await viewer(`api/identity/${viewerRoot}/where/${listedRoot}`)).json();
            if (where.servers.some((s) => s.endpoint === bravo)) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        const there = where.servers.find((s) => s.endpoint === bravo);
        assert.ok(there, `bravo, among ${JSON.stringify(where)}`);
        assert.equal(there.name, (await page(bravo)).intro.name, 'by the name it introduced');
        assert.deepEqual(where.computers, [], "nobody else's computers named");
    });

    it("answers for a node it has never met, for one it can't reach, and for itself", async function () {
        // A real key that no node answers to: the viewer's own persona root.
        const nobody = await page(viewerRoot);
        assert.equal(nobody.machine, null);
        assert.equal(nobody.intro, null);
        assert.deepEqual(nobody.hosts, []);

        const asked = await introduce(viewerRoot);
        assert.equal(asked.asked.ok, false);
        assert.equal(asked.asked.error, 'unreachable');
        assert.equal(asked.intro.error, 'unreachable', 'and the page remembers why');

        const alpha = (await (await viewer('api/node')).json()).endpoint_id;
        const self = await page(alpha);
        assert.equal(self.ours, true);
        assert.ok(self.intro.name, 'what it would say of itself');

        assert.equal((await viewer(`api/identity/${viewerRoot}/nodes/not-a-node`)).status, 400);
    });
});
