/*
    Crawling (plans/CRAWLING.md, 2026-10-11): the public site as a search engine reads it - a
    reading copy of each page in its body, the right status for an address that names nothing or a
    post taken down, structured data, the node-wide feed, and who is indexed. The rig's nodes have
    no public URL, so here nothing is indexed: every page says `noindex`, `robots.txt` turns
    crawlers away, and there is no sitemap. The public case was seen on a scratch node with
    RINGTOME_PUBLIC_URL (HISTORY).
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('crawling: the public site as a search engine reads it', function () {
    this.timeout(600000);

    let ada, root, short, post, gone;
    const crawler = makeFetch();
    // The reading copy: what's inside `<div class="reading-copy">`.
    const copyOf = (html) => {
        const at = html.indexOf('<div class="reading-copy">');
        return at < 0 ? '' : html.slice(at);
    };
    const publish = async (title, body) => {
        const d = await (
            await j(ada, `api/identity/${root}/docs`, { title, body, format: 'marquee' })
        ).json();
        const r = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, {});
        const said = await r.text();
        assert.equal(r.status, 200, said);
        return JSON.parse(said).post_id;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'crawlada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        await j(ada, `api/identity/${root}/profile`, { field: 'name', value: 'Ada Crawl' });
        short = (await import('../../js/speakable.js')).toBase58(root);
        post = await publish(
            'A Horse at Dawn',
            'The **horse** stood in the [field](https://example.com).',
        );
        gone = await publish('Soon Gone', 'not for long');
        const down = await ada(`api/identity/${root}/posts/${gone}`, { method: 'DELETE' });
        assert.equal(down.status, 200, await down.clone().text());
        await wait(300);
    });

    it("a post's page carries its words, its author and date, and its structured data", async () => {
        const r = await crawler(`ringtome/user/${short}/a-horse-at-dawn`);
        assert.equal(r.status, 200);
        const html = await r.text();
        const copy = copyOf(html);
        assert.ok(copy.includes('<h1>A Horse at Dawn</h1>'), copy);
        assert.ok(copy.includes('<strong>horse</strong>'), 'the words, rendered');
        assert.ok(copy.includes('href="https://example.com"'));
        assert.ok(copy.includes('Ada Crawl'), 'its author');
        assert.ok(/<time datetime="\d{4}-\d\d-\d\dT/.test(copy), 'and its date');
        assert.ok(html.includes('<script type="application/ld+json">'), 'structured data');
        assert.ok(html.includes('"@type":"SocialMediaPosting"'));
        assert.ok(
            html.includes('<meta name="robots" content="noindex">'),
            'no public URL: not indexed',
        );
        assert.ok(
            html.includes("classList.add('js')"),
            'and a browser that runs scripts hides the copy',
        );
    });

    it("lets a CDN keep a public page a while, and asks for a post's words every time (2026-10-13)", async () => {
        const page = await crawler(`ringtome/user/${short}/a-horse-at-dawn`);
        assert.equal(
            page.headers.get('cache-control'),
            'public, max-age=0, s-maxage=300',
            'a new post: the five-minute floor',
        );
        const person = await crawler(`ringtome/user/${short}`);
        assert.equal(person.headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
        // The app reads the words at their own address: kept by nobody, so an edit reaches every
        // reader in the app at once.
        const words = await crawler(`ringtome/user/${short}/doc/${post}/body`);
        assert.equal(words.status, 200);
        assert.equal(words.headers.get('cache-control'), 'no-cache');
    });

    it('a takedown is a 404 on the very next read, however warm the caches (2026-10-13)', async () => {
        const id = await publish('Here Then Gone', 'words to forget');
        const words = `ringtome/user/${short}/doc/${id}/body`;
        for (let i = 0; i < 3; i++) {
            const r = await crawler(words);
            assert.equal(r.status, 200, 'served, and every cache on the way warmed');
            assert.equal(await r.text(), 'words to forget');
        }
        const down = await ada(`api/identity/${root}/posts/${id}`, { method: 'DELETE' });
        assert.equal(down.status, 200, await down.clone().text());
        assert.equal((await crawler(words)).status, 404, 'gone at once - no cache answers for it');
    });

    it("a person's page lists their posts as links, and paging goes further back", async () => {
        const html = await (await crawler(`ringtome/user/${short}`)).text();
        const copy = copyOf(html);
        assert.ok(copy.includes('<h1>Ada Crawl</h1>'), copy);
        assert.ok(
            copy.includes(`/ringtome/user/${short}/a-horse-at-dawn"`),
            'a link to the post, by its path',
        );
        assert.ok(!copy.includes('Soon Gone'), 'never a post taken down');
        assert.ok(html.includes('"@type":"ProfilePage"'));
        assert.ok(
            html.includes(`<link rel="canonical" href="`) &&
                html.includes(`/ringtome/user/${short}">`),
        );
        // Past a page of posts, an "older posts" link, and it leads somewhere that lists more.
        for (let i = 0; i < 31; i++) await publish(`Filler ${i}`, 'words');
        const full = copyOf(await (await crawler(`ringtome/user/${short}`)).text());
        const next = /rel="next" href="([^"]+)"/.exec(full);
        assert.ok(next, full.slice(0, 400));
        const older = copyOf(
            await (await crawler(next[1].replace(/^\//, '').replace(/&amp;/g, '&'))).text(),
        );
        assert.ok(older.includes('A Horse at Dawn'), 'the oldest post, on the older page');
    });

    it('answers honestly: 404 for an address naming nothing, 410 for a post taken down', async () => {
        assert.equal((await crawler(`ringtome/user/${short}/no-such-post`)).status, 404);
        assert.equal((await crawler(`ringtome/user/${short}/post/${'0'.repeat(32)}`)).status, 404);
        assert.equal((await crawler(`ringtome/user/${short}/post/${gone}`)).status, 410);
        assert.equal((await crawler(`ringtome/user/${short}`)).status, 200, 'the person, as ever');
    });

    it("the node's own pages: the front page and people, as links, and a feed of what's new", async () => {
        const front = await (await crawler('feed')).text();
        // The newest first: the last of the claim above's fillers.
        assert.ok(copyOf(front).includes('Filler 30'), copyOf(front).slice(0, 500));
        assert.ok(
            front.includes('href="/feed.xml"') || front.includes('/feed.xml"'),
            'the feed, named',
        );
        const people = copyOf(await (await crawler('people')).text());
        assert.ok(people.includes('Ada Crawl'), people.slice(0, 500));
        const feed = await crawler('feed.xml');
        assert.equal(feed.status, 200);
        assert.match(feed.headers.get('content-type'), /rss/);
        const xml = await feed.text();
        assert.ok(xml.includes('<title>Filler 30</title>'), xml.slice(0, 600));
        assert.ok(xml.includes('/filler-30</link>'), 'linked by its path');
    });

    it('with no public URL: robots turns crawlers away, there is no sitemap, and the settings say so', async () => {
        const robots = await (await crawler('robots.txt')).text();
        assert.match(robots, /Disallow: \//);
        assert.equal((await crawler('sitemap.xml')).status, 404);
        // A persona can still say no for themselves - a public profile field.
        const r = await j(ada, `api/identity/${root}/profile`, { field: 'search', value: 'no' });
        assert.equal(r.status, 200, await r.clone().text());
    });
});
