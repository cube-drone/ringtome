/*
    BOOKS.md slice 2: a notebook rolls out as one book. Pages publish through the door
    carrying `part_of`; the fold keeps them off feeds and shelves; the book document carries
    the tree; hidden never publishes. The follower's feed shows one book post and no pages,
    and every page has a permalink that opens from the book.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST_B } = require("./fetch.cjs");

const base58 = async (host) => (await (await host("api/node")).json()).base58;

describe("books: a notebook rolls out as one book", function () {
    this.timeout(600000);

    let ada, adaRoot, pages = {}, book, hiddenId;
    const bucket = "grimoire";
    const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

    before(async () => {
        ada = await makeUserFetch({ prefix: "bookada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        const mk = async (title, body) => {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: "marquee" })).json();
            await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/${bucket}`, { method: "PUT" });
            return d.doc_id;
        };
        pages.one = await mk("chapter one", "the first words");
        pages.two = await mk("chapter two", "the second words");
        pages.loose = await mk("a loose page", "unfiled words");
        hiddenId = await mk("the secret page", "never published");
        // A picture filed in the notebook is not a page (field-found 2026-09-04): it must
        // neither count nor send the rollout through the text door.
        const pic = await (await ada(`api/identity/${adaRoot}/docs/binary?title=plate`, { method: "POST", body: makePng(32, 32), file: true })).json();
        await ada(`api/identity/${adaRoot}/docs/${pic.doc_id}/buckets/${bucket}`, { method: "PUT" });
        for (let i = 0; i < 60; i++) {
            if ((await ada(`api/identity/${adaRoot}/docs/${pic.doc_id}/body`)).status === 200) break;
            await new Promise((r) => setTimeout(r, 300));
        }
        // The tree: a root by title convention, one section holding two chapters.
        const root = (await (await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: `wiki:${bucket}` })).json()).taxonomy_id;
        const part = (await (await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: "part one" })).json()).taxonomy_id;
        await j(ada, `api/identity/${adaRoot}/taxonomies/${root}/members/${part}`, {}, "PUT");
        await j(ada, `api/identity/${adaRoot}/taxonomies/${part}/members/${pages.one}`, {}, "PUT");
        await j(ada, `api/identity/${adaRoot}/taxonomies/${part}/members/${pages.two}`, {}, "PUT");
        await j(ada, `api/identity/${adaRoot}/taxonomies/${root}/members/${hiddenId}`, {}, "PUT");
        // A hidden SECTION with a page in it, and an empty section: neither may appear in
        // the table of contents (field-found 2026-09-04).
        const secret = await (await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: "hidden section" })).json();
        const behind = await mk("behind the curtain", "not for the book");
        await j(ada, `api/identity/${adaRoot}/taxonomies/${root}/members/${secret.taxonomy_id}`, {}, "PUT");
        await j(ada, `api/identity/${adaRoot}/taxonomies/${secret.taxonomy_id}/members/${behind}`, {}, "PUT");
        await j(ada, `api/identity/${adaRoot}/private/kv/book_hidden/sec:${secret.taxonomy_id}`, { value: "yes" }, "PUT");
        const empty = await (await j(ada, `api/identity/${adaRoot}/taxonomies`, { title: "images" })).json();
        await j(ada, `api/identity/${adaRoot}/taxonomies/${root}/members/${empty.taxonomy_id}`, {}, "PUT");
        // Book mode, and the secret page hidden.
        await j(ada, `api/identity/${adaRoot}/private/kv/books/${bucket}`, { value: JSON.stringify({ mode: "book" }) }, "PUT");
        await j(ada, `api/identity/${adaRoot}/private/kv/book_hidden/doc:${hiddenId}`, { value: "yes" }, "PUT");
    });

    const plan = async () => {
        const r = await (await ada(`api/identity/${adaRoot}/private/kv/book_rollout`)).json();
        const row = (r.values || []).find((v) => v.key === bucket);
        return row ? JSON.parse(row.value) : null;
    };

    it("a rollout asked for lands as a plan naming this device, and the sweep carries it out", async () => {
        const asked = await j(ada, `api/identity/${adaRoot}/books/${bucket}/rollout`, {});
        assert.equal(asked.status, 200, await asked.text());
        assert.equal((await plan()).status, "pending");
        let p = null;
        for (let i = 0; i < 40; i++) {
            await beat(undefined, "book-rollout", adaRoot);
            p = await plan();
            if (p && (p.status === "done" || p.status === "failed")) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.ok(p, "a plan");
        assert.equal(p.status, "done", `the rollout came to rest: ${JSON.stringify(p)}`);
        assert.equal(p.total, 3, "three pages, the hidden one never counted");
        assert.equal(p.done, 3);
        book = p.book;
        assert.ok(book, "the book has an id");
    });

    it("the shelf lists the book and none of its pages; the book carries the tree", async () => {
        const shelf = (await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || [];
        const formats = shelf.map((p) => `${p.format}:${p.title}`);
        assert.deepEqual(formats, [`book:${bucket}`], `only the book: ${formats}`);
        const body = JSON.parse(await (await ada(`id/${adaRoot}/docs/${book}/body`)).text());
        assert.equal(body.title, bucket);
        assert.deepEqual(body.sections.map((s) => s.title), ["part one"], "a hidden section and an empty one are not listed");
        assert.ok(!JSON.stringify(body).includes("curtain"), "nothing beneath a hidden section publishes");
        assert.deepEqual(body.sections[0].pages.map((p) => p.title), ["chapter one", "chapter two"]);
        assert.deepEqual(body.pages.map((p) => p.title), ["a loose page"], "the unfiled page rides at the top level");
        assert.ok(!JSON.stringify(body).includes("secret"), "hidden never publishes");
    });

    it("every page is a real post carrying part_of, with the version it published recorded", async () => {
        const body = JSON.parse(await (await ada(`id/${adaRoot}/docs/${book}/body`)).text());
        for (const p of [...body.sections[0].pages, ...body.pages]) {
            const head = await (await ada(`api/id/${adaRoot}/posts/${p.post}`)).json();
            assert.equal(head.part_of, book, `${p.title} names its book`);
            assert.equal(head.title, p.title);
        }
        const docs = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs;
        const one = docs.find((d) => d.doc_id === pages.one);
        assert.ok(one.fields.published_version && one.fields.published_version === one.head, "the ledger can say 'current'");
        assert.ok(one.fields.published_as, "and the page knows its post");
        const secret = docs.find((d) => d.doc_id === hiddenId);
        assert.ok(!secret.fields.published_as, "the hidden page never published");
    });

    it("a follower's feed shows one book post and no pages", async function () {
        if (!HOST_B) this.skip();
        const bea = await makeUserFetch({ prefix: "bookbea", host: HOST_B });
        const beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        const viaAda = await base58(ada);
        if ((await bea(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let items = [];
        for (let i = 0; i < 30 && !items.some((it) => it.doc_id === book); i++) {
            await pullAndFold(HOST_B, adaRoot);
            items = ((await (await bea(`api/identity/${beaRoot}/feed`)).json()).items || []).filter((it) => it.author === adaRoot);
            if (!items.some((it) => it.doc_id === book)) await new Promise((r) => setTimeout(r, 300));
        }
        assert.deepEqual(items.map((it) => `${it.format}:${it.title}`), [`book:${bucket}`], `one book, no pages: ${JSON.stringify(items.map((i) => i.title))}`);
        const page = await bea(`id/${adaRoot}/docs/${(JSON.parse(await (await bea(`id/${adaRoot}/docs/${book}/body`)).text())).pages[0].post}/body`);
        assert.equal(page.status, 200, "a page opens from the book");
        assert.equal(await page.text(), "unfiled words");
    });

    it("a second rollout re-publishes changed pages, retracts a newly hidden one, and says so in one update", async () => {
        // Edit two pages, hide one.
        const edit = async (docId, body) => {
            const got = await (await ada(`api/identity/${adaRoot}/docs/${docId}`)).json();
            const r = await j(ada, `api/identity/${adaRoot}/docs/${docId}`, { title: got.title, body, parents: got.heads.map((h) => h.version), format: "marquee" }, "PUT");
            assert.equal(r.status, 200, await r.text());
        };
        await edit(pages.one, "the first words, revised");
        await edit(pages.loose, "unfiled words, revised");
        await j(ada, `api/identity/${adaRoot}/private/kv/book_hidden/doc:${pages.two}`, { value: "yes" }, "PUT");
        const twoPost = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs.find((d) => d.doc_id === pages.two).fields.published_as;
        assert.ok(twoPost, "chapter two was published by the first rollout");
        const asked = await j(ada, `api/identity/${adaRoot}/books/${bucket}/rollout`, {});
        assert.equal(asked.status, 200, await asked.text());
        let p = null;
        for (let i = 0; i < 40; i++) {
            await beat(undefined, "book-rollout", adaRoot);
            p = await plan();
            if (p && (p.status === "done" || p.status === "failed")) break;
            await new Promise((r) => setTimeout(r, 500));
        }
        assert.equal(p.status, "done", `the second rollout came to rest: ${JSON.stringify(p)}`);
        assert.equal(p.changed, 2, "two pages re-published");
        assert.equal(p.removed, 1, "one page retracted");
        assert.ok(p.update, "an update post was minted");
        // The book's new version no longer names chapter two; its permalink is gone.
        const body = JSON.parse(await (await ada(`id/${adaRoot}/docs/${book}/body`)).text());
        assert.deepEqual(body.sections[0].pages.map((x) => x.title), ["chapter one"]);
        assert.equal((await ada(`api/id/${adaRoot}/posts/${twoPost}`)).status, 404, "the hidden page's permalink is gone");
        const two = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs.find((d) => d.doc_id === pages.two);
        assert.ok(!two.fields.published_as, "and its note is a draft again");
        // The update: threaded under the book, naming the two changed pages and the removed one.
        const update = await (await ada(`api/id/${adaRoot}/posts/${p.update}`)).json();
        assert.equal(update.title, `${bucket} updated`);
        assert.ok(update.reply_to && update.reply_to.doc_id === book, "threaded under the book");
        const words = await (await ada(`id/${adaRoot}/docs/${p.update}/body`)).text();
        assert.ok(words.includes("[chapter one]") && words.includes("[a loose page]"), `names the changed pages: ${words}`);
        assert.ok(words.includes("removed:") && words.includes("chapter two"), `names the removed page: ${words}`);
        // The shelf: the book and the update, still no pages.
        const shelf = (await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || [];
        assert.deepEqual(shelf.map((x) => `${x.format}:${x.title}`).sort(), [`book:${bucket}`, `marquee:${bucket} updated`]);
    });
});