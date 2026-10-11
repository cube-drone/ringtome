/*
    A person's page, narrowed, pages on (Curtis, 2026-10-11: a stranger at someone's page reads
    "just their books" or "just their rebroadcasts" past the first screen): a narrowed listing
    answers a page and whether there is more, and the cursor the whole shelf pages by reads the
    narrowed one onward - nothing twice, nothing that doesn't match, nobody signed in.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

describe("a person's page: a narrowed shelf pages for a stranger", function () {
    this.timeout(600000);

    let ada, adaRoot;
    const stranger = makeFetch();
    const tagged = new Set();

    const post = async (title, tags) => {
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, { title, body: title, format: 'marquee' })
        ).json();
        for (const g of tags)
            await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/annotations/tags/${g}`, {
                method: 'PUT',
            });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        return JSON.parse(said).post_id;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'pagenada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: 'POST' });
        // Twenty-five that match and some that don't, interleaved: more than one page of each.
        for (let i = 0; i < 25; i++) {
            tagged.add(await post(`Loaf ${i}`, ['bread']));
            if (i % 3 === 0) await post(`Ride ${i}`, ['bikes']);
        }
    });

    it('the first narrowed page is a page, and says there is more', async () => {
        const r = await stranger(`api/id/${adaRoot}/posts?tag=bread`);
        assert.equal(r.status, 200);
        const page = await r.json();
        assert.equal(page.posts.length, 20);
        assert.equal(page.more, true);
        assert.ok(
            page.posts.every((p) => tagged.has(p.doc_id)),
            'only what matches',
        );
    });

    it('its cursor reads on to the rest, and the rest says it is the end', async () => {
        const first = await (await stranger(`api/id/${adaRoot}/posts?tag=bread`)).json();
        const last = first.posts[first.posts.length - 1];
        const r = await stranger(
            `api/id/${adaRoot}/posts?tag=bread&after_ms=${last.published_ms}&after_doc=${last.doc_id}`,
        );
        assert.equal(r.status, 200);
        const second = await r.json();
        assert.equal(second.posts.length, 5);
        assert.equal(second.more, false);
        assert.ok(
            second.posts.every((p) => tagged.has(p.doc_id)),
            'only what matches',
        );
        const seen = new Set([...first.posts, ...second.posts].map((p) => p.doc_id));
        assert.deepEqual([...seen].sort(), [...tagged].sort(), 'every match once, none twice');
    });
});
