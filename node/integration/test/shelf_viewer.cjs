/*
    Who is looking at a shelf (Curtis's audit, 2026-11-10). The public shelf's doors take the
    viewing persona as `?as=<root>`, and took it on its word: an anonymous `?as=<author>` was the
    author - their sealed posts listed, a private chat's other half named by its opened labels,
    the audience tag told, and the shelf's search matching the sealed words a prefix at a time.
    Any signed-in session with no `as` at all was shown a hosted author's sealed rows unhidden,
    search and all. The viewer is now a persona the session owns, or nobody.

    And a chat for two with no audience on record admits nobody but its author: the trust list
    never stands in for the one person it was sealed to.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeFetch, sql, HOST } = require('./fetch.cjs');
const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

describe('who is looking at a shelf', function () {
    this.timeout(120000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, post, chat;
    const anon = makeFetch();
    const shelf = async (who, query = '') => {
        const res = await who(`api/id/${adaRoot}/posts${query}`);
        assert.equal(res.status, 200, await res.clone().text());
        return res.text();
    };
    // What a shelf answer gives away: the sealed post, the chat, who it's with, its audience.
    const tells = (text) => ({
        post: text.includes(post),
        chat: text.includes(chat),
        partner: text.includes(beaRoot),
        audience: text.includes('"audience"'),
    });
    const nothing = { post: false, chat: false, partner: false, audience: false };

    before(async () => {
        const { speakable } = await import('../../js/speakable.js');
        const person = async (prefix) => {
            const who = await makeUserFetch({ prefix });
            const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
            await who(`api/identity/${root}/serve`, { method: 'POST' });
            return [who, root];
        };
        [ada, adaRoot] = await person('svada');
        [bea, beaRoot] = await person('svbea');
        [cal, calRoot] = await person('svcal');
        // Ada trusts bea and cal, in public.
        for (const them of [beaRoot, calRoot])
            await j(
                ada,
                `api/identity/${adaRoot}/private/kv/contact:${them}/trust`,
                { value: 'high' },
                'PUT',
            );
        await beat(HOST, 'mint', adaRoot);

        // A post sealed to the people ada trusts.
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'quokka plans',
                body: 'meet me by the zebrafish tank at noon',
                format: 'marquee',
            })
        ).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {
            trusted_only: true,
        });
        assert.equal(pub.status, 200, await pub.clone().text());
        post = (await pub.json()).post_id;

        // A chat for two with bea, as the client's `openIm` mints it (ims.cjs).
        const c = await (
            await j(ada, `api/identity/${adaRoot}/docs`, {
                title: 'a chat',
                body: `[user id=/id/${speakable(beaRoot)}]them[/user]`,
                format: 'marquee',
            })
        ).json();
        await ada(`api/identity/${adaRoot}/docs/${c.doc_id}/buckets/chat`, { method: 'PUT' });
        const im = await j(ada, `api/identity/${adaRoot}/docs/${c.doc_id}/publish`, {
            room: true,
            im: true,
            trusted_only: true,
            audience: '@mentioned',
        });
        assert.equal(im.status, 200, await im.clone().text());
        chat = (await im.json()).post_id;

        // The search index fills behind the publish: wait until ada's own search finds the post.
        let found = false;
        for (let i = 0; i < 40 && !found; i++) {
            found = (await shelf(ada, `?as=${adaRoot}&q=zebra`)).includes(post);
            if (!found) await wait(250);
        }
        assert.ok(found, "ada's own search finds her sealed post");
    });

    it('the author sees her own sealed shelf, as herself', async () => {
        const mine = tells(await shelf(ada, `?as=${adaRoot}`));
        assert.deepEqual(mine, { post: true, chat: true, partner: true, audience: true });
        // With no `as` at all she still sees her own sealed rows, and no sealed labels on them
        // (sealedlabels.cjs): the labels are what name the chat's other half.
        const bare = tells(await shelf(ada));
        assert.deepEqual(
            { post: bare.post, chat: bare.chat, partner: bare.partner },
            { post: true, chat: true, partner: false },
            'and with no as',
        );
    });

    it('a stranger naming the author as the viewer is nobody', async () => {
        assert.deepEqual(tells(await shelf(anon, `?as=${adaRoot}`)), nothing);
        assert.deepEqual(tells(await shelf(anon)), nothing, 'as with no as at all');
        for (const q of ['zebra', 'quok'])
            assert.ok(
                !(await shelf(anon, `?as=${adaRoot}&q=${q}`)).includes(post),
                `the search says nothing of "${q}"`,
            );
        const one = await anon(`api/id/${adaRoot}/posts/${chat}?as=${adaRoot}`);
        assert.ok(!(await one.text()).includes(beaRoot), "nor the chat's page who it is with");
        const page = await (await anon(`api/id/${adaRoot}/profile?as=${adaRoot}`)).text();
        assert.ok(!page.includes(post) && !page.includes(chat), 'nor her page');
    });

    it("another account naming the author, or naming nobody, sees no more than it's sealed to", async () => {
        // Cal is trusted, so the post sealed to the trusted is his - asked as himself.
        const his = tells(await shelf(cal, `?as=${calRoot}`));
        assert.equal(his.post, true, 'the post sealed to the people ada trusts');
        assert.deepEqual(
            { chat: his.chat, partner: his.partner, audience: his.audience },
            { chat: false, partner: false, audience: false },
            'and nothing of the chat',
        );
        // Naming ada, he is nobody: her persona isn't his session's.
        assert.deepEqual(tells(await shelf(cal, `?as=${adaRoot}`)), nothing);
        assert.ok(!(await shelf(cal, `?as=${adaRoot}&q=zebra`)).includes(post), 'no search as her');
        // Naming nobody, a signed-in session used to be shown every sealed row.
        assert.deepEqual(tells(await shelf(cal)), nothing, 'with no as');
        assert.ok(!(await shelf(cal, '?q=zebra')).includes(post), 'no search with no as');
    });

    it('a chat for two with no audience on record admits nobody the author merely trusts', async () => {
        const door = (who, root) => who(`api/identity/${root}/rooms/${adaRoot}/${chat}`);
        assert.equal((await door(bea, beaRoot)).status, 200, 'bea is in');
        assert.equal((await door(cal, calRoot)).status, 403, 'cal is not');
        // The memo as a failed write would leave it: the key, and no word of who it is for.
        await sql(
            `UPDATE post_keys SET audience = NULL WHERE author_root = '${adaRoot}' AND doc_id = '${chat}'`,
        );
        await sql(
            `DELETE FROM post_audience_members WHERE author_root = '${adaRoot}' AND doc_id = '${chat}'`,
        );
        const his = await door(cal, calRoot);
        assert.equal(his.status, 403, await his.clone().text());
        const words = await cal(`api/identity/${calRoot}/rooms/${adaRoot}/${chat}/messages`);
        assert.equal(words.status, 403, 'nor its lines');
    });
});
