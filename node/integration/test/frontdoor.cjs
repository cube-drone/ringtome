/*
    The server's front door, its own parts (frontdoor.rs; Curtis, 2026-09-30). Its name and the
    taglines scrolling under the sign-in are the administrator's to choose in the Server app, and
    null until they do - the page says the app's own. And a node administrator may super-pin a
    public post hosted here above "lately on this node": a stranger sees it as a feed card; a
    sealed post, or a post by someone who isn't hosted here, can't go up.

    The rig is shared, so everything chosen here is put back before the file ends.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, makeFetch, sql } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

describe('the front door: its name, its taglines, its super-pins', function () {
    this.timeout(300000);

    const stranger = makeFetch();
    const front = async () => (await stranger('api/node/front')).json();
    let admin, plain, root, open, sealed;

    const publish = async (title, extra = {}) => {
        const d = await (
            await j(plain, `api/identity/${root}/docs`, {
                title,
                body: 'hay, mostly',
                format: 'marquee',
            })
        ).json();
        const pub = await j(plain, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        assert.equal(pub.status, 200, await pub.clone().text());
        return (await pub.json()).post_id;
    };

    before(async () => {
        admin = await makeUserFetch({ prefix: 'frontadm' });
        await sql(
            `INSERT OR IGNORE INTO account_tags (account_id, tag) VALUES ('${admin.account.id}', 'node_admin')`,
            HOST,
        );
        plain = await makeUserFetch({ prefix: 'frontplain' });
        root = (await (await plain('api/identity', { method: 'POST' })).json()).root_pubkey;
        open = await publish('a horse, drawn badly');
        sealed = await publish('for my people', { trusted_only: true });
        for (let i = 0; i < 30; i++) {
            const items = (await (await stranger('api/node/feed')).json()).items || [];
            if (items.some((it) => it.doc_id === open)) break;
            await beat(HOST, 'fold', root);
            await wait(300);
        }
    });

    after(async () => {
        await j(admin, 'api/admin/front', { name: null, taglines: null }, 'PUT');
        await admin(`api/admin/super-pins/${root}/${open}`, { method: 'DELETE' });
    });

    it("the name and taglines are the administrator's, and the app's own until chosen", async () => {
        await j(admin, 'api/admin/front', { name: null, taglines: null }, 'PUT');
        const none = await front();
        assert.equal(none.name, null, 'no name chosen: the page says Horse Drawing Tycoon 2');
        assert.equal(none.taglines, null, "no taglines chosen: the page says the app's own");

        assert.equal(
            (await j(plain, 'api/admin/front', { name: 'Hay Barn' }, 'PUT')).status,
            403,
            'for node administrators only',
        );
        const set = await j(
            admin,
            'api/admin/front',
            { name: '  Hay Barn  ', taglines: ['neigh', '', '  whinny '] },
            'PUT',
        );
        assert.equal(set.status, 200, await set.clone().text());
        const chosen = await front();
        assert.equal(chosen.name, 'Hay Barn', 'trimmed');
        assert.deepEqual(
            chosen.taglines,
            ['neigh', 'whinny'],
            'trimmed, and the blank line dropped',
        );
        assert.equal(
            (await j(admin, 'api/admin/front', { name: 'x'.repeat(81) }, 'PUT')).status,
            400,
            "a header's worth, no more",
        );
    });

    it('a node administrator super-pins a public post hosted here, and a stranger sees it', async () => {
        const pin = (doc, who = admin) =>
            who(`api/admin/super-pins/${root}/${doc}`, { method: 'PUT' });
        assert.equal((await pin(open, plain)).status, 403, 'for node administrators only');
        assert.equal((await pin(sealed)).status, 400, "a sealed post can't go on the front page");
        assert.equal((await pin('00'.repeat(32))).status, 400, "nor a post this node doesn't hold");
        assert.equal((await pin(open)).status, 200);
        assert.equal((await pin(open)).status, 200, 'pinning twice is pinning once');

        const pins = (await front()).pins;
        assert.equal(
            pins.length >= 1 && pins[0].doc_id,
            open,
            'the newest pin first, as a feed card',
        );
        assert.equal(pins[0].author, root);
        assert.equal(pins[0].title, 'a horse, drawn badly');

        assert.equal(
            (await admin(`api/admin/super-pins/${root}/${open}`, { method: 'DELETE' })).status,
            200,
        );
        assert.ok(!(await front()).pins.some((p) => p.doc_id === open), 'and unpinned, gone');
    });
});
