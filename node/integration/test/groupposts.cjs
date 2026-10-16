/*
    Groups, slice 2 (plans/GROUPS.md, section 7): a group post is a document like any other post -
    a draft published, its picture a media document, edited by publishing again and taken down
    as any post is - on the poster's lane for the group instead of their public chain. Bea posts
    words and a picture to the Potato Bunch; ada's node reads both. Nothing public lists or
    serves them, and a stranger on another node is shown nothing. An edit and a takedown reach
    ada as they would for any post; an owner hides a post without touching it.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, HOST_C, makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)('groups: a group post is a document', function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, dee, deeRoot, group, draft, post, picture;

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
    const sync = (who, root) => act(who, root, 'sync');
    const page = async (host, who, root) => {
        for (const r of [adaRoot, beaRoot]) await beat(host, 'fold', r);
        const res = await who(`api/identity/${root}/groups/${group}/posts`);
        assert.equal(res.status, 200);
        return (await res.json()).posts;
    };
    const upload = async (who, root, title) => {
        const pic = await (
            await who(`api/identity/${root}/docs/binary?title=${title}`, {
                method: 'POST',
                body: makePng(24, 24),
                file: true,
            })
        ).json();
        assert.ok(pic.doc_id, `the upload minted a document: ${JSON.stringify(pic)}`);
        for (let i = 0; i < 60; i++) {
            if ((await who(`api/identity/${root}/docs/${pic.doc_id}/body`)).status === 200)
                return pic.doc_id;
            await wait(300);
        }
        assert.fail('the picture finished ingesting');
    };

    before(async function () {
        [ada, adaRoot] = await persona('gpada');
        [bea, beaRoot] = await persona('gpbea', HOST_B);
        [dee, deeRoot] = await persona('gpdee', HOST_C);
        const founded = await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Potato Bunch' });
        group = (await founded.json()).group;
        const token = await act(ada, adaRoot, 'invites', { invitee: beaRoot });
        await act(bea, beaRoot, 'join', {
            invite: token.invite,
            founder: token.founder,
            inviter: token.inviter,
            via: token.via,
        });
        await sync(ada, adaRoot);
    });

    it("a member's post, with a picture, reaches another member's node and reads there", async () => {
        const pic = await upload(bea, beaRoot, 'spud');
        const created = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'harvest',
                body: `a good year\n\n![spud](/api/identity/${beaRoot}/docs/${pic}/body/spud.avif)`,
                format: 'marquee',
            })
        ).json();
        draft = created;
        post = (await act(bea, beaRoot, 'publish', { doc: created.doc_id })).post;
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);

        const there = (await page(HOST, ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(there, 'the post is on the group page at ada');
        assert.equal(there.title, 'harvest');
        assert.equal(there.author, beaRoot);
        assert.equal(there.media.length, 1);
        [picture] = there.media;
        assert.ok(there.words.includes('a good year'));
        assert.ok(
            there.words.includes(`/api/groups/${group}/docs/${picture}/body/`),
            'the embed points at the group, not at bea',
        );
        const bytes = await ada(`api/groups/${group}/docs/${picture}/body/spud.avif`);
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get('content-type'), 'image/avif');
        assert.ok((await bytes.arrayBuffer()).byteLength > 0);
    });

    it('nothing public lists or serves it, and a stranger is shown nothing', async () => {
        const anon = makeFetch(HOST_B);
        for (const doc of [post, picture]) {
            assert.equal((await anon(`id/${beaRoot}/docs/${doc}/body`)).status, 404);
            // A post's own page falls back to the app's shell for a document it doesn't know -
            // a 200 whatever the id - so the claim is that it carries none of the post.
            const page = await (await anon(`ringtome/user/${beaRoot}/doc/${doc}`)).text();
            assert.ok(!page.includes('harvest') && !page.includes('a good year'));
        }
        const profile = await (await anon(`api/id/${beaRoot}/profile`)).json();
        assert.ok(!(profile.posts || []).some((p) => [post, picture].includes(p.doc_id)));
        // Dee, on a node outside the group, and ada's node's stranger-facing door.
        assert.equal((await dee(`api/groups/${group}/docs/${picture}/body`)).status, 404);
        assert.equal((await dee(`api/identity/${deeRoot}/groups/${group}/posts`)).status, 404);
    });

    it('an edit and a takedown reach the other members, as for any post', async () => {
        await j(
            bea,
            `api/identity/${beaRoot}/docs/${draft.doc_id}`,
            {
                title: 'harvest',
                body: 'a good year, and a better one coming',
                parents: [draft.version],
            },
            'PUT',
        );
        assert.equal(
            (await act(bea, beaRoot, 'publish', { doc: draft.doc_id })).post,
            post,
            'the same post',
        );
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        const edited = (await page(HOST, ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(edited.edited);
        assert.equal(edited.words, 'a good year, and a better one coming');

        const other = await (
            await j(bea, `api/identity/${beaRoot}/docs`, {
                title: 'oops',
                body: 'wrong group',
                format: 'marquee',
            })
        ).json();
        const oops = (await act(bea, beaRoot, 'publish', { doc: other.doc_id })).post;
        await act(bea, beaRoot, `docs/${oops}/retract`);
        await sync(bea, beaRoot);
        await sync(ada, adaRoot);
        assert.ok(!(await page(HOST, ada, adaRoot)).some((p) => p.doc === oops));
    });

    it("an owner hides a post from the page; it stays its author's", async () => {
        await act(ada, adaRoot, `docs/${post}/hide`, { hidden: true });
        let seen = (await page(HOST, ada, adaRoot)).find((p) => p.doc === post);
        assert.ok(seen.hidden);
        await sync(ada, adaRoot);
        await sync(bea, beaRoot);
        seen = (await page(HOST_B, bea, beaRoot)).find((p) => p.doc === post);
        assert.ok(seen.hidden, "bea's node folds ada's hide too");
        await act(ada, adaRoot, `docs/${post}/hide`, { hidden: false });
        assert.ok(!(await page(HOST, ada, adaRoot)).find((p) => p.doc === post).hidden);
        const res = await j(bea, `api/identity/${beaRoot}/groups/${group}/docs/${post}/hide`, {
            hidden: true,
        });
        assert.equal(res.status, 403, 'only owners hide');
    });
});
