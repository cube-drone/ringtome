/*
    Document bucketing: which project(s)/notebook(s) a document lives in. The tag mechanism in
    its own namespace - so buckets never mingle with tags, and buckets are the axis search and
    tags are scoped to. Membership is an unordered LWW-element-set (add/remove, unions on
    concurrent add); the roster is the distinct names in use.
*/
const assert = require("node:assert");
const { makeUserFetch } = require("./helpers.cjs");

async function makeIdentity(prefix) {
    const user = await makeUserFetch({ prefix });
    const created = await (await user("api/identity", { method: "POST" })).json();
    return { user, root: created.root_pubkey };
}

async function createDoc(fetch, root, title, body) {
    const res = await fetch(`api/identity/${root}/docs`, {
        method: "POST",
        body: JSON.stringify({ title, body }),
    });
    assert.equal(res.status, 200);
    return res.json();
}

const listDocs = (fetch, root) => fetch(`api/identity/${root}/docs`).then((r) => r.json());

const putBucket = (fetch, root, docId, bucket) =>
    fetch(`api/identity/${root}/docs/${docId}/buckets/${encodeURIComponent(bucket)}`, {
        method: "PUT",
    });

const deleteBucket = (fetch, root, docId, bucket) =>
    fetch(`api/identity/${root}/docs/${docId}/buckets/${encodeURIComponent(bucket)}`, {
        method: "DELETE",
    });

async function roster(fetch, root) {
    const res = await fetch(`api/identity/${root}/buckets`);
    assert.equal(res.status, 200);
    return res.json();
}

async function bucketed(fetch, root, bucket) {
    const res = await fetch(`api/identity/${root}/docs/bucketed/${encodeURIComponent(bucket)}`);
    assert.equal(res.status, 200);
    return res.json();
}

describe("buckets: which notebook a document lives in", function () {
    this.timeout(30000);

    it("places a doc in buckets, joins them onto the list row, and rosters them", async () => {
        const { user, root } = await makeIdentity("buckets");
        const pier = await createDoc(user, root, "pier", "a sunset");
        const cake = await createDoc(user, root, "cake", "a recipe");

        await putBucket(user, root, cake.doc_id, "recipes");
        await putBucket(user, root, pier.doc_id, "journal");
        await putBucket(user, root, cake.doc_id, "favorites");

        const list = await listDocs(user, root);
        const cakeRow = list.docs.find((d) => d.doc_id === cake.doc_id);
        assert.deepEqual(cakeRow.buckets, ["favorites", "recipes"], "buckets joined + sorted");
        const pierRow = list.docs.find((d) => d.doc_id === pier.doc_id);
        assert.deepEqual(pierRow.buckets, ["journal"]);

        const r = await roster(user, root);
        const byName = Object.fromEntries(r.buckets.map((b) => [b.name, b.docs]));
        assert.deepEqual(byName, { favorites: 1, journal: 1, recipes: 1 });
    });

    it("lists docs in a bucket, and removing takes them out", async () => {
        const { user, root } = await makeIdentity("bucketsdocs");
        const a = await createDoc(user, root, "a", "x");
        const b = await createDoc(user, root, "b", "y");
        await putBucket(user, root, a.doc_id, "recipes");
        await putBucket(user, root, b.doc_id, "recipes");

        let inBucket = await bucketed(user, root, "recipes");
        assert.equal(inBucket.docs.length, 2, "both docs in the bucket");

        assert.equal((await deleteBucket(user, root, a.doc_id, "recipes")).status, 200);
        inBucket = await bucketed(user, root, "recipes");
        assert.deepEqual(
            inBucket.docs.map((d) => d.doc_id),
            [b.doc_id],
            "the removed doc is gone from the bucket"
        );
    });

    it("keeps buckets and tags in separate namespaces (same name, no collision)", async () => {
        const { user, root } = await makeIdentity("bucketsep");
        const doc = await createDoc(user, root, "doc", "z");
        // The same word as both a bucket and a tag must not cross-contaminate.
        await putBucket(user, root, doc.doc_id, "recipes");
        await user(`api/identity/${root}/docs/${doc.doc_id}/annotations/tags/recipes`, {
            method: "PUT",
        });

        const list = await listDocs(user, root);
        const row = list.docs.find((d) => d.doc_id === doc.doc_id);
        assert.deepEqual(row.buckets, ["recipes"], "bucket axis");
        assert.deepEqual(row.tags, ["recipes"], "tag axis, kept separate");

        // docs_by_bucket resolves to the bucket namespace only, never the like-named tag.
        const inBucket = await bucketed(user, root, "recipes");
        assert.equal(inBucket.docs.length, 1);
        assert.equal(inBucket.docs[0].doc_id, doc.doc_id);
    });

    it("rejects an empty bucket name", async () => {
        const { user, root } = await makeIdentity("bucketbad");
        const doc = await createDoc(user, root, "doc", "z");
        assert.equal((await putBucket(user, root, doc.doc_id, "   ")).status, 400);
    });
});
