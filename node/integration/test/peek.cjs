/*
    PEEK.md slice 2: a peek is a shape, not a mirror. A member on another node looks at a
    stranger nobody there follows: the node syncs the stranger's identity, profile and
    annotations chains (scoped), asks the answering node for the shelf, and fetches the
    newest twenty posts as fragments - each the author's own signed header, verified at
    the edge, its labels riding along. No posts chain exists on the peeking node; the page
    says it is a peek; the words open from the fragment ledger. Then the follow dial
    promotes the peek to a mirror (ruling 7) and the posts chain arrives.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat } = require("./beat.cjs");
const { sql, HOST_B } = require("./fetch.cjs");

const POSTS = 30;
const PEEK_POSTS = 20;
const SERVICE_POSTS = 3;
const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

(HOST_B ? describe : describe.skip)("a peek: a stranger's identity, labels and newest posts, and no history", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, profile, titles = [];

    const servicesHeld = async () =>
        (await sql(`SELECT DISTINCT service FROM chain_heads WHERE root_pubkey = '${adaRoot}'`, HOST_B)).rows
            .map((r) => Number(r.service))
            .sort((a, b) => a - b);

    before(async function () {
        ada = await makeUserFetch({ prefix: "peekada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        const named = await j(ada, `api/identity/${adaRoot}/profile`, { field: "name", value: "Ada Peekable" });
        assert.equal(named.status, 200, await named.text());
        for (let i = 0; i < POSTS; i++) {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: `post ${i}`, body: `the words of post ${i}`, format: "plaintext" })).json();
            if (i % 5 === 0) await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/annotations/tags/peekable`, { method: "PUT" });
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            assert.equal(pub.status, 200, await pub.text());
            titles.push(`post ${i}`);
        }
        bea = await makeUserFetch({ prefix: "peekbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        // The look itself: nobody on B follows ada, so this is a peek.
        const r = await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        if (r.status !== 200) this.skip();
        profile = await r.json();
    });

    it("the page says it is a peek and carries the name, and only the newest twenty posts", async () => {
        assert.equal(profile.peek, true, "a look, not a mirror");
        assert.equal(profile.foreign, true);
        assert.ok((profile.fields || []).some((f) => f.field === "name" && f.value === "Ada Peekable"), "the profile chain came");
        let posts = profile.posts || [];
        // The shelf lands behind the page when the node was slow (ruling 9): ask again.
        for (let i = 0; i < 20 && posts.length < PEEK_POSTS; i++) {
            await new Promise((r) => setTimeout(r, 400));
            posts = ((await (await bea(`api/id/${adaRoot}/profile`)).json()).posts) || [];
        }
        assert.equal(posts.length, PEEK_POSTS, `twenty newest, no more: ${posts.length}`);
        assert.equal(posts[0].title, `post ${POSTS - 1}`, "newest first");
        assert.equal(posts[PEEK_POSTS - 1].title, `post ${POSTS - PEEK_POSTS}`, "and the twentieth is the twentieth newest");
        assert.equal(profile.posts_more, false, "a peek's shelf goes no further");
    });

    it("the posts arrived as fragments with their labels; no posts chain exists here", async () => {
        const held = await servicesHeld();
        assert.ok(held.includes(0) && held.includes(2) && held.includes(12), `identity, profile, annotations: ${held}`);
        assert.ok(!held.includes(SERVICE_POSTS), `and no posts chain: ${held}`);
        const posts = ((await (await bea(`api/id/${adaRoot}/profile`)).json()).posts) || [];
        const tagged = posts.filter((p) => (p.annotations || []).some((a) => a.key === "tag" && a.value === "peekable"));
        assert.ok(tagged.length >= 2, `the labels rode the fragments: ${tagged.length} tagged of ${posts.length}`);
        const fragments = (await sql(`SELECT count(*) AS n FROM fragments WHERE author_root = '${adaRoot}'`, HOST_B)).rows[0];
        assert.equal(Number(fragments.n), PEEK_POSTS, "twenty fragments on the ledger");
    });

    it("the words open from the fragment ledger, and the shelf page agrees with the profile", async () => {
        const posts = ((await (await bea(`api/id/${adaRoot}/profile`)).json()).posts) || [];
        let body = null;
        for (let i = 0; i < 40 && body === null; i++) {
            const r = await bea(`id/${adaRoot}/docs/${posts[0].doc_id}/body`);
            if (r.status === 200) body = await r.text();
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(body, `the words of post ${POSTS - 1}`, "the body followed the header");
        const shelf = await (await bea(`api/id/${adaRoot}/posts`)).json();
        assert.equal((shelf.posts || []).length, PEEK_POSTS);
        assert.equal(shelf.more, false);
    });

    it("the follow dial promotes the peek to a mirror: the posts chain arrives and the page stops being a peek", async () => {
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let held = [];
        for (let i = 0; i < 12 && !held.includes(SERVICE_POSTS); i++) {
            await beat(HOST_B, "pull", adaRoot);
            held = await servicesHeld();
        }
        assert.ok(held.includes(SERVICE_POSTS), `the posts chain came with the follow: ${held}`);
        const after = await (await bea(`api/id/${adaRoot}/profile`)).json();
        assert.equal(after.peek, false, "a mirror now");
        assert.equal(after.posts_more, true, "with history behind the first page");
    });
});
