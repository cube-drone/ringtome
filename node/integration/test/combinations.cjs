/*
    Combinations (Curtis, 2026-09-05: "our publication flow is now SO feature rich that we're
    starting to face combinatoric expansion of features"). Every other suite proves ONE
    feature with the rest switched off. This file stacks them and asserts each feature's own
    guarantee while several others are on at once - the shape that finds the seam where two
    features' bookkeeping disagree (which is how slice 5 found the book switch wiping the
    rollout's facts). Three stacks:

      1. a TRUSTED-ONLY BOOK whose title page carries a VIDEO, with TAGS, read by a trusted
         follower, SHARED two hops to strangers, UPDATED under the same flags, then TAKEN
         DOWN - and the takedown followed to the far end of the share tree.
      2. a SCHEDULED post that is SETTLED and TRUSTED-ONLY and carries a PICTURE, EDITED
         before its day, minted by the sweep with every wish intact, then taken down with
         its picture.
      3. a page that stood as a SEALED post of its own before its notebook rolled out as an
         OPEN book: same id, now a page; the book is open, the page stays sealed.

    Each claim names the feature whose guarantee it re-asserts, so a red here says which
    seam split, not merely that the stack fell over.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");
const fs = require("node:fs");
const path = require("node:path");

const { makeUserFetch, makePng } = require("./helpers.cjs");
const { beat, pullAndFold, shareArrives } = require("./beat.cjs");
const { sql, HOST_B, HOST_C, HOST_E } = require("./fetch.cjs");

const SQUIRREL = path.join(__dirname, "..", "..", "..", "sample_media", "animated_color_squirrel.gif");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const dial = (who, mine, theirs, key, value) => j(who, `api/identity/${mine}/private/kv/contact:${theirs}/${key}`, { value }, "PUT");

/// A persona on a host, serving.
const persona = async (prefix, host) => {
    const who = await makeUserFetch({ prefix, host });
    const root = (await (await who("api/identity", { method: "POST" })).json()).root_pubkey;
    await who(`api/identity/${root}/serve`, { method: "POST" });
    return { who, root };
};

/// Poll a public read until it answers 200; null when it never does.
const opens = async (who, path, tries = 40) => {
    for (let i = 0; i < tries; i++) {
        const r = await who(path);
        if (r.status === 200) return r;
        await sleep(400);
    }
    return null;
};

/// Upload bytes to a persona's private shelf and wait for the ingest to crush them.
const ingest = async (who, root, title, bytes, tries = 450) => {
    const queued = await (await who(`api/identity/${root}/docs/binary?title=${title}`, { method: "POST", body: bytes, file: true })).json();
    for (let i = 0; i < tries; i++) {
        if ((await who(`api/identity/${root}/docs/${queued.doc_id}/body`)).status === 200) return queued.doc_id;
        await sleep(400);
    }
    throw new Error(`${title} never finished ingesting`);
};

/// Publish a draft, riding out the bake of any media it embeds.
const publishRiding = async (who, root, doc, flags = {}) => {
    for (let i = 0; i < 60; i++) {
        const r = await j(who, `api/identity/${root}/docs/${doc}/publish`, flags);
        const t = JSON.parse(await r.text());
        assert.ok(!(t.baking || []).some((x) => x.status === "failed"), `bake failed: ${JSON.stringify(t.baking)}`);
        if (r.status === 200 && t.post_id) return t;
        if (r.status === 200 && t.scheduled_for) return t;
        await sleep(500);
    }
    throw new Error("the publish never came to rest");
};

const editDraft = async (who, root, doc, body, format = "marquee") => {
    const got = await (await who(`api/identity/${root}/docs/${doc}`)).json();
    const r = await j(who, `api/identity/${root}/docs/${doc}`, { title: got.title, body, parents: got.heads.map((h) => h.version), format }, "PUT");
    assert.equal(r.status, 200, await r.text());
};

const feedRowOf = async (who, root, docId) =>
    ((await (await who(`api/identity/${root}/feed`)).json()).items || []).find((i) => i.doc_id === docId);
const journalRowOf = async (host, readerRoot, docId) =>
    (await sql(`SELECT trusted_only, format FROM feed_journal WHERE reader_root = '${readerRoot}' AND doc_id = '${docId}'`, host)).rows[0];

/// The book machinery, per persona and bucket.
const bookOf = (who, root, bucket) => ({
    plan: async () => {
        const r = await (await who(`api/identity/${root}/private/kv/book_rollout`)).json();
        const row = (r.values || []).find((v) => v.key === bucket);
        return row ? JSON.parse(row.value) : null;
    },
    rollout: async function (flags = {}) {
        const asked = await j(who, `api/identity/${root}/books/${bucket}/rollout`, flags);
        assert.equal(asked.status, 200, await asked.text());
        let p = null;
        for (let i = 0; i < 120; i++) {
            await beat(undefined, "book-rollout", root);
            p = await this.plan();
            if (p && (p.status === "done" || p.status === "failed")) break;
            await sleep(500);
        }
        assert.ok(p && p.status === "done", `the rollout came to rest: ${JSON.stringify(p)}`);
        return p;
    },
    payload: async (bookId) => JSON.parse(await (await who(`id/${root}/docs/${bookId}/body`)).text()),
    file: async (doc) => who(`api/identity/${root}/docs/${doc}/buckets/${bucket}`, { method: "PUT" }),
    mode: (on) => j(who, `api/identity/${root}/private/kv/books/${bucket}`, { value: JSON.stringify({ mode: on ? "book" : "" }) }, "PUT"),
    hide: (doc) => j(who, `api/identity/${root}/private/kv/book_hidden/doc:${doc}`, { value: "yes" }, "PUT"),
});

const mkDoc = async (who, root, title, body, tags = []) => {
    const d = await (await j(who, `api/identity/${root}/docs`, { title, body, format: "marquee" })).json();
    for (const t of tags) await who(`api/identity/${root}/docs/${d.doc_id}/annotations/tags/${t}`, { method: "PUT" });
    return d.doc_id;
};

const taxonomy = async (who, root, title) => (await (await j(who, `api/identity/${root}/taxonomies`, { title })).json()).taxonomy_id;
const member = (who, root, parent, child) => j(who, `api/identity/${root}/taxonomies/${parent}/members/${child}`, {}, "PUT");

/// ada publishes trust for a reader and MEETS them - the ceremony the app cannot skip
/// (trust is dialed from a profile page), which puts the reader's chains where the
/// key-release check can resolve their serving record.
const trustAndMeet = async (ada, adaRoot, other, otherRoot) => {
    await dial(ada, adaRoot, otherRoot, "trust", "high");
    await beat(undefined, "mint", adaRoot);
    await ada(`api/id/${otherRoot}/profile?via=${await base58(other)}`);
    await pullAndFold(undefined, otherRoot);
};

(HOST_B && HOST_C && HOST_E ? describe : describe.skip)(
    "combinations 1: a trusted-only book with a video title page, tags, two hops of shares, an update, and a takedown",
    function () {
        this.timeout(900000);

        const bucket = "bestiary";
        let ada, adaRoot, bea, beaRoot, cal, calRoot, eve, eveRoot, dana, grimoire;
        let media, squirrelsDoc, chapterDoc, book, squirrelPost, chapterPost, twin, update;

        before(async function () {
            ({ who: ada, root: adaRoot } = await persona("comboada"));
            ({ who: bea, root: beaRoot } = await persona("combobea", HOST_B));
            ({ who: cal, root: calRoot } = await persona("combocal", HOST_C));
            ({ who: eve, root: eveRoot } = await persona("comboeve", HOST_E));
            dana = await makeUserFetch({ prefix: "combodana" });
            grimoire = bookOf(ada, adaRoot, bucket);
            // The video: an opaque animation the ingest turns into a silent WebM loop.
            media = await ingest(ada, adaRoot, "squirrel", fs.readFileSync(SQUIRREL));
            // The notebook: a title page carrying the video, a chapter in a section, a hidden page.
            squirrelsDoc = await mkDoc(ada, adaRoot, "on squirrels", `look at it go\n\n![squirrel](/api/identity/${adaRoot}/docs/${media}/body/squirrel.webm)`, ["video"]);
            chapterDoc = await mkDoc(ada, adaRoot, "chapter one", "the first words", ["alpha"]);
            const hidden = await mkDoc(ada, adaRoot, "the secret page", "never published", ["secret"]);
            for (const d of [squirrelsDoc, chapterDoc, hidden]) await grimoire.file(d);
            const root = await taxonomy(ada, adaRoot, `wiki:${bucket}`);
            const part = await taxonomy(ada, adaRoot, "part one");
            await member(ada, adaRoot, root, squirrelsDoc);
            await member(ada, adaRoot, root, part);
            await member(ada, adaRoot, part, chapterDoc);
            await member(ada, adaRoot, root, hidden);
            await grimoire.mode(true);
            await grimoire.hide(hidden);
            // The graph: bea follows ada and is trusted; cal follows bea for shares only; eve
            // follows cal for shares only. Neither cal nor eve has heard of ada.
            const viaAda = await base58(ada);
            if ((await bea(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
            await dial(bea, beaRoot, adaRoot, "interest", "high");
            await trustAndMeet(ada, adaRoot, bea, beaRoot);
            if ((await cal(`api/id/${beaRoot}/profile?via=${await base58(bea)}`)).status !== 200) this.skip();
            await dial(cal, calRoot, beaRoot, "interest_rebroadcasts", "high");
            if ((await eve(`api/id/${calRoot}/profile?via=${await base58(cal)}`)).status !== 200) this.skip();
            await dial(eve, eveRoot, calRoot, "interest_rebroadcasts", "high");
            await beat(HOST_B, "fold", beaRoot);
            await beat(HOST_C, "fold", calRoot);
            await beat(HOST_E, "fold", eveRoot);
        });

        it("[book x trusted x video x tags] the rollout mints a sealed book: the book, both pages and the video twin wear the seal; the tags union", async () => {
            const p = await grimoire.rollout({ trusted_only: true });
            assert.equal(p.total, 2, "two pages, the hidden one never counted");
            book = p.book;
            const shelf = (await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || [];
            assert.deepEqual(shelf.map((x) => `${x.format}:${x.title}`), ["book:on squirrels"], "one book on the shelf, titled by its title page");
            const head = await (await dana(`api/id/${adaRoot}/posts/${book}`)).json();
            assert.equal(head.trusted_only, true, "the book wears the seal");
            assert.equal(head.title, "on squirrels", "the title is the public face");
            const tags = (head.annotations || []).filter((a) => a.key === "tag").map((a) => a.value).sort();
            assert.deepEqual(tags, ["alpha", "video"], "the union of the published pages' tags, never the hidden page's");
            const body = await grimoire.payload(book);
            assert.deepEqual(body.pages.map((x) => x.title), ["on squirrels"]);
            assert.deepEqual(body.sections.map((s) => s.title), ["part one"]);
            squirrelPost = body.pages[0].post;
            chapterPost = body.sections[0].pages[0].post;
            for (const post of [squirrelPost, chapterPost]) {
                const h = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
                assert.equal(h.trusted_only, true, "a page wears the seal too");
                assert.equal(h.part_of, book, "and names its book");
            }
            const squirrel = await (await ada(`api/id/${adaRoot}/posts/${squirrelPost}`)).json();
            twin = (squirrel.refs || [])[0];
            assert.ok(twin, "the video page's header names a twin");
            const own = await ada(`id/${adaRoot}/docs/${twin}/body`);
            assert.equal(own.status, 200, await own.clone().text());
            assert.equal(own.headers.get("content-type"), "video/webm");
            const words = await (await ada(`id/${adaRoot}/docs/${squirrelPost}/body`)).text();
            assert.ok(words.includes(`/docs/${twin}/body/media-loop.webm`), `the page names the twin as a silent loop: ${words}`);
            // A stranger: the tree, the words, the video and its poster all refuse.
            assert.equal((await dana(`id/${adaRoot}/docs/${book}/body`)).status, 403, "the table of contents is sealed");
            assert.equal((await dana(`id/${adaRoot}/docs/${squirrelPost}/body`)).status, 403, "the page is sealed");
            assert.equal((await dana(`id/${adaRoot}/docs/${twin}/body`)).status, 403, "the video is sealed");
            assert.equal((await dana(`id/${adaRoot}/docs/${twin}/thumb`)).status, 403, "and so is its poster");
        });

        it("[book x trusted x follow] the trusted follower's feed shows one book and no pages, and the tree, a page and the video all open for her", async () => {
            let items = [];
            for (let i = 0; i < 30 && !items.some((it) => it.doc_id === book); i++) {
                await pullAndFold(HOST_B, adaRoot);
                items = ((await (await bea(`api/identity/${beaRoot}/feed`)).json()).items || []).filter((it) => it.author === adaRoot);
                if (!items.some((it) => it.doc_id === book)) await sleep(300);
            }
            assert.deepEqual(items.map((it) => `${it.format}:${it.title}:${it.trusted_only}`), ["book:on squirrels:true"], "one sealed book, no pages");
            const tree = await opens(bea, `id/${adaRoot}/docs/${book}/body`);
            assert.ok(tree, "the key lane opened the table of contents");
            assert.equal(JSON.parse(await tree.text()).title, "on squirrels");
            const page = await opens(bea, `id/${adaRoot}/docs/${chapterPost}/body`);
            assert.ok(page, "a page opens from the book");
            assert.equal(await page.text(), "the first words");
            const video = await opens(bea, `id/${adaRoot}/docs/${twin}/body`);
            assert.ok(video, "the video opens for the trusted");
            assert.equal(video.headers.get("content-type"), "video/webm");
            assert.equal((await bea(`id/${adaRoot}/docs/${twin}/thumb`)).status, 200, "poster too");
        });

        it("[book x trusted x rebroadcast] hop 1: the share journals the sealed book, flag intact; the relay's feed shows nothing and the tree refuses him", async () => {
            const shared = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: book });
            assert.equal(shared.status, 200, await shared.text());
            let jrow = null;
            for (let i = 0; i < 30 && !jrow; i++) {
                await shareArrives(HOST_C, beaRoot, adaRoot);
                jrow = await journalRowOf(HOST_C, calRoot, book);
            }
            assert.ok(jrow, "the pointer reached cal's journal");
            assert.equal(jrow.trusted_only, 1, "wearing the seal");
            assert.equal(await feedRowOf(cal, calRoot, book), undefined, "the feed shows cal nothing he cannot open");
            assert.notEqual((await cal(`id/${adaRoot}/docs/${book}/body`)).status, 200, "the tree is sealed against him");
            assert.notEqual((await cal(`id/${adaRoot}/docs/${twin}/body`)).status, 200, "and so is the video");
        });

        it("[book x trusted x rebroadcast x video] hop 2: the relay relays what it cannot read; trust reveals the book two hops out, tree, page and video", async () => {
            const onward = await j(cal, `api/identity/${calRoot}/rebroadcasts`, { author: adaRoot, doc_id: book });
            assert.equal(onward.status, 200, await onward.text());
            let jrow = null;
            for (let i = 0; i < 30 && !jrow; i++) {
                await shareArrives(HOST_E, calRoot, adaRoot);
                jrow = await journalRowOf(HOST_E, eveRoot, book);
            }
            assert.ok(jrow, "the pointer crossed a second hop");
            assert.equal(jrow.trusted_only, 1, "flag intact through the relay");
            assert.equal(await feedRowOf(eve, eveRoot, book), undefined, "hidden from eve while untrusted");
            // ada trusts eve; eve meets ada so her node can ask for the key.
            await trustAndMeet(ada, adaRoot, eve, eveRoot);
            await eve(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
            await pullAndFold(HOST_E, adaRoot);
            let row = null;
            for (let i = 0; i < 40 && !row; i++) {
                row = await feedRowOf(eve, eveRoot, book);
                if (!row) await sleep(400);
            }
            assert.ok(row, "the row appears the moment trust does");
            assert.equal(row.format, "book");
            assert.equal(row.trusted_only, true);
            const tree = await opens(eve, `id/${adaRoot}/docs/${book}/body`);
            assert.ok(tree, "trust opens the table of contents two hops out");
            const body = JSON.parse(await tree.text());
            assert.equal(body.title, "on squirrels");
            const page = await opens(eve, `id/${adaRoot}/docs/${body.sections[0].pages[0].post}/body`);
            assert.ok(page, "a page of a book that arrived by share opens for the trusted");
            assert.equal(await page.text(), "the first words");
            const video = await opens(eve, `id/${adaRoot}/docs/${twin}/body`);
            assert.ok(video, "the sealed video opens two hops out");
            assert.equal(video.headers.get("content-type"), "video/webm");
            assert.equal(await feedRowOf(cal, calRoot, book), undefined, "the relay in the middle still sees nothing");
            assert.notEqual((await cal(`id/${adaRoot}/docs/${book}/body`)).status, 200, "and still cannot read what it carried");
        });

        it("[book x trusted x update] a second rollout re-says a changed page under the same seal, and the update post is sealed and threaded", async () => {
            await editDraft(ada, adaRoot, chapterDoc, "the first words, revised");
            const p = await grimoire.rollout({ trusted_only: true });
            assert.equal(p.changed, 1, `one changed page: ${JSON.stringify(p)}`);
            assert.equal(p.removed, 0);
            assert.ok(p.update, "an update post was minted");
            update = p.update;
            const head = await (await dana(`api/id/${adaRoot}/posts/${update}`)).json();
            assert.equal(head.trusted_only, true, "the update wears the seal");
            assert.ok(head.reply_to && head.reply_to.doc_id === book, "threaded under the book");
            assert.equal((await dana(`id/${adaRoot}/docs/${update}/body`)).status, 403, "its words refuse a stranger");
            assert.equal((await dana(`id/${adaRoot}/docs/${chapterPost}/body`)).status, 403, "the re-said page still refuses a stranger");
            let words = null;
            for (let i = 0; i < 40 && words !== "the first words, revised"; i++) {
                await pullAndFold(HOST_B, adaRoot);
                const r = await bea(`id/${adaRoot}/docs/${chapterPost}/body`);
                if (r.status === 200) words = await r.text();
                if (words !== "the first words, revised") await sleep(400);
            }
            assert.equal(words, "the first words, revised", "the trusted follower reads the new words under the same key");
            const row = await feedRowOf(bea, beaRoot, update);
            assert.ok(row && row.trusted_only === true, "the follower's feed carries the sealed update");
        });

        it("[book x trusted x video x takedown x rebroadcast] the takedown takes the book, the pages, the update and the video, and follows the shares to the far end", async () => {
            const took = await ada(`api/identity/${adaRoot}/books/${bucket}`, { method: "DELETE" });
            const text = await took.text();
            assert.equal(took.status, 200, text);
            assert.deepEqual(JSON.parse(text), { pages: 2, updates: 1, book: true });
            for (const gone of [book, squirrelPost, chapterPost, update]) {
                assert.equal((await ada(`api/id/${adaRoot}/posts/${gone}`)).status, 404, `${gone} is gone`);
            }
            assert.notEqual((await ada(`id/${adaRoot}/docs/${twin}/body`)).status, 200, "the video twin goes with its page");
            assert.notEqual((await bea(`id/${adaRoot}/docs/${twin}/body`)).status, 200, "for the trusted reader too");
            // The follower's feed, then the share tree, hear it.
            let stillThere = true;
            for (let i = 0; i < 20 && stillThere; i++) {
                await pullAndFold(HOST_B, adaRoot);
                await beat(HOST_C, "fragment-sweep", adaRoot);
                await beat(HOST_E, "fragment-sweep", adaRoot);
                stillThere = !!(await feedRowOf(bea, beaRoot, book)) || !!(await feedRowOf(bea, beaRoot, update)) || !!(await journalRowOf(HOST_E, eveRoot, book));
                if (stillThere) await sleep(400);
            }
            assert.equal(await feedRowOf(bea, beaRoot, book), undefined, "the follower's feed drops the book");
            assert.equal(await feedRowOf(bea, beaRoot, update), undefined, "and the update");
            assert.equal(await journalRowOf(HOST_E, eveRoot, book), undefined, "the takedown reached the second hop's journal");
            assert.notEqual((await eve(`id/${adaRoot}/docs/${book}/body`)).status, 200, "and the tree no longer serves there");
            const docs = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs;
            assert.ok(docs.filter((d) => d.buckets && d.buckets.includes(bucket)).every((d) => !d.fields.published_as), "every note is a draft again");
        });
    }
);

describe("combinations 2: a scheduled post that is settled, trusted-only and carries a picture, edited before its day, then taken down", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, dana, media, draft, at, post, twin;

    const shelf = async () => ((await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || []);
    const ringDue = (atMs) => ada("test/beat", { method: "POST", body: JSON.stringify({ pass: "publish-due", root: adaRoot, at_ms: atMs }) });

    before(async () => {
        ({ who: ada, root: adaRoot } = await persona("combo2ada"));
        ({ who: bea, root: beaRoot } = await persona("combo2bea"));
        dana = await makeUserFetch({ prefix: "combo2dana" });
        await dial(bea, beaRoot, adaRoot, "interest", "high");
        await beat(undefined, "fold", beaRoot);
        await trustAndMeet(ada, adaRoot, bea, beaRoot);
        media = await ingest(ada, adaRoot, "plate", makePng(48, 48), 60);
    });

    it("[scheduled x settled x trusted x picture] a future date with every wish on schedules, and nothing touches the public lane", async () => {
        draft = await mkDoc(ada, adaRoot, "for my people, later", `first words\n\n![p](/api/identity/${adaRoot}/docs/${media}/body/p.avif)`);
        await j(ada, `api/identity/${adaRoot}/docs/${draft}/annotations/fields/display_date`, { value: "2031-01-01" }, "PUT");
        const answer = await publishRiding(ada, adaRoot, draft, { settled: true, trusted_only: true });
        assert.ok(!answer.post_id, "nothing minted");
        assert.ok(answer.scheduled_for > Date.now(), "scheduled for a moment ahead");
        at = answer.scheduled_for;
        assert.deepEqual(await shelf(), [], "nothing public");
        await ringDue(undefined);
        assert.deepEqual(await shelf(), [], "the sweep leaves it alone before its day");
    });

    it("[scheduled x edit] an edit before the day is what the sweep mints - with every wish and the picture intact", async () => {
        await editDraft(ada, adaRoot, draft, `edited words\n\n![p](/api/identity/${adaRoot}/docs/${media}/body/p.avif)`);
        let minted = [];
        for (let i = 0; i < 30 && !minted.length; i++) {
            assert.equal((await ringDue(at + 1000)).status, 200);
            minted = (await shelf()).filter((p) => p.title === "for my people, later");
            if (!minted.length) await sleep(400);
        }
        assert.equal(minted.length, 1, "minted once the day came");
        post = minted[0].doc_id;
        assert.equal(minted[0].published_ms, at, "under its scheduled moment");
        assert.equal((await ringDue(at + 2000)).status, 200);
        assert.equal((await shelf()).length, 1, "never twice");
        const head = await (await dana(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.settled, true, "the settled wish rode the schedule");
        assert.equal(head.trusted_only, true, "and the seal");
        twin = (head.refs || [])[0];
        assert.ok(twin, "the header names the picture's twin");
        const own = await (await ada(`id/${adaRoot}/docs/${post}/body`)).text();
        assert.match(own, /^edited words/, "the words minted are the edited ones");
        assert.ok(own.includes(`/docs/${twin}/body/`), "and they name the twin");
        const beaWords = await opens(bea, `id/${adaRoot}/docs/${post}/body`);
        assert.ok(beaWords, "the trusted reader gets the words");
        assert.match(await beaWords.text(), /^edited words/);
        const beaPic = await opens(bea, `id/${adaRoot}/docs/${twin}/body`);
        assert.ok(beaPic, "and the picture");
        assert.equal(beaPic.headers.get("content-type"), "image/avif");
        assert.equal((await dana(`id/${adaRoot}/docs/${post}/body`)).status, 403, "a stranger gets the door");
        assert.equal((await dana(`id/${adaRoot}/docs/${twin}/body`)).status, 403, "for the picture too");
        assert.equal((await dana(`id/${adaRoot}/docs/${twin}/thumb`)).status, 403, "and its thumbnail");
    });

    it("[settled x trusted x feed] the trusted follower's feed row wears both wishes; a reply and a share are refused with the word", async () => {
        let row = null;
        for (let i = 0; i < 30 && !row; i++) {
            await pullAndFold(undefined, adaRoot);
            row = await feedRowOf(bea, beaRoot, post);
            if (!row) await sleep(300);
        }
        assert.ok(row, "the sealed post reaches the trusted follower's feed");
        assert.equal(row.trusted_only, true);
        assert.equal(row.settled, true);
        assert.equal(row.published_ms, at, "dated to its scheduled moment");
        const reply = await mkDoc(bea, beaRoot, "", "but actually");
        const no = await j(bea, `api/identity/${beaRoot}/docs/${reply}/publish`, { reply_to: { author: adaRoot, doc_id: post } });
        const noText = await no.text();
        assert.equal(no.status, 400, noText);
        assert.match(noText, /settled/, "the reply refusal has the word");
        const share = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: post });
        const shareText = await share.text();
        assert.equal(share.status, 400, shareText);
        assert.match(shareText, /settled/, "the share refusal has the word");
    });

    it("[takedown x trusted x picture] the takedown takes the sealed picture with the words, and the note is a draft again", async () => {
        const down = await ada(`api/identity/${adaRoot}/posts/${post}`, { method: "DELETE" });
        assert.equal(down.status, 200, await down.text());
        assert.equal((await ada(`api/id/${adaRoot}/posts/${post}`)).status, 404, "the post is gone");
        assert.notEqual((await ada(`id/${adaRoot}/docs/${twin}/body`)).status, 200, "the picture twin goes with it");
        assert.notEqual((await bea(`id/${adaRoot}/docs/${twin}/body`)).status, 200, "for the trusted reader too");
        assert.equal(await feedRowOf(bea, beaRoot, post), undefined, "the follower's feed drops it");
        const docs = (await (await ada(`api/identity/${adaRoot}/docs`)).json()).docs;
        assert.ok(!docs.find((d) => d.doc_id === draft).fields.published_as, "the note is a draft again");
    });
});

describe("combinations 3: a page that was a sealed post of its own before its notebook rolled out as an open book", function () {
    this.timeout(600000);

    const bucket = "mixed";
    let ada, adaRoot, bea, beaRoot, dana, mixed, sealedDoc, openDoc, standalone, book;

    before(async () => {
        ({ who: ada, root: adaRoot } = await persona("combo3ada"));
        ({ who: bea, root: beaRoot } = await persona("combo3bea"));
        dana = await makeUserFetch({ prefix: "combo3dana" });
        await trustAndMeet(ada, adaRoot, bea, beaRoot);
        mixed = bookOf(ada, adaRoot, bucket);
        openDoc = await mkDoc(ada, adaRoot, "the open chapter", "loud chapter words", ["loud"]);
        sealedDoc = await mkDoc(ada, adaRoot, "the sealed chapter", "quiet chapter words", ["quiet"]);
        for (const d of [openDoc, sealedDoc]) await mixed.file(d);
        const root = await taxonomy(ada, adaRoot, `wiki:${bucket}`);
        await member(ada, adaRoot, root, openDoc);
        await member(ada, adaRoot, root, sealedDoc);
    });

    it("[trusted x publish] the chapter stands as a sealed post of its own first", async () => {
        standalone = (await publishRiding(ada, adaRoot, sealedDoc, { trusted_only: true })).post_id;
        assert.ok(standalone);
        const head = await (await dana(`api/id/${adaRoot}/posts/${standalone}`)).json();
        assert.equal(head.trusted_only, true);
        assert.equal(head.part_of, undefined, "no book yet");
        assert.deepEqual(((await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || []).map((p) => `${p.format}:${p.title}`), ["marquee:the sealed chapter"]);
    });

    it("[book x publish] the open rollout adopts the standing post as a page: same id, now part of the book, off the shelf; the tags union", async () => {
        await mixed.mode(true);
        const p = await mixed.rollout({});
        assert.equal(p.total, 2);
        book = p.book;
        const body = await mixed.payload(book);
        assert.deepEqual(body.pages.map((x) => x.title), ["the open chapter", "the sealed chapter"]);
        assert.equal(body.pages[1].post, standalone, "the sealed chapter keeps its id");
        const head = await (await dana(`api/id/${adaRoot}/posts/${standalone}`)).json();
        assert.equal(head.part_of, book, "and now names its book");
        const shelf = ((await (await ada(`api/id/${adaRoot}/posts`)).json()).posts || []).map((x) => `${x.format}:${x.title}`);
        assert.deepEqual(shelf, ["book:the open chapter"], "the adopted post left the shelf as a standalone");
        const bookHead = await (await dana(`api/id/${adaRoot}/posts/${book}`)).json();
        assert.ok(!bookHead.trusted_only, "the book is open");
        const tags = (bookHead.annotations || []).filter((a) => a.key === "tag").map((a) => a.value).sort();
        assert.deepEqual(tags, ["loud", "quiet"]);
    });

    it("[book x trusted] the book is open but the adopted page stays sealed: once sealed, always sealed", async () => {
        assert.equal((await dana(`id/${adaRoot}/docs/${book}/body`)).status, 200, "a stranger reads the table of contents");
        const loud = await dana(`id/${adaRoot}/docs/${(await mixed.payload(book)).pages[0].post}/body`);
        assert.equal(loud.status, 200);
        assert.equal(await loud.text(), "loud chapter words", "and the open page");
        const head = await (await dana(`api/id/${adaRoot}/posts/${standalone}`)).json();
        assert.equal(head.trusted_only, true, "the adopted page still wears its seal");
        assert.equal((await dana(`id/${adaRoot}/docs/${standalone}/body`)).status, 403, "and refuses the stranger");
        const quiet = await opens(bea, `id/${adaRoot}/docs/${standalone}/body`);
        assert.ok(quiet, "the trusted reader still opens it");
        assert.equal(await quiet.text(), "quiet chapter words");
    });
});
