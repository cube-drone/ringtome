/*
    A share on a person's page opens (Curtis, 2026-09-08): the shared post's author is not
    held on the reader's node, and nothing ever asked for the words - the card read "these
    words haven't reached this computer" forever. The body door now asks, once, for a post
    it does not hold: from the sharer whose shelf listed it when the card says so (`?via=`),
    else from the author's own nodes.
*/
const assert = require("node:assert");
const dns = require("node:dns");
dns.setDefaultResultOrder("ipv4first");

const { makeUserFetch } = require("./helpers.cjs");
const { pullAndFold } = require("./beat.cjs");
const { HOST_B, HOST_C } = require("./fetch.cjs");

const base58 = async (host) => {
    const { toBase58 } = await import("../../js/speakable.js");
    return toBase58((await (await host("api/node")).json()).endpoint_id);
};
const j = (who, path, body, method = "POST") => who(path, { method, body: JSON.stringify(body) });
const wait = (ms) => new Promise((res) => setTimeout(res, ms));

(HOST_B && HOST_C ? describe : describe.skip)("a share on a person's page opens", function () {
    this.timeout(600000);

    let ada, adaRoot, bea, beaRoot, cal, calRoot, post, other;

    const follow = async (who, root, them, viaHost) => {
        if ((await who(`api/id/${them}/profile?via=${await base58(viaHost)}`)).status !== 200) return false;
        await j(who, `api/identity/${root}/private/kv/contact:${them}/interest`, { value: "high" }, "PUT");
        return true;
    };
    const opens = async (who, path) => {
        for (let i = 0; i < 30; i++) {
            const r = await who(path);
            if (r.status === 200) return r.text();
            await wait(400);
        }
        return null;
    };

    before(async function () {
        ada = await makeUserFetch({ prefix: "shelfada" });
        adaRoot = (await (await ada("api/identity", { method: "POST" })).json()).root_pubkey;
        await ada(`api/identity/${adaRoot}/serve`, { method: "POST" });
        const mk = async (title, body) => {
            const d = await (await j(ada, `api/identity/${adaRoot}/docs`, { title, body, format: "marquee" })).json();
            const pub = await j(ada, `api/identity/${adaRoot}/docs/${d.doc_id}/publish`, {});
            const said = await pub.text();
            assert.equal(pub.status, 200, said);
            return JSON.parse(said).post_id;
        };
        post = await mk("passed along", "the words bea passed along");
        other = await mk("never shared", "the words nobody passed along");
        bea = await makeUserFetch({ prefix: "shelfbea", host: HOST_B });
        beaRoot = (await (await bea("api/identity", { method: "POST" })).json()).root_pubkey;
        await bea(`api/identity/${beaRoot}/serve`, { method: "POST" });
        if (!(await follow(bea, beaRoot, adaRoot, ada))) this.skip();
        await pullAndFold(HOST_B, adaRoot);
        assert.ok(await opens(bea, `id/${adaRoot}/docs/${post}/body`), "bea holds ada's words");
        const shared = await j(bea, `api/identity/${beaRoot}/rebroadcasts`, { author: adaRoot, doc_id: post });
        assert.equal(shared.status, 200, await shared.text());
        // cal follows bea for her own posts only - no rebroadcast dial, so the fanout never
        // carries the share into cal's feed, and ada is a stranger to cal's node.
        cal = await makeUserFetch({ prefix: "shelfcal", host: HOST_C });
        calRoot = (await (await cal("api/identity", { method: "POST" })).json()).root_pubkey;
        await cal(`api/identity/${calRoot}/serve`, { method: "POST" });
        if (!(await follow(cal, calRoot, beaRoot, bea))) this.skip();
        await pullAndFold(HOST_C, beaRoot);
    });

    it("bea's shelf lists the share with its via, and the card's hinted read brings the words from bea's node", async () => {
        let share = null;
        for (let i = 0; i < 20 && !share; i++) {
            const shelf = await (await cal(`api/id/${beaRoot}/posts?as=${calRoot}`)).json();
            share = (shelf.posts || []).find((p) => p.kind === "share" && p.doc_id === post);
            if (!share) await wait(400);
        }
        assert.ok(share, "the share is on bea's shelf as cal sees it");
        assert.equal(share.author, adaRoot);
        assert.equal(share.via, beaRoot, "the card knows who passed it along");
        const words = await opens(cal, `id/${adaRoot}/docs/${post}/body?via=${beaRoot}`);
        assert.equal(words, "the words bea passed along", "the words came from the sharer's node");
    });

    it("without a hint the door asks the author's own nodes", async () => {
        const words = await opens(cal, `id/${adaRoot}/docs/${other}/body`);
        assert.equal(words, "the words nobody passed along");
    });
});
