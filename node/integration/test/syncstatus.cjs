// Sync status (plans/SYNC_STATUS.md, pieces 2 and 4): the node's sync ledger, as a persona's page
// asks it - each of its other computers by its key, whether and when it was reached, what the last
// exchange moved, the bodies still to come, the corner's face, and the network's work in counts.
const assert = require('node:assert');
const { HOST_B } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)('sync status across two computers', function () {
    this.timeout(60000);

    it("each computer names the other, reached, with what moved; the face and the network's counts ride along", async () => {
        const alice = await makeUserFetch({ prefix: 'syncstat' });
        const root = (await (await alice('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(alice, `api/identity/${root}/docs`, {
            title: 'a note',
            body: 'words',
            format: 'marquee',
        });
        const aliceOnB = await makeUserFetch({ prefix: 'syncstatb', host: HOST_B });
        const request = await (
            await aliceOnB('api/identity/adopt/begin', { method: 'POST' })
        ).json();
        const grant = await (
            await j(alice, `api/identity/${root}/nodes`, { code: request.code })
        ).json();
        const adopted = await j(aliceOnB, 'api/identity/adopt/complete', { code: grant.code });
        assert.equal(adopted.status, 200, await adopted.text());

        // B asks for a sync; A has written since, so it has something to move.
        await j(alice, `api/identity/${root}/docs`, {
            title: 'another',
            body: 'more words',
            format: 'marquee',
        });
        const pulled = await aliceOnB(`api/identity/${root}/sync`, { method: 'POST' });
        assert.ok([200, 202].includes(pulled.status), `sync answered ${pulled.status}`);

        const status = async (who) => (await who(`api/identity/${root}/sync/status`)).json();
        let onB;
        for (let i = 0; i < 40; i++) {
            onB = await status(aliceOnB);
            if (onB.computers.some((c) => c.reached_ms)) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        const a = onB.computers.find((c) => c.reached_ms);
        assert.ok(a, `B names A, reached: ${JSON.stringify(onB)}`);
        assert.ok(a.leaf, 'by its key, which the page names');
        assert.equal(a.error, null, 'no error');
        assert.ok(
            a.theirs_ahead !== undefined && a.ours_ahead !== undefined,
            'how far apart, both ways',
        );
        assert.equal(typeof onB.bodies_waiting, 'number');
        assert.ok(['down', 'up', 'sun', 'idle'].includes(onB.face.face), JSON.stringify(onB.face));
        assert.equal(typeof onB.network.people, 'number', 'the network, in counts');

        const onA = await status(alice);
        assert.ok(onA.computers.length >= 1, 'A names B among its computers');

        const stranger = await makeUserFetch({ prefix: 'syncstatx' });
        assert.equal(
            (await stranger(`api/identity/${root}/sync/status`)).status,
            404,
            'only its owner asks',
        );
    });

    it('two computers holding the same things show the same sync code, and the same counts', async () => {
        const alice = await makeUserFetch({ prefix: 'synccode' });
        const root = (await (await alice('api/identity', { method: 'POST' })).json()).root_pubkey;
        for (const title of ['one', 'two', 'three']) {
            await j(alice, `api/identity/${root}/docs`, {
                title,
                body: 'words',
                format: 'marquee',
            });
        }
        const aliceOnB = await makeUserFetch({ prefix: 'synccodeb', host: HOST_B });
        const request = await (
            await aliceOnB('api/identity/adopt/begin', { method: 'POST' })
        ).json();
        const grant = await (
            await j(alice, `api/identity/${root}/nodes`, { code: request.code })
        ).json();
        await j(aliceOnB, 'api/identity/adopt/complete', { code: grant.code });

        const held = async (who) => (await who(`api/identity/${root}/sync/held`)).json();
        let a, b;
        for (let i = 0; i < 40; i++) {
            await aliceOnB(`api/identity/${root}/sync`, { method: 'POST' });
            [a, b] = [await held(alice), await held(aliceOnB)];
            if (a.sync_code === b.sync_code) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.match(a.sync_code, /^[A-Z2-9]{6}$/, 'six letters a person can read aloud');
        assert.equal(b.sync_code, a.sync_code, 'the same chains, the same code');
        assert.equal(a.documents.notes, 3);
        assert.equal(b.documents.notes, a.documents.notes, 'and the same notes');

        // A writes; until B has it, the codes differ - which is what the code is for.
        await j(alice, `api/identity/${root}/docs`, {
            title: 'four',
            body: 'words',
            format: 'marquee',
        });
        assert.notEqual((await held(alice)).sync_code, b.sync_code, 'A moved on');
    });
});
