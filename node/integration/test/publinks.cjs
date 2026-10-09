/*
    The people a public post links to (publinks.rs; Curtis, 2026-10-08). A `/ringtome/` link
    resolves through the node showing it, so a stranger reading a front-page post that links
    someone off-node used to meet "no such persona here": the node fetches only for its members.
    Now a public post vouches - "if something is on our node it's because someone we trust put it
    there" - and the person it links is admitted to a stranger as a member's visit admits them,
    the peek cache warmed ahead of the first look. Someone no public post links stays shut.

    Two nodes: Ada and Cyd on A, Bea on B; the stranger reads B.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { makeFetch, HOST_B } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const base58 = async (host) => {
    const { toBase58 } = await import('../../js/speakable.js');
    return toBase58((await (await host('api/node')).json()).endpoint_id);
};

(HOST_B ? describe : describe.skip)('a public link opens its person to a stranger', function () {
    this.timeout(300000);

    let ada, adaRoot, cydRoot, bea, beaRoot, adaPost;
    const stranger = HOST_B && makeFetch(HOST_B);

    const persona = async (who) => {
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return root;
    };
    const publish = async (who, root, title, body) => {
        const d = await (
            await j(who, `api/identity/${root}/docs`, { title, body, format: 'marquee' })
        ).json();
        const pub = await j(who, `api/identity/${root}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        return (await pub.json()).post_id;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'linkada' });
        adaRoot = await persona(ada);
        adaPost = await publish(ada, adaRoot, 'over here', 'words worth a link');
        const cyd = await makeUserFetch({ prefix: 'linkcyd' });
        cydRoot = await persona(cyd);
        await publish(cyd, cydRoot, 'nobody links me', 'quiet words');
        bea = await makeUserFetch({ prefix: 'linkbea', host: HOST_B });
        beaRoot = await persona(bea);
    });

    it('shuts a stranger out of someone off-node that no public post here links', async () => {
        await beat(HOST_B, 'public-links');
        assert.equal((await stranger(`api/id/${adaRoot}/profile`)).status, 404);
    });

    it('opens them once a public post here links them - person and post', async () => {
        const link = `/ringtome/user/${adaRoot}/post/${adaPost}?via=${await base58(ada)}`;
        const linking = await publish(
            bea,
            beaRoot,
            'read this',
            `a good one: [over there](${link})`,
        );
        // Onto B's front page, then the pass that reads it and warms Ada's peek.
        for (let i = 0; i < 30; i++) {
            const items = (await (await stranger('api/node/feed')).json()).items || [];
            if (items.some((it) => it.doc_id === linking)) break;
            await beat(HOST_B, 'fold', beaRoot);
            await wait(300);
        }
        let profile;
        for (let i = 0; i < 20; i++) {
            await beat(HOST_B, 'public-links');
            profile = await stranger(`api/id/${adaRoot}/profile`);
            if (profile.status === 200) break;
            await wait(500);
        }
        assert.equal(profile.status, 200, 'a stranger reaches the linked person');
        assert.equal((await profile.json()).foreign, true);
        const post = await stranger(`api/id/${adaRoot}/posts/${adaPost}`);
        assert.equal(post.status, 200, 'and the linked post');
    });

    it('keeps someone else on that node shut - the link names one person', async () => {
        assert.equal((await stranger(`api/id/${cydRoot}/profile`)).status, 404);
    });
});
