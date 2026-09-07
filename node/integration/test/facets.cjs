/*
    Facets (2026-09-07): every bucket and every tag across the whole journal and the whole
    held shelf, counted by the node, buckets first, most frequent first; picking narrows the
    listing - buckets widen among themselves, tags each narrow - and the words narrow what
    survives. A sealed post's labels stay out of a viewer's counts when they may not see it.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { pullAndFold } = require("./beat.cjs");
const { HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B ? describe : describe.skip)("facets: buckets and tags over the whole set, and the narrowing", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, a1, a2, a3, sealed;
    const ids = (page) => (page.items || page.posts || []).map((p) => p.doc_id).sort();
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
        await post("Plain", "filed nowhere in particular", "feed", []); // the automatic bucket
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
        assert.deepEqual(f.tags.slice(0, 1), [{ value: "bread", count: 2 }], "the most frequent tag leads");
        assert.deepEqual(f.tags.slice(1).map((x) => x.value), ["bikes", "pudding", "slow"], "then by name");
    });

    it("picking narrows: a bucket, a tag, two buckets widen, two tags narrow, and the words narrow the rest", async () => {
        const feed = (qs) => ada(`api/identity/${adaRoot}/feed?${qs}`).then((r) => r.json());
        assert.deepEqual(ids(await feed("bucket=outings")), [a2]);
        assert.deepEqual(ids(await feed("tag=bread")), [a1, a3].sort());
        assert.deepEqual(ids(await feed("bucket=outings&bucket=recipes")), [a1, a2, a3, sealed].sort(), "either bucket");
        assert.deepEqual(ids(await feed("tag=bread&tag=slow")), [a1], "every tag");
        assert.deepEqual(ids(await feed("tag=bread&q=boiled")), [a3], "the words narrow the tagged");
        assert.deepEqual(ids(await feed("bucket=recipes&tag=bikes")), [], "a bucket and a tag that never meet");
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
});
