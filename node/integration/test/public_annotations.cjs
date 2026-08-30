/*
    The annotations arc, slice 1 (ANNOTATIONS.md): the wire and the mint.

    A public annotation is a statement on the SPEAKER's chain - LWW per (target, key,
    value), one statement per tag, retracted by restating it absent. Publishing a draft
    restates every annotation it carries - tags, fields, and its bucket - about the fresh
    post, on the author's own chain (copy, don't flip: the draft keeps its private facts).
    The permalink read serves the author's own statements from the author's shelf, so a
    mirror-holding node answers too - which is the sync scope proven along the way.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { HOST_B } = require("./fetch.cjs");
const { makeUserFetch } = require("./helpers.cjs");
const { pullAndFold } = require("./beat.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

describe("public annotations: the wire and the mint", function () {
    this.timeout(600000);

    let ada, adaRoot, post, draft;

    const mine = async (doc) =>
        (await (await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${doc}`)).json())
            .items || [];

    before(async () => {
        ada = await makeUserFetch({ prefix: "annada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
    });

    it("publishing restates the draft's annotations - tags, fields, bucket - about the post", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "labelled", body: "the words", format: "plaintext" }),
            })
        ).json();
        draft = made.doc_id;
        for (const tag of ["mighty", "saucy"]) {
            await ada(`api/identity/${adaRoot}/docs/${draft}/annotations/tags/${tag}`, { method: "PUT" });
        }
        await ada(`api/identity/${adaRoot}/docs/${draft}/annotations/fields/description`, {
            method: "PUT",
            body: JSON.stringify({ value: "a post about sauce" }),
        });
        await ada(`api/identity/${adaRoot}/docs/${draft}/buckets/blog`, { method: "PUT" });
        const pub = await ada(`api/identity/${adaRoot}/docs/${draft}/publish`, { method: "POST" });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        post = JSON.parse(text).post_id;

        const said = await mine(post);
        const has = (k, v) => said.some((s) => s.key === k && s.value === v);
        assert.ok(has("tag", "mighty") && has("tag", "saucy"), "both tags, one statement each");
        assert.ok(has("description", "a post about sauce"), "the description");
        assert.ok(has("bucket", "blog"), "the bucket comes too - it is the label, not a leak");
    });

    it("a statement by hand joins the same chain, and a retraction restates it absent", async () => {
        const put = await ada(`api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}`, {
            method: "PUT",
            body: JSON.stringify({ key: "tag", value: "goopy" }),
        });
        assert.equal(put.status, 200, await put.text());
        assert.ok((await mine(post)).some((s) => s.key === "tag" && s.value === "goopy"));
        const del = await ada(
            `api/identity/${adaRoot}/public-annotations/${adaRoot}/${post}/tag/goopy`,
            { method: "DELETE" }
        );
        assert.equal(del.status, 200, await del.text());
        assert.ok(
            !(await mine(post)).some((s) => s.key === "tag" && s.value === "goopy"),
            "retracted: the present set no longer names it"
        );
        assert.ok(
            (await mine(post)).some((s) => s.key === "tag" && s.value === "mighty"),
            "and the others stand - LWW per statement, never per post"
        );
    });

    it("the permalink read carries the author's own statements", async () => {
        const head = await (await ada(`api/id/${adaRoot}/posts/${post}`)).json();
        const has = (k, v) => (head.annotations || []).some((a) => a.key === k && a.value === v);
        assert.ok(has("tag", "mighty") && has("bucket", "blog"), "labels on the post's own read");
    });

    it("the chain syncs like any public service - a mirror-holding node answers too", async function () {
        if (!HOST_B) this.skip();
        const bea = await makeUserFetch({ prefix: "annbea", host: HOST_B });
        const beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        const viaAda = await base58(ada);
        if ((await bea(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        await bea(`api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await pullAndFold(HOST_B, adaRoot);
        const head = await (await bea(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.ok(
            (head.annotations || []).some((a) => a.key === "tag" && a.value === "saucy"),
            "the annotations chain crossed the wire with the rest of the persona"
        );
    });
});
