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
