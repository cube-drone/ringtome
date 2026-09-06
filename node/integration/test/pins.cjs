/*
    PEEK.md slice 4: public pins. A pin is the author's own `pin` statement on the public
    annotations lane about their own post - it travels wherever their chain and proofs do,
    the page opens with the pinned strip, and a peek fetches the pinned posts ahead of the
    window however deep they sit. Unpinning retracts the statement: the strip empties
    everywhere while the post stands.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST_B, HOST_C } = require("./fetch.cjs");

const POSTS = 60;
const DEEP = 3;
const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });

(HOST_B && HOST_C ? describe : describe.skip)("public pins: the author's pin heads their page, travels, and is fetched first", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, posts = [], deep;
    const pinPath = () => `api/identity/${adaRoot}/public-annotations/${adaRoot}/${deep}`;

    before(async () => {
        ada = await makeUserFetch({ prefix: "pinada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        for (let i = 0; i < POSTS; i++) {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title: `post ${i}`, body: `words ${i}`, format: "plaintext" })).json();
            if (i === DEEP) await ada(`api/identity/${adaRoot}/docs/${d.doc_id}/annotations/tags/keeper`, { method: "PUT" });
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            const pubText = await pub.text();
            assert.equal(pub.status, 200, pubText);
            posts.push(JSON.parse(pubText).post_id);
        }
        deep = posts[DEEP];
        assert.ok(deep, "the deep post has a public id");
    });

    it("the author pins a post deep in their history, and their own page opens with it", async () => {
        const pinned = await j(ada, pinPath(), { key: "pin", value: "yes" }, "PUT");
        assert.equal(pinned.status, 200, await pinned.text());
        const profile = await (await ada(`api/id/${adaRoot}/profile`)).json();
        assert.deepEqual((profile.pinned || []).map((p) => p.doc_id), [deep], "the strip holds the pin");
        assert.ok(!(profile.posts || []).some((p) => p.doc_id === deep), "and it sits deep, past the first page");
        const head = await (await ada(`api/id/${adaRoot}/posts/${deep}`)).json();
        assert.ok((head.annotations || []).some((a) => a.key === "pin" && a.annotator === adaRoot), "the card knows");
    });

    it("a follower's page opens with the pin, its labels along, and the pinned body serves", async function () {
        bea = await makeUserFetch({ prefix: "pinbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if ((await bea(`api/id/${adaRoot}/profile?via=${await base58(ada)}`)).status !== 200) this.skip();
        await j(bea, `api/identity/${beaRoot}/private/kv/contact:${adaRoot}/interest`, { value: "high" }, "PUT");
        let strip = [];
        for (let i = 0; i < 12 && !strip.includes(deep); i++) {
            await pullAndFold(HOST_B, adaRoot);
            strip = ((await (await bea(`api/id/${adaRoot}/profile`)).json()).pinned || []).map((p) => p.doc_id);
        }
        assert.deepEqual(strip, [deep], "the follower's strip holds the pin");
        const prof = await (await bea(`api/id/${adaRoot}/profile`)).json();
        assert.ok((prof.pinned[0].annotations || []).some((a) => a.key === "tag" && a.value === "keeper"), "its labels came too");
        let body = null;
        for (let i = 0; i < 40 && body === null; i++) {
            const r = await bea(`id/${adaRoot}/docs/${deep}/body`);
            if (r.status === 200) body = await r.text();
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(body, `words ${DEEP}`, "the pinned body arrived");
    });

    it("a stranger's peek fetches the pinned post beside the newest twenty, labels along", async function () {
        cal = await makeUserFetch({ prefix: "pincal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        const r = await cal(`api/id/${adaRoot}/profile?via=${await base58(ada)}`);
        if (r.status !== 200) this.skip();
        let prof = await r.json();
        for (let i = 0; i < 20 && !(prof.pinned || []).length; i++) {
            await new Promise((res) => setTimeout(res, 400));
            prof = await (await cal(`api/id/${adaRoot}/profile`)).json();
        }
        assert.equal(prof.peek, true);
        assert.deepEqual((prof.pinned || []).map((p) => p.doc_id), [deep], "the peek fetched the pin ahead of the window");
        assert.ok(!(prof.posts || []).some((p) => p.doc_id === deep), "which the window itself never reaches");
        assert.ok((prof.pinned[0].annotations || []).some((a) => a.key === "tag" && a.value === "keeper"), "labels rode the fragment");
    });

    it("unpinning empties the strip everywhere while the post stands", async () => {
        const un = await ada(`${pinPath()}/pin/yes`, { method: "DELETE" });
        assert.equal(un.status, 200, await un.text());
        assert.deepEqual(((await (await ada(`api/id/${adaRoot}/profile`)).json()).pinned || []), [], "the author's strip is empty");
        assert.equal((await ada(`api/id/${adaRoot}/posts/${deep}`)).status, 200, "the post stands");
        let strip = [deep];
        for (let i = 0; i < 12 && strip.length; i++) {
            await pullAndFold(HOST_B, adaRoot);
            strip = ((await (await bea(`api/id/${adaRoot}/profile`)).json()).pinned || []).map((p) => p.doc_id);
        }
        assert.deepEqual(strip, [], "the follower's strip emptied");
        assert.equal((await bea(`api/id/${adaRoot}/posts/${deep}`)).status, 200, "and the post stands there too");
        if (!cal) return;
        let peeked = [deep];
        for (let i = 0; i < 12 && peeked.length; i++) {
            await beat(HOST_C, "pull", adaRoot);
            peeked = ((await (await cal(`api/id/${adaRoot}/profile`)).json()).pinned || []).map((p) => p.doc_id);
        }
        assert.deepEqual(peeked, [], "the peek's strip emptied on its next look");
    });
});
