/*
    A chat read on the persona's other computer while the other person is away (Curtis,
    2026-10-30: "my conversation with him lives on Computer A, where I was chatting with him ...
    Computer B has my half of the conversation, but not his"). Ada talks with bea from her first
    computer; then bea's node goes dark, and ada opens the chat on her second computer. Her own
    lines come over with her own chains; bea's are on nobody the room names that is still up -
    only on ada's first computer, which heard them. The second computer asks its siblings first,
    and reads both halves - but a sibling's answer never ends the search, because a sibling can
    be behind: the room's own nodes are asked after it, for anything newer.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');
const { HOST, HOST_B, HOST_E } = require('./fetch.cjs');
const { withUnplugged } = require('./unplug.cjs');

const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};
const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_E ? describe : describe.skip)(
    "a chat on the persona's other computer, with the other person away",
    function () {
        this.timeout(600000);

        let ada, adaRoot, adaOnE, bea, beaRoot, chat;

        const wordsOn = async (who, root) =>
            (
                (await (await who(`api/identity/${root}/rooms/${adaRoot}/${chat}/messages`)).json())
                    .items || []
            ).map((m) => m.words);

        before(async function () {
            const { speakable } = await import('../../js/speakable.js');
            ada = await makeUserFetch({ prefix: 'sibada' });
            adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
            await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
            bea = await makeUserFetch({ prefix: 'sibbea', host: HOST_B });
            beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
            await bea(`api/identity/${beaRoot}/serve`, { method: 'POST' });
            if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
                this.skip();
            await j(
                bea,
                `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
                { value: 'high' },
                'PUT',
            );
            await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);

            // Ada's second computer, by the real ceremony.
            adaOnE = await makeUserFetch({ prefix: 'sibadae', host: HOST_E });
            const request = await (
                await adaOnE('api/identity/adopt/begin', { method: 'POST' })
            ).json();
            const granted = await j(ada, `api/identity/${adaRoot}/nodes`, { code: request.code });
            assert.equal(granted.status, 200, await granted.text());
            await pullAndFold(HOST_E, adaRoot);
            await beat(HOST, 'mint', adaRoot);

            // The chat for two, as the client's `openIm` mints it (ims.cjs).
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, {
                    title: 'a chat',
                    body: `[user id=/id/${speakable(beaRoot)}]them[/user]`,
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
            const pubText = await pub.text();
            assert.equal(pub.status, 200, pubText);
            chat = JSON.parse(pubText).post_id;
        });

        it('both halves are said, and heard on the first computer', async () => {
            let entered = false;
            for (let i = 0; i < 40 && !entered; i++) {
                entered =
                    (await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${chat}`)).status === 200;
                if (!entered) {
                    await pullAndFold(HOST_B, adaRoot);
                    await wait(400);
                }
            }
            assert.ok(entered, 'the door admits bea');
            const mine = await j(ada, `api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/messages`, {
                words: 'ada, from her first computer',
            });
            assert.equal(mine.status, 200, await mine.text());
            const hers = await j(bea, `api/identity/${beaRoot}/rooms/${adaRoot}/${chat}/messages`, {
                words: 'bea, before she goes',
            });
            assert.equal(hers.status, 200, await hers.text());
            let heard = [];
            for (let i = 0; i < 80 && !heard.includes('bea, before she goes'); i++) {
                await bea(`api/identity/${beaRoot}/rooms/${adaRoot}/${chat}/sync`, {
                    method: 'POST',
                });
                await ada(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/sync`, {
                    method: 'POST',
                });
                await beat(HOST, 'fold', beaRoot);
                heard = await wordsOn(ada, adaRoot);
                if (!heard.includes('bea, before she goes')) await wait(400);
            }
            assert.ok(heard.includes('bea, before she goes'), JSON.stringify(heard));
        });

        it("the second computer reads bea's half off the first, with bea's node dark", async () => {
            await withUnplugged(HOST_B, async () => {
                let heard = [];
                const both = () =>
                    heard.includes('ada, from her first computer') &&
                    heard.includes('bea, before she goes');
                for (let i = 0; i < 30 && !both(); i++) {
                    await pullAndFold(HOST_E, adaRoot);
                    await adaOnE(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/sync`, {
                        method: 'POST',
                    });
                    await beat(HOST_E, 'fold', beaRoot);
                    heard = await wordsOn(adaOnE, adaRoot);
                    if (!both()) await wait(400);
                }
                assert.ok(
                    heard.includes('ada, from her first computer'),
                    `her own half came with her chains: ${JSON.stringify(heard)}`,
                );
                assert.ok(
                    heard.includes('bea, before she goes'),
                    `and bea's came from her first computer: ${JSON.stringify(heard)}`,
                );
            });
        });

        it("a sibling that slept through a line doesn't end the search: bea's own node still adds it", async () => {
            // Bea speaks while ada's first computer is away, so it never hears her...
            await withUnplugged(HOST, async () => {
                const said = await j(
                    bea,
                    `api/identity/${beaRoot}/rooms/${adaRoot}/${chat}/messages`,
                    {
                        words: 'bea, while the first computer slept',
                    },
                );
                assert.equal(said.status, 200, await said.text());
            });
            // ...and ada's second computer asks that sibling first, then bea's node.
            let heard = [];
            for (let i = 0; i < 30 && !heard.includes('bea, while the first computer slept'); i++) {
                await adaOnE(`api/identity/${adaRoot}/rooms/${adaRoot}/${chat}/sync`, {
                    method: 'POST',
                });
                await beat(HOST_E, 'fold', beaRoot);
                heard = await wordsOn(adaOnE, adaRoot);
                if (!heard.includes('bea, while the first computer slept')) await wait(400);
            }
            assert.ok(heard.includes('bea, while the first computer slept'), JSON.stringify(heard));
        });
    },
);
