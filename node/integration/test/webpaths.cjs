/*
    Web addresses (plans/WEB_ADDRESSES.md, slice 1, 2026-10-11): a post published gets a readable
    path - from its title, else its date and first words - under the folder of the notebook it came
    from, and a book's pages under the book and its sections. The path is the author's `path` label
    on the post, so the node answers `/ringtome/user/<them>/<path>` for anyone, and the post's page
    names it as canonical. It's made once: a retitle keeps it, a clash takes the post's own id, and
    a sealed post gets none.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { makeFetch } = require('./fetch.cjs');
const { beat } = require('./beat.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('web addresses: a post lives at a readable path', function () {
    this.timeout(600000);

    let ada, root;
    const stranger = makeFetch();

    const draft = async (title, body, notebook = null) => {
        const d = await (
            await j(ada, `api/identity/${root}/docs`, { title, body, format: 'marquee' })
        ).json();
        if (notebook)
            await ada(`api/identity/${root}/docs/${d.doc_id}/buckets/${notebook}`, {
                method: 'PUT',
            });
        return d.doc_id;
    };
    const publish = async (doc, flags = {}) => {
        const r = await j(ada, `api/identity/${root}/docs/${doc}/publish`, flags);
        const said = await r.text();
        assert.equal(r.status, 200, said);
        return JSON.parse(said).post_id;
    };
    // The path the post's author gave it, off the post's own read.
    const pathOf = async (post) => {
        const p = await (await stranger(`api/id/${root}/posts/${post}`)).json();
        const label = (p.annotations || []).find((a) => a.annotator === root && a.key === 'path');
        return label ? label.value : null;
    };
    // What a path names, asked as a stranger - a moment's patience for the node's label memo.
    const at = async (path) => {
        for (let i = 0; i < 20; i++) {
            const r = await stranger(`api/id/${root}/at/${path}`);
            if (r.status === 200) return (await r.json()).post;
            await wait(250);
        }
        return null;
    };

    before(async () => {
        ada = await makeUserFetch({ prefix: 'pathada' });
        root = (await (await ada('api/identity', { method: 'POST' })).json()).root_pubkey;
        await ada(`api/identity/${root}/serve`, { method: 'POST' });
    });

    it('a titled post lives at its title, for anyone, and its page names that address', async () => {
        const post = await publish(await draft('CyberGamer Canada: Ad ViewMagic', 'words'));
        assert.equal(await pathOf(post), 'cybergamer-canada--ad-viewmagic');
        assert.equal(await at('cybergamer-canada--ad-viewmagic'), post);
        const page = await (
            await stranger(`ringtome/user/${root}/cybergamer-canada--ad-viewmagic`)
        ).text();
        assert.match(
            page,
            /<link rel="canonical" href="[^"]*\/ringtome\/user\/[^/"]+\/cybergamer-canada--ad-viewmagic">/,
            'the head names the path as canonical',
        );
        assert.ok(page.includes(`<meta name="ringtome:post" content="${root}/${post}">`));
        assert.equal((await stranger(`api/id/${root}/at/no-such-thing`)).status, 404);
    });

    it('is made once: a retitle keeps it, and a second post of the same title takes its id', async () => {
        const note = await draft('Sourdough Loaf', 'first');
        const post = await publish(note);
        assert.equal(await pathOf(post), 'sourdough-loaf');
        const held = await (await ada(`api/identity/${root}/docs/${note}`)).json();
        const parents = (held.heads || []).map((h) => h.version);
        const put = await j(
            ada,
            `api/identity/${root}/docs/${note}`,
            { title: 'A Better Loaf', body: 'second', parents, format: 'marquee' },
            'PUT',
        );
        assert.equal(put.status, 200, await put.clone().text());
        assert.equal(await publish(note), post, 'the same post, again');
        assert.equal(await pathOf(post), 'sourdough-loaf', 'only a person changes a path');

        const twin = await publish(await draft('Sourdough Loaf', 'another'));
        assert.equal(await pathOf(twin), `sourdough-loaf-${twin.slice(0, 6)}`);
        assert.equal(await at(`sourdough-loaf-${twin.slice(0, 6)}`), twin);
    });

    it('an untitled post is its date and first words; a notebook is a folder; a sealed post has none', async () => {
        const quick = await publish(await draft('', 'Today I drew a horse, and then another'));
        const day = new Date().toISOString().slice(0, 10);
        assert.equal(await pathOf(quick), `${day}-today-i-drew-a-horse`);

        const filed = await publish(await draft('Leek Soup', 'leeks', 'Recipes'));
        assert.equal(await pathOf(filed), 'recipes/leek-soup');
        assert.equal(await at('recipes/leek-soup'), filed);

        const sealed = await publish(await draft('Secret Pudding', 'shh'), { trusted_only: true });
        assert.equal(await pathOf(sealed), null, 'its title is for trusted readers');
        assert.equal(await at('secret-pudding'), null);
    });

    it("a book lives at its notebook's folder, and its pages under it and their sections", async () => {
        const notebook = 'grimoire';
        const loose = await draft('The Title Page', 'opening', notebook);
        const chapter = await draft('Chapter One', 'the first words', notebook);
        const tree = (
            await (
                await j(ada, `api/identity/${root}/taxonomies`, { title: `wiki:${notebook}` })
            ).json()
        ).taxonomy_id;
        const part = (
            await (await j(ada, `api/identity/${root}/taxonomies`, { title: 'Part One' })).json()
        ).taxonomy_id;
        await j(ada, `api/identity/${root}/taxonomies/${tree}/members/${loose}`, {}, 'PUT');
        await j(ada, `api/identity/${root}/taxonomies/${tree}/members/${part}`, {}, 'PUT');
        await j(ada, `api/identity/${root}/taxonomies/${part}/members/${chapter}`, {}, 'PUT');
        await j(
            ada,
            `api/identity/${root}/private/kv/books/${notebook}`,
            { value: JSON.stringify({ mode: 'book' }) },
            'PUT',
        );
        assert.equal(
            (await j(ada, `api/identity/${root}/books/${notebook}/rollout`, {})).status,
            200,
        );
        let plan = null;
        for (let i = 0; i < 40; i++) {
            await beat(undefined, 'book-rollout', root);
            const r = await (await ada(`api/identity/${root}/private/kv/book_rollout`)).json();
            const row = (r.values || []).find((v) => v.key === notebook);
            plan = row ? JSON.parse(row.value) : null;
            if (plan && (plan.status === 'done' || plan.status === 'failed')) break;
            await wait(500);
        }
        assert.equal(plan && plan.status, 'done', JSON.stringify(plan));
        assert.equal(await at('grimoire'), plan.book, 'the folder is the book');
        const chapterPost = await at('grimoire/part-one/chapter-one');
        assert.ok(chapterPost, 'a page under its section');
        const read = await (await stranger(`api/id/${root}/posts/${chapterPost}`)).json();
        assert.equal(read.part_of, plan.book, "and it is the book's page");
        assert.ok(await at('grimoire/the-title-page'), 'a page at the top of the book');
        // The reader links its pages by path (slice 2): the book's payload names each one's.
        const payload = JSON.parse(
            await (await stranger(`id/${root}/docs/${plan.book}/body`)).text(),
        );
        const named = JSON.stringify(payload);
        assert.ok(named.includes('"path":"grimoire/part-one/chapter-one"'), named);
    });

    it("under the persona's @name: answered, but handed out only where the node has a public URL", async () => {
        // The rig's nodes declare no public URL: an @name there would mean nothing at any other
        // address (Curtis, 2026-10-11), so nothing hands it out and the identity form is canonical.
        // The public case was seen on a scratch node with RINGTOME_PUBLIC_URL (HISTORY).
        const name = `paths${Date.now() % 1000000}`;
        const claim = await j(ada, `api/identity/${root}/slug`, { slug: name }, 'PUT');
        assert.equal(claim.status, 200, await claim.clone().text());
        assert.deepEqual(await (await stranger(`api/node/slug-of/${root}`)).json(), { slug: null });
        const page = await (await stranger(`@${name}/cybergamer-canada--ad-viewmagic`)).text();
        assert.ok(
            page.includes('property="og:title" content="CyberGamer Canada: Ad ViewMagic"'),
            'it answers',
        );
        assert.match(
            page,
            /<link rel="canonical" href="[^"]*\/ringtome\/user\/[^/"]+\/cybergamer-canada--ad-viewmagic">/,
            'and names the form that travels',
        );
        // A new name: the old one sends on, the path kept.
        const renamed = `${name}x`;
        await j(ada, `api/identity/${root}/slug`, { slug: renamed }, 'PUT');
        const old = await stranger(`@${name}/cybergamer-canada--ad-viewmagic`, {
            redirect: 'manual',
        });
        assert.equal(old.status, 307);
        assert.ok(
            (old.headers.get('location') || '').endsWith(
                `/@${renamed}/cybergamer-canada--ad-viewmagic`,
            ),
            old.headers.get('location'),
        );
    });

    it("a notebook's folder names its notebook, for the person's page to narrow to", async () => {
        const r = await stranger(`api/id/${root}/at/recipes`);
        assert.equal(r.status, 200, await r.clone().text());
        assert.deepEqual(await r.json(), { folder: 'recipes', bucket: 'Recipes' });
        assert.equal((await stranger(`api/id/${root}/at/nothing-filed`)).status, 404);
    });
});
