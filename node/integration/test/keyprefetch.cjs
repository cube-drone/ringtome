/*
    A follower reads sealed words after their author goes dark (Curtis, 2026-09-29: "it'll make
    'trusted only' posts work more reliably network wide, not just for chat rooms"). A sealed
    post's key is released only by its author's node - so bea's node must have it before ada's
    goes away, though bea has opened neither the post nor the room. For a follower two things see
    to that at arrival: folding ada's chain opens her sealed labels, which asks for the key on
    every hosted follower's behalf (notifications.rs), and the key prefetch (keyprefetch.rs) backs
    it up. This claim pins the outcome; onward.cjs pins what only the prefetch reaches - a share's
    key, for a reader who doesn't follow the author.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat, pullAndFold } = require('./beat.cjs');
const { HOST, HOST_B } = require('./fetch.cjs');
const { withUnplugged } = require('./unplug.cjs');

const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};
const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("sealed posts' keys are asked for at arrival", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, post, room;

    const publish = async (title, body, extra) => {
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: 'marquee' })
        ).json();
        if (extra.room)
            await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/chat`, { method: 'PUT' });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
            trusted_only: true,
            ...extra,
        });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        return JSON.parse(text).post_id;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: 'keysada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        bea = await makeUserFetch({ prefix: 'keysbea', host: HOST_B });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: 'POST' });
        // bea follows ada; ada trusts bea, and meets her chains so the key-release check can
        // find her serving record.
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200)
            this.skip();
        await j(
            bea,
            `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`,
            { value: 'high' },
            'PUT',
        );
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`,
            { value: 'high' },
            'PUT',
        );
        await beat(undefined, 'mint', adaRoot);
        await ada(`api/id/${beaRoot}/profile?via=${await base58(bea)}`);
        await pullAndFold(undefined, beaRoot);

        post = await publish('between us', 'the quiet words', {});
        room = await publish('the back room', 'only for the trusted', { room: true });
        // bea's node takes both in while ada is up - and bea opens neither.
        let feed = [];
        for (let i = 0; i < 30 && !(feed.includes(post) && feed.includes(room)); i++) {
            await pullAndFold(HOST_B, adaRoot);
            feed = ((await (await bea(`api/identity/${beaRoot}/feed`)).json()).items || []).map(
                (r) => r.doc_id,
            );
            if (!(feed.includes(post) && feed.includes(room))) await wait(400);
        }
        assert.ok(
            feed.includes(post) && feed.includes(room),
            `both reached bea's feed: ${JSON.stringify(feed)}`,
        );
    });

    it("with ada's node dark, bea opens the sealed post and the sealed room she never opened while ada was up", async () => {
        await beat(HOST_B, 'key-prefetch');
        await withUnplugged([HOST], async () => {
            for (const [doc, words] of [
                [post, 'the quiet words'],
                [room, 'only for the trusted'],
            ]) {
                const r = await bea(`id/${adaRoot}/docs/${doc}/body`);
                const text = await r.text();
                assert.equal(r.status, 200, `${doc}: ${text}`);
                assert.equal(text, words);
            }
        });
    });
});
