/*
    Facets (2026-09-07): every bucket and every tag across the whole journal and the whole
    held shelf, counted by the node, buckets first, most frequent first; picking narrows the
    listing - every chip three-state since 2026-10-01: "only" picks in a row widen to either,
    "leave out" picks drop what carries them, the rows narrow together - and the words narrow
    what survives. A sealed post's labels stay out of a viewer's counts when they may not see it.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch, stated } = require("./helpers.cjs");
const { pullAndFold } = require("./beat.cjs");
const { HOST, HOST_B, sql } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("facets: buckets and tags over the whole set, and the narrowing", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, a1, a2, a3, sealed, plain;
    const ids = (page) => (page.items || page.posts || []).map((p) => p.doc_id).sort();
    // The tags people stated (helpers.cjs `stated`): these claims are about picking, and every post
    // here is also "micro" for being short.
    const post = async (title, body, bucket, tags, flags = {}) => {
        const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: "marquee" })).json();
        await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/buckets/${bucket}`, { method: "PUT" });
        for (const g of tags) await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/annotations/tags/${g}`, { method: "PUT" });
        const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, flags);
        const said = await pub.text();
        assert.equal(pub.status, 200, said);
        return JSON.parse(said).post_id;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "facetada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        a1 = await post("Loaf", "a sourdough loaf", "recipes", ["bread", "slow"]);
        a2 = await post("Ride", "a canal ride", "outings", ["bikes"]);
        a3 = await post("Bagels", "boiled then baked", "recipes", ["bread"]);
        sealed = await post("Secret", "the sealed pudding", "recipes", ["pudding"], { trusted_only: true });
        plain = await post("Plain", "filed nowhere in particular", "feed", []); // the automatic bucket
        bea = await makeUserFetch({ prefix: "facetbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        await pullAndFold(HOST_B, adaRoot);
    });

    it("the author's own feed counts every bucket and tag, buckets first, most frequent first - and never the automatic bucket", async () => {
        const f = await (await ada(`api/identity/${adaRoot}/feed/labels`)).json();
        assert.deepEqual(f.buckets, [{ value: "recipes", count: 3 }, { value: "outings", count: 1 }], "'feed' says nothing and is not listed");
        assert.deepEqual(stated(f.tags).slice(0, 1), [{ value: "bread", count: 2 }], "the most frequent tag leads");
        assert.deepEqual(stated(f.tags).slice(1).map((x) => x.value), ["bikes", "pudding", "slow"], "then by name");
    });

    it("the kind row counts posts, replies, rebroadcasts and books, and narrows like the other rows", async () => {
        const f = await (await ada(`api/identity/${adaRoot}/feed/labels`)).json();
        assert.deepEqual(f.kinds, [{ value: "post", count: 5 }], "five plain posts, nothing else yet");
        const feed = (qs) => ada(`api/identity/${adaRoot}/feed?${qs}`).then((r) => r.json());
        assert.equal(ids(await feed("kind=post")).length, 5, "'posts' is every plain post");
        assert.deepEqual(ids(await feed("kind=reply")), [], "no replies");
        assert.deepEqual(ids(await feed("kind=book&kind=post")).length, 5, "two kinds widen");
        assert.deepEqual(ids(await feed("kind=post&tag=bikes")), [a2], "and the rows combine");
        const shelf = await (await ada(`api/id/${adaRoot}/labels?as=${adaRoot}`)).json();
        assert.deepEqual(shelf.kinds, [{ value: "post", count: 5 }], "the shelf counts the same");
    });

    it("picking narrows: a bucket, a tag, two of either widen, and the words narrow the rest", async () => {
        const feed = (qs) => ada(`api/identity/${adaRoot}/feed?${qs}`).then((r) => r.json());
        assert.deepEqual(ids(await feed("bucket=outings")), [a2]);
        assert.deepEqual(ids(await feed("tag=bread")), [a1, a3].sort());
        assert.deepEqual(ids(await feed("bucket=outings&bucket=recipes")), [a1, a2, a3, sealed].sort(), "either bucket");
        assert.deepEqual(ids(await feed("tag=slow&tag=bikes")), [a1, a2].sort(), "either tag, like every row (2026-10-01)");
        assert.deepEqual(ids(await feed("tag=bread&q=boiled")), [a3], "the words narrow the tagged");
        assert.deepEqual(ids(await feed("bucket=recipes&tag=bikes")), [], "a bucket and a tag that never meet");
    });

    it("leaving out drops what carries it, in every row, and an only less what's left out is both", async () => {
        // Curtis, 2026-10-01: a chip clicked twice "excludes items thusly tagged".
        const feed = (qs) => ada(`api/identity/${adaRoot}/feed?${qs}`).then((r) => r.json());
        assert.deepEqual(ids(await feed("not_tag=bread")), [a2, sealed, plain].sort(), "no bread");
        assert.deepEqual(ids(await feed("not_bucket=recipes")), [a2, plain].sort(), "no recipes");
        assert.deepEqual(ids(await feed("tag=bread&not_tag=slow")), [a3], "bread, but not slow bread");
        assert.deepEqual(ids(await feed("not_kind=post")), [], "every post here is a post");
        assert.deepEqual(ids(await feed("not_tag=bread&not_tag=bikes&bucket=recipes")), [sealed], "and the rows still combine");
    });

    it("picking thins the other rows; a row is never thinned by its own onlys, and its left-out chips keep their counts", async () => {
        // Curtis, 2026-09-27: pick "heph", and the other rows count what is left. 2026-10-01: a
        // second tag picked WIDENS, so the tag row counts as if it weren't - but leaving #slow out
        // takes its posts out of every other tag's count, and slow still shows how much it hides.
        const labels = (qs) => ada(`api/identity/${adaRoot}/feed/labels?${qs}`).then((r) => r.json());
        const byName = (row) => Object.fromEntries(stated(row).map((x) => [x.value, x.count]));
        const bread = await labels("tag=bread");
        assert.deepEqual(byName(bread.tags), { bread: 2, bikes: 1, pudding: 1, slow: 1 }, "every tag still: another would widen");
        assert.deepEqual(byName(bread.buckets), { recipes: 2 }, "only the notebooks holding bread");
        assert.deepEqual(byName(bread.kinds), { post: 2 });
        const noSlow = await labels("not_tag=slow");
        assert.deepEqual(byName(noSlow.tags), { bread: 1, bikes: 1, pudding: 1, slow: 1 }, "the loaf is out of bread's count; slow says what it leaves out");
        assert.deepEqual(byName(noSlow.buckets), { recipes: 2, outings: 1 }, "and out of the notebooks'");
        const outings = await labels("bucket=outings");
        assert.deepEqual(byName(outings.buckets), { recipes: 3, outings: 1 }, "a picked notebook keeps its siblings: another would widen");
        assert.deepEqual(byName(outings.tags), { bikes: 1 }, "but the tags are those in the picked notebook");
        const shelf = await (await ada(`api/id/${adaRoot}/labels?as=${adaRoot}&tag=bikes`)).json();
        assert.deepEqual([byName(shelf.tags).bikes, byName(shelf.buckets)], [1, { outings: 1 }], "a person's page thins alike");
    });

    it("me=0 leaves the reader's own posts out of the feed, a narrowed feed and the counts - and without it nothing changes", async () => {
        // The feed page's "me" chip, unpicked (Curtis, 2026-09-27). Ada's own feed is only her own posts.
        const get = (path) => ada(path).then((r) => r.json());
        assert.ok((await get(`api/identity/${adaRoot}/feed`)).items.length > 0, "her own posts, as ever, when not asked otherwise");
        assert.deepEqual((await get(`api/identity/${adaRoot}/feed?me=0`)).items, [], "the plain page");
        // The cursor branch has its own query and its own binds (fanout.rs feed_page) - page it.
        const cursor = `before_ms=${Date.now() + 60000}&before_doc=${"0".repeat(32)}`;
        const paged = await ada(`api/identity/${adaRoot}/feed?${cursor}&me=0`);
        assert.equal(paged.status, 200, await paged.clone().text());
        assert.deepEqual((await paged.json()).items, [], "a later page too");
        assert.ok((await get(`api/identity/${adaRoot}/feed?${cursor}`)).items.length > 0, "and a later page without it, hers");
        assert.deepEqual((await get(`api/identity/${adaRoot}/feed?tag=bread&me=0`)).items, [], "a narrowed page");
        assert.deepEqual(ids(await get(`api/identity/${adaRoot}/feed?tag=bread`)), [a1, a3].sort(), "and narrowed without it, hers");
        const counts = await get(`api/identity/${adaRoot}/feed/labels?me=0`);
        assert.deepEqual([counts.kinds, counts.buckets, counts.tags], [[], [], []], "nothing to count");
    });

    it("me=only is the reader's own posts and nothing else - the third state of the \"me\" chip (2026-10-01)", async () => {
        const get = (path) => ada(path).then((r) => r.json());
        assert.deepEqual(ids(await get(`api/identity/${adaRoot}/feed?me=only`)), [a1, a2, a3, sealed, plain].sort(), "all hers");
        assert.deepEqual(ids(await get(`api/identity/${adaRoot}/feed?tag=bread&me=only`)), [a1, a3].sort(), "narrowed, still hers");
        let theirs = null;
        for (let i = 0; i < 20; i++) {
            theirs = await bea(`api/identity/${beaRoot}/feed`).then((r) => r.json());
            if ((theirs.items || []).length) break;
            await wait(400);
        }
        assert.ok(theirs.items.length > 0, "bea's feed holds ada's posts");
        assert.deepEqual((await bea(`api/identity/${beaRoot}/feed?me=only`).then((r) => r.json())).items, [], "and only bea's own: none");
    });

    it("a person's page counts and narrows the whole held shelf, and a viewer they do not trust never sees the sealed post's labels", async () => {
        let f = null;
        for (let i = 0; i < 20; i++) {
            f = await (await bea(`api/id/${adaRoot}/labels?as=${beaRoot}`)).json();
            if ((f.buckets || []).length) break;
            await wait(400);
        }
        assert.deepEqual(f.buckets, [{ value: "recipes", count: 2 }, { value: "outings", count: 1 }], "the sealed post is not counted for bea");
        assert.ok(!f.tags.some((x) => x.value === "pudding"), "nor its tag");
        assert.deepEqual(ids(await (await bea(`api/id/${adaRoot}/posts?tag=bread&as=${beaRoot}`)).json()), [a1, a3].sort());
        const own = await (await ada(`api/id/${adaRoot}/labels?as=${adaRoot}`)).json();
        assert.equal(own.buckets[0].count, 3, "the author counts their own sealed post");
        assert.deepEqual(ids(await (await ada(`api/id/${adaRoot}/posts?tag=pudding&as=${adaRoot}`)).json()), [sealed]);
    });

    it("the selectivity dial narrows the lists and the search: at 'high interest only' a low-interest author's labels vanish, and return with the dial", async () => {
        // bea follows ada at 'high' (the setup): the strict stop keeps ada's labels.
        let f = await (await bea(`api/identity/${beaRoot}/feed/labels?stop=high`)).json();
        assert.ok((f.buckets || []).some((x) => x.value === "recipes"), `at 'high', a high-interest author counts: ${JSON.stringify(f.buckets)}`);
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "low" }, "PUT");
        f = await (await bea(`api/identity/${beaRoot}/feed/labels?stop=high`)).json();
        assert.deepEqual(f.buckets, [], "at 'high', a low-interest author's buckets are gone");
        assert.deepEqual(f.tags, [], "and their tags");
        assert.deepEqual(ids(await (await bea(`api/identity/${beaRoot}/feed?tag=bread&stop=high`)).json()), [], "the search narrows the same way");
        f = await (await bea(`api/identity/${beaRoot}/feed/labels`)).json();
        assert.ok((f.buckets || []).some((x) => x.value === "recipes"), "Explorer counts everything");
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        f = await (await bea(`api/identity/${beaRoot}/feed/labels?stop=high`)).json();
        assert.ok((f.buckets || []).some((x) => x.value === "recipes"), "and the dial back up brings them back");
    });

    it("a tag somebody else put on a post counts in the reader's feed, as the cards show it, once per post", async () => {
        const put = await bea(`api/identity/${beaRoot}/public-annotations/${adaRoot}/${a2}`, {
            method: "PUT",
            body: JSON.stringify({ key: "tag", value: "beef" }),
        });
        assert.equal(put.status, 200, await put.text());
        const f = await (await bea(`api/identity/${beaRoot}/feed/labels`)).json();
        assert.ok(f.tags.some((x) => x.value === "beef" && x.count === 1), `bea's own tag on ada's post counts: ${JSON.stringify(f.tags)}`);
        assert.deepEqual(ids(await (await bea(`api/identity/${beaRoot}/feed?tag=beef`)).json()), [a2], "and narrows to it");
    });

    it("the cloud counts a year of the feed however much is newer, moves the moment a label does, and leaves the lists unthinned for a pick past 1000 posts", async () => {
        // 2026-09-28 (PROJECT_PLAN's Scores and sort orders, *Shape*): the cloud used to count the
        // newest 5000 journal rows; it counts a year, kept an hour unless something moves.
        const labels = async (qs = "") => (await (await ada(`api/identity/${adaRoot}/feed/labels${qs ? `?${qs}` : ""}`)).json());
        const tagCount = (f, v) => ((f.tags || []).find((x) => x.value === v) || {}).count || 0;
        const dee = await makeUserFetch({ prefix: "facetdee" });
        const deeRoot = (await (await dee("api/identity", { method: "POST" })).json()).root_pubkey;
        assert.equal(tagCount(await labels(), "bread"), 2, "the cloud before: bread on two posts");
        // 8192 newer posts in ada's feed, each tagged "planted", laid in by doubling one row.
        const plant = (q) => sql(q, HOST);
        const PLANT = "abad1dea";
        await plant(
            `INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)
             VALUES ('${adaRoot}', '${adaRoot}', '${PLANT}', 'filler', 'marquee', 9000000000000, 9000000000000, 9000000000000)`
        );
        // Hex ids (a label read skips a malformed one), each doubling two more hex digits wide.
        for (let i = 0; i < 13; i++) {
            await plant(
                `INSERT INTO feed_journal (reader_root, author_root, doc_id, title, format, published_ms, updated_ms, arrived_ms)
                 SELECT reader_root, author_root, doc_id || '${i.toString(16).padStart(2, "0")}', title, format, published_ms + 1, updated_ms, arrived_ms
                 FROM feed_journal WHERE reader_root = '${adaRoot}' AND doc_id LIKE '${PLANT}%'`
            );
        }
        await plant(
            `INSERT INTO doc_annotations (target_author, target_doc, annotator, key, value, noted_ms)
             SELECT author_root, doc_id, author_root, 'tag', 'planted', 1 FROM feed_journal
             WHERE reader_root = '${adaRoot}' AND doc_id LIKE '${PLANT}%'`
        );
        try {
            // Planted behind the node's back, so the cached cloud has not heard. A label somebody
            // else says - on this node, so it lands in the memo without touching ada's own store,
            // whose change would move the cache by another road - is what moves it: at once, not
            // an hour later.
            const said = await dee(`api/identity/${deeRoot}/public-annotations/${adaRoot}/${a2}`, {
                method: "PUT",
                body: JSON.stringify({ key: "tag", value: "fresh" }),
            });
            assert.equal(said.status, 200, await said.text());
            const f = await labels();
            assert.equal(tagCount(f, "fresh"), 1, "the label just said is counted at once");
            assert.equal(tagCount(f, "planted"), 8192, "the planted tag, on every planted post");
            assert.equal(tagCount(f, "bread"), 2, "and bread still counts, from under 8192 newer posts");
            // A pick past 1000 posts leaves the lists as they are; a small pick still thins them -
            // the OTHER rows, since a row's own picks only widen it (2026-10-01).
            const big = await labels("tag=planted");
            assert.ok((big.buckets || []).some((x) => x.value === "outings"), `picking a tag on 8192 posts leaves outings listed: ${JSON.stringify(big.buckets)}`);
            const small = await labels("tag=bread");
            assert.ok(!(small.buckets || []).some((x) => x.value === "outings"), "picking bread still thins outings away");
            // The posts themselves (2026-09-28): a pick and a search find what lies under 8192
            // newer posts - off the labels' value index and the inverted index, not the newest 5000.
            const feed = (qs) => ada(`api/identity/${adaRoot}/feed?${qs}`).then((r) => r.json());
            assert.deepEqual(ids(await feed("tag=bread")), [a1, a3].sort(), "a pick finds the two bread posts beneath them");
            assert.deepEqual(ids(await feed("q=sourdough")), [a1], "and a word finds the loaf");
            assert.deepEqual(ids(await feed("tag=bread&q=boiled")), [a3], "the two together");
            const common = (await feed("tag=planted")).items || [];
            assert.equal(common.length, 100, "a pick on 8192 posts walks the feed newest first and stops at a page");
        } finally {
            await plant(`DELETE FROM doc_annotations WHERE target_author = '${adaRoot}' AND target_doc LIKE '${PLANT}%'`);
            await plant(`DELETE FROM post_terms WHERE doc_id LIKE '${PLANT}%'`);
            await plant(`DELETE FROM post_search WHERE doc_id LIKE '${PLANT}%'`);
            await plant(`DELETE FROM feed_journal WHERE reader_root = '${adaRoot}' AND doc_id LIKE '${PLANT}%'`);
            await dee(`api/identity/${deeRoot}/public-annotations/${adaRoot}/${a2}/tag/fresh`, { method: "DELETE" });
        }
    });
});
