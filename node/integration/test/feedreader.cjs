/*
    Horse's RSS, the feed reader (feedreader.rs, plans/RSS.md slice 1): a persona follows a feed - its
    address, or a page that names it - and the node fetches it into its own cache, once however many
    people here follow it. What a persona follows is a register on its private chain, and how far it
    has read each feed is another.

    An item is a post (plans/RSS.md, _Feed items are posts_): journalled into each follower's
    feed as the post of `rss:<feed id>`, wearing a post's automatic tags, taking the follower's own
    tags privately, and copying into their notes.

    The rig's "open web" is the node itself (the feed reader may dial loopback only under
    LOCAL_TEST): a person's own `rss.xml` (rss.rs) is the feed.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { HOST } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });

describe("Horse's RSS", function () {
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
        await publish(
            'hay & oats',
            'the first post, about *hay*\n\n## Oats\n\n[her page](/ringtome/user/ada)',
        );
        // An RSS date is whole seconds: a second apart, so the order is the dates'.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await publish('a canter', 'the second post');
        bea = await makeUserFetch({ prefix: 'rssfeedbea' });
        beaRoot = (await (await bea('api/identity', { method: 'POST' })).json()).root_pubkey;
        cal = await makeUserFetch({ prefix: 'rssfeedcal' });
        calRoot = (await (await cal('api/identity', { method: 'POST' })).json()).root_pubkey;
    });

    it('follows a feed by the page that names it, and its items are posts in the feed', async () => {
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
        assert.ok(feed.newest_ms > 0);
        assert.ok(feed.fetched_ms > 0 && !feed.error);

        // Horse's RSS's merged view: the feed's own stream, over the feed reader's door.
        const rss = await (await bea(`api/identity/${beaRoot}/rss/feed`)).json();
        assert.deepEqual(
            rss.items.map((i) => i.title),
            ['a canter', 'hay & oats'],
            'newest first, plain text',
        );
        const [canter, hay] = rss.items;
        assert.equal(canter.author, `rss:${feedId}`, 'the feed stands where an author would');
        assert.equal(canter.format, 'rss');
        assert.equal(canter.author_name, 'Ada Gazette');
        assert.equal(canter.feed.id, feedId);
        assert.match(canter.feed.link, /^http/);
        assert.ok(
            hay.annotations.some(
                (a) => a.annotator === `rss:${feedId}` && a.key === 'tag' && a.value === 'micro',
            ),
            `a post's automatic length tag, said by the feed: ${JSON.stringify(hay.annotations)}`,
        );
        const one = await (await bea(`api/identity/${beaRoot}/rss/${feedId}/feed`)).json();
        assert.equal(one.items.length, 2, "one feed's own stream");

        // And folded into the main feed, beside everything else, under its filters.
        const main = await (await bea(`api/identity/${beaRoot}/feed`)).json();
        assert.equal(main.items.filter((i) => i.feed).length, 2);
        const only = await (await bea(`api/identity/${beaRoot}/feed?kind=rss`)).json();
        assert.equal(only.items.length, 2, 'the "feed item" kind');
        const none = await (await bea(`api/identity/${beaRoot}/feed?not_kind=rss`)).json();
        assert.equal(none.items.filter((i) => i.feed).length, 0, 'and leaving them out');
        const sized = await (await bea(`api/identity/${beaRoot}/feed?tag=micro`)).json();
        assert.equal(sized.items.filter((i) => i.feed).length, 2, 'a size pick finds them');
        const labels = await (await bea(`api/identity/${beaRoot}/rss/feed/labels`)).json();
        assert.ok(
            JSON.stringify(labels).includes(`rss:${feedId}`),
            `the feed is an author chip: ${JSON.stringify(labels.authors)}`,
        );

        // Its words through the feed reader's door, as Marquee.
        const body = await bea(`api/identity/${beaRoot}/rss/${feedId}/${hay.doc_id}/body`);
        assert.equal(body.status, 200);
        const words = await body.text();
        assert.match(words, /\*hay\*/, words);
        // The whole of it, as her feed renders it (2026-10-27): her heading and her link, whole.
        assert.match(words, /## Oats/, words);
        assert.match(words, /\[her page\]\(https?:\/\/[^)]+\/ringtome\/user\/ada\)/, words);
    });

    it('reads a feed up to a watermark, and retags it', async () => {
        let page = await (await bea(`api/identity/${beaRoot}/rss`)).json();
        const newest = page.feeds[0].newest_ms;
        const put = await j(
            bea,
            `api/identity/${beaRoot}/private/kv/rss_seen/${feedId}`,
            { value: String(newest) },
            'PUT',
        );
        assert.equal(put.status, 200);
        page = await (await bea(`api/identity/${beaRoot}/rss`)).json();
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

    it('tags an item privately, two at most, and copies it into notes', async () => {
        const [canter] = (await (await bea(`api/identity/${beaRoot}/rss/feed`)).json()).items;
        const tag = (value, method = 'PUT') =>
            bea(`api/identity/${beaRoot}/rss/${feedId}/${canter.doc_id}/tags/${value}`, { method });
        assert.equal((await tag('gallop')).status, 200);
        assert.equal((await tag('Trot')).status, 200);
        assert.equal((await tag('canter')).status, 400, 'two tags on an item at most');
        let mine = (await (await bea(`api/identity/${beaRoot}/feed?tag=trot`)).json()).items;
        assert.deepEqual(
            mine.map((i) => i.doc_id),
            [canter.doc_id],
            'a tag of theirs is a pick like any',
        );
        assert.ok(mine[0].annotations.some((a) => a.annotator === beaRoot && a.value === 'gallop'));
        // Private: the register on their chain, and nobody else's card.
        const kv = await (await bea(`api/identity/${beaRoot}/private/kv/rss_tags`)).json();
        assert.deepEqual(JSON.parse(kv.values[0].value), ['gallop', 'trot']);
        assert.equal((await tag('gallop', 'DELETE')).status, 200);
        mine = (await (await bea(`api/identity/${beaRoot}/feed?tag=gallop`)).json()).items;
        assert.equal(mine.length, 0, 'taken off again');

        const copy = await j(bea, `api/identity/${beaRoot}/docs/copy`, {
            author: canter.author,
            doc_id: canter.doc_id,
            bucket: 'clippings',
            new: true,
        });
        assert.equal(copy.status, 200, await copy.clone().text());
        const note = await (
            await bea(`api/identity/${beaRoot}/docs/${(await copy.json()).doc_id}`)
        ).json();
        assert.equal(note.title, 'a canter');
        assert.match(note.body, /the second post/);
        assert.match(note.body, /Ada Gazette: http/, 'where it came from, at its foot');
    });

    it('rebroadcasts an item as a post of their own: full text, their tags, and its source', async () => {
        const [canter] = (await (await bea(`api/identity/${beaRoot}/rss/feed`)).json()).items;
        const draft = await j(
            bea,
            `api/identity/${beaRoot}/rss/${feedId}/${canter.doc_id}/rebroadcast`,
            {},
        );
        assert.equal(draft.status, 200, await draft.clone().text());
        const { doc_id: draftId } = await draft.json();
        const pub = await j(bea, `api/identity/${beaRoot}/docs/${draftId}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        const again = await j(
            bea,
            `api/identity/${beaRoot}/rss/${feedId}/${canter.doc_id}/rebroadcast`,
            {},
        );
        assert.equal(again.status, 400, 'once to everyone');

        const own = (await (await bea(`api/identity/${beaRoot}/feed?me=only`)).json()).items;
        const post = own.find((i) => i.title === 'a canter');
        assert.ok(post, `their own post now: ${JSON.stringify(own.map((i) => i.title))}`);
        assert.equal(post.author, beaRoot);
        const said = (key) =>
            (post.annotations.find((a) => a.annotator === beaRoot && a.key === key) || {}).value;
        assert.equal(said('source_feed'), feedUrl, 'where it came from, said in public');
        assert.equal(said('source_name'), 'Ada Gazette');
        assert.match(said('source_link'), /^http/);
        assert.ok(
            post.annotations.some((a) => a.annotator === beaRoot && a.value === 'trot'),
            'their private tag on the item is a tag on their post now',
        );
        const body = await bea(`id/${beaRoot}/docs/${post.doc_id}/body`);
        assert.match(await body.text(), /the second post/, 'the full text');
    });

    it('a second follower here shares the cache; letting go leaves the other', async () => {
        const res = await j(cal, `api/identity/${calRoot}/rss`, { url: feedUrl });
        assert.equal(res.status, 200, await res.clone().text());
        const page = await res.json();
        assert.equal(page.followed, feedId, 'the same address is the same feed');
        assert.equal(page.feeds[0].unread, 2, "their own watermark, not the first follower's");
        const theirs = (await (await cal(`api/identity/${calRoot}/rss/feed`)).json()).items;
        assert.equal(theirs.length, 2);
        assert.ok(
            theirs.every((i) => i.annotations.every((a) => a.annotator !== beaRoot)),
            "bea's tags are bea's alone",
        );

        const gone = await cal(`api/identity/${calRoot}/rss/${feedId}`, { method: 'DELETE' });
        assert.equal(gone.status, 200);
        assert.deepEqual((await gone.json()).feeds, []);
        const none = await (await cal(`api/identity/${calRoot}/feed?kind=rss`)).json();
        assert.deepEqual(none.items, [], 'nothing of a feed they let go');
        const still = await (await bea(`api/identity/${beaRoot}/rss/feed`)).json();
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
        const items = await cal(`api/identity/${beaRoot}/rss/feed`);
        assert.ok(items.status === 403 || items.status === 404, `got ${items.status}`);
        const body = await cal(`api/identity/${calRoot}/rss/${feedId}/${'0'.repeat(32)}/body`);
        assert.equal(body.status, 404, 'no item of a feed they do not follow');
    });
});
