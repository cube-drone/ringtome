/*
    How long a public document's bytes may be kept (Curtis, 2026-10-02: back from a post, "all of
    the images slowly reload" - "if we're behind a CDN we should be indicating that media can be
    cached for a pretty long span"). A post's words live at a mutable address and revalidate every
    use; its media is minted once per address and is kept - by anyone for an open post, by the
    reader's own browser alone for a sealed one.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('caching: words revalidate, media is kept', function () {
    this.timeout(120000);

    let ada, root, pic;
    const anon = makeFetch();

    // A post embedding the picture, published `flags`; answers the post id and its picture's twin.
    const postWithPicture = async (flags) => {
        const d = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'a picture',
                body: `look\n\n![a horse](/api/identity/${root}/docs/${pic}/body/a-horse.png)\n`,
                format: 'marquee',
            })
        ).json();
        const pub = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, flags);
        assert.equal(pub.status, 200, await pub.clone().text());
        const post = (await pub.json()).post_id;
        const head = await (await ada(`api/id/${root}/posts/${post}`)).json();
        return { post, twin: (head.refs || [])[0] };
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'cacheada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        pic = (
            await (
                await ada(`api/identity/${root}/docs/binary?title=a horse`, {
                    method: 'POST',
                    body: makePng(16, 16),
                    file: true,
                })
            ).json()
        ).doc_id;
        for (let i = 0; i < 60; i++) {
            if ((await ada(`api/identity/${root}/docs/${pic}/body`)).status === 200) break;
            await wait(250);
        }
    });

    it("an open post's picture is kept - a year in a browser, a month in a CDN - and its words are asked after", async () => {
        const { post, twin } = await postWithPicture({});
        assert.ok(twin, "the post names its picture's twin");
        const media = await anon(`id/${root}/docs/${twin}/body`);
        assert.equal(media.status, 200);
        assert.equal(
            media.headers.get('cache-control'),
            'public, max-age=31536000, s-maxage=2592000, immutable',
        );
        const again = await anon(`id/${root}/docs/${twin}/body`, {
            headers: { 'If-None-Match': media.headers.get('etag') },
        });
        assert.equal(again.status, 304, 'an asker with the copy still gets the cheap answer');
        assert.equal(
            again.headers.get('cache-control'),
            'public, max-age=31536000, s-maxage=2592000, immutable',
        );
        const words = await anon(`id/${root}/docs/${post}/body`);
        assert.equal(words.status, 200);
        assert.equal(
            words.headers.get('cache-control'),
            'no-cache',
            'an edit reuses the address, so the words revalidate',
        );
    });

    it("a sealed post's picture is kept by its reader alone - never a shared cache", async () => {
        const { twin } = await postWithPicture({ trusted_only: true });
        assert.ok(twin, 'the sealed post names its twin');
        const media = await ada(`id/${root}/docs/${twin}/body`);
        assert.equal(media.status, 200, 'the author opens it');
        assert.equal(media.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    });
});

/*
    Every answer says who may keep it (Curtis, 2026-10-15: BunnyCDN kept a persona's shelf, which
    said nothing, for thirty days under one key for every filter and every page, so "load more"
    brought the first page back). What is the same for everyone a CDN may keep; what was answered
    for a reader, or sets a cookie, it may not.
*/
describe('caching: an answer says who may keep it', function () {
    this.timeout(120000);

    let ada, root;
    const anon = makeFetch();
    const cacheOf = async (who, path) => {
        const r = await who(path);
        assert.equal(r.status, 200, `${path}: ${await r.clone().text()}`);
        return r.headers.get('cache-control') || '';
    };
    const shared = (cc) => /\bpublic\b/.test(cc) && /\bs-maxage=\d+/.test(cc);

    before(async () => {
        ada = await makeUserFetch({ prefix: 'keepada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
        const d = await (
            await j(ada, `api/identity/${root}/docs`, {
                title: 'a post for everyone',
                body: 'hello, strangers',
                format: 'marquee',
            })
        ).json();
        const pub = await j(ada, `api/identity/${root}/docs/${d.doc_id}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
    });

    it("a stranger's view of a shelf, its labels and the node's front page are anyone's to keep", async () => {
        for (const path of [
            `api/id/${root}/posts`,
            `api/id/${root}/posts?kind=post`,
            `api/id/${root}/labels`,
            'api/node/feed',
            'api/node/feed/labels',
            'api/node/personas',
        ]) {
            const cc = await cacheOf(anon, path);
            assert.ok(shared(cc), `${path} is anyone's: ${cc}`);
        }
    });

    it("a reader's view of the same shelf is theirs alone", async () => {
        for (const path of [
            `api/id/${root}/posts`,
            `api/id/${root}/posts?as=${root}`,
            `api/id/${root}/labels?as=${root}`,
        ]) {
            const cc = await cacheOf(ada, path);
            assert.ok(/\bprivate\b/.test(cc), `${path} for a reader is private: ${cc}`);
        }
    });

    it('an API answer that names no rule is kept by nobody without asking', async () => {
        const cc = await cacheOf(ada, `api/identity/${root}/docs`);
        assert.equal(cc, 'private, no-cache');
    });

    it('an answer that sets a cookie is stored nowhere', async () => {
        const fresh = makeFetch();
        const login = await fresh('api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username: ada.username, password: ada.password }),
        });
        assert.equal(login.status, 200, await login.clone().text());
        assert.ok(login.headers.get('set-cookie'), 'the login sets its cookie');
        assert.equal(login.headers.get('cache-control'), 'private, no-store');
    });
});
