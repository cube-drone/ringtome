/*
    A sealing key among a persona's own computers (Curtis, 2026-11-10: as @official, a chat with
    @cube_drone - both on one server - said "this room is sealed", the chat having been opened on
    another of @cube_drone's computers).

    A key's memo is written where a post is sealed, with the audience it was sealed to; the
    author's other computers write their own when the draft comes over. Until it does, a node
    hosting the author knows the audience no better than a stranger's node - and it used to judge
    anyway, by a memo it didn't have. Three claims:

    - A node hosting the author with no memo of its own asks the author's other computers, for the
      reader: ada's chat with cat, opened on ada's first computer, opens for cat on the server that
      hosts cat and ada's second computer.
    - A persona's computers hand each other the keys it was given: bea opens ada's chat on her
      first computer; with ada's node dark, her second computer gets the key from the first.
    - Only a node that may judge the audience does. A reader's node holding a key gives it to that
      reader's own computers and to nobody else - not to someone the author trusts who asks it.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C, HOST_E, makeFetch, sql } = require('./fetch.cjs');
const { withUnplugged } = require('./unplug.cjs');

const endpointOf = async (who) => (await (await who('api/node')).json()).endpoint_id;
const base58 = async (who) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58(await endpointOf(who));
};
const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)(
    "a sealing key among a persona's own computers",
    function () {
        this.timeout(900000);

        let speakable;
        let ada, adaRoot, adaOnE, cat, catRoot, dan, danRoot, bea, beaRoot, beaOnC;
        let chatCat, chatBea;

        const person = async (prefix, host) => {
            const who = await makeUserFetch(host ? { prefix, host } : { prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };
        // A second computer for a persona, by the real ceremony.
        const adopt = async (owner, root, prefix, host) => {
            const second = await makeUserFetch({ prefix, host });
            const request = await (
                await second('api/identity/adopt/begin', { method: 'POST' })
            ).json();
            const granted = await j(owner, `api/identity/${root}/nodes`, { code: request.code });
            assert.equal(granted.status, 200, await granted.text());
            await pullAndFold(host, root);
            return second;
        };
        // The chat for two, as the client's `openIm` mints it (ims.cjs).
        const openIm = async (them) => {
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'a chat',
                    body: `[user id=/id/${speakable(them)}]them[/user]`,
                    format: 'marquee',
                })
            ).json();
            await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: 'PUT' });
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
                room: true,
                im: true,
                trusted_only: true,
                audience: '@mentioned',
            });
            const text = await pub.text();
            assert.equal(pub.status, 200, text);
            return JSON.parse(text).post_id;
        };
        const memo = async (host, doc) =>
            (
                await sql(
                    `SELECT own FROM post_keys WHERE author_root = '${adaRoot}' AND doc_id = '${doc}'`,
                    host,
                )
            ).rows[0];
        const grants = async (host, doc) =>
            (
                await sql(
                    `SELECT reader_root FROM post_key_grants WHERE author_root = '${adaRoot}' AND doc_id = '${doc}'`,
                    host,
                )
            ).rows.map((r) => r.reader_root);
        // Everything `host` knows of the key: as on a computer the key has not reached.
        const forget = async (host, doc) => {
            for (const table of [
                'post_keys',
                'post_audience_members',
                'post_key_grants',
                'post_key_refusals',
            ])
                await sql(
                    `DELETE FROM ${table} WHERE author_root = '${adaRoot}' AND doc_id = '${doc}'`,
                    host,
                );
        };
        const door = (who, root, doc) => who(`api/identity/${root}/rooms/${adaRoot}/${doc}`);

        before(async function () {
            ({ speakable } = await import('../../js/speakable.js'));
            [ada, adaRoot] = await person('ksada');
            [cat, catRoot] = await person('kscat', HOST_E);
            [dan, danRoot] = await person('ksdan', HOST_E);
            [bea, beaRoot] = await person('ksbea', HOST_B);
            // Bea follows ada, which is how the chat's post reaches her nodes.
            if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
                this.skip();
            await j(
                bea,
                `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
            await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
            await ada(`api/id/${catRoot}/profile?via=${await base58(cat)}`);
            await ada(`api/id/${danRoot}/profile?via=${await base58(dan)}`);
            // Ada trusts dan, in public: under the old door that was enough to be handed a key
            // by any node that held it.
            await j(
                ada,
                `api/identity/${adaRoot}/private/kv/contact:${danRoot}/trust`,
                { value: 'high' },
                'PUT',
            );
            adaOnE = await adopt(ada, adaRoot, 'ksadae', HOST_E);
            beaOnC = await adopt(bea, beaRoot, 'ksbeac', HOST_C);
            await beat(HOST, 'mint', adaRoot);
            await beat(HOST_B, 'mint', beaRoot);
        });

        it("a server hosting the author asks the author's other computer, for the reader", async () => {
            chatCat = await openIm(catRoot);
            // The draft comes over and the second computer writes its own memo; then take it
            // away, which is the server the draft never reached.
            let own = false;
            for (let i = 0; i < 60 && !own; i++) {
                await pullAndFold(HOST_E, adaRoot);
                own = !!(await memo(HOST_E, chatCat))?.own;
                if (!own) await wait(400);
            }
            assert.ok(own, "the second computer's own memo, from the draft");
            // Let the rest of the draft's private chain land first: each arrival has the second
            // computer write its memo again, and the claim needs it gone.
            for (let i = 0; i < 4; i++) await pullAndFold(HOST_E, adaRoot);
            await forget(HOST_E, chatCat);

            const hers = await door(cat, catRoot, chatCat);
            assert.equal(hers.status, 200, await hers.clone().text());
            assert.equal((await hers.json()).other, adaRoot, 'her chat with ada');
            const row = await memo(HOST_E, chatCat);
            assert.ok(row && !row.own, "the key, on the first computer's word and not this one's");
            assert.ok((await grants(HOST_E, chatCat)).includes(catRoot), 'given for cat');

            // Dan, on the same server and trusted by ada, is not who it was sealed to.
            const his = await door(dan, danRoot, chatCat);
            assert.equal(his.status, 403, await his.clone().text());
            assert.ok(!(await grants(HOST_E, chatCat)).includes(danRoot), 'nothing given for dan');

            // Ada reads her own chat there too.
            const own_door = await door(adaOnE, adaRoot, chatCat);
            assert.equal(own_door.status, 200, await own_door.clone().text());
        });

        it("a persona's second computer gets a key its first was given, with the author dark", async () => {
            chatBea = await openIm(beaRoot);
            let entered = false;
            for (let i = 0; i < 40 && !entered; i++) {
                entered = (await door(bea, beaRoot, chatBea)).status === 200;
                if (!entered) {
                    await pullAndFold(HOST_B, adaRoot);
                    await wait(400);
                }
            }
            assert.ok(entered, 'bea is in, on her first computer');
            assert.ok((await grants(HOST_B, chatBea)).includes(beaRoot), 'the key given for her');

            // Her second computer holds the room, and nothing of its key.
            let held = false;
            for (let i = 0; i < 40 && !held; i++) {
                await pullAndFold(HOST_C, adaRoot);
                await pullAndFold(HOST_C, beaRoot);
                held = [200, 403].includes((await door(beaOnC, beaRoot, chatBea)).status);
                if (!held) await wait(400);
            }
            assert.ok(held, 'the room reached her second computer');
            await withUnplugged(HOST, async () => {
                await forget(HOST_C, chatBea);
                // The first ask may find a ledger not yet resolved; the door asks again.
                let status = 0;
                for (let i = 0; i < 20 && status !== 200; i++) {
                    status = (await door(beaOnC, beaRoot, chatBea)).status;
                    if (status !== 200) await wait(500);
                }
                assert.equal(status, 200, "in, on her first computer's copy of the key");
                assert.ok((await grants(HOST_C, chatBea)).includes(beaRoot), 'given for bea');
            });
        });

        it("a reader's node gives the key to that reader's computers, and to nobody the author merely trusts", async () => {
            const probe = async (from, reader) => {
                const res = await j(makeFetch(from), 'test/door-probe', {
                    root: adaRoot,
                    endpoint: await endpointOf(bea),
                    door: 'key',
                    doc: chatBea,
                    reader,
                });
                assert.equal(res.status, 200, await res.clone().text());
                return (await res.json()).given;
            };
            // Bea's first computer is asked directly. It holds the key and judges nothing.
            assert.equal(await probe(HOST_C, beaRoot), true, "bea's other computer, for bea");
            // Dan's server asks for dan, whom ada trusts in public and didn't seal it to.
            // Bea's node knows dan's server and ada's trust in him: everything the old door
            // asked for before handing him the key.
            const met = await bea(`api/id/${danRoot}/profile?via=${await base58(dan)}`);
            assert.equal(met.status, 200, await met.clone().text());
            await pullAndFold(HOST_B, adaRoot);
            await pullAndFold(HOST_B, danRoot);
            assert.equal(await probe(HOST_E, danRoot), false, 'not for dan');
            // Nor for cat, by a server that does serve her.
            assert.equal(await probe(HOST_E, catRoot), false, 'not for cat');
        });
    },
);
