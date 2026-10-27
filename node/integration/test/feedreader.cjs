/*
    hrseRSS™, the feed reader (feedreader.rs, plans/RSS.md slice 1): a persona follows a feed - its
    address, or a page that names it - and the node fetches it into its own cache, once however many
    people here follow it. What a persona follows is a register on its private chain, and how far it
    has read each feed is another.

    The rig's "open web" is the node itself (the feed reader may dial loopback only under
    LOCAL_TEST): a person's own `rss.xml` (rss.rs) is the feed.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { HOST } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

describe('hrseRSS', function () {
    this.timeout(120000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, feedId, feedUrl;

    const publish = async (title, body) => {
        const d = await (
            await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: 'marquee' })
        ).json();
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'rssfeedada' });
        adaRoot = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await j(ada, `api/identity/${adaRoot}/profile`, { field: 'name', value: 'Ada Gazette' });
        await publish('hay & oats', 'the first post, about *hay*');
        // An RSS date is whole seconds: a second apart, so the order is the dates'.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await publish('a canter', 'the second post');
        bea = await makeUserFetch({ prefix: 'rssfeedbea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        cal = await makeUserFetch({ prefix: 'rssfeedcal' });
        calRoot = (await (await cal('api/identity', { method: 'POST' })).json()).root_pubkey;
    });

    it("follows a feed by the page that names it, and keeps the feed's items", async () => {
        // The person's page, not the feed: its head's `<link rel="alternate">` names the feed.
        const res = await j(bea, `api/identity/${beaRoot}/rss`, {
            url: `http://${HOST}/ringtome/user/${adaRoot}`,
            tags: ['Horses', 'horses', ' news '],
        });
        assert.equal(res.status, 200, await res.clone().text());
        const page = await res.json();
        assert.equal(page.feeds.length, 1);
        const [feed] = page.feeds;
        feedId = page.followed;
        feedUrl = feed.url;
        assert.equal(feed.id, feedId);
        assert.match(feed.url, /\/rss\.xml$/, 'the feed the page named, not the page');
        assert.equal(feed.title, 'Ada Gazette');
        assert.deepEqual(
            feed.tags,
            ['horses', 'news'],
            'tags tidied: lowercased, trimmed, each once',
        );
        assert.equal(feed.unread, 2);
        assert.ok(feed.fetched_ms > 0 && !feed.error);

        const items = await (await bea(`api/identity/${beaRoot}/rss/items`)).json();
        assert.deepEqual(
            items.items.map((i) => i.title),
            ['a canter', 'hay & oats'],
            'newest first, plain text',
        );
        assert.ok(items.items.every((i) => i.feed === feedId && i.link.startsWith('http')));
        assert.match(items.items[1].summary, /the first post, about hay/);
        const one = await (await bea(`api/identity/${beaRoot}/rss/items?feed=${feedId}`)).json();
        assert.equal(one.items.length, 2);
    });

    it('reads a feed up to a watermark, and retags it', async () => {
        const items = await (await bea(`api/identity/${beaRoot}/rss/items?feed=${feedId}`)).json();
        const newest = items.items[0].dated_ms;
        const put = await j(
            bea,
            `api/identity/${beaRoot}/private/kv/rss_seen/${feedId}`,
            { value: String(newest) },
            'PUT',
        );
        assert.equal(put.status, 200);
        let page = await (await bea(`api/identity/${beaRoot}/rss`)).json();
        assert.equal(page.feeds[0].unread, 0, 'read to its newest item');
        assert.equal(page.feeds[0].seen_ms, newest);

        page = await (
            await j(bea, `api/identity/${beaRoot}/rss/${feedId}`, { tags: ['ponies'] }, 'PUT')
        ).json();
        assert.deepEqual(page.feeds[0].tags, ['ponies']);
        // The register is the persona's own fact: its private chain says it.
        const kv = await (await bea(`api/identity/${beaRoot}/private/kv/rss_feeds`)).json();
        const register = kv.values.find((v) => v.key === feedId);
        assert.deepEqual(JSON.parse(register.value).tags, ['ponies']);
    });

    it('a second follower here shares the cache; letting go leaves the other', async () => {
        const res = await j(cal, `api/identity/${calRoot}/rss`, { url: feedUrl });
        assert.equal(res.status, 200, await res.clone().text());
        const page = await res.json();
        assert.equal(page.followed, feedId, 'the same address is the same feed');
        assert.equal(page.feeds[0].unread, 2, "their own watermark, not the first follower's");

        const gone = await cal(`api/identity/${calRoot}/rss/${feedId}`, { method: 'DELETE' });
        assert.equal(gone.status, 200);
        assert.deepEqual((await gone.json()).feeds, []);
        const none = await (await cal(`api/identity/${calRoot}/rss/items`)).json();
        assert.deepEqual(none.items, [], 'nothing of a feed they let go');
        const still = await (await bea(`api/identity/${beaRoot}/rss/items`)).json();
        assert.equal(still.items.length, 2, 'the other follower keeps it');
    });

    it('refuses what is not a feed, and what is not the web', async () => {
        let res = await j(cal, `api/identity/${calRoot}/rss`, { url: 'javascript:alert(1)' });
        assert.equal(res.status, 400);
        res = await j(cal, `api/identity/${calRoot}/rss`, { url: 'ftp://example.com/feed.xml' });
        assert.equal(res.status, 400);
        // A JSON answer that is no feed, from a page with no feed to name.
        res = await j(cal, `api/identity/${calRoot}/rss`, { url: `http://${HOST}/health` });
        assert.equal(res.status, 400, await res.clone().text());
        const page = await (await cal(`api/identity/${calRoot}/rss`)).json();
        assert.deepEqual(page.feeds, [], 'nothing followed for a refusal');
    });

    it("someone else's persona's feeds are not theirs to read", async () => {
        const res = await cal(`api/identity/${beaRoot}/rss`);
        assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
        const items = await cal(`api/identity/${beaRoot}/rss/items`);
        assert.ok(items.status === 403 || items.status === 404, `got ${items.status}`);
    });
});
