/*
    VISIBILITY.md slice 2: trusted-only posts. Title public, body gated - the words go only
    to readers the author publishes trust for, checked at serve time against the author's
    own FOLLOWS_PUBLIC edges. The HTTP door here; the node-to-node doors are slice 2b.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { beat, pullAndFold } = require("./beat.cjs");
const { HOST_B } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};

describe("trusted-only posts: the body goes to trusted readers", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, post;

    before(async () => {
        ada = await makeUserFetch({ prefix: "trustada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        bea = await makeUserFetch({ prefix: "trustbea" });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
    });

    it("the flag rides the publish; the title stays public", async () => {
        const made = await (
            await ada(`api/identity/${adaRoot}/docs`, {
                method: "POST",
                body: JSON.stringify({ title: "for my people", body: "the quiet words", format: "plaintext" }),
            })
        ).json();
        const pub = await ada(`api/identity/${adaRoot}/docs/${made.doc_id}/publish`, {
            method: "POST",
            body: JSON.stringify({ trusted_only: true }),
        });
        const text = await pub.text();
        assert.equal(pub.status, 200, text);
        post = JSON.parse(text).post_id;
        // The public face, for an untrusted reader: existence, title, date - and the flag.
        const head = await (await bea(`api/id/${adaRoot}/posts/${post}`)).json();
        assert.equal(head.title, "for my people", "the title is the post's public face");
        assert.equal(head.trusted_only, true);
    });

    it("the body refuses an untrusted reader with honest words, and serves the author", async () => {
        const no = await bea(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(no.status, 403, await no.clone().text());
        assert.match(await no.text(), /people they trust/);
        const own = await ada(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(own.status, 200, await own.clone().text());
        assert.equal(await own.text(), "the quiet words");
    });

    it("publishing trust opens the door - at serve time, no re-publication", async () => {
        await ada(`api/identity/${adaRoot}/private/kv/contact:${beaRoot}/trust`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(undefined, "mint", adaRoot);
        const yes = await bea(`id/${adaRoot}/docs/${post}/body`);
        assert.equal(yes.status, 200, await yes.clone().text());
        assert.equal(await yes.text(), "the quiet words");
    });

    it("across nodes, the body is ciphertext and the KEY travels the trusted lane", async function () {
        if (!HOST_B) this.skip();
        // cara, on another node, follows ada - her node mirrors the chains and pulls the
        // ciphertext like any bytes. The words appear only after ada trusts her and her
        // node earns the key over the lane.
        const cara = await makeUserFetch({ prefix: "trustcara", host: HOST_B });
        const caraRoot = (await (await cara("api/identity", { method: "POST" })).json()).root_pubkey;
        await cara(`api/identity/${caraRoot}/serve`, { method: "POST" });
        const viaAda = await base58(ada);
        if ((await cara(`api/id/${adaRoot}/profile?via=${viaAda}`)).status !== 200) this.skip();
        await cara(`api/identity/${caraRoot}/private/kv/contact:${adaRoot}/interest`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await pullAndFold(HOST_B, adaRoot);
        // Untrusted: her node can see the flag (it mirrors ada), so the gate refuses.
        const no = await cara(`id/${adaRoot}/docs/${post}/body`);
        assert.notEqual(no.status, 200, "no words for the untrusted, on any node");
        // ada trusts cara and, so her node can resolve cara's serving record for the
        // key-release check, meets her chains.
        await ada(`api/identity/${adaRoot}/private/kv/contact:${caraRoot}/trust`, {
            method: "PUT",
            body: JSON.stringify({ value: "high" }),
        });
        await beat(undefined, "mint", adaRoot);
        const viaCara = await base58(cara);
        await ada(`api/id/${caraRoot}/profile?via=${viaCara}`);
        await pullAndFold(undefined, caraRoot);
        await pullAndFold(HOST_B, adaRoot);
        let got = null;
        for (let i = 0; i < 40 && got !== "the quiet words"; i++) {
            const r = await cara(`id/${adaRoot}/docs/${post}/body`);
            if (r.status === 200) got = await r.text();
            else await new Promise((res) => setTimeout(res, 400));
        }
        assert.equal(got, "the quiet words", "the key lane opened the sealed body");
    });
});
