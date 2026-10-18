/*
    Books in groups (plans/GROUPS.md, "Books in groups", 2026-10-18). A notebook published as a
    book can go into one of its author's groups, for the members alone: every page the group's
    document, part of the book, and the book itself the group's, its payload naming those pages -
    nothing of it public. A second rollout edits it in place, and taking it down takes its pages.
    Or it goes out in public as a public group: the public book, which the group counts as its own.
*/
const assert = require('node:assert');
const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');

const { makeUserFetch } = require('./helpers.cjs');
const { beat } = require('./beat.cjs');
const { HOST, HOST_B, makeFetch } = require('./fetch.cjs');

const j = (who, path, body, method = 'POST') => who(path, { method, body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(HOST_B ? describe : describe.skip)('groups: books, within a group and as one', function () {
    this.timeout(300000);

    let ada, adaRoot, bea, beaRoot, club, guild;

    const persona = async (prefix, host) => {
        const who = await makeUserFetch({ prefix, host });
        const root = (await (await who('api/identity', { method: 'POST' })).json()).root_pubkey;
        await who(`api/identity/${root}/serve`, { method: 'POST' });
        return [who, root];
    };
    const act = async (who, root, group, path, body = {}) => {
        const res = await j(who, `api/identity/${root}/groups/${group}/${path}`, body);
        const text = await res.text();
        assert.equal(res.status, 200, `${path}: ${text}`);
        return JSON.parse(text);
    };
    /// A notebook of two pages, under its wiki root, switched to publish as a book.
    const notebook = async (bucket) => {
        const page = async (title, body) => {
            const d = await (
                await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: 'marquee' })
            ).json();
            await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/${bucket}`, {
                method: 'PUT',
            });
            return d.doc_id;
        };
        const first = await page('chapter one', 'the first words');
        const second = await page('chapter two', 'the second words');
        const root = (
            await (
                await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: `wiki:${bucket}` })
            ).json()
        ).taxonomy_id;
        for (const d of [first, second])
            await j(ada, `api/identity/${adaRoot}/taxonomies/${root}/members/${d}`, {}, 'PUT');
        await j(
            ada,
            `api/identity/${adaRoot}/private/kv/books/${bucket}`,
            { value: JSON.stringify({ mode: 'book' }) },
            'PUT',
        );
        return [first, second];
    };
    const rollout = async (bucket, flags = {}) => {
        const asked = await j(ada, `api/identity/${adaRoot}/books/${bucket}/rollout`, flags);
        const text = await asked.text();
        if (asked.status !== 200) return { status: asked.status, text };
        let p = null;
        for (let i = 0; i < 120; i++) {
            await beat(HOST, 'book-rollout', adaRoot);
            const r = await (await ada(`api/identity/${adaRoot}/private/kv/book_rollout`)).json();
            const row = (r.values || []).find((v) => v.key === bucket);
            p = row ? JSON.parse(row.value) : null;
            if (p && (p.status === 'done' || p.status === 'failed')) break;
            await sleep(300);
        }
        assert.ok(p && p.status === 'done', `the rollout came to rest: ${JSON.stringify(p)}`);
        return { status: 200, plan: p };
    };
    const groupPosts = async (who, root, group) => {
        await beat(who === ada ? HOST : HOST_B, 'fold', root);
        return (await (await who(`api/identity/${root}/groups/${group}/posts`)).json()).posts;
    };
    const body = async (who, group, doc) => {
        const r = await who(`api/groups/${group}/docs/${doc}/body`);
        return r.status === 200 ? r.text() : null;
    };

    before(async () => {
        [ada, adaRoot] = await persona('gbada');
        [bea, beaRoot] = await persona('gbbea', HOST_B);
        club = (
            await (await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Book Club' })).json()
        ).group;
        guild = (
            await (
                await j(ada, `api/identity/${adaRoot}/groups`, { name: 'Book Guild', public: true })
            ).json()
        ).group;
        const token = await act(ada, adaRoot, club, 'invites', { invitee: beaRoot });
        await act(bea, beaRoot, club, 'join', {
            invite: token.invite,
            founder: token.founder,
            inviter: token.inviter,
            via: token.via,
        });
    });

    let book;

    it("a notebook rolls out into a group for its members: the book and its pages are the group's, and nothing public", async () => {
        await notebook('clubnotes');
        const { plan } = await rollout('clubnotes', { group: club });
        book = plan.book;
        const posts = await groupPosts(ada, adaRoot, club);
        const card = posts.find((p) => p.doc === book);
        assert.ok(card, 'the book is on the group page');
        assert.equal(card.format, 'book');
        assert.equal(
            posts.length,
            2,
            'the book and #general - the pages are part of the book, not posts',
        );

        const payload = JSON.parse(await body(ada, club, book));
        const pages = [
            ...(payload.pages || []),
            ...(payload.sections || []).flatMap((s) => s.pages),
        ];
        assert.equal(pages.length, 2, `both pages named: ${JSON.stringify(payload)}`);
        const words = await Promise.all(pages.map((p) => body(ada, club, p.post)));
        assert.deepEqual(words.sort(), ['the first words', 'the second words']);

        const stranger = makeFetch(HOST);
        assert.notEqual(
            (await stranger(`id/${adaRoot}/docs/${book}/body`)).status,
            200,
            'never public',
        );
        for (const p of pages)
            assert.notEqual((await stranger(`id/${adaRoot}/docs/${p.post}/body`)).status, 200);

        // At bea's node, as any of the group's posts.
        await act(ada, adaRoot, club, 'sync');
        await act(bea, beaRoot, club, 'sync');
        let there = null;
        for (let i = 0; i < 10 && !there; i++) {
            there = (await groupPosts(bea, beaRoot, club)).find((p) => p.doc === book);
            if (!there) await sleep(300);
        }
        assert.ok(there, "the book reached bea's node");
        let read = null;
        for (let i = 0; i < 10 && !read; i++) {
            read = await body(bea, club, pages[0].post);
            if (!read) await sleep(300);
        }
        assert.ok(read && read.startsWith('the '), 'and she reads its pages');
    });

    it('a second rollout edits it in place, and a takedown takes the book and its pages', async () => {
        const payload = JSON.parse(await body(ada, club, book));
        const pages = [
            ...(payload.pages || []),
            ...(payload.sections || []).flatMap((s) => s.pages),
        ];
        const docs = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs;
        const one = docs.find((d) => d.title === 'chapter one');
        const got = await (await ada(`api/identity/${adaRoot}/docs/${one.doc_id}`)).json();
        await j(
            ada,
            `api/identity/${adaRoot}/docs/${one.doc_id}`,
            {
                title: 'chapter one',
                body: 'the first words, revised',
                parents: got.heads.map((h) => h.version),
                format: 'marquee',
            },
            'PUT',
        );
        const { plan } = await rollout('clubnotes');
        assert.equal(plan.book, book, 'the same book');
        assert.equal(plan.changed, 1, 'one page re-said');
        const again = JSON.parse(await body(ada, club, book));
        const now = [...(again.pages || []), ...(again.sections || []).flatMap((s) => s.pages)];
        assert.deepEqual(
            now.map((p) => p.post).sort(),
            pages.map((p) => p.post).sort(),
            'the same pages',
        );
        const words = await Promise.all(now.map((p) => body(ada, club, p.post)));
        assert.ok(words.includes('the first words, revised'));

        const down = await ada(`api/identity/${adaRoot}/books/clubnotes`, { method: 'DELETE' });
        assert.equal(down.status, 200, await down.text());
        assert.ok(
            !(await groupPosts(ada, adaRoot, club)).some((p) => p.doc === book),
            'the book went',
        );
        for (const p of now) assert.equal(await body(ada, club, p.post), null, 'and its pages');
    });

    it("a notebook rolls out in public as a public group: the public book is the group's", async () => {
        await notebook('guildnotes');
        const { plan } = await rollout('guildnotes', { as_group: guild });
        const stranger = makeFetch(HOST);
        assert.equal(
            (await stranger(`id/${adaRoot}/docs/${plan.book}/body`)).status,
            200,
            'a public book',
        );
        const page = await (await stranger(`api/groups/${guild}/public`)).json();
        assert.ok(
            page.posts.some((p) => p.doc_id === plan.book),
            'which the group counts as its own',
        );

        const down = await ada(`api/identity/${adaRoot}/books/guildnotes`, { method: 'DELETE' });
        assert.equal(down.status, 200, await down.text());
        const after = await (await stranger(`api/groups/${guild}/public`)).json();
        assert.ok(!after.posts.some((p) => p.doc_id === plan.book), 'taken down, the claim goes');
    });

    it('a group book is never sealed, goes one place, and only into a group its author is in', async () => {
        await notebook('refused');
        const sealed = await rollout('refused', { group: club, trusted_only: true });
        assert.equal(sealed.status, 400, sealed.text);
        const both = await rollout('refused', { group: club, as_group: guild });
        assert.equal(both.status, 400, both.text);
        const stranger = await persona('gbdee');
        const theirs = (
            await (
                await j(stranger[0], `api/identity/${stranger[1]}/groups`, { name: 'Not Ada' })
            ).json()
        ).group;
        const outside = await rollout('refused', { group: theirs });
        assert.notEqual(outside.status, 200, 'not a group she is in');
    });
});
