/*
    Implicit tags (Curtis, 2026-10-01): "image", "video" and "audio", on whatever holds that kind
    of media, and "micro" / "short" / "medium" / "long" on whatever is words, by how many. A private
    document's are worked out each time its row is built - a picture is an image, a note embedding
    one is too, and the tag goes when the picture does - and never land on the chain. Publishing
    says them in public as ordinary tags, so every reader can filter on them, and a republish that
    no longer earns one takes it back.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch, makePng } = require('./helpers.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('implicit tags: image, video, audio for what a thing holds', function () {
    this.timeout(120000);

    let ada, root, pic, note, plain;
    const row = async (id) =>
        (await (await ada(`api/identity/${root}/docs`)).json()).docs.find((d) => d.doc_id === id);
    const said = async (post) =>
        (
            (await (await ada(`api/identity/${root}/public-annotations/${root}/${post}`)).json())
                .items || []
        )
            .filter((s) => s.key === 'tag')
            .map((s) => s.value);

    before(async () => {
        ada = await makeUserFetch({ prefix: 'implicit' });
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
        note = (
            await (
                await j(ada, `api/identity/${root}/docs`, {
                    title: 'with a horse',
                    body: `look\n\n![a horse](/api/identity/${root}/docs/${pic}/body/a-horse.png)\n`,
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
        plain = (
            await (
                await j(ada, `api/identity/${root}/docs`, {
                    title: 'just words',
                    body: 'only words here',
                    format: 'marquee',
                })
            ).json()
        ).doc_id;
    });

    it('a picture is an image, and so is a note that holds one; words alone are neither', async () => {
        const p = await row(pic);
        assert.ok(p.tags.includes('image'), JSON.stringify(p.tags));
        assert.deepEqual(p.implicit, ['image'], 'and the row says which tags are implicit');
        const n = await row(note);
        assert.ok(n.tags.includes('image'), JSON.stringify(n.tags));
        assert.deepEqual(n.implicit, ['image', 'micro'], 'a picture, in a few words');
        const w = await row(plain);
        assert.ok(!w.tags.includes('image'));
        assert.deepEqual(w.implicit, ['micro'], 'three words: micro, and no picture');
    });

    it('is found by the tagged read, though no statement names it', async () => {
        const tagged = (
            await (await ada(`api/identity/${root}/docs/tagged/image`)).json()
        ).docs.map((d) => d.doc_id);
        assert.ok(tagged.includes(pic) && tagged.includes(note), 'both, by their media');
        assert.ok(!tagged.includes(plain));
    });

    it('goes when the picture does', async () => {
        const got = await (await ada(`api/identity/${root}/docs/${note}`)).json();
        const saved = await j(
            ada,
            `api/identity/${root}/docs/${note}`,
            {
                title: 'with a horse',
                body: 'the horse ran off',
                parents: got.heads.map((h) => h.version),
                format: 'marquee',
            },
            'PUT',
        );
        assert.equal(saved.status, 200, await saved.text());
        const n = await row(note);
        assert.ok(!n.tags.includes('image'), JSON.stringify(n.tags));
        // And back, for the publish below.
        const again = await (await ada(`api/identity/${root}/docs/${note}`)).json();
        await j(
            ada,
            `api/identity/${root}/docs/${note}`,
            {
                title: 'with a horse',
                body: `it came back\n\n![a horse](/api/identity/${root}/docs/${pic}/body/a-horse.png)\n`,
                parents: again.heads.map((h) => h.version),
                format: 'marquee',
            },
            'PUT',
        );
        assert.ok((await row(note)).tags.includes('image'));
    });

    it('publishing says it in public, as an ordinary tag - and only of a post that holds a picture', async () => {
        await ada(`api/identity/${root}/docs/${note}/annotations/tags/horses`, { method: 'PUT' });
        const pub = await j(ada, `api/identity/${root}/docs/${note}/publish`, {});
        assert.equal(pub.status, 200, await pub.clone().text());
        const post = (await pub.json()).post_id;
        const tags = await said(post);
        assert.ok(tags.includes('image') && tags.includes('horses'), JSON.stringify(tags));

        const words = await j(ada, `api/identity/${root}/docs/${plain}/publish`, {});
        assert.equal(words.status, 200, await words.clone().text());
        const plainTags = await said((await words.json()).post_id);
        assert.ok(
            !plainTags.includes('image') && plainTags.includes('micro'),
            JSON.stringify(plainTags),
        );
    });

    const many = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
    const rewrite = async (id, body) => {
        const got = await (await ada(`api/identity/${root}/docs/${id}`)).json();
        const saved = await j(
            ada,
            `api/identity/${root}/docs/${id}`,
            {
                title: 'a growing note',
                body,
                parents: got.heads.map((h) => h.version),
                format: 'plaintext',
            },
            'PUT',
        );
        assert.equal(saved.status, 200, await saved.text());
    };

    it("a note's length tag follows its words: micro, then short - never both", async () => {
        const grow = (
            await (
                await j(ada, `api/identity/${root}/docs`, {
                    title: 'a growing note',
                    body: many(10),
                    format: 'plaintext',
                })
            ).json()
        ).doc_id;
        assert.deepEqual((await row(grow)).implicit, ['micro']);
        await rewrite(grow, many(80));
        const r = await row(grow);
        assert.deepEqual(r.implicit, ['short'], '80 words');
        assert.ok(!r.tags.includes('micro'), 'and micro is gone');
    });

    it('a republish that outgrows its length says the new one and takes the old one back', async () => {
        const essay = (
            await (
                await j(ada, `api/identity/${root}/docs`, {
                    title: 'a growing note',
                    body: many(100),
                    format: 'plaintext',
                })
            ).json()
        ).doc_id;
        const first = await j(ada, `api/identity/${root}/docs/${essay}/publish`, {});
        assert.equal(first.status, 200, await first.clone().text());
        const post = (await first.json()).post_id;
        assert.ok((await said(post)).includes('short'));
        await rewrite(essay, many(600));
        const again = await j(ada, `api/identity/${root}/docs/${essay}/publish`, {});
        assert.equal(again.status, 200, await again.clone().text());
        assert.equal((await again.json()).post_id, post, 'the same post, a new version');
        const tags = await said(post);
        assert.ok(tags.includes('medium'), JSON.stringify(tags));
        assert.ok(!tags.includes('short'), `short is retracted: ${JSON.stringify(tags)}`);
    });
});
