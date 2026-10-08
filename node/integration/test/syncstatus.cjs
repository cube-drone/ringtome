// Sync status (plans/SYNC_STATUS.md, pieces 2 and 4): the node's sync ledger, as a persona's page
// asks it - each of its other computers by its key, whether and when it was reached, what the last
// exchange moved, the bodies still to come, the corner's face, and the network's work in counts.
const assert = require('node:assert');
const { HOST_B, sql } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

// A persona on A with some notes, adopted on B, and B caught up: the two computers agree. Returns
// both fetches and the root.
async function twoComputersAgreeing(prefix, notes = 3) {
    const alice = await makeUserFetch({ prefix });
    const root = (await (await alice('api/identity', { method: 'POST' })).json()).root_pubkey;
    for (let n = 0; n < notes; n++) {
        await j(alice, `api/identity/${root}/docs`, {
            title: `note ${n}`,
            body: 'words',
            format: 'marquee',
        });
    }
    const aliceOnB = await makeUserFetch({ prefix: `${prefix}b`, host: HOST_B });
    const request = await (await aliceOnB('api/identity/adopt/begin', { method: 'POST' })).json();
    const grant = await (
        await j(alice, `api/identity/${root}/nodes`, { code: request.code })
    ).json();
    await j(aliceOnB, 'api/identity/adopt/complete', { code: grant.code });
    const held = async (who) => (await who(`api/identity/${root}/sync/held`)).json();
    for (let i = 0; i < 60; i++) {
        await aliceOnB(`api/identity/${root}/sync`, { method: 'POST' });
        if ((await held(alice)).sync_code === (await held(aliceOnB)).sync_code) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal((await held(aliceOnB)).sync_code, (await held(alice)).sync_code, 'B caught up');
    return { alice, aliceOnB, root };
}

// B pulls from A, and answers what the pull said: the one exchange's stats.
async function pullOnB(aliceOnB, root) {
    const res = await aliceOnB(`api/identity/${root}/sync`, { method: 'POST' });
    assert.equal(res.status, 200, `the pull finished: ${res.status}`);
    const results = await res.json();
    const reached = results.find((r) => r.ok);
    assert.ok(reached, `B reached A: ${JSON.stringify(results)}`);
    return reached.stats;
}

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

    it('between two computers that agree, a pull resends nothing - private chains included', async () => {
        // The dialler used to claim only its public chains, so the other end resent every private
        // chain from its first entry, every exchange (plans/SYNC_STATUS.md, piece 7).
        const { aliceOnB, root } = await twoComputersAgreeing('syncdup');
        const stats = await pullOnB(aliceOnB, root);
        assert.equal(stats.duplicates, 0, `nothing came twice: ${JSON.stringify(stats)}`);
        assert.equal(stats.received, 0, 'and nothing new');
    });

    it('a memo behind its entries heals at the first resend, and the next pull is quiet', async () => {
        const { aliceOnB, root } = await twoComputersAgreeing('syncheal');
        // B forgets, in its memo only, the private chains it holds: its next claim leaves them out.
        await sql(
            `DELETE FROM chain_heads WHERE root_pubkey = '${root}' AND service IN (5, 6, 7)`,
            HOST_B,
        );
        const first = await pullOnB(aliceOnB, root);
        assert.ok(
            first.duplicates > 0,
            `A resent what B claimed to lack: ${JSON.stringify(first)}`,
        );
        assert.equal(first.received, 0, 'all of it already held');
        const second = await pullOnB(aliceOnB, root);
        assert.equal(second.duplicates, 0, `the memo healed: ${JSON.stringify(second)}`);
        const repair = await (
            await aliceOnB(`api/identity/${root}/sync/repair`, { method: 'POST' })
        ).json();
        assert.equal(repair.differed, 0, 'nothing left to repair');
    });

    it('the sync report and the repair: a memo out of step is named, mended, and agrees after', async () => {
        const { aliceOnB, root } = await twoComputersAgreeing('syncrep');
        await pullOnB(aliceOnB, root);
        await sql(
            `UPDATE chain_heads SET head_seq = head_seq + 5 WHERE root_pubkey = '${root}' AND service = 6`,
            HOST_B,
        );
        const report = async () => {
            const res = await aliceOnB(`api/identity/${root}/sync/report`);
            assert.equal(res.status, 200);
            assert.match(res.headers.get('content-type') || '', /^text\/plain/);
            return res.text();
        };
        const before = await report();
        assert.match(before, /DISAGREES with the entries on 1 chains/, before);
        assert.match(before, /documents-private/, before);
        assert.match(before, /sync code {3}[A-Z2-9]{6}/, before);
        assert.match(before, /pull .*sent \d+ received \d+ already-held 0/, 'the exchange B made');
        const repaired = await (
            await aliceOnB(`api/identity/${root}/sync/repair`, { method: 'POST' })
        ).json();
        assert.equal(repaired.differed, 1, 'one chain out of step');
        assert.match(await report(), /the memo agrees with the entries/);
        const again = await (
            await aliceOnB(`api/identity/${root}/sync/repair`, { method: 'POST' })
        ).json();
        assert.equal(again.differed, 0, 'and nothing the second time');

        const stranger = await makeUserFetch({ prefix: 'syncrepx' });
        assert.equal(
            (await stranger(`api/identity/${root}/sync/report`)).status,
            404,
            'its owner only',
        );
    });

    it("a persona's own sealed post and sealed room, made on one computer, open on its other", async () => {
        // The key memo was written only where a post was minted, so everything sealed on one
        // computer stayed shut to the persona on the rest (Curtis, 2026-10-07: "none of the chats,
        // none of the sealed posts"), though the draft carrying the key had synced across.
        const alice = await makeUserFetch({ prefix: 'syncseal' });
        const root = (await (await alice('api/identity', { method: 'POST' })).json()).root_pubkey;
        const draft = async (title) =>
            (
                await (
                    await j(alice, `api/identity/${root}/docs`, {
                        title,
                        body: 'sealed words',
                        format: 'marquee',
                    })
                ).json()
            ).doc_id;
        const note = await draft('a sealed post');
        const sealed = await j(alice, `api/identity/${root}/docs/${note}/publish`, {
            trusted_only: true,
        });
        assert.equal(sealed.status, 200, await sealed.clone().text());
        const post = (await sealed.json()).post_id;
        const kitchen = await draft('the kitchen');
        await alice(`api/identity/${root}/docs/${kitchen}/buckets/chat`, { method: 'PUT' });
        const made = await j(alice, `api/identity/${root}/docs/${kitchen}/publish`, {
            room: true,
            trusted_only: true,
        });
        assert.equal(made.status, 200, await made.clone().text());
        const room = (await made.json()).post_id;
        assert.equal(
            (await alice(`id/${root}/docs/${post}/body`)).status,
            200,
            'it opens where it was made',
        );

        const aliceOnB = await makeUserFetch({ prefix: 'syncsealb', host: HOST_B });
        const request = await (
            await aliceOnB('api/identity/adopt/begin', { method: 'POST' })
        ).json();
        const grant = await (
            await j(alice, `api/identity/${root}/nodes`, { code: request.code })
        ).json();
        await j(aliceOnB, 'api/identity/adopt/complete', { code: grant.code });
        let body, door;
        for (let i = 0; i < 60; i++) {
            await aliceOnB(`api/identity/${root}/sync`, { method: 'POST' });
            body = (await aliceOnB(`id/${root}/docs/${post}/body`)).status;
            door = (await aliceOnB(`api/identity/${root}/rooms/${root}/${room}`)).status;
            if (body === 200 && door === 200) break;
            await new Promise((r) => setTimeout(r, 250));
        }
        assert.equal(body, 200, 'the sealed post opens on the other computer');
        assert.equal(door, 200, 'and so does the sealed room');
    });
});
