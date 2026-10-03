/*
    A person's RSS (rss.rs; Curtis, 2026-09-30): `/ringtome/user/<address>/rss.xml`, beside their page,
    RSS 2.0 of their newest posts for anyone with a feed reader. A stranger's view: a sealed post
    never appears, and a persona this node doesn't host has no feed here. The page's head points
    readers at it.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

describe("a person's RSS", function () {
    this.timeout(120000);

    const stranger = makeFetch();
    let ada, root;

    const publish = async (title, body, extra = {}) => {
        const d = await (
            await j(ada, `api/identity/${root}/docs`, { title, body, format: 'marquee' })
        ).json();
        const pub = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, extra);
        assert.equal(pub.status, 200, await pub.clone().text());
        return (await pub.json()).post_id;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'rssada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(ada, `api/identity/${root}/profile`, { field: 'name', value: 'Ada <Feeds> & Co' });
    });

    it('carries their open posts, newest first, and never a sealed one', async () => {
        const first = await publish('hay & oats', 'the first post, about hay & oats');
        const second = await publish('a canter', 'the second post');
        await publish('for my people', 'quiet words', { trusted_only: true });

        const res = await stranger(`ringtome/user/${root}/rss.xml`);
        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /application\/rss\+xml/);
        const xml = await res.text();
        assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
        assert.match(
            xml,
            /<title>Ada &lt;Feeds&gt; &amp; Co<\/title>/,
            'the channel is theirs, escaped',
        );
        const titles = [...xml.matchAll(/<item><title>([^<]*)<\/title>/g)].map((m) => m[1]);
        assert.deepEqual(
            titles,
            ['a canter', 'hay &amp; oats'],
            'newest first, and no sealed post',
        );
        assert.ok(
            xml.includes(`/post/${second}</link>`) && xml.includes(`/post/${first}</link>`),
            "each links to its post's page",
        );
        assert.ok(!xml.includes('quiet words'), "a sealed post's words never either");
        // Its words are text inside the item's HTML, and that HTML is text inside the XML: an
        // ampersand is escaped once for each.
        assert.ok(
            xml.includes(
                '<description>&lt;p&gt;the first post, about hay &amp;amp; oats&lt;/p&gt;</description>',
            ),
            'its words, plain, inside escaped HTML',
        );
        assert.match(xml, /<pubDate>\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT<\/pubDate>/);
    });

    it("the page's head points at it, and a persona not hosted here has none", async () => {
        const page = await (await stranger(`ringtome/user/${root}`)).text();
        assert.ok(
            page.includes('type="application/rss+xml"') && page.includes('/rss.xml'),
            'for a reader that looks on the page',
        );
        assert.equal((await stranger(`ringtome/user/${'ab'.repeat(32)}/rss.xml`)).status, 404);
    });
});
